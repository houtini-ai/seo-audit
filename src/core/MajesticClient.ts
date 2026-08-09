import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Majestic API client — the optional Trust Flow / Topical Trust Flow enrichment tier.
 *
 * Majestic is an OLD API (XML-native, JSON bolted on). Auth is the `app_api_key` query param.
 * We use ONE command: GetIndexItemInfo — batch up to 100 domains/URLs → TrustFlow, CitationFlow,
 * Topical Trust Flow, RefDomains each, in a single call. Shape confirmed live against the dev
 * sandbox (scripts/probe-majestic.mjs): message-level fields are FLAT at the top (no GlobalVars
 * wrapper); DataTables.Results.Data is an array of KEYED OBJECTS (fields named, not positional);
 * DataTables.Results.Headers is topic-cap metadata, NOT column names.
 *
 * Cost control mirrors DataForSeoClient:
 *  - SINGULAR WORKER: live requests serialised (Majestic decrements resource units per item).
 *  - CACHE (default 20 days): per (item, datasource); a hit costs nothing and skips the worker.
 *
 * Host: LIVE is api.majestic.com (real, current index, consumes units). The dev sandbox
 * developer.majestic.com is a frozen 2015 Historic subset (schema-only) — override via
 * MAJESTIC_API_HOST for testing. datasource: 'fresh' | 'historic' (Majestic default historic).
 */

export interface TopicalTrustFlow {
  topic: string;
  value: number;
}

export interface MajesticMetrics {
  item: string;
  datasource: string;
  itemType: number | null;        // 1 = root domain, 2 = subdomain, 3 = URL
  status: string;                 // Found | MayExist | NotFound
  trustFlow: number | null;       // 0-100 — the authority signal
  citationFlow: number | null;    // 0-100 — link volume
  trustMetric: number | null;
  refDomains: number | null;
  extBackLinks: number | null;
  indexedURLs: number | null;
  acRank: number | null;
  refIPs: number | null;
  refSubNets: number | null;
  title: string | null;
  languageDesc: string | null;
  topicalTrustFlow: TopicalTrustFlow[]; // sorted desc by value — the directory-killer signal
  indexBuildDate: string | null;
  uniqueIndexId: string | null;
  cached: boolean;
}

const DEFAULT_HOST = 'https://api.majestic.com';
const num = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const str = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
};

export class MajesticClient {
  private readonly key: string;
  private readonly host: string;
  private readonly ttlMs: number;
  private readonly cache: Database.Database;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(apiKey: string, cacheDbPath: string, ttlDays = 20, host = process.env.MAJESTIC_API_HOST || DEFAULT_HOST) {
    this.key = apiKey;
    this.host = host.replace(/\/+$/, '');
    this.ttlMs = ttlDays * 86400000;
    mkdirSync(dirname(cacheDbPath), { recursive: true });
    this.cache = new Database(cacheDbPath);
    this.cache.pragma('journal_mode = WAL');
    this.cache.exec(`
      CREATE TABLE IF NOT EXISTS majestic_metrics (
        item TEXT NOT NULL,
        datasource TEXT NOT NULL,
        item_type INTEGER,
        status TEXT,
        trust_flow INTEGER,
        citation_flow INTEGER,
        trust_metric INTEGER,
        ref_domains INTEGER,
        ext_backlinks INTEGER,
        indexed_urls INTEGER,
        ac_rank INTEGER,
        ref_ips INTEGER,
        ref_subnets INTEGER,
        title TEXT,
        language_desc TEXT,
        topical_trust_flow TEXT,        -- JSON [{topic, value}] sorted desc
        index_build_date TEXT,
        unique_index_id TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (item, datasource)
      );
    `);
  }

  /** Serialise live work — only one request in flight (Majestic bills units per item). */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private rowToMetrics(row: any, datasource: string, cached: boolean): MajesticMetrics {
    return {
      item: String(row.item),
      datasource,
      itemType: row.item_type ?? null,
      status: row.status ?? 'Unknown',
      trustFlow: row.trust_flow ?? null,
      citationFlow: row.citation_flow ?? null,
      trustMetric: row.trust_metric ?? null,
      refDomains: row.ref_domains ?? null,
      extBackLinks: row.ext_backlinks ?? null,
      indexedURLs: row.indexed_urls ?? null,
      acRank: row.ac_rank ?? null,
      refIPs: row.ref_ips ?? null,
      refSubNets: row.ref_subnets ?? null,
      title: row.title ?? null,
      languageDesc: row.language_desc ?? null,
      topicalTrustFlow: row.topical_trust_flow ? JSON.parse(row.topical_trust_flow) : [],
      indexBuildDate: row.index_build_date ?? null,
      uniqueIndexId: row.unique_index_id ?? null,
      cached,
    };
  }

  private getCached(item: string, datasource: string): MajesticMetrics | null {
    const row = this.cache
      .prepare('SELECT * FROM majestic_metrics WHERE item = ? AND datasource = ?')
      .get(item, datasource) as any;
    if (row && Date.now() - Date.parse(row.fetched_at) < this.ttlMs) return this.rowToMetrics(row, datasource, true);
    return null;
  }

  /** Pull TopicalTrustFlow_Topic_N / _Value_N flat pairs into a sorted {topic,value}[]. */
  private parseTopical(row: any): TopicalTrustFlow[] {
    const out: TopicalTrustFlow[] = [];
    for (let i = 0; row[`TopicalTrustFlow_Topic_${i}`] !== undefined; i++) {
      const topic = str(row[`TopicalTrustFlow_Topic_${i}`]);
      const value = num(row[`TopicalTrustFlow_Value_${i}`]);
      if (topic && value != null && value > 0) out.push({ topic, value });
    }
    return out.sort((a, b) => b.value - a.value);
  }

  /**
   * GetIndexItemInfo for a set of items (domains/URLs). Returns one MajesticMetrics per item,
   * in input order. Cache hits are served free; misses are batched (≤100/call) into one live
   * request. `desiredTopics` controls how many Topical Trust Flow topics come back (default 5).
   */
  async getIndexItemInfo(
    items: string[],
    opts: { datasource?: 'fresh' | 'historic'; desiredTopics?: number } = {},
  ): Promise<MajesticMetrics[]> {
    const datasource = opts.datasource ?? 'historic';
    const desiredTopics = opts.desiredTopics ?? 5;
    const uniq = [...new Set(items.map(i => i.trim()).filter(Boolean))];

    const byItem = new Map<string, MajesticMetrics>();
    const misses: string[] = [];
    for (const it of uniq) {
      const hit = this.getCached(it, datasource);
      if (hit) byItem.set(it, hit);
      else misses.push(it);
    }

    // Fetch misses in batches of 100 (Majestic's per-call item cap).
    for (let start = 0; start < misses.length; start += 100) {
      const batch = misses.slice(start, start + 100);
      const fetched = await this.serialize(() => this.fetchBatch(batch, datasource, desiredTopics));
      for (const m of fetched) byItem.set(m.item, m);
    }

    // Return in the caller's requested order (deduped items map back by trimmed key).
    return uniq.map(it => byItem.get(it)).filter((m): m is MajesticMetrics => m != null);
  }

  private async fetchBatch(items: string[], datasource: string, desiredTopics: number): Promise<MajesticMetrics[]> {
    const p = new URLSearchParams();
    p.set('app_api_key', this.key);
    p.set('cmd', 'GetIndexItemInfo');
    p.set('items', String(items.length));
    items.forEach((it, i) => p.set(`item${i}`, it));
    p.set('datasource', datasource);
    p.set('DesiredTopics', String(desiredTopics));

    const res = await fetch(`${this.host}/api/json?${p.toString()}`, { signal: AbortSignal.timeout(60000) });
    const json: any = await res.json();
    if (!res.ok) throw new Error(`Majestic HTTP ${res.status}`);
    // Message-level Code must be OK; anything else (e.g. auth/units) is surfaced loudly, not stored.
    if (json.Code && json.Code !== 'OK') {
      throw new Error(`Majestic ${json.Code}: ${json.ErrorMessage || json.FullError || 'request failed'}`.trim());
    }
    const indexBuildDate = str(json.IndexBuildDate);
    const uniqueIndexId = str(json.UniqueIndexID);
    const rows: any[] = json.DataTables?.Results?.Data ?? [];

    const upsert = this.cache.prepare(
      `INSERT INTO majestic_metrics
         (item, datasource, item_type, status, trust_flow, citation_flow, trust_metric,
          ref_domains, ext_backlinks, indexed_urls, ac_rank, ref_ips, ref_subnets,
          title, language_desc, topical_trust_flow, index_build_date, unique_index_id, fetched_at)
       VALUES (@item,@datasource,@item_type,@status,@trust_flow,@citation_flow,@trust_metric,
          @ref_domains,@ext_backlinks,@indexed_urls,@ac_rank,@ref_ips,@ref_subnets,
          @title,@language_desc,@topical_trust_flow,@index_build_date,@unique_index_id,datetime('now'))
       ON CONFLICT(item, datasource) DO UPDATE SET
         item_type=excluded.item_type, status=excluded.status, trust_flow=excluded.trust_flow,
         citation_flow=excluded.citation_flow, trust_metric=excluded.trust_metric,
         ref_domains=excluded.ref_domains, ext_backlinks=excluded.ext_backlinks,
         indexed_urls=excluded.indexed_urls, ac_rank=excluded.ac_rank, ref_ips=excluded.ref_ips,
         ref_subnets=excluded.ref_subnets, title=excluded.title, language_desc=excluded.language_desc,
         topical_trust_flow=excluded.topical_trust_flow, index_build_date=excluded.index_build_date,
         unique_index_id=excluded.unique_index_id, fetched_at=datetime('now')`,
    );

    const out: MajesticMetrics[] = [];
    const writeAll = this.cache.transaction((records: any[]) => { for (const r of records) upsert.run(r); });
    const records = rows.map(row => {
      const item = String(row.Item);
      const topical = this.parseTopical(row);
      const record = {
        item,
        datasource,
        item_type: num(row.ItemType),
        status: str(row.Status) ?? 'Unknown',
        trust_flow: num(row.TrustFlow),
        citation_flow: num(row.CitationFlow),
        trust_metric: num(row.TrustMetric),
        ref_domains: num(row.RefDomains),
        ext_backlinks: num(row.ExtBackLinks),
        indexed_urls: num(row.IndexedURLs),
        ac_rank: num(row.ACRank),
        ref_ips: num(row.RefIPs),
        ref_subnets: num(row.RefSubNets),
        title: str(row.Title),
        language_desc: str(row.LanguageDesc),
        topical_trust_flow: JSON.stringify(topical),
        index_build_date: indexBuildDate,
        unique_index_id: uniqueIndexId,
      };
      out.push({
        item, datasource,
        itemType: record.item_type, status: record.status,
        trustFlow: record.trust_flow, citationFlow: record.citation_flow, trustMetric: record.trust_metric,
        refDomains: record.ref_domains, extBackLinks: record.ext_backlinks, indexedURLs: record.indexed_urls,
        acRank: record.ac_rank, refIPs: record.ref_ips, refSubNets: record.ref_subnets,
        title: record.title, languageDesc: record.language_desc,
        topicalTrustFlow: topical, indexBuildDate, uniqueIndexId, cached: false,
      });
      return record;
    });
    writeAll(records);
    return out;
  }

  /** Confirm the key works + see remaining units, without spending an index query. */
  async subscriptionInfo(): Promise<Record<string, unknown>> {
    const p = new URLSearchParams();
    p.set('app_api_key', this.key);
    p.set('cmd', 'GetSubscriptionInfo');
    const res = await fetch(`${this.host}/api/json?${p.toString()}`, { signal: AbortSignal.timeout(30000) });
    const json: any = await res.json();
    if (json.Code && json.Code !== 'OK') {
      throw new Error(`Majestic ${json.Code}: ${json.ErrorMessage || json.FullError || 'GetSubscriptionInfo failed'}`.trim());
    }
    return json;
  }

  close(): void {
    this.cache.close();
  }
}
