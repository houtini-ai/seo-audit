/**
 * FTS5 full-text indexes (#35). Text lookups used to be LIKE '%term%' scans — a full scan of a
 * multi-million-row search_analytics for "queries containing X".
 *
 * - sa_queries + sa_query_fts: the DISTINCT query strings (far smaller than the fact table), joined
 *   back to search_analytics by exact query.
 * - pages_fts: url_key, title, h1 and the body text (from body_chunks), rowid = pages.id.
 * - links_fts: anchor_text, rowid = links.id.
 *
 * Kept in step inside the writing transaction, so a killed job can't leave FTS out of step with the
 * data (cf. #34): insert triggers on pages and links (the crawl wipe clears the FTS tables in its own
 * transaction, see CLEAR_CRAWL_FTS); for search_analytics, GscSync calls addQueries() with
 * each batch's distinct queries in the batch transaction (a per-row trigger cost ~50% more insert time). Databases created before this
 * get a one-time backfill on first use (ensureFtsBackfilled), never at open, so opening a 5 GB
 * property DB doesn't stall a tool call.
 */
import type Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';

const TOKENIZE = `tokenize='unicode61 remove_diacritics 2'`;
// Body text for pages_fts: headings + text of every chunk, from the body_chunks JSON column.
const BODY_SQL = (alias: string) => `(SELECT group_concat(COALESCE(json_extract(value,'$.heading'),'') || ' ' || COALESCE(json_extract(value,'$.text'),''), ' ') FROM json_each(CASE WHEN json_valid(${alias}.body_chunks) THEN ${alias}.body_chunks ELSE '[]' END))`;

export function ensureFtsSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fts_meta (name TEXT PRIMARY KEY, built_at TEXT);`);
  // sa_query_fts is an external-content index that resolves `query` through the content table's
  // rowid. The first schema gave sa_queries a TEXT primary key, so its rowid was implicit — and
  // VACUUM may renumber implicit rowids, after which `match` silently returned the wrong queries.
  // An explicit INTEGER PRIMARY KEY is VACUUM-stable. Migrate old DBs by dropping the (distinct-
  // query, cheap to rebuild) index; it re-backfills on next use.
  const saCols = db.prepare(`PRAGMA table_info(sa_queries)`).all() as { name: string }[];
  if (saCols.length && !saCols.some(c => c.name === 'id')) {
    db.exec(`
      DROP TRIGGER IF EXISTS sa_queries_ai;
      DROP TRIGGER IF EXISTS sa_queries_ad;
      DROP TABLE IF EXISTS sa_query_fts;
      DROP TABLE IF EXISTS sa_queries;
      DELETE FROM fts_meta WHERE name = 'sa_query_fts';
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sa_queries (id INTEGER PRIMARY KEY, query TEXT NOT NULL UNIQUE);
    CREATE VIRTUAL TABLE IF NOT EXISTS sa_query_fts USING fts5(query, content='sa_queries', content_rowid='id', ${TOKENIZE});
    CREATE TRIGGER IF NOT EXISTS sa_queries_ai AFTER INSERT ON sa_queries BEGIN
      INSERT INTO sa_query_fts(rowid, query) VALUES (new.id, new.query);
    END;
    CREATE TRIGGER IF NOT EXISTS sa_queries_ad AFTER DELETE ON sa_queries BEGIN
      INSERT INTO sa_query_fts(sa_query_fts, rowid, query) VALUES ('delete', old.id, old.query);
    END;
    -- No per-row trigger on search_analytics: it added ~50% to sync insert time. GscSync adds each
    -- batch's DISTINCT queries inside the batch's own transaction instead (addQueries).
    DROP TRIGGER IF EXISTS search_analytics_fts_ai;

    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(url_key UNINDEXED, title, h1, body, ${TOKENIZE});
    CREATE TRIGGER IF NOT EXISTS pages_fts_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, url_key, title, h1, body) VALUES (new.id, new.url_key, new.title, new.h1, ${BODY_SQL('new')});
    END;
    -- No AFTER DELETE triggers: per-row FTS deletes turned the crawl's bulk wipe of pages/links into
    -- millions of trigger runs and disabled SQLite's truncate optimisation. The only deleter (the
    -- crawl wipe) clears pages_fts/links_fts in the same transaction instead (clearCrawlFts).
    DROP TRIGGER IF EXISTS pages_fts_ad;
    DROP TRIGGER IF EXISTS links_fts_ad;

    CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(anchor_text, ${TOKENIZE});
    CREATE TRIGGER IF NOT EXISTS links_fts_ai AFTER INSERT ON links WHEN new.anchor_text IS NOT NULL AND new.anchor_text <> '' BEGIN
      INSERT INTO links_fts(rowid, anchor_text) VALUES (new.id, new.anchor_text);
    END;
  `);
}

/** Add query strings to the distinct-query index. Call inside the transaction that wrote them. */
export function addQueries(db: Database.Database, queries: Iterable<string>): void {
  const ins = db.prepare(`INSERT OR IGNORE INTO sa_queries(query) VALUES (?)`);
  for (const q of queries) ins.run(q);
}

const BASE_TABLE: Record<FtsIndex, string> = { sa_query_fts: 'search_analytics', pages_fts: 'pages', links_fts: 'links' };
/** Below this many base-table rows a backfill is near-instant and runs inline; above, in a worker job. */
export const INLINE_BACKFILL_MAX_ROWS = 200_000;

/** FTS indexes a query needs that aren't backfilled yet, with a cheap size estimate (max rowid). */
export function pendingBackfills(db: Database.Database, indexes: Iterable<FtsIndex>): { index: FtsIndex; rows: number }[] {
  const out: { index: FtsIndex; rows: number }[] = [];
  for (const index of new Set(indexes)) {
    let built = false;
    try { built = !!db.prepare(`SELECT 1 FROM fts_meta WHERE name = ?`).get(index); } catch { /* pre-FTS DB: no fts_meta yet */ }
    if (built) continue;
    let rows = 0;
    try { rows = (db.prepare(`SELECT COALESCE(MAX(rowid), 0) n FROM ${BASE_TABLE[index]}`).get() as { n: number }).n; } catch { /* table absent */ }
    out.push({ index, rows });
  }
  return out;
}

/** Run the backfill for these indexes in a worker thread (large DBs). */
export function backfillInWorker(dbFile: string, indexes: FtsIndex[], signal?: AbortSignal): Promise<{ indexes: FtsIndex[] }> {
  if (signal?.aborted) return Promise.reject(new Error('cancelled'));
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./ftsWorker.js', import.meta.url), { workerData: { dbFile, indexes } });
    // Cancelling the job terminates the worker; its open transaction rolls back and releases the
    // write lock, so a crawl or sync started afterwards isn't left waiting on a ghost.
    const onAbort = (): void => { void w.terminate(); reject(new Error('cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (): void => signal?.removeEventListener('abort', onAbort);
    w.once('message', (m: any) => { done(); m.ok ? resolve({ indexes: m.indexes }) : reject(new Error(m.error)); });
    w.once('error', e => { done(); reject(e); });
    w.once('exit', code => { done(); if (code !== 0 && !signal?.aborted) reject(new Error(`FTS worker exited with code ${code}`)); });
  });
}

/** SQL clearing the crawl FTS indexes; run in the same transaction as the pages/links wipe. */
export const CLEAR_CRAWL_FTS = 'DELETE FROM pages_fts; DELETE FROM links_fts;';

export type FtsIndex = 'sa_query_fts' | 'pages_fts' | 'links_fts';

/** One-time backfill of rows written before the triggers existed. Idempotent; recorded in fts_meta. */
export function ensureFtsBackfilled(db: Database.Database, which: FtsIndex): void {
  if (db.prepare(`SELECT 1 FROM fts_meta WHERE name = ?`).get(which)) return;
  db.transaction(() => {
    if (which === 'sa_query_fts') {
      db.exec(`INSERT OR IGNORE INTO sa_queries(query) SELECT DISTINCT query FROM search_analytics WHERE query IS NOT NULL`);
    } else if (which === 'pages_fts') {
      db.exec(`INSERT INTO pages_fts(rowid, url_key, title, h1, body)
        SELECT p.id, p.url_key, p.title, p.h1, ${BODY_SQL('p')} FROM pages p WHERE p.id NOT IN (SELECT rowid FROM pages_fts)`);
    } else {
      db.exec(`INSERT INTO links_fts(rowid, anchor_text)
        SELECT l.id, l.anchor_text FROM links l WHERE l.anchor_text IS NOT NULL AND l.anchor_text <> '' AND l.id NOT IN (SELECT rowid FROM links_fts)`);
    }
    db.prepare(`INSERT OR REPLACE INTO fts_meta(name, built_at) VALUES (?, datetime('now'))`).run(which);
  })();
}

/**
 * The SQL predicate (on the base table) for a query_data `match` filter, routed to the right FTS
 * index. Throws for columns without an index. `value` is FTS5 query syntax: words, "phrases",
 * prefix*, AND/OR/NOT, NEAR(a b, 5).
 */
/** Which FTS index serves table.column, or null. Pure: no database access. */
export function ftsIndexFor(table: string, column: string): FtsIndex | null {
  if (table === 'search_analytics' && column === 'query') return 'sa_query_fts';
  if (table === 'pages' && ['title', 'h1', 'body_chunks'].includes(column)) return 'pages_fts';
  if (table === 'links' && column === 'anchor_text') return 'links_fts';
  return null;
}

/** Pure: the predicate SQL for a match filter. The caller backfills first (needs a writable handle). */
export function matchPredicate(table: string, column: string): { sql: string; wrap: (v: string) => string } {
  if (table === 'search_analytics' && column === 'query') {
    return { sql: `query IN (SELECT query FROM sa_query_fts WHERE sa_query_fts MATCH ?)`, wrap: v => v };
  }
  if (table === 'pages' && ['title', 'h1', 'body_chunks'].includes(column)) {
    const ftsCol = column === 'body_chunks' ? 'body' : column;
    return { sql: `id IN (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?)`, wrap: v => `${ftsCol} : (${v})` };
  }
  if (table === 'links' && column === 'anchor_text') {
    return { sql: `id IN (SELECT rowid FROM links_fts WHERE links_fts MATCH ?)`, wrap: v => v };
  }
  throw new Error(`op "match" (full-text) works on search_analytics.query, pages.title / pages.h1 / pages.body_chunks, and links.anchor_text. Use "like" for ${table}.${column}.`);
}
