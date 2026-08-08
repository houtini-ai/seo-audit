/**
 * Regression probe for the change-detection + finding-join fixes (0.4.7).
 *
 * Covers two defects found in the 0.4.6 shakedown:
 *  1. `detect_changes` silently diffed OLD crawls while a newer completed crawl sat
 *     unsnapshotted (snapshotCrawl used to run only inside runAudit). The crawler now
 *     snapshots itself, and diffLatest reports `staleness` when a gap remains.
 *  2. Four page-level checks knew their URL but stored `url_key` NULL, so findings
 *     couldn't be joined to pages / filtered by URL in query_data.
 *
 * Runs against whatever property databases you already have locally (read-only) — no network,
 * no cost, and no property names baked into the repo.
 *   node scripts/probe-drift-fixes.mjs            # every database in the data dir
 *   node scripts/probe-drift-fixes.mjs example.com  # just one
 */
import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { diffLatest, buildDriftMarkdown } from '../dist/audit/drift.js';

const DIR = process.env.SAC_DATA_DIR ?? join(homedir(), 'Documents', 'seo-audit-console');
const args = process.argv.slice(2);
const PROPS = args.length
  ? args.map(a => a.replace(/\.db$/, ''))
  : readdirSync(DIR)
      .filter(f => f.endsWith('.db') && !f.includes('cache'))
      .map(f => f.replace(/\.db$/, ''));

if (!PROPS.length) {
  console.error(`No property databases found in ${DIR}. Run refresh_property on a property first.`);
  process.exit(1);
}

// Page-level checks that must carry a joinable url_key. Query-level checks
// (position-slipping, lost-queries, keyword-cannibalisation) legitimately stay NULL.
const MUST_HAVE_URL_KEY = ['traffic-decay', 'rising-pages', 'impressions-rising-clicks-flat', 'stale-content'];
const MUST_BE_NULL = ['position-slipping', 'lost-queries', 'keyword-cannibalisation'];

let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? (pass++, console.log('  ✓', msg)) : (fail++, console.log('  ✗ FAIL:', msg)); };

for (const p of PROPS) {
  const path = join(DIR, p + '.db');
  if (!existsSync(path)) { console.log(`\n=== ${p} === (skipped: no database)`); continue; }
  const db = new Database(path, { readonly: true });
  console.log(`\n=== ${p} ===`);

  // ---- 1. staleness ----
  const newest = db.prepare(
    `SELECT crawl_id, REPLACE(REPLACE(finished_at,'T',' '),'Z','') at FROM crawl_metadata
     WHERE status='completed' AND finished_at IS NOT NULL ORDER BY at DESC LIMIT 1`).get();
  const snapped = newest ? !!db.prepare('SELECT 1 FROM page_snapshots WHERE crawl_id=? LIMIT 1').get(newest.crawl_id) : null;
  const d = diffLatest(db);
  console.log(`  newest completed crawl ${newest?.crawl_id ?? '(none)'} @ ${newest?.at ?? '-'} | snapshotted: ${snapped}`);
  console.log(`  diff ${d.baselineAt ?? '-'} -> ${d.currentAt ?? '-'} | staleness: ${d.staleness ? 'WARNED' : 'none'}`);

  if (newest) {
    // The invariant: warn IFF the newest completed crawl is missing from page_snapshots.
    ok(!!d.staleness === !snapped, `staleness set iff newest crawl unsnapshotted (snapped=${snapped}, warned=${!!d.staleness})`);
    const md = buildDriftMarkdown(d, p, 3);
    if (d.staleness) {
      ok(d.staleness.newestCrawl === newest.crawl_id, 'staleness names the newest completed crawl');
      ok(d.staleness.snapshotAt !== newest.at, 'staleness distinguishes snapshot time from crawl time');
      ok(md.includes('not current'), 'markdown carries the warning');
    } else {
      ok(!md.includes('not current'), 'no false staleness warning when up to date');
    }
  }

  // ---- 2. finding url_key ----
  // NB: these assert over STORED findings, so a run written before this fix shipped will fail
  // legitimately — the run date is printed so a stale run is obvious rather than mysterious.
  // Re-run run_audit on the property to refresh it.
  const run = db.prepare('SELECT run_id, started_at FROM audit_runs ORDER BY rowid DESC LIMIT 1').get();
  if (run) {
    console.log(`  latest audit run ${run.run_id} @ ${run.started_at ?? 'unknown'}`);
    const rows = db.prepare(
      `SELECT check_id, COUNT(*) n, SUM(url_key IS NULL) nulls FROM findings WHERE run_id=? GROUP BY check_id`).all(run.run_id);
    const by = Object.fromEntries(rows.map(r => [r.check_id, r]));
    for (const c of MUST_HAVE_URL_KEY) {
      if (by[c]) ok(by[c].nulls === 0, `${c}: ${by[c].n} findings, ${by[c].nulls} NULL url_key (want 0)`);
    }
    for (const c of MUST_BE_NULL) {
      if (by[c]) ok(by[c].nulls === by[c].n, `${c}: query-level, all ${by[c].n} correctly NULL`);
    }
  } else {
    console.log('  (no audit run yet — re-run run_audit to exercise the url_key assertions)');
  }
  db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
