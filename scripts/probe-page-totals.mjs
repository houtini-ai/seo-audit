// #118 GSC page totals: the date × page sync, the source switch, the checks and the history.
//   npm run build:server && node scripts/probe-page-totals.mjs [--live sc-domain:a.com ...]
// Offline (default): a fake GSC client drives the real GscSync; real checks, pageRowsFor and
// auditHistory run on a temp database. --live: on the real databases, every latest-run finding of
// a zero-traffic check must have no page-totals traffic in the audit's window.
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { GscSync, planPageTotals, gscRetentionStart } from '../dist/core/GscSync.js';
import { pageRowsFor, PAGE_TOTALS } from '../dist/core/gscPageTotals.js';
import { CHECKS } from '../dist/audit/checks.js';
import { runAudit } from '../dist/audit/engine.js';
import { auditHistory } from '../dist/audit/history.js';
import { dbPathFor } from '../dist/core/paths.js';

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ` :: ${detail}` : ''}`); cond ? pass++ : fail++; };
const day = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);

// ── planPageTotals ──────────────────────────────────────────────────────────────────────────────
{
  const now = new Date('2026-11-17T12:00:00Z');
  const floor = gscRetentionStart(now);
  t('retention floor is 16 months back', floor === '2025-07-17', floor);
  const b = planPageTotals({ min: null, max: null }, '2026-03-11', '2026-08-19', '2026-11-17', false, now);
  t('empty table backfills from the first stored query row', b.backfill && b.startDate === '2026-03-11' && !b.noop, JSON.stringify(b));
  const c = planPageTotals({ min: null, max: null }, '2024-01-01', '2026-08-19', '2026-11-17', false, now);
  t('backfill never asks before GSC retention', c.startDate === floor, c.startDate);
  const d = planPageTotals({ min: null, max: null }, null, '2026-08-19', '2026-11-17', false, now);
  t('first sync with no query rows backfills the requested window', d.startDate === '2026-08-19');
  const i = planPageTotals({ min: '2026-03-11', max: '2026-11-15' }, '2026-03-11', '2026-08-19', '2026-11-17', false, now);
  t('later syncs resume incrementally and replace the lag days', !i.backfill && i.startDate === '2026-11-11' && i.replaceFrom === '2026-11-11', JSON.stringify(i));
  const f = planPageTotals({ min: '2026-03-11', max: '2026-11-15' }, '2026-03-11', '2026-08-19', '2026-11-17', true, now);
  t('full resync pulls the requested window', f.startDate === '2026-08-19' && !f.replaceFrom);
}

// ── A fake property: 120 days. Page /a has query rows; /b's clicks are all anonymised (page totals only). ──
const MAX = '2026-11-15';
const DAYS = Array.from({ length: 120 }, (_, k) => day(MAX, -119 + k));
function fakeGsc({ failPageTotals = false } = {}) {
  const calls = [];
  return {
    calls,
    async fetchSearchAnalytics(site, opts, signal, onPage) {
      calls.push({ dims: opts.dimensions.join(','), start: opts.startDate, end: opts.endDate });
      const inRange = DAYS.filter(d => d >= opts.startDate && d <= opts.endDate);
      const pageOnly = opts.dimensions.join(',') === 'date,page';
      if (pageOnly && failPageTotals) throw new Error('page totals request failed');
      const rows = [];
      for (const d of inRange) {
        if (pageOnly) {
          rows.push({ keys: [d, 'https://x.test/a'], clicks: 10, impressions: 100, ctr: 0.1, position: 3 });
          rows.push({ keys: [d, 'https://x.test/b'], clicks: 2, impressions: 40, ctr: 0.05, position: 8 });
        } else {
          rows.push({ keys: [d, 'widget', 'https://x.test/a'], clicks: 4, impressions: 50, ctr: 0.08, position: 3 });
        }
      }
      onPage({ rows, totalSoFar: rows.length, startRow: 0 });
      return rows.length;
    },
  };
}
const SITE = 'sc-domain:x.test';
async function withDir(fn) {
  const dir = path.join(tmpdir(), `sac-pt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try { await fn(dir); } finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ } }
}
const sig = () => new AbortController().signal;
// Read on a short-lived handle, closed before the next writer.
const read = (dir, fn) => { const db = new Database(dbPathFor(dir, SITE)); try { return fn(db); } finally { db.close(); } };

await withDir(async (dir) => {
  // Seed: query rows only, as a pre-1.0.7 database holds them.
  const adb = new AuditDatabase(dbPathFor(dir, SITE));
  adb.upsertProperty(SITE, 'apex');
  const ins = adb.db.prepare(`INSERT INTO search_analytics (date, query, page, page_key, device, country, clicks, impressions, ctr, position) VALUES (?, 'widget', 'https://x.test/a', 'https://x.test/a', '', '', 4, 50, 0.08, 3)`);
  for (const d of DAYS.slice(0, 116)) ins.run(d);
  // Crawl: /a and /b are indexable HTML pages, linked (click depth 1).
  adb.db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,max_pages) VALUES ('c1','https://x.test','x.test','completed',2,100)`).run();
  const pg = adb.db.prepare(`INSERT INTO pages (crawl_id, url, url_key, status_code, indexable, content_type, click_depth, ipr, inlink_count) VALUES ('c1', ?, ?, 200, 1, 'text/html', 1, 60, 5)`);
  pg.run('https://x.test/a', 'https://x.test/a'); pg.run('https://x.test/b', 'https://x.test/b');
  adb.close();

  const bloat = CHECKS.find(c => c.id === 'index-bloat');
  read(dir, (db) => {
    t('no page totals yet: totals read the query rows', pageRowsFor(db, MAX, 28).source === 'query-attributed');
    const flagged = bloat.run({ db, gscMaxDate: MAX }).map(f => f.urlKey);
    t('before: index-bloat flags /b (its clicks are all anonymised)', flagged.includes('https://x.test/b'), JSON.stringify(flagged));
  });
  const old = runAudit(dir, SITE, {});
  t('audit reports the query-attributed source', old.pageTotalsSource === 'query-attributed', old.pageTotalsSource);

  // A failed page-totals request writes nothing at all (both row sets land together).
  let threw = false;
  try { await new GscSync(fakeGsc({ failPageTotals: true }), dir).run(SITE, { startDate: day(MAX, -89), endDate: MAX }, () => {}, sig()); } catch { threw = true; }
  t('a failed page-totals fetch fails the sync', threw);
  read(dir, (db) => t('...and writes neither row set', db.prepare(`SELECT COUNT(*) n FROM ${PAGE_TOTALS}`).get().n === 0
    && db.prepare(`SELECT MAX(date) d FROM search_analytics`).get().d === DAYS[115]));

  // The upgrade sync: the main rows resume incrementally, the page totals backfill from the first query row.
  const gsc = fakeGsc();
  const r = await new GscSync(gsc, dir).run(SITE, { startDate: day(MAX, -89), endDate: MAX }, () => {}, sig());
  const ptCall = gsc.calls.find(c => c.dims === 'date,page'), mainCall = gsc.calls.find(c => c.dims === 'date,query,page');
  t('main rows resume incrementally', mainCall && mainCall.start === day(DAYS[115], -4), JSON.stringify(mainCall));
  t('page totals backfill from the first stored query row', ptCall && ptCall.start === DAYS[0] && r.pageTotals?.backfill === true, JSON.stringify(ptCall));
  read(dir, (db) => {
    t('page totals stored for every day and page', db.prepare(`SELECT COUNT(*) n FROM ${PAGE_TOTALS}`).get().n === 240);
    t('page_key normalised on write', db.prepare(`SELECT COUNT(*) n FROM ${PAGE_TOTALS} WHERE page_key = 'https://x.test/b'`).get().n === 120);
    t('now totals read the page totals', pageRowsFor(db, MAX, 28).source === 'page-totals');
    t('a window older than the page totals falls back', pageRowsFor(db, MAX, 400).source === 'query-attributed');
    const flagged = bloat.run({ db, gscMaxDate: MAX }).map(f => f.urlKey);
    t('after: index-bloat no longer flags /b', !flagged.includes('https://x.test/b'), JSON.stringify(flagged));
  });

  // A second sync is a small delta that replaces the lag days (no duplicates).
  const gsc2 = fakeGsc();
  await new GscSync(gsc2, dir).run(SITE, { startDate: day(MAX, -89), endDate: MAX }, () => {}, sig());
  const pt2 = gsc2.calls.find(c => c.dims === 'date,page');
  t('second sync fetches only the lag days of page totals', pt2 && pt2.start === day(MAX, -4), JSON.stringify(pt2));
  read(dir, (db) => t('...without duplicating rows', db.prepare(`SELECT COUNT(*) n FROM ${PAGE_TOTALS}`).get().n === 240));

  // Engine: the source on the result; the history leaves the traffic checks out once.
  const now = runAudit(dir, SITE, {});
  t('audit reports the page-totals source', now.pageTotalsSource === 'page-totals', now.pageTotalsSource);
  const last = read(dir, db => auditHistory(db).auditDeltas.slice(-1)[0]);
  t('the first page-totals audit leaves the traffic checks out of opened/resolved',
    !!last?.excluded?.checkIds?.includes('index-bloat') && /page totals/.test(last.excluded.note ?? ''), JSON.stringify(last));
  runAudit(dir, SITE, {});
  const last2 = read(dir, db => auditHistory(db).auditDeltas.slice(-1)[0]);
  t('two page-totals audits compare normally', !last2?.excluded?.checkIds?.includes('index-bloat'), JSON.stringify(last2));
});

// ── --live: the real databases ───────────────────────────────────────────────────────────────────
const liveIdx = process.argv.indexOf('--live');
if (liveIdx >= 0) {
  const dir = process.env.SAC_DATA_DIR || path.join(homedir(), 'Documents', 'seo-audit-console');
  for (const site of process.argv.slice(liveIdx + 1)) {
    const db = new Database(dbPathFor(dir, site), { readonly: true });
    const run = db.prepare(`SELECT run_id, gsc_window_end e FROM audit_runs WHERE status='completed' ORDER BY started_at DESC LIMIT 1`).get();
    t(`${site}: page totals cover the 90-day window`, pageRowsFor(db, run.e, 90).source === 'page-totals');
    const traffic = db.prepare(`SELECT COALESCE(SUM(impressions),0) i, COALESCE(SUM(clicks),0) c FROM ${PAGE_TOTALS} WHERE page_key=? AND date <= ? AND date > date(?, ?)`);
    for (const [id, days, field] of [['index-bloat', 90, 'i'], ['high-ipr-no-traffic', 90, 'c'], ['faceted-spider-trap', 28, 'i']]) {
      const keys = db.prepare(`SELECT url_key k FROM findings WHERE run_id=? AND check_id=? AND url_key IS NOT NULL`).all(run.run_id, id).map(r => r.k);
      const wrong = keys.filter(k => traffic.get(k, run.e, run.e, `-${days} days`)[field] > 0);
      t(`${site}: ${id} flags no page with page-totals ${field === 'i' ? 'impressions' : 'clicks'} (${keys.length} findings)`, wrong.length === 0, wrong.slice(0, 3).join(' '));
    }
    db.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
