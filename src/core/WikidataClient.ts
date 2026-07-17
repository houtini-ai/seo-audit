import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Minimal Wikidata client over the PUBLIC API (no auth) — entity search + claims — with a
 * long SQLite cache (entities are stable). Used by the 6d entity layer. Wikidata asks for a
 * descriptive User-Agent.
 */
const UA = 'seo-audit-console/0.1 (https://github.com/houtini-ai/seo-audit-console)';
const API = 'https://www.wikidata.org/w/api.php';

export class WikidataClient {
  private readonly cache: Database.Database;
  private readonly ttlMs: number;

  constructor(cacheDbPath: string, ttlDays = 45) {
    this.ttlMs = ttlDays * 86400000;
    mkdirSync(dirname(cacheDbPath), { recursive: true });
    this.cache = new Database(cacheDbPath);
    this.cache.pragma('journal_mode = WAL');
    this.cache.exec(`CREATE TABLE IF NOT EXISTS wd_cache (url TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at TEXT NOT NULL)`);
  }

  private async getJson(url: string): Promise<any> {
    const row = this.cache.prepare('SELECT body, fetched_at FROM wd_cache WHERE url = ?').get(url) as { body: string; fetched_at: string } | undefined;
    if (row && Date.now() - Date.parse(row.fetched_at) < this.ttlMs) return JSON.parse(row.body);
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Wikidata ${res.status} for ${url}`);
    const json = await res.json();
    this.cache.prepare(`INSERT INTO wd_cache (url, body, fetched_at) VALUES (?,?,datetime('now'))
      ON CONFLICT(url) DO UPDATE SET body=excluded.body, fetched_at=datetime('now')`).run(url, JSON.stringify(json));
    return json;
  }

  /** Best entity match for free text (e.g. an H1). Returns null if nothing matches. */
  async searchEntity(query: string, language = 'en'): Promise<{ id: string; label: string; description?: string } | null> {
    const q = query.trim();
    if (!q) return null;
    const url = `${API}?action=wbsearchentities&format=json&type=item&limit=1&language=${encodeURIComponent(language)}&uselang=${encodeURIComponent(language)}&search=${encodeURIComponent(q)}`;
    const j = await this.getJson(url);
    const hit = j?.search?.[0];
    return hit?.id ? { id: hit.id, label: hit.label ?? q, description: hit.description } : null;
  }

  /** Parent/whole entities of a QID: P279 (subclass of) + P361 (part of). */
  async relatedEntities(qid: string): Promise<{ related: string; relation: string }[]> {
    const out: { related: string; relation: string }[] = [];
    for (const [prop, relation] of [['P279', 'subclass_of'], ['P361', 'part_of']] as const) {
      const url = `${API}?action=wbgetclaims&format=json&entity=${qid}&property=${prop}`;
      const j = await this.getJson(url);
      for (const cl of j?.claims?.[prop] ?? []) {
        const id = cl?.mainsnak?.datavalue?.value?.id;
        if (id) out.push({ related: id, relation });
      }
    }
    return out;
  }

  close(): void { this.cache.close(); }
}
