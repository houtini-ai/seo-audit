import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * DataForSEO client modelled on the official connection (api.dataforseo.com, Basic
 * Auth, array-body POST, response under tasks[].result — per dataforseo/typescriptclient
 * and dataforseo/mcp-server-typescript).
 *
 * Two cost-control layers the user asked for:
 *  - SINGULAR WORKER: live requests are serialised (one at a time) via a promise
 *    chain, so we never fan out paid calls concurrently.
 *  - TTL CACHE: every response is written to a shared SQLite cache keyed on
 *    (endpoint + body); a cache hit costs nothing and skips the worker entirely.
 *    TTL comes from DATAFORSEO_CACHE_DAYS (default DEFAULT_DFS_CACHE_DAYS, 20); SERP/keyword/
 *    domain data is stable enough that a ~3-week TTL is safe.
 */

/**
 * The ONE default TTL for the shared dataforseo-cache.db. The MCP and the dashboard sidecar open the
 * same file, so they must agree on when an entry is stale: with different defaults, one process
 * would pay to refetch what the other still serves from cache.
 */
export const DEFAULT_DFS_CACHE_DAYS = 20;
export const dfsCacheDaysFromEnv = (env: NodeJS.ProcessEnv = process.env): number => Number(env.DATAFORSEO_CACHE_DAYS) || DEFAULT_DFS_CACHE_DAYS;

export interface DfsResponse {
  tasks: any[];
  cached: boolean;
  cost: number;
}

const BASE_URL = 'https://api.dataforseo.com';

/** Google Trends related topic / query. `value` is relative interest (top) or % increase (rising). */
export interface TrendTopic { title: string; type: string | null; value: number | null }
export interface TrendQuery { query: string; value: number | null }

/** Earliest date_from DataForSEO holds for Labs historical endpoints. */
export const HISTORICAL_MIN_DATE_FROM = '2020-10-01';

/**
 * date_from (yyyy-mm-dd) for a window of `months` whole months ending last month:
 * the first day of the month `months` before `now`'s month, clamped to 2020-10-01.
 * In Oct 2026, months=12 -> 2025-10-01 (2025-10 .. 2026-09). Computed in UTC so the
 * request body (and therefore the cache key) is stable for the whole month.
 */
export function historicalDateFrom(months: number, now: Date = new Date()): string {
  const m = Math.max(1, Math.floor(months));
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
  const iso = d.toISOString().slice(0, 10);
  return iso < HISTORICAL_MIN_DATE_FROM ? HISTORICAL_MIN_DATE_FROM : iso;
}

/** Per-call options. `maxAgeDays` narrows the cache age for one call (the portfolio's weekly tier
 * wants last week's numbers, not the 20-day shared default). It may be longer or shorter than the
 * client TTL: it only decides whether THIS call reuses a cached response. */
export interface DfsCallOptions { timeoutMs?: number; maxAgeDays?: number }

/** Client-level hooks: `fetchImpl` lets tests serve saved fixtures with no network; `onCost` sees every
 * paid response (cache hits cost nothing and never call it), which is how a portfolio run totals its
 * actual spend instead of trusting the quote. */
export interface DfsClientHooks {
  fetchImpl?: typeof fetch;
  onCost?: (endpoint: string, usd: number) => void;
}

export class DataForSeoClient {
  private readonly auth: string;
  private readonly ttlMs: number;
  private readonly cache: Database.Database;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly fetchImpl: typeof fetch;
  onCost?: (endpoint: string, usd: number) => void;

  constructor(login: string, password: string, cacheDbPath: string, ttlDays = DEFAULT_DFS_CACHE_DAYS, hooks: DfsClientHooks = {}) {
    this.fetchImpl = hooks.fetchImpl ?? fetch;
    this.onCost = hooks.onCost;
    this.auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
    this.ttlMs = ttlDays * 86400000;
    mkdirSync(dirname(cacheDbPath), { recursive: true });
    this.cache = new Database(cacheDbPath);
    this.cache.pragma('journal_mode = WAL');
    this.cache.exec(`
      CREATE TABLE IF NOT EXISTS dataforseo_cache (
        cache_key TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        request_json TEXT,
        response_json TEXT NOT NULL,
        cost REAL DEFAULT 0,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dfs_endpoint ON dataforseo_cache(endpoint);
    `);
  }

  /** Serialise live work — only one request in flight at any time (singular worker). */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private keyFor(endpoint: string, body: unknown): string {
    // Canonical (key-sorted) serialisation so equivalent bodies hash identically.
    const canonical = JSON.stringify(body, (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
        : v,
    );
    return createHash('sha256').update(endpoint + '\n' + canonical).digest('hex');
  }

  /** POST to a DataForSEO endpoint, served from the cache (DEFAULT_DFS_CACHE_DAYS) when fresh. */
  async call(endpoint: string, body: unknown[], opts: number | DfsCallOptions = 60000): Promise<DfsResponse> {
    const { timeoutMs = 60000, maxAgeDays } = typeof opts === 'number' ? { timeoutMs: opts } : opts;
    const ttlMs = maxAgeDays != null ? maxAgeDays * 86400000 : this.ttlMs;
    const key = this.keyFor(endpoint, body);
    const row = this.cache
      .prepare('SELECT response_json, cost, fetched_at FROM dataforseo_cache WHERE cache_key = ?')
      .get(key) as { response_json: string; cost: number; fetched_at: string } | undefined;
    if (row && Date.now() - Date.parse(row.fetched_at) < ttlMs) {
      return { tasks: JSON.parse(row.response_json), cached: true, cost: 0 };
    }

    return this.serialize(async () => {
      // Re-check the cache now that we hold the single-worker slot: a concurrent identical
      // call may have just paid for and cached this exact request — don't double-spend.
      const again = this.cache
        .prepare('SELECT response_json, fetched_at FROM dataforseo_cache WHERE cache_key = ?')
        .get(key) as { response_json: string; fetched_at: string } | undefined;
      if (again && Date.now() - Date.parse(again.fetched_at) < ttlMs) {
        return { tasks: JSON.parse(again.response_json), cached: true, cost: 0 };
      }
      const res = await this.fetchImpl(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: this.auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json: any = await res.json();
      if (!res.ok || json?.status_code >= 40000) {
        throw new Error(`DataForSEO ${endpoint} failed: ${res.status} ${json?.status_message ?? ''}`.trim());
      }
      const tasks = json.tasks ?? [];
      // Task-level failures (40xxx inside tasks[0]) must be LOUD — swallowed, they surface as a
      // plausible-looking empty result (found live: Labs rejecting a field returned [] at $0).
      const t0 = tasks[0];
      if (t0 && (t0.status_code ?? 20000) >= 40000) {
        throw new Error(
          `DataForSEO ${endpoint} task failed: ${t0.status_code} ${t0.status_message ?? ''}`.trim() +
          (t0.status_code === 40204 ? ' — the Backlinks API is a separate DataForSEO subscription; activate it at app.dataforseo.com to use pull_backlinks.' : ''),
        );
      }
      const cost = Number(json.cost) || 0;
      if (cost > 0) this.onCost?.(endpoint, cost);
      // Only cache genuinely successful responses — a task-level failure (40xxx) or
      // all-null results must not be cached for the TTL; let a later call retry.
      const taskOk = tasks.length > 0 && (tasks[0]?.status_code ?? 20000) < 40000 && tasks.some((t: any) => t?.result != null);
      if (taskOk) {
        this.cache
          .prepare(
            `INSERT INTO dataforseo_cache (cache_key, endpoint, request_json, response_json, cost, fetched_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(cache_key) DO UPDATE SET response_json=excluded.response_json,
               cost=excluded.cost, fetched_at=datetime('now')`,
          )
          .run(key, endpoint, JSON.stringify(body), JSON.stringify(tasks), cost);
      }
      return { tasks, cached: false, cost };
    });
  }

  // ── Typed helpers (within our enabled scopes) ─────────────────────────────

  /** Build the location field — numeric → location_code, string → location_name, else US default. */
  private loc(location?: string | number): Record<string, unknown> {
    if (typeof location === 'number') return { location_code: location };
    if (typeof location === 'string' && location.trim()) return { location_name: location.trim() };
    return { location_code: 2840 }; // default United States
  }

  /** KEYWORDS_DATA — true monthly search volume + CPC + competition (cheap). */
  async searchVolume(keywords: string[], location?: string | number, languageCode = 'en'): Promise<DfsResponse> {
    return this.call('/v3/keywords_data/google_ads/search_volume/live', [
      { keywords, ...this.loc(location), language_code: languageCode },
    ]);
  }

  /** SERP — live Google organic results (per-request cost; use sparingly).
   * `depth` = how many ORGANIC results to collect (not total SERP elements), so a domain absent
   * at depth=20 is absent from the top 20 organic — nothing is known about its position beyond that.
   * `loadAsyncAiOverview` makes DataForSEO wait for a client-side-loaded AI Overview and return its
   * references; without it those SERPs come back with an empty AIO (asynchronous_ai_overview:true)
   * and citation is unknowable. Small surcharge, refunded when no async AIO is found. */
  async serpOrganic(
    keyword: string, location?: string | number, languageCode = 'en', depth = 20,
    opts: { loadAsyncAiOverview?: boolean } = {},
  ): Promise<DfsResponse> {
    return this.call('/v3/serp/google/organic/live/advanced', [
      {
        keyword, ...this.loc(location), language_code: languageCode, depth,
        ...(opts.loadAsyncAiOverview ? { load_async_ai_overview: true } : {}),
      },
    ]);
  }

  /** SERP — live YouTube organic results for a keyword (video discovery). Same SERP
   * scope + cache (DEFAULT_DFS_CACHE_DAYS) as serpOrganic. Returns the ranking videos shaped for content
   * research: title, url, channel, views, publish date, duration. `blockDepth` = how many
   * videos to collect (YouTube SERP uses block_depth, default 20, max 200). */
  async serpYoutube(
    keyword: string, location?: string | number, languageCode = 'en', blockDepth = 20,
  ): Promise<{
    videos: Array<{
      rank: number | null; title: string | null; url: string | null; videoId: string | null;
      channel: string | null; channelUrl: string | null; views: number | null;
      published: string | null; durationSeconds: number | null; isShorts: boolean | null; isLive: boolean | null;
    }>;
    cached: boolean; cost: number;
  }> {
    const r = await this.call('/v3/serp/youtube/organic/live/advanced', [
      { keyword, ...this.loc(location), language_code: languageCode, block_depth: blockDepth },
    ]);
    const items: any[] = r.tasks[0]?.result?.[0]?.items ?? [];
    const videos = items
      .filter((it) => it.type === 'youtube_video')
      .map((it) => ({
        rank: it.rank_absolute ?? null,
        title: it.title ?? null,
        url: it.url ?? (it.video_id ? `https://www.youtube.com/watch?v=${it.video_id}` : null),
        videoId: it.video_id ?? null,
        channel: it.channel_name ?? null,
        channelUrl: it.channel_url ?? null,
        views: it.views_count ?? null,
        published: it.publication_date ?? it.timestamp ?? null,
        durationSeconds: it.duration_time_seconds ?? null,
        isShorts: it.is_shorts ?? null,
        isLive: it.is_live ?? null,
      }));
    return { videos, cached: r.cached, cost: r.cost };
  }

  /** SERP — live Google News results for a keyword (what's been PUBLISHED / freshness).
   * Same SERP scope + cache (DEFAULT_DFS_CACHE_DAYS). Flattens both `news_search` items and `top_stories`
   * groups into one ranked list: title, url, source, snippet, timestamp. */
  async serpNews(
    keyword: string, location?: string | number, languageCode = 'en', depth = 20,
  ): Promise<{
    articles: Array<{ rank: number | null; title: string | null; url: string | null; source: string | null; snippet: string | null; timestamp: string | null; imageUrl: string | null }>;
    cached: boolean; cost: number;
  }> {
    const r = await this.call('/v3/serp/google/news/live/advanced', [
      { keyword, ...this.loc(location), language_code: languageCode, depth },
    ]);
    const items: any[] = r.tasks[0]?.result?.[0]?.items ?? [];
    const articles: Array<{ rank: number | null; title: string | null; url: string | null; source: string | null; snippet: string | null; timestamp: string | null; imageUrl: string | null }> = [];
    for (const it of items) {
      if (it.type === 'news_search') {
        articles.push({ rank: it.rank_absolute ?? null, title: it.title ?? null, url: it.url ?? null, source: it.domain ?? null, snippet: it.snippet ?? null, timestamp: it.timestamp ?? null, imageUrl: it.image_url ?? null });
      } else if (it.type === 'top_stories' && Array.isArray(it.items)) {
        for (const s of it.items) {
          articles.push({ rank: it.rank_absolute ?? null, title: s.title ?? null, url: s.url ?? null, source: s.source ?? s.domain ?? null, snippet: null, timestamp: s.timestamp ?? s.date ?? null, imageUrl: s.image_url ?? null });
        }
      }
    }
    return { articles, cached: r.cached, cost: r.cost };
  }

  /** KEYWORDS_DATA — Google Trends relative interest (0–100) over time for up to 5
   * keywords, for seasonality / "is this rising or fading". Returns the time series per
   * keyword (values aligned to the queried keywords). `timeRange` presets: past_7_days,
   * past_30_days, past_90_days, past_12_months (default), past_5_years, 2004_present.
   * `type`: web (default), news, youtube, images, froogle. Cached for the TTL (default 20 days). */
  async googleTrends(
    keywords: string[], location?: string | number, languageCode = 'en',
    opts: { timeRange?: string; type?: string; categoryCode?: number; related?: boolean } = {},
  ): Promise<{
    series: Array<{ dateFrom: string | null; dateTo: string | null; values: Record<string, number | null> }>;
    keywords: string[]; categoryCode: number | null; cached: boolean; cost: number;
    topics?: { top: TrendTopic[]; rising: TrendTopic[] };
    queries?: { top: TrendQuery[]; rising: TrendQuery[] };
  }> {
    // Since Sep 2026 the Explore endpoint accepts category_code on its own (keywords optional,
    // code > 0): whole-category interest, not one term's. Related topics/queries need <= 1 keyword.
    const kwIn = keywords.slice(0, 5);
    const cat = opts.categoryCode && opts.categoryCode > 0 ? opts.categoryCode : null;
    if (!kwIn.length && !cat) throw new Error('googleTrends needs keywords, a categoryCode > 0, or both');
    if (opts.related && kwIn.length > 1) throw new Error('related topics/queries need at most one keyword (DataForSEO limit)');
    const itemTypes = ['google_trends_graph', ...(opts.related ? ['google_trends_topics_list', 'google_trends_queries_list'] : [])];
    const r = await this.call('/v3/keywords_data/google_trends/explore/live', [
      {
        ...(kwIn.length ? { keywords: kwIn } : {}), ...(cat ? { category_code: cat } : {}),
        ...this.loc(location), language_code: languageCode,
        type: opts.type ?? 'web', time_range: opts.timeRange ?? 'past_12_months',
        item_types: itemTypes,
      },
    ]);
    const result: any = r.tasks[0]?.result?.[0];
    const items: any[] = result?.items ?? [];
    // A category-only graph carries one unnamed series; label it by its code.
    const kw: string[] = kwIn.length ? (Array.isArray(result?.keywords) && result.keywords.length ? result.keywords : kwIn) : [`category:${cat}`];
    const graph = items.find((it: any) => it.type === 'google_trends_graph');
    const series = (graph?.data ?? []).map((d: any) => ({
      dateFrom: d.date_from ?? null,
      dateTo: d.date_to ?? null,
      values: Object.fromEntries(kw.map((k, i) => [k, d.values?.[i] ?? null])),
    }));
    const list = (type: string) => items.find((it: any) => it.type === type)?.data;
    const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
    const topicsData = list('google_trends_topics_list');
    const queriesData = list('google_trends_queries_list');
    const toTopic = (t: any): TrendTopic => ({ title: t.topic_title, type: t.topic_type ?? null, value: num(t.value) });
    const toQuery = (q: any): TrendQuery => ({ query: q.query, value: num(q.value) });
    return {
      series, keywords: kw, categoryCode: cat, cached: r.cached, cost: r.cost,
      ...(opts.related ? {
        topics: { top: (topicsData?.top ?? []).map(toTopic), rising: (topicsData?.rising ?? []).map(toTopic) },
        queries: { top: (queriesData?.top ?? []).map(toQuery), rising: (queriesData?.rising ?? []).map(toQuery) },
      } : {}),
    };
  }

  /** KEYWORDS_DATA — the Google Trends category tree (free, GET; ~1,400 rows). Cached like any call. */
  async googleTrendsCategories(): Promise<Array<{ code: number; name: string; parent: number | null }>> {
    const endpoint = '/v3/keywords_data/google_trends/categories';
    const key = this.keyFor(endpoint, ['GET']);
    const row = this.cache
      .prepare('SELECT response_json, fetched_at FROM dataforseo_cache WHERE cache_key = ?')
      .get(key) as { response_json: string; fetched_at: string } | undefined;
    let tasks: any[];
    if (row && Date.now() - Date.parse(row.fetched_at) < this.ttlMs) {
      tasks = JSON.parse(row.response_json);
    } else {
      const res = await fetch(`${BASE_URL}${endpoint}`, { headers: { Authorization: this.auth }, signal: AbortSignal.timeout(60000) });
      const json: any = await res.json();
      if (!res.ok || json?.status_code >= 40000) throw new Error(`DataForSEO ${endpoint} failed: ${res.status} ${json?.status_message ?? ''}`.trim());
      tasks = json.tasks ?? [];
      if (tasks[0]?.result?.length) {
        this.cache
          .prepare(
            `INSERT INTO dataforseo_cache (cache_key, endpoint, request_json, response_json, cost, fetched_at)
             VALUES (?, ?, ?, ?, 0, datetime('now'))
             ON CONFLICT(cache_key) DO UPDATE SET response_json=excluded.response_json, fetched_at=datetime('now')`,
          )
          .run(key, endpoint, '["GET"]', JSON.stringify(tasks));
      }
    }
    return (tasks[0]?.result ?? []).map((c: any) => ({ code: c.category_code, name: c.category_name, parent: c.category_code_parent ?? null }));
  }

  /**
   * Related terms for a keyword — People Also Ask questions + related searches,
   * parsed from the SERP advanced response. Powers the click-through "related
   * terms" on the keyword charts. Cached for the TTL (default 20 days) via the underlying SERP call.
   */
  async relatedTerms(
    keyword: string,
    location?: string | number,
    languageCode = 'en',
  ): Promise<{ peopleAlsoAsk: string[]; relatedSearches: string[]; cached: boolean; cost: number }> {
    const r = await this.serpOrganic(keyword, location, languageCode, 30);
    const items: any[] = r.tasks[0]?.result?.[0]?.items ?? [];
    const peopleAlsoAsk: string[] = [];
    const relatedSearches: string[] = [];
    for (const it of items) {
      if (it.type === 'people_also_ask') {
        for (const q of it.items ?? []) if (q?.title) peopleAlsoAsk.push(q.title);
      } else if (it.type === 'related_searches') {
        for (const t of it.items ?? []) {
          if (typeof t === 'string') relatedSearches.push(t);
          else if (t?.title) relatedSearches.push(t.title);
        }
      }
    }
    return { peopleAlsoAsk, relatedSearches, cached: r.cached, cost: r.cost };
  }

  /** Labs — domain ranking distribution over time (monthly). The over-time sequence.
   * date_from is REQUIRED for full history: without it the endpoint returns only the
   * previous 6 months (the chart silently showed just those). 2020-10-01 is the earliest
   * data DataForSEO holds for this endpoint, so the default pulls everything available (~6 years).
   * Billed per monthly item returned, so callers that only need a recent window should pass a
   * later dateFrom (see historicalDateFrom). */
  async historicalRankOverview(target: string, location?: string | number, languageCode = 'en', languageName?: string, dateFrom = HISTORICAL_MIN_DATE_FROM): Promise<DfsResponse> {
    return this.call('/v3/dataforseo_labs/google/historical_rank_overview/live', [
      { target, ...this.loc(location), ...(languageName ? { language_name: languageName } : { language_code: languageCode }), date_from: dateFrom },
    ]);
  }

  /** Labs — a domain's top ranking pages by estimated organic traffic (relevant_pages). */
  async relevantPages(target: string, location?: string | number, languageCode = 'en', limit = 25): Promise<DfsResponse> {
    return this.call('/v3/dataforseo_labs/google/relevant_pages/live', [
      {
        target,
        ...this.loc(location),
        language_code: languageCode,
        limit: Math.min(limit, 1000),
        order_by: ['metrics.organic.etv,desc'],
        item_types: ['organic'],
      },
    ]);
  }

  /**
   * Labs — every keyword a target ranks for. `target` may be a domain, a subdomain,
   * or a full URL (DataForSEO switches mode on the shape). Optional `filters` narrows
   * to e.g. a subfolder via ranked_serp_element.serp_item.relative_url LIKE.
   */
  async rankedKeywords(
    target: string,
    location?: string | number,
    languageCode = 'en',
    limit = 50,
    orderBy = 'ranked_serp_element.serp_item.etv,desc',
    filters?: unknown[],
  ): Promise<DfsResponse> {
    // NB: element-type scoping (e.g. AI Overview citations) is expressed via `filters` on
    // serp_item.type here. `item_types` itself IS accepted (verified live 2026-10-24 with limit 1 and
    // no filters: rankedKeywordsMetrics), contrary to an earlier note; a 40501 seen before came from
    // this body shape and wasn't re-tested, so this method doesn't send it.
    const body: Record<string, unknown> = {
      target,
      ...this.loc(location),
      language_code: languageCode,
      limit: Math.min(limit, 1000),
      order_by: [orderBy],
    };
    if (filters && filters.length) body.filters = filters;
    return this.call('/v3/dataforseo_labs/google/ranked_keywords/live', [body]);
  }

  /** Backlinks — overall profile for a domain (total backlinks, referring domains, spam). Cheap. */
  async backlinksSummary(target: string): Promise<DfsResponse> {
    return this.call('/v3/backlinks/summary/live', [{ target, internal_list_limit: 1, backlinks_status_type: 'live' }]);
  }

  /** Backlinks — per-page backlink/referring-domain counts for a domain (top pages by backlinks). */
  async domainPagesSummary(target: string, limit = 1000): Promise<DfsResponse> {
    return this.call('/v3/backlinks/domain_pages_summary/live', [
      { target, limit: Math.min(limit, 1000), order_by: ['backlinks,desc'], backlinks_status_type: 'live' },
    ]);
  }

  /** Backlinks (#47) — referring domains for a target, best rank first; `all` includes lost domains (lost_date set). */
  async referringDomains(target: string, limit = 1000, status: 'live' | 'all' = 'all'): Promise<DfsResponse> {
    return this.call('/v3/backlinks/referring_domains/live', [
      { target, limit: Math.min(limit, 1000), order_by: ['rank,desc'], backlinks_status_type: status, exclude_internal_backlinks: true },
    ]);
  }

  /** Backlinks (#47) — anchor texts pointing at a target, most backlinks first (live links only). */
  async backlinkAnchors(target: string, limit = 500): Promise<DfsResponse> {
    return this.call('/v3/backlinks/anchors/live', [
      { target, limit: Math.min(limit, 1000), order_by: ['backlinks,desc'], backlinks_status_type: 'live', exclude_internal_backlinks: true },
    ]);
  }

  /** Backlinks (#47) — daily backlink / referring-domain history (new and lost) for a target since `dateFrom` (YYYY-MM-DD). */
  /** Backlinks history is MONTHLY (one item per month), not daily. `rankScale` defaults to the API's
   * 0-1000; the portfolio asks for 'one_hundred' so it matches bulk_ranks. */
  async backlinksHistory(target: string, dateFrom: string, dateTo?: string, rankScale?: 'one_hundred' | 'one_thousand', opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/backlinks/history/live', [{ target, date_from: dateFrom, ...(dateTo ? { date_to: dateTo } : {}), ...(rankScale ? { rank_scale: rankScale } : {}) }], opts);
  }

  /**
   * Backlinks — LINK INTERSECT: domains that link to a set of competitor `targets`, minus
   * anything already linking to `excludeTarget` (our own domain). Each returned item is a
   * referring domain with a `domain_intersection.{N}` entry per competitor it links to
   * (N maps back to the `targets` array position) plus `summary.intersections_count`.
   * Server-side `order_by: intersections_count,desc` is target-agnostic (the union), so a
   * generous limit captures the true multi-competitor intersect; priority (followed +
   * domain trust) and spam filtering are applied client-side in LinkIntersect. ~$0.024/call.
   */
  async domainIntersection(targets: string[], excludeTarget?: string, limit = 300): Promise<DfsResponse> {
    const targetMap: Record<string, string> = {};
    targets.slice(0, 20).forEach((t, i) => { targetMap[String(i + 1)] = t; });
    const body: Record<string, unknown> = {
      targets: targetMap,
      order_by: ['intersections_count,desc'],
      limit: Math.min(limit, 1000),
      backlinks_status_type: 'live',
    };
    if (excludeTarget) body.exclude_targets = [excludeTarget];
    return this.call('/v3/backlinks/domain_intersection/live', [body]);
  }

  /**
   * Labs — classify the search intent of keywords (informational / navigational /
   * commercial / transactional) with a probability + secondary intents. Language-only
   * (no location), up to 1000 keywords per call. Cheap (~50 credits).
   */
  async searchIntent(keywords: string[], languageCode = 'en'): Promise<DfsResponse> {
    return this.call('/v3/dataforseo_labs/google/search_intent/live', [
      { keywords: keywords.slice(0, 1000), language_code: languageCode },
    ]);
  }

  /**
   * On-Page — live Lighthouse audit for ONE url (lab Core Web Vitals + opportunities).
   * Pricier (~2000 credits) and slow: Lighthouse renders the page, so allow up to 120s
   * (DataForSEO aborts at 120s). `for_mobile` defaults true (mobile-first).
   */
  async lighthouse(url: string, forMobile = true, languageCode = 'en'): Promise<DfsResponse> {
    return this.call(
      '/v3/on_page/lighthouse/live/json',
      [{ url, for_mobile: forMobile, language_code: languageCode, categories: ['performance', 'seo', 'best_practices', 'accessibility'] }],
      120000,
    );
  }

  /** Labs — competitor domains by organic keyword overlap (discovery seed for gap analysis). */
  async competitorsDomain(target: string, location?: string | number, languageCode = 'en', limit = 20): Promise<DfsResponse> {
    return this.call('/v3/dataforseo_labs/google/competitors_domain/live', [
      { target, ...this.loc(location), language_code: languageCode, limit: Math.min(limit, 1000), exclude_top_domains: true },
    ]);
  }

  /**
   * Labs — keywords that a set of competitor pages rank for but our page(s) do NOT
   * (content gap). `competitorUrls` → the `pages` map (max 20); `excludeUrls` → our own
   * page(s) to subtract (max 10). Sorted by search volume. Wildcards like `…/*` allowed.
   */
  // ── Portfolio (design/portfolio/SPEC.md). Request bodies verified live 2026-10-24; the raw
  // responses are the fixtures in scripts/fixtures/portfolio/. The bulk endpoints take up to 1,000
  // targets per call (one task), so a whole portfolio costs one task each.

  /** Backlinks: DataForSEO Domain Rank per target, 0-100. NOT Semrush's Authority Score: label it as DataForSEO's. */
  async bulkRanks(targets: string[], opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/backlinks/bulk_ranks/live', [{ targets, rank_scale: 'one_hundred' }], opts);
  }

  /** Backlinks: referring_domains / referring_main_domains (+ nofollow) per target. */
  async bulkReferringDomains(targets: string[], opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/backlinks/bulk_referring_domains/live', [{ targets }], opts);
  }

  /** Backlinks: backlink count per target. */
  async bulkBacklinks(targets: string[], opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/backlinks/bulk_backlinks/live', [{ targets }], opts);
  }

  /** Backlinks: new / lost referring (main) domains since dateFrom (YYYY-MM-DD, up to 365 days back). */
  async bulkNewLostReferringDomains(targets: string[], dateFrom: string, opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/backlinks/bulk_new_lost_referring_domains/live', [{ targets, date_from: dateFrom }], opts);
  }

  /** Labs: current organic / paid ETV + keyword count per target, at ONE location (ETV is per
   * location: an AU site read at the US default is near zero), so callers group targets by location. */
  async bulkTrafficEstimation(targets: string[], location?: string | number, languageCode = 'en', opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/dataforseo_labs/google/bulk_traffic_estimation/live', [{ targets, ...this.loc(location), language_code: languageCode }], opts);
  }

  /** Labs: one row per location the target ranks in (no location sent). Rows come sorted by
   * location_code, not by traffic, so ask for enough rows and sort client-side. */
  async domainRankOverviewAllLocations(target: string, limit = 300, opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/dataforseo_labs/google/domain_rank_overview/live', [{ target, limit }], opts);
  }

  /** Labs: ranked_keywords with limit 1, for its result-level `metrics` block (organic / paid /
   * featured_snippet / local_pack / ai_overview_reference position counts). A null block means none counted. */
  async rankedKeywordsMetrics(target: string, location?: string | number, languageCode = 'en', opts: DfsCallOptions = {}): Promise<DfsResponse> {
    // item_types is required for the SERP-feature counts: without it featured_snippet, local_pack and
    // ai_overview_reference come back null (verified live; fixtures ranked_keywords_metrics vs _item_types).
    return this.call('/v3/dataforseo_labs/google/ranked_keywords/live', [{
      target, ...this.loc(location), language_code: languageCode, limit: 1,
      item_types: ['organic', 'paid', 'featured_snippet', 'local_pack', 'ai_overview_reference'],
    }], opts);
  }

  /** Backlinks: a domain's pages ordered by referring main domains ("top pages by links"). */
  async domainPages(target: string, limit = 100, opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/backlinks/domain_pages/live', [{ target, limit, order_by: ['page_summary.referring_main_domains,desc'] }], opts);
  }

  /** LLM Mentions: mentions + ai_search_volume for up to 10 domains in one task, for ONE platform
   * ('google' = AI Overviews, 'chat_gpt'; ChatGPT data is United States only). */
  async llmMultiTargetMetrics(platform: 'google' | 'chat_gpt', domains: string[], location: number = 2840, languageCode = 'en', opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/ai_optimization/llm_mentions/multi_target_metrics/live', [{
      location_code: location, language_code: languageCode, platform,
      targets: domains.map(d => ({ key: d, target: [{ domain: d }] })),
    }], opts);
  }

  /** LLM Mentions: monthly mentions + ai_search_volume for a domain (from 2025-08; the current month is partial). */
  async llmHistorical(domain: string, platform: 'google' | 'chat_gpt', location: number = 2840, languageCode = 'en', opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/ai_optimization/llm_mentions/historical/live', [{ location_code: location, language_code: languageCode, platform, target: [{ domain }] }], opts);
  }

  /** LLM Mentions: the domain's pages cited most. */
  async llmTopMentionedPages(domain: string, platform: 'google' | 'chat_gpt', location: number = 2840, languageCode = 'en', limit = 20, opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/ai_optimization/llm_mentions/top_mentioned_pages/live', [{ location_code: location, language_code: languageCode, platform, target: [{ domain }], limit }], opts);
  }

  /** LLM Mentions: domains cited in the same answers as the target ("top cited sources"). */
  async llmTopMentionedDomains(domain: string, platform: 'google' | 'chat_gpt', location: number = 2840, languageCode = 'en', limit = 20, opts: DfsCallOptions = {}): Promise<DfsResponse> {
    return this.call('/v3/ai_optimization/llm_mentions/top_mentioned_domains/live', [{ location_code: location, language_code: languageCode, platform, target: [{ domain }], limit }], opts);
  }

  async pageIntersection(
    competitorUrls: string[],
    excludeUrls: string[],
    location?: string | number,
    languageCode = 'en',
    limit = 100,
  ): Promise<DfsResponse> {
    const pages: Record<string, string> = {};
    competitorUrls.slice(0, 20).forEach((u, i) => { pages[String(i + 1)] = u; });
    return this.call('/v3/dataforseo_labs/google/page_intersection/live', [
      {
        pages,
        exclude_pages: excludeUrls.slice(0, 10),
        intersection_mode: 'union',
        ...this.loc(location),
        language_code: languageCode,
        limit: Math.min(limit, 1000),
      },
    ]);
  }

  cacheStats(): { rows: number; totalCost: number } {
    const r = this.cache.prepare('SELECT COUNT(*) rows, COALESCE(SUM(cost),0) totalCost FROM dataforseo_cache').get() as {
      rows: number;
      totalCost: number;
    };
    return r;
  }

  close(): void {
    this.cache.close();
  }
}
