import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Supadata client for transcribing the ranking VIDEOS in content recon (YouTube, TikTok, X…).
 * Firecrawl can't read video; this is the video leg. Owned pages → our crawler, competitor
 * articles → Firecrawl, Reddit → its .json, videos → here.
 *
 * API (not the MCP): GET /v1/transcript?url=&text=true with an x-api-key header. Returns the
 * transcript immediately (200 { content, lang }) or a jobId (202) for long videos — we poll.
 */
export interface TranscriptResult { url: string; content: string; lang: string | null; cached: boolean }

const BASE_URL = 'https://api.supadata.ai/v1';

export class SupadataClient {
  private readonly apiKey: string;
  private readonly ttlMs: number;
  private readonly cache: Database.Database;

  constructor(apiKey: string, cacheDbPath: string, ttlDays = 14) {
    this.apiKey = apiKey;
    this.ttlMs = ttlDays * 86400000;
    mkdirSync(dirname(cacheDbPath), { recursive: true });
    this.cache = new Database(cacheDbPath);
    this.cache.pragma('journal_mode = WAL');
    this.cache.exec(`
      CREATE TABLE IF NOT EXISTS supadata_cache (
        cache_key TEXT PRIMARY KEY, url TEXT NOT NULL, content TEXT, lang TEXT, fetched_at TEXT NOT NULL
      );`);
  }

  async transcript(url: string, opts: { maxChars?: number; lang?: string } = {}): Promise<TranscriptResult> {
    const key = createHash('sha256').update('transcript\n' + url).digest('hex');
    const row = this.cache.prepare('SELECT content, lang, fetched_at FROM supadata_cache WHERE cache_key=?')
      .get(key) as { content: string; lang: string | null; fetched_at: string } | undefined;
    if (row && Date.now() - Date.parse(row.fetched_at) < this.ttlMs) {
      return { url, content: opts.maxChars ? (row.content ?? '').slice(0, opts.maxChars) : (row.content ?? ''), lang: row.lang, cached: true };
    }

    const q = new URLSearchParams({ url, text: 'true', mode: 'auto', ...(opts.lang ? { lang: opts.lang } : {}) });
    const res = await fetch(`${BASE_URL}/transcript?${q}`, { headers: { 'x-api-key': this.apiKey }, signal: AbortSignal.timeout(45000) });
    let json: any = await res.json();
    if (!res.ok) throw new Error(`Supadata transcript failed for ${url}: ${res.status} ${json?.message ?? json?.error ?? ''}`.trim());

    // Async (202): poll the job until it completes (bounded).
    if (json?.jobId) {
      json = await this.pollJob(json.jobId);
    }
    const content: string = Array.isArray(json?.content) ? json.content.map((c: any) => c.text ?? '').join(' ') : (json?.content ?? '');
    const lang: string | null = json?.lang ?? null;
    this.cache.prepare(`INSERT INTO supadata_cache (cache_key, url, content, lang, fetched_at) VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(cache_key) DO UPDATE SET content=excluded.content, lang=excluded.lang, fetched_at=datetime('now')`).run(key, url, content, lang);
    return { url, content: opts.maxChars ? content.slice(0, opts.maxChars) : content, lang, cached: false };
  }

  private async pollJob(jobId: string, tries = 8, delayMs = 2500): Promise<any> {
    for (let i = 0; i < tries; i++) {
      await new Promise(r => setTimeout(r, delayMs));
      const res = await fetch(`${BASE_URL}/transcript/${jobId}`, { headers: { 'x-api-key': this.apiKey }, signal: AbortSignal.timeout(30000) });
      const j: any = await res.json();
      const status = j?.status;
      if (status === 'completed' || j?.content) return j;
      if (status === 'failed' || status === 'error') throw new Error(`Supadata job ${jobId} ${status}: ${j?.error ?? ''}`.trim());
    }
    throw new Error(`Supadata job ${jobId} did not complete in time`);
  }
}
