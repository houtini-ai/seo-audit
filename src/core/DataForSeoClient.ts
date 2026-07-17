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
 *  - 20-DAY CACHE: every response is written to a shared SQLite cache keyed on
 *    (endpoint + body); a cache hit costs nothing and skips the worker entirely.
 *    SERP/keyword/domain data is stable enough that a ~20-day TTL is safe.
 */
export interface DfsResponse {
  tasks: any[];
  cached: boolean;
  cost: number;
}

const BASE_URL = 'https://api.dataforseo.com';

export class DataForSeoClient {
  private readonly auth: string;
  private readonly ttlMs: number;
  private readonly cache: Database.Database;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(login: string, password: string, cacheDbPath: string, ttlDays = 20) {
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

  /** POST to a DataForSEO endpoint, served from the 20-day cache when fresh. */
  async call(endpoint: string, body: unknown[], timeoutMs = 60000): Promise<DfsResponse> {
    const key = this.keyFor(endpoint, body);
    const row = this.cache
      .prepare('SELECT response_json, cost, fetched_at FROM dataforseo_cache WHERE cache_key = ?')
      .get(key) as { response_json: string; cost: number; fetched_at: string } | undefined;
    if (row && Date.now() - Date.parse(row.fetched_at) < this.ttlMs) {
      return { tasks: JSON.parse(row.response_json), cached: true, cost: 0 };
    }

    return this.serialize(async () => {
      // Re-check the cache now that we hold the single-worker slot: a concurrent identical
      // call may have just paid for and cached this exact request — don't double-spend.
      const again = this.cache
        .prepare('SELECT response_json, fetched_at FROM dataforseo_cache WHERE cache_key = ?')
        .get(key) as { response_json: string; fetched_at: string } | undefined;
      if (again && Date.now() - Date.parse(again.fetched_at) < this.ttlMs) {
        return { tasks: JSON.parse(again.response_json), cached: true, cost: 0 };
      }
      const res = await fetch(`${BASE_URL}${endpoint}`, {
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
      const cost = Number(json.cost) || 0;
      // Only cache genuinely successful responses — a task-level failure (40xxx) or
      // all-null results must not be cached for 20 days; let a later call retry.
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

  /** SERP — live Google organic results (per-request cost; use sparingly). */
  async serpOrganic(keyword: string, location?: string | number, languageCode = 'en', depth = 20): Promise<DfsResponse> {
    return this.call('/v3/serp/google/organic/live/advanced', [
      { keyword, ...this.loc(location), language_code: languageCode, depth },
    ]);
  }

  /**
   * Related terms for a keyword — People Also Ask questions + related searches,
   * parsed from the SERP advanced response. Powers the click-through "related
   * terms" on the keyword charts. Cached 20 days via the underlying SERP call.
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

  /** Labs — domain ranking distribution over time (monthly). The over-time sequence. */
  async historicalRankOverview(target: string, location?: string | number, languageCode = 'en'): Promise<DfsResponse> {
    return this.call('/v3/dataforseo_labs/google/historical_rank_overview/live', [
      { target, ...this.loc(location), language_code: languageCode },
    ]);
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
