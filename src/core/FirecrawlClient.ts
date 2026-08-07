import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Firecrawl client for scraping THIRD-PARTY (competitor) pages during content recon.
 * Owned pages use our own crawler; competitor pages use Firecrawl.
 *
 * NB the API vs MCP divergence: the raw v2 API nests the result under `.data`
 * ({ success, data: { markdown, metadata } }) whereas the Firecrawl MCP flattens it.
 * We code against the API and read `json.data`.
 *
 * A small SQLite cache (default 7 days) avoids re-scraping the same competitor URL
 * across a batch or a re-run — competitor pages don't change minute to minute, and it
 * keeps recon cheap and polite.
 */
export interface ScrapeResult {
  url: string;
  markdown: string;
  title: string | null;
  cached: boolean;
}

const BASE_URL = 'https://api.firecrawl.dev';

export class FirecrawlClient {
  private readonly apiKey: string;
  private readonly ttlMs: number;
  private readonly cache: Database.Database;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(apiKey: string, cacheDbPath: string, ttlDays = 7) {
    this.apiKey = apiKey;
    this.ttlMs = ttlDays * 86400000;
    mkdirSync(dirname(cacheDbPath), { recursive: true });
    this.cache = new Database(cacheDbPath);
    this.cache.pragma('journal_mode = WAL');
    this.cache.exec(`
      CREATE TABLE IF NOT EXISTS firecrawl_cache (
        cache_key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        markdown TEXT,
        title TEXT,
        fetched_at TEXT NOT NULL
      );
    `);
  }

  /** Serialise live scrapes — polite, and keeps us within rate limits. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Scrape one URL to clean markdown (main content only). Cached for the TTL. */
  async scrape(url: string, opts: { maxChars?: number; timeoutMs?: number } = {}): Promise<ScrapeResult> {
    const key = createHash('sha256').update('scrape\n' + url).digest('hex');
    const row = this.cache
      .prepare('SELECT url, markdown, title, fetched_at FROM firecrawl_cache WHERE cache_key = ?')
      .get(key) as { url: string; markdown: string; title: string | null; fetched_at: string } | undefined;
    if (row && Date.now() - Date.parse(row.fetched_at) < this.ttlMs) {
      const md = opts.maxChars ? (row.markdown ?? '').slice(0, opts.maxChars) : (row.markdown ?? '');
      return { url, markdown: md, title: row.title, cached: true };
    }

    return this.serialize(async () => {
      const res = await fetch(`${BASE_URL}/v2/scrape`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 45000),
      });
      const json: any = await res.json();
      if (!res.ok || json?.success === false) {
        throw new Error(`Firecrawl scrape failed for ${url}: ${res.status} ${json?.error ?? ''}`.trim());
      }
      // API nests under .data (MCP flattens it — we read the API shape here).
      const data = json.data ?? json;
      const markdown: string = data.markdown ?? '';
      const title: string | null = data.metadata?.title ?? null;
      this.cache
        .prepare(
          `INSERT INTO firecrawl_cache (cache_key, url, markdown, title, fetched_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(cache_key) DO UPDATE SET markdown=excluded.markdown, title=excluded.title, fetched_at=datetime('now')`,
        )
        .run(key, url, markdown, title);
      const md = opts.maxChars ? markdown.slice(0, opts.maxChars) : markdown;
      return { url, markdown: md, title, cached: false };
    });
  }
}
