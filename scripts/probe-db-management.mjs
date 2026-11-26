// Probe: database-management fixes.
//  1. GSC sync: a request that starts before the stored history also fetches the days before it
//     (the lag-day re-pull stays), and "nothing to fetch" is only planned when that is true.
//  2. clear-crawl-history keeps the newest COMPLETED audit runs and drops failed / unfinished ones.
//  3. The dashboard cache notices page_cwv, page_entity and pages.max_passage_* writes.
//  4. pull_backlinks removes page_backlinks rows the pull no longer returns, keeps a known status
//     when this pull did not check the URL, and never prunes on an empty list.
//  5. delete-property removes the property's .bak-* files and its row-count cache entry.
//  6. SQLite UTC timestamps are parsed as UTC whatever the host's time zone (cache TTLs).
// Run: node scripts/probe-db-management.mjs   (after npm run build:server). No network.
process.env.TZ = 'Pacific/Auckland'; // far from UTC: a zone-less timestamp read as local time is 12-13 h out
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { GscSync, planBackfill, planPageTotals } from '../dist/core/GscSync.js';
import { pruneProperty, storageSummary, COUNTS_CACHE_FILE } from '../dist/core/dataStorage.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { Backlinks } from '../dist/core/Backlinks.js';
import { DataForSeoClient } from '../dist/core/DataForSeoClient.js';
import { parseSqliteUtc } from '../dist/core/sqliteTime.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const dir = mkdtempSync(path.join(tmpdir(), 'sac-dbmgmt-'));
const noop = () => {};
const sig = new AbortController().signal;
/** ISO date n days before today (UTC): the page-totals plan is floored at GSC's 16-month retention. */
const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

try {
  // ── 1. GSC sync: the days before the stored history ─────────────────────────────────────────
  {
    /** One row per day of the requested range, shaped by the requested dimensions. */
    const stub = () => {
      const calls = [];
      return {
        calls,
        async fetchSearchAnalytics(_site, options, _signal, onPage) {
          calls.push({ startDate: options.startDate, endDate: options.endDate, dimensions: options.dimensions });
          const rows = [];
          for (let t = Date.parse(options.startDate); t <= Date.parse(options.endDate); t += 86400000) {
            const date = new Date(t).toISOString().slice(0, 10);
            const val = { date, query: 'acme widgets', page: 'https://gsc.test/a', device: 'MOBILE', country: 'gbr' };
            rows.push({ keys: options.dimensions.map(k => val[k]), clicks: 2, impressions: 20, ctr: 0.1, position: 3 });
          }
          if (rows.length) onPage({ rows, totalSoFar: rows.length, startRow: 0 });
          return rows.length;
        },
      };
    };
    const site = 'sc-domain:gsc.test';
    const file = dbPathFor(dir, site);
    const days = (table) => { const db = new Database(file, { readonly: true }); try { return db.prepare(`SELECT MIN(date) lo, MAX(date) hi, COUNT(DISTINCT date) n, COUNT(*) r FROM ${table}`).get(); } finally { db.close(); } };

    check('planBackfill: nothing stored, or nothing earlier asked = no backfill',
      planBackfill(null, '2026-01-01', '2026-02-01') === null && planBackfill('2026-01-01', '2026-01-01', '2026-02-01') === null);
    const pb = planBackfill('2026-03-10', '2026-01-01', '2026-06-01');
    check('planBackfill: the gap ends the day before the first stored day', pb?.startDate === '2026-01-01' && pb?.endDate === '2026-03-09', JSON.stringify(pb));
    check('planBackfill: capped at the requested end', planBackfill('2026-03-10', '2026-01-01', '2026-02-01')?.endDate === '2026-02-01');
    const ppt = planPageTotals({ min: d(60), max: d(20) }, d(60), d(150), d(18), false);
    check('planPageTotals: plans the days before the stored page totals too', ppt.before?.startDate === d(150) && ppt.before?.endDate === d(61) && ppt.replaceFrom === d(24), JSON.stringify(ppt));

    const s1 = stub();
    await new GscSync(s1, dir).run(site, { startDate: d(60), endDate: d(20) }, noop, sig);
    const first = days('search_analytics');
    check('first sync stores the requested window', first.lo === d(60) && first.hi === d(20) && first.n === 41, JSON.stringify(first));

    // A later request reaching 150 days back: the lag days AND the 90 days before the stored history.
    const s2 = stub();
    const syncer = new GscSync(s2, dir);
    const plan = syncer.plannedRange(site, { startDate: d(150), endDate: d(18) });
    check('plannedRange: incremental from the lag days, with the earlier days announced',
      plan.incremental && plan.startDate === d(24) && !plan.noop && plan.backfill?.startDate === d(150) && plan.backfill?.endDate === d(61), JSON.stringify(plan));
    const r2 = await syncer.run(site, { startDate: d(150), endDate: d(18) }, noop, sig);
    const qp = s2.calls.filter(c => c.dimensions.includes('query')).map(c => `${c.startDate}..${c.endDate}`);
    check('run fetches the lag days and the days before the stored history', qp.join() === `${d(24)}..${d(18)},${d(150)}..${d(61)}`, qp.join());
    const after = days('search_analytics');
    check('the earlier days are stored, each day once', after.lo === d(150) && after.hi === d(18) && after.n === 133 && after.r === 133, JSON.stringify(after));
    check('the result reports the backfill', r2.backfill?.startDate === d(150) && r2.backfill?.rowsFetched === 90 && r2.startDate === d(24), JSON.stringify(r2));
    const pt = days('gsc_page_totals');
    check('page totals reach back as far', pt.lo === d(150) && pt.hi === d(18) && pt.n === 133 && pt.r === 133, JSON.stringify(pt));

    // Truthful no-op: a window inside the stored history fetches nothing...
    const s3 = stub();
    const inside = new GscSync(s3, dir);
    check('plannedRange: a window inside the stored history is a no-op', inside.plannedRange(site, { startDate: d(100), endDate: d(40) }).noop === true);
    await inside.run(site, { startDate: d(100), endDate: d(40) }, noop, sig);
    check('...and makes no API call', s3.calls.length === 0, JSON.stringify(s3.calls));
    // ...but a window that ends before the stored max and starts before the stored min is not one.
    const s4 = stub();
    const older = new GscSync(s4, dir);
    const p4 = older.plannedRange(site, { startDate: d(200), endDate: d(170) });
    check('plannedRange: a window wholly before the stored history is fetched, not "already covered"',
      !p4.noop && p4.startDate === d(200) && p4.endDate === d(170), JSON.stringify(p4));
    await older.run(site, { startDate: d(200), endDate: d(170) }, noop, sig);
    const a4 = days('search_analytics');
    check('...and stored without touching the later days', a4.lo === d(200) && a4.r === 133 + 31 && s4.calls.every(c => c.startDate === d(200) && c.endDate === d(170)), JSON.stringify({ a4, calls: s4.calls }));
  }

  // ── 2. clear-crawl-history keeps completed runs ────────────────────────────────────────────
  {
    const site = 'sc-domain:history.test';
    const file = dbPathFor(dir, site);
    const adb = new AuditDatabase(file);
    adb.upsertProperty(site, 'apex');
    const run = adb.db.prepare(`INSERT INTO audit_runs (run_id, started_at, finished_at, status) VALUES (?,?,?,?)`);
    const finding = adb.db.prepare(`INSERT INTO findings (run_id, check_id) VALUES (?, 'x')`);
    for (let i = 1; i <= 7; i++) { run.run(`ok${i}`, `2026-10-0${i} 10:00:00`, `2026-10-0${i} 10:01:00`, 'completed'); finding.run(`ok${i}`); }
    for (let i = 1; i <= 5; i++) run.run(`bad${i}`, `2026-11-0${i} 10:00:00`, null, i === 5 ? 'running' : 'failed'); // newer than every completed run
    adb.close();
    const preview = pruneProperty(dir, site, 'clear-crawl-history', false, []);
    check('preview counts what goes and says which runs stay', preview.detail.oldRuns === 7 && preview.detail.unfinishedRuns === 5 && preview.detail.oldFindings === 2
      && /7 audit runs \(5 of them failed or never finished\)/.test(preview.refused) && /most recent completed audit runs/.test(preview.refused), preview.refused);
    check('preview keeps the wording the server parses', /^REFUSED[^.]*needs confirm:true\./.test(preview.refused) && /Re-run with confirm:true to proceed\.$/.test(preview.refused));
    pruneProperty(dir, site, 'clear-crawl-history', true, []);
    const db = new Database(file, { readonly: true });
    const left = db.prepare(`SELECT run_id FROM audit_runs ORDER BY started_at`).all().map(r => r.run_id).join();
    const findings = db.prepare(`SELECT COUNT(*) n FROM findings`).get().n;
    db.close();
    check('the 5 newest completed runs survive five newer failed attempts', left === 'ok3,ok4,ok5,ok6,ok7' && findings === 5, `${left} / ${findings} findings`);
  }

  // ── 3. dashboard cache version ─────────────────────────────────────────────────────────────
  {
    const site = 'sc-domain:dash.test';
    const file = dbPathFor(dir, site);
    const adb = new AuditDatabase(file);
    adb.upsertProperty(site, 'apex');
    const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,'kw','https://dash.test/','https://dash.test/','','',5,100,0.05,4)`);
    for (let i = 3; i < 73; i++) ins.run(d(i));
    adb.db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1','https://dash.test/','dash.test','completed')`).run();
    adb.db.prepare(`INSERT INTO pages (crawl_id, url, url_key, status_code, is_internal, indexable) VALUES ('c1','https://dash.test/','https://dash.test/',200,1,1)`).run();
    adb.close();
    const p0 = getDashboardData(dir, site);
    check('baseline payload has none of the three panels', !p0.cwvCoverage && !p0.entityGraph && !p0.answerability);
    const write = (sql) => { const w = new AuditDatabase(file); try { w.db.exec(sql); } finally { w.close(); } };
    write(`INSERT INTO page_cwv (url_key,url,for_mobile,performance,lcp_ms,cls,tbt_ms) VALUES ('https://dash.test/','https://dash.test/',1,0.3,5000,0.3,900)`);
    check('a page_lighthouse write shows on the next load', getDashboardData(dir, site).cwvCoverage?.pages === 1);
    write(`INSERT INTO page_entity (url_key,qid,label) VALUES ('a','Q1','A'),('b','Q2','B')`);
    check('a resolve_entities write shows on the next load', getDashboardData(dir, site).entityGraph?.total === 2);
    write(`UPDATE pages SET max_passage_score=0.2, max_passage_query='kw', max_passage_impr=100, max_passage_at=datetime('now')`);
    check('a score_passages write (an UPDATE of pages) shows on the next load', getDashboardData(dir, site).answerability?.scored === 1);
  }

  // ── 4. page_backlinks: stale rows pruned, known status kept ────────────────────────────────
  {
    const site = 'sc-domain:links.test';
    const file = dbPathFor(dir, site);
    const page = (p, backlinks) => ({ url: `https://links.test/${p}`, backlinks, referring_domains: 1 });
    let list = [];
    const dfs = {
      async backlinksSummary() { return { tasks: [{ status_code: 20000, result: [{ backlinks: 18, referring_domains: 3 }] }], cached: false, cost: 0 }; },
      async domainPagesSummary() { return { tasks: [{ status_code: 20000, result: [{ items: list }] }], cached: false, cost: 0 }; },
    };
    const pull = (opts = {}) => new Backlinks(dfs, dir).run(site, { statusLimit: 0, profile: false, ...opts }, noop, sig); // statusLimit 0: no live fetch
    const stored = () => { const db = new Database(file, { readonly: true }); try { return db.prepare(`SELECT url, backlinks, status_code st FROM page_backlinks ORDER BY url`).all().map(r => `${r.url.split('/').pop()}:${r.backlinks}:${r.st ?? '-'}`).join(); } finally { db.close(); } };
    const exec = (sql) => { const w = new Database(file); try { w.exec(sql); } finally { w.close(); } };

    list = [page('a', 10), page('b', 5), page('c', 3)];
    await pull();
    exec(`UPDATE page_backlinks SET status_code = 404 WHERE url LIKE '%/b'`); // an earlier pull found it dead
    list = [page('a', 11), page('b', 5)];
    await pull();
    check('a URL the pull no longer returns is removed; an unchecked URL keeps its known status', stored() === 'a:11:-,b:5:404', stored());

    // A list filled to its limit is only the top N: rows below its smallest count may sit beyond it.
    exec(`INSERT INTO page_backlinks (url_key, url, backlinks) VALUES ('links.test/d','https://links.test/d',1), ('links.test/e','https://links.test/e',50)`);
    await pull({ limit: 2 });
    check('a capped list removes only rows that would have been in it', stored() === 'a:11:-,b:5:404,d:1:-', stored());

    list = [];
    await pull();
    check('an empty list deletes nothing', stored() === 'a:11:-,b:5:404,d:1:-', stored());
    dfs.domainPagesSummary = async () => { throw new Error('DataForSEO /v3/backlinks/domain_pages_summary/live failed: 500'); };
    let threw = false;
    try { await pull(); } catch { threw = true; }
    check('a failed list deletes nothing', threw && stored() === 'a:11:-,b:5:404,d:1:-', stored());
  }

  // ── 5. delete-property takes its backups and its counts entry ──────────────────────────────
  {
    const site = 'sc-domain:gone.test';
    const other = 'sc-domain:kept.test';
    const file = dbPathFor(dir, site), otherFile = dbPathFor(dir, other);
    for (const [s, f] of [[site, file], [other, otherFile]]) { const adb = new AuditDatabase(f); adb.upsertProperty(s, 'apex'); adb.close(); }
    const baks = [`${file}.bak-20261101-000000`, `${file}.bak-20261102-000000`];
    for (const b of baks) writeFileSync(b, 'x'.repeat(2048));
    writeFileSync(`${baks[0]}-shm`, 'x'); // a sidecar an older version left
    const otherBak = `${otherFile}.bak-20261101-000000`;
    writeFileSync(otherBak, 'x'.repeat(2048));
    storageSummary(dir); // writes the row-count cache
    const counts = () => Object.keys(JSON.parse(readFileSync(path.join(dir, COUNTS_CACHE_FILE), 'utf8')));
    check('setup: both properties are in the counts cache', counts().includes(path.basename(file)) && counts().includes(path.basename(otherFile)), counts().join());
    const preview = pruneProperty(dir, site, 'delete-property', false, []);
    check('the confirmation names the backups that go', /its 2 backup file\(s\)/.test(preview.refused) && preview.refused.includes(path.basename(baks[1])) && existsSync(file), preview.refused);
    const r = pruneProperty(dir, site, 'delete-property', true, []);
    const leftover = readdirSync(dir).filter(f => f.startsWith(path.basename(file)));
    check('database, backups and their sidecars are gone', r.ok && leftover.length === 0 && r.detail.backupsDeleted.length === 2, leftover.join());
    check('another property and its backup are untouched', existsSync(otherFile) && existsSync(otherBak));
    check('its counts-cache entry is gone, the other stays', !counts().includes(path.basename(file)) && counts().includes(path.basename(otherFile)), counts().join());
  }

  // ── 6. SQLite UTC timestamps (this process runs in Pacific/Auckland) ───────────────────────
  {
    check('parseSqliteUtc reads a SQLite datetime as UTC', parseSqliteUtc('2026-11-26 10:00:00') === Date.UTC(2026, 10, 26, 10, 0, 0));
    check('parseSqliteUtc keeps an ISO string, a bare date and absence', parseSqliteUtc('2026-11-26T10:00:00.000Z') === Date.UTC(2026, 10, 26, 10)
      && parseSqliteUtc('2026-11-26T10:00:00+02:00') === Date.UTC(2026, 10, 26, 8) && parseSqliteUtc('2026-11-26') === Date.UTC(2026, 10, 26) && Number.isNaN(parseSqliteUtc(null)));
    // A response cached 12 hours ago must still be served for a 1-day max age (read as local time
    // in this zone it looked 24-25 hours old and was paid for again).
    const cacheFile = path.join(dir, 'dataforseo-cache.db');
    let fetches = 0;
    const fetchImpl = async () => { fetches++; return new Response(JSON.stringify({ status_code: 20000, cost: 0.01, tasks: [{ status_code: 20000, result: [{ ok: true }] }] }), { status: 200 }); };
    const client = new DataForSeoClient('u', 'p', cacheFile, 20, { fetchImpl });
    await client.bulkRanks(['a.test'], { maxAgeDays: 1 });
    const raw = new Database(cacheFile);
    raw.prepare(`UPDATE dataforseo_cache SET fetched_at = datetime('now', '-12 hours')`).run();
    raw.close();
    const again = await client.bulkRanks(['a.test'], { maxAgeDays: 1 });
    client.close();
    check('a 12-hour-old cached DataForSEO response is reused within a 1-day max age', again.cached === true && fetches === 1, `cached=${again.cached} fetches=${fetches}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
