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
    return createHash('sha256').update(endpoint + '\n' + JSON.stringify(body)).digest('hex');
  }

  /** POST to a DataForSEO endpoint, served from the 20-day cache when fresh. */
  async call(endpoint: string, body: unknown[]): Promise<DfsResponse> {
    const key = this.keyFor(endpoint, body);
    const row = this.cache
      .prepare('SELECT response_json, cost, fetched_at FROM dataforseo_cache WHERE cache_key = ?')
      .get(key) as { response_json: string; cost: number; fetched_at: string } | undefined;
    if (row && Date.now() - Date.parse(row.fetched_at) < this.ttlMs) {
      return { tasks: JSON.parse(row.response_json), cached: true, cost: 0 };
    }

    return this.serialize(async () => {
      const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: this.auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const json: any = await res.json();
      if (!res.ok || json?.status_code >= 40000) {
        throw new Error(`DataForSEO ${endpoint} failed: ${res.status} ${json?.status_message ?? ''}`.trim());
      }
      const tasks = json.tasks ?? [];
      const cost = Number(json.cost) || 0;
      this.cache
        .prepare(
          `INSERT INTO dataforseo_cache (cache_key, endpoint, request_json, response_json, cost, fetched_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(cache_key) DO UPDATE SET response_json=excluded.response_json,
             cost=excluded.cost, fetched_at=datetime('now')`,
        )
        .run(key, endpoint, JSON.stringify(body), JSON.stringify(tasks), cost);
      return { tasks, cached: false, cost };
    });
  }

  // ── Typed helpers (within our enabled scopes) ─────────────────────────────

  /** KEYWORDS_DATA — true monthly search volume + CPC + competition (cheap). */
  async searchVolume(keywords: string[], locationCode = 2840, languageCode = 'en'): Promise<DfsResponse> {
    return this.call('/v3/keywords_data/google_ads/search_volume/live', [
      { keywords, location_code: locationCode, language_code: languageCode },
    ]);
  }

  /** SERP — live Google organic results (per-request cost; use sparingly). */
  async serpOrganic(keyword: string, locationCode = 2840, languageCode = 'en', depth = 20): Promise<DfsResponse> {
    return this.call('/v3/serp/google/organic/live/advanced', [
      { keyword, location_code: locationCode, language_code: languageCode, depth },
    ]);
  }

  /**
   * Related terms for a keyword — People Also Ask questions + related searches,
   * parsed from the SERP advanced response. Powers the click-through "related
   * terms" on the keyword charts. Cached 20 days via the underlying SERP call.
   */
  async relatedTerms(
    keyword: string,
    locationCode = 2840,
    languageCode = 'en',
  ): Promise<{ peopleAlsoAsk: string[]; relatedSearches: string[]; cached: boolean; cost: number }> {
    const r = await this.serpOrganic(keyword, locationCode, languageCode, 30);
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
