// Regression test for FTS5 indexes + query_data match (#35): trigger maintenance inside the
// write transaction, one-time backfill for pre-existing DBs, and match routing.
// Run: node scripts/probe-fts.mjs (after build:server)
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { runQueryData } from '../dist/core/queryData.js';
import { GscSync } from '../dist/core/GscSync.js';
import { dbPathFor } from '../dist/core/paths.js';
import { mkdtempSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const dir = mkdtempSync(path.join(tmpdir(), 'sac-fts-'));
const site = 'https://e.com/';
const dbPath = dbPathFor(dir, site);

// A "pre-FTS" database: rows written with the triggers absent, as in a DB from an older version.
{
  const w = new AuditDatabase(dbPath);
  w.db.exec(`DROP TRIGGER pages_fts_ai; DROP TRIGGER links_fts_ai;`);
  w.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES ('2026-10-01','pimax crystal light review','u','u','','',5,50,0.1,3)`).run();
  w.db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1','https://e.com','e.com','completed')`).run();
  w.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,title,h1,body_chunks) VALUES ('c1','https://e.com/old','https://e.com/old',200,'Old page','Old',?)`).run(JSON.stringify([{ heading: 'Intro', level: 2, text: 'legacy wheelbase notes' }]));
  w.close();
}

const w = new AuditDatabase(dbPath); // re-open: schema recreates the triggers
const db = w.db;
const q = (input) => runQueryData(dbPath, input).structured;
// New GSC rows arrive through GscSync, which indexes each batch's distinct queries in-transaction.
const row = (date, query, page, clicks) => ({ keys: [date, query, page], clicks, impressions: clicks * 10, ctr: 0.1, position: 3 });
await new GscSync({ fetchSearchAnalytics: async (_s, _o, _sig, onBatch) => onBatch({ rows: [row('2026-10-02', 'best direct drive wheelbase', `${site}u2`, 9), row('2026-10-03', 'best direct drive wheelbase', `${site}u3`, 1)] }) }, dir)
  .run(site, { startDate: '2026-10-02', endDate: '2026-10-16', fullResync: true }, () => {}, new AbortController().signal);
// New crawl writes after the triggers exist.
db.transaction(() => {
  db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,title,h1,body_chunks) VALUES ('c1','https://e.com/w','https://e.com/w',200,'Direct drive wheels','Wheels',?)`).run(JSON.stringify([{ heading: 'Buying guide', level: 2, text: 'A crystal clear guide to torque and wheelbase choice' }]));
  db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,anchor_text,is_internal) VALUES ('c1','a','a','b','b','best racing wheel deals',1)`).run();
})();

check('GSC sync indexes new distinct queries in the batch transaction', db.prepare(`SELECT COUNT(*) n FROM sa_queries WHERE query='best direct drive wheelbase'`).get().n === 1, '');
check('pages_fts row written by trigger, with body text from body_chunks', db.prepare(`SELECT COUNT(*) n FROM pages_fts WHERE pages_fts MATCH 'body : torque'`).get().n === 1, '');
check('pre-existing rows are NOT indexed until first use (no stall at open)', db.prepare(`SELECT COUNT(*) n FROM sa_queries WHERE query LIKE 'pimax%'`).get().n === 0, '');

const sa = q({ table: 'search_analytics', mode: 'rows', filters: [{ column: 'query', op: 'match', value: 'pimax' }], columns: ['query', 'clicks'] });
check('match on search_analytics.query finds a pre-existing row (lazy backfill)', sa.rows?.length === 1 && sa.rows[0].query === 'pimax crystal light review', JSON.stringify(sa));
const agg = q({ table: 'search_analytics', groupBy: ['query'], metrics: [{ fn: 'sum', column: 'clicks' }], filters: [{ column: 'query', op: 'match', value: 'wheelbase NOT pimax' }] });
check('match composes with aggregate mode and FTS boolean syntax', JSON.stringify(agg).includes('best direct drive wheelbase') && !JSON.stringify(agg).includes('pimax'), JSON.stringify(agg).slice(0, 300));

const pg = q({ table: 'pages', mode: 'rows', filters: [{ column: 'body_chunks', op: 'match', value: 'legacy OR torque' }], columns: ['url'] });
check('match on pages.body_chunks searches body text (old + new rows)', pg.rows?.length === 2, JSON.stringify(pg));
const tt = q({ table: 'pages', mode: 'rows', filters: [{ column: 'title', op: 'match', value: 'wheel*' }], columns: ['url'] });
check('match on pages.title is column-scoped (prefix query)', tt.rows?.length === 1 && tt.rows[0].url === 'https://e.com/w', JSON.stringify(tt));

const ln = q({ table: 'links', mode: 'rows', filters: [{ column: 'anchor_text', op: 'match', value: '"racing wheel"' }], columns: ['anchor_text'] });
check('match on links.anchor_text (phrase)', ln.rows?.length === 1, JSON.stringify(ln));

let err = '';
try { q({ table: 'pages', filters: [{ column: 'url', op: 'match', value: 'x' }] }); } catch (e) { err = e.message; }
check('match on an unindexed column explains where it works', err.includes('works on search_analytics.query'), err);

// The crawl wipe clears FTS in the same transaction (no per-row delete triggers).
const { CLEAR_CRAWL_FTS } = await import('../dist/core/fts.js');
check('no per-row AFTER DELETE triggers on pages/links', db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('pages_fts_ad','links_fts_ad')`).get().n === 0, '');
db.transaction(() => db.exec(`DELETE FROM pages; DELETE FROM links; ${CLEAR_CRAWL_FTS}`))();
check('the crawl wipe statement clears their FTS rows', db.prepare('SELECT COUNT(*) n FROM pages_fts').get().n === 0 && db.prepare('SELECT COUNT(*) n FROM links_fts').get().n === 0, '');
// Rolled-back write leaves FTS untouched (same transaction).
try { db.transaction(() => { db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,title) VALUES ('c1','https://e.com/r','https://e.com/r',200,'rollback probe')`).run(); throw new Error('abort'); })(); } catch {}
check('a rolled-back write leaves no FTS row behind', db.prepare(`SELECT COUNT(*) n FROM pages_fts WHERE pages_fts MATCH 'rollback'`).get().n === 0, '');

w.close();

// Large-DB path: the backfill runs in a worker thread (query_data starts it as a job).
{
  const { pendingBackfills, backfillInWorker } = await import('../dist/core/fts.js');
  const site2 = 'https://big.example/';
  const p2 = dbPathFor(dir, site2);
  const w2 = new AuditDatabase(p2);
  w2.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES ('2026-10-01','worker built query','u','u','','',1,10,0.1,3)`).run();
  const before = pendingBackfills(w2.db, ['sa_query_fts']);
  w2.close();
  check('pendingBackfills reports an unbuilt index with a size estimate', before.length === 1 && before[0].rows >= 1, JSON.stringify(before));
  await backfillInWorker(p2, ['sa_query_fts']);
  const r = runQueryData(p2, { table: 'search_analytics', mode: 'rows', filters: [{ column: 'query', op: 'match', value: 'worker' }], columns: ['query'] }).structured;
  check('worker backfill makes the index usable', r.rows?.length === 1, JSON.stringify(r));
  const w3 = new AuditDatabase(p2); const after = pendingBackfills(w3.db, ['sa_query_fts']); w3.close();
  check('and records it as built', after.length === 0, JSON.stringify(after));
  const ac = new AbortController(); ac.abort();
  let cancelled = false;
  try { await backfillInWorker(p2, ['pages_fts'], ac.signal); } catch (e) { cancelled = /cancel/.test(e.message); }
  check('an aborted backfill job rejects as cancelled and releases the worker', cancelled, '');
}

// 0.15.0: sa_queries had a TEXT primary key, so its rowid was implicit, and VACUUM may renumber
// implicit rowids - after which the external-content sa_query_fts resolved `match` to the WRONG
// query strings with no error. An explicit INTEGER PRIMARY KEY is VACUUM-stable.
{
  // Control: does this SQLite actually renumber an implicit rowid on VACUUM? If not, the next
  // check can't tell broken from fixed, and we say so instead of passing silently.
  const cp = path.join(dir, 'control.db');
  const c = new Database(cp);
  c.exec(`CREATE TABLE t (q TEXT PRIMARY KEY)`);
  const ci = c.prepare(`INSERT INTO t (q) VALUES (?)`);
  c.transaction(() => { for (let i = 0; i < 50; i++) ci.run(`q${i}`); })();
  c.exec(`DELETE FROM t WHERE rowid <= 25`);
  const before = c.prepare(`SELECT rowid r FROM t WHERE q = 'q40'`).get().r;
  c.exec('VACUUM');
  const after = c.prepare(`SELECT rowid r FROM t WHERE q = 'q40'`).get().r;
  c.close();
  const renumbers = before !== after;
  console.log(`  ..  control: VACUUM ${renumbers ? 'renumbers' : 'did NOT renumber'} an implicit rowid here (${before} -> ${after})`);

  const p3 = dbPathFor(dir, 'https://vac.com/');
  const a = new AuditDatabase(p3);
  const ins = a.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES ('2026-10-01',?,'u','u','','',1,10,0.1,5)`);
  const qs = Array.from({ length: 50 }, (_, i) => `vacq${i}token wheel`);
  a.db.transaction(() => { for (const q of qs) ins.run(q); })();
  a.close();
  runQueryData(p3, { table: 'search_analytics', mode: 'rows', filters: [{ column: 'query', op: 'match', value: 'vacq1token' }], columns: ['query'] }); // builds the index inline
  const b = new AuditDatabase(p3);
  b.db.prepare(`DELETE FROM sa_queries WHERE query IN (${qs.slice(0, 25).map(() => '?').join(',')})`).run(...qs.slice(0, 25));
  b.db.exec('VACUUM');
  b.close();
  const r = runQueryData(p3, { table: 'search_analytics', mode: 'rows', filters: [{ column: 'query', op: 'match', value: 'vacq40token' }], columns: ['query'] }).structured;
  check(`match resolves the right query after VACUUM${renumbers ? '' : ' (control did not renumber: weak check here)'}`, r.rows?.length === 1 && r.rows[0].query === 'vacq40token wheel', JSON.stringify(r.rows));

  // Migration: a DB carrying the OLD schema is moved to the stable one, and re-backfills on use.
  const p4 = path.join(dir, 'oldschema.db');
  const o = new Database(p4);
  o.exec(`CREATE TABLE fts_meta (name TEXT PRIMARY KEY, built_at TEXT);
    CREATE TABLE sa_queries (query TEXT PRIMARY KEY);
    CREATE VIRTUAL TABLE sa_query_fts USING fts5(query, content='sa_queries', content_rowid='rowid');
    INSERT INTO sa_queries (query) VALUES ('legacy query');
    INSERT INTO fts_meta (name, built_at) VALUES ('sa_query_fts', datetime('now'));`);
  o.close();
  const m = new AuditDatabase(p4);
  const cols = m.db.prepare(`PRAGMA table_info(sa_queries)`).all().map(x => x.name);
  const meta = m.db.prepare(`SELECT 1 FROM fts_meta WHERE name='sa_query_fts'`).get();
  m.close();
  check('an old-schema sa_queries is migrated to an explicit INTEGER PRIMARY KEY', cols.includes('id') && cols.includes('query'), JSON.stringify(cols));
  check('and its index is marked unbuilt, so it re-backfills on next use', !meta, JSON.stringify(meta));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
