#!/usr/bin/env node
// Issue #65 regression: segment rows (country / device) live in search_analytics_segments, totals
// in search_analytics only. Covers the one-time migration from the #64 layout (mixed shapes in
// search_analytics): totals unchanged, segments preserved, idempotent, resumable after an abort,
// refused cleanly without disk, a no-op on a clean database; and the guard that keeps a sync from
// mixing shapes again (the triggers, and GscSync routing rows by shape).
// Run:  npm run build:server && node scripts/probe-gsc-storage.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { GscSync, FULL_DIMENSIONS } from '../dist/core/GscSync.js';
import { migrateGscStorage } from '../dist/core/gscMigrate.js';
import { gscMixedShape } from '../dist/core/gscRows.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { dbPathFor } from '../dist/core/paths.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e?.message ?? e)); } };
const dataDir = path.join(tmpdir(), `sac-gscstorage-${Date.now()}`);
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const days = (from, to) => { const out = []; for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) out.push(iso(t)); return out; };
const HUGE = () => 1e15;

/** A property database in the #64 layout: built by this version, then its guard dropped and its
 *  layout state cleared, so the next open sees segment rows in search_analytics (pending). */
function legacyProperty(name, fill) {
  const site = `sc-domain:${name}.test`;
  const file = dbPathFor(dataDir, site);
  const adb = new AuditDatabase(file);
  adb.upsertProperty(site, 'apex');
  adb.db.exec(`DROP TRIGGER IF EXISTS sa_totals_only; DROP TRIGGER IF EXISTS sa_totals_only_upd; DELETE FROM gsc_storage_state;`);
  const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  adb.db.transaction(() => fill(ins))();
  adb.close();
  new AuditDatabase(file).close(); // the first open by this version: detects the layout, sets up #64's views
  return { site, file };
}
/** The SRC-like history: lite + per-country rows (lite short on 06-10..06-19: zero-click rows
 *  missing, impressions cut), a partial per-country day (06-25), device rows on some days, a day
 *  held only in per-country rows (06-28), a day with two country-carrying shapes (06-29), and
 *  lite-only days after. */
function srcLike(ins) {
  const u = (p) => `https://x.test/${p}`;
  for (const d of days('2026-06-01', '2026-06-30')) {
    for (const [q, p, c, i] of [['acme widgets', 'a', 10, 100], ['blue widgets', 'b', 4, 200], ['red widgets', 'c', 0, 60]]) {
      const shortLite = d >= '2026-06-10' && d <= '2026-06-19';
      if (!(shortLite && c === 0) && d !== '2026-06-28') ins.run(d, q, u(p), u(p), '', '', c, shortLite ? Math.max(c, 1) : i, 0, 4);
      if (d === '2026-06-25') { if (p === 'a') ins.run(d, q, u(p), u(p), '', 'gbr', 2, 20, 0, 5); continue; } // partial per-country day
      const g = Math.round(c * 0.6);
      ins.run(d, q, u(p), u(p), '', 'gbr', g, i / 2, 0, 3);
      ins.run(d, q, u(p), u(p), '', 'usa', c - g, i / 2, 0, 5);
      if (d <= '2026-06-05') { ins.run(d, q, u(p), u(p), 'MOBILE', '', Math.max(c - 1, 0), i - 10, 0, 4); ins.run(d, q, u(p), u(p), 'DESKTOP', '', c > 0 ? 1 : 0, 10, 0, 4); }
      if (d === '2026-06-29') { ins.run(d, q, u(p), u(p), 'MOBILE', 'gbr', g, i / 2, 0, 3); ins.run(d, q, u(p), u(p), 'MOBILE', 'usa', c - g, i / 2, 0, 5); }
    }
  }
  for (const d of days('2026-07-01', '2026-07-10')) ins.run(d, 'acme widgets', u('a'), u('a'), '', '', 9, 90, 0.1, 4); // lite only
}
/** Everything a reader sees: per-day totals, per-day per-country and per-device sums. */
function readerView(file) {
  const db = new Database(file, { readonly: true });
  try {
    const q = (sql) => JSON.stringify(db.prepare(sql).all());
    return {
      totals: q(`SELECT date, SUM(clicks) c, SUM(impressions) i, COUNT(DISTINCT query || page) qp FROM gsc_rows GROUP BY date ORDER BY date`),
      country: q(`SELECT date, country, SUM(clicks) c, SUM(impressions) i FROM gsc_country_rows GROUP BY date, country ORDER BY date, country`),
      device: q(`SELECT date, device, SUM(clicks) c, SUM(impressions) i FROM gsc_device_rows GROUP BY date, device ORDER BY date, device`),
    };
  } finally { db.close(); }
}
const one = (file, sql) => { const db = new Database(file, { readonly: true }); try { return db.prepare(sql).get(); } finally { db.close(); } };
const segmentRowsIn = (file, table) => one(file, `SELECT COUNT(*) n FROM ${table} WHERE device <> '' OR country <> ''`).n;
const stateOf = (file) => one(file, `SELECT state, backup FROM gsc_storage_state`);
const viewSql = (file, name) => one(file, `SELECT sql FROM sqlite_master WHERE name = '${name}'`).sql;
const backups = (file) => readdirSync(path.dirname(file)).filter(f => f.startsWith(path.basename(file) + '.bak-') && !/-(wal|shm)$/.test(f));
async function migrate(file, opts = {}) {
  const adb = new AuditDatabase(file);
  try { return await migrateGscStorage(adb.db, file, { freeBytes: HUGE, ...opts }); } finally { adb.close(); }
}

// ── 1. Migrate a mixed database: totals unchanged, segments preserved, guard on ─────────────────
{
  const { site, file } = legacyProperty('mixed', srcLike);
  ok(stateOf(file).state === 'pending', 'a database with segment rows in search_analytics opens as pending');
  const before = readerView(file);
  const segBefore = segmentRowsIn(file, 'search_analytics');
  const r = await migrate(file, { batchRows: 40 }); // small batches: many transactions
  ok(r.ran && r.state === 'done' && r.days === 30 && r.daysDone === 30, `migration ran over the 30 days holding segment rows (${r.days} / ${r.daysDone})`);
  ok(r.segmentRowsMoved === segBefore, `every segment row moved (${r.segmentRowsMoved} of ${segBefore})`);
  ok(r.daysFromSegments === 11 && r.allCountryRowsReplaced === 20, `the 10 short days and the per-country-only day now total from the per-country rows (${r.daysFromSegments} days, ${r.allCountryRowsReplaced} all-country rows replaced, ${r.totalsRowsDerived} derived)`);
  const after = readerView(file);
  ok(after.totals === before.totals, 'totals per day (clicks, impressions, query × page count) are unchanged');
  ok(after.country === before.country, 'per-country breakdown per day is unchanged');
  ok(after.device === before.device, 'per-device breakdown per day is unchanged');
  const pos = one(file, `SELECT position p FROM gsc_rows WHERE date = '2026-06-15' AND query = 'acme widgets'`).p;
  ok(Math.abs(pos - 4) < 1e-9, `a derived row's position is impression-weighted (gbr 3, usa 5, equal impressions: ${pos})`);
  ok(segmentRowsIn(file, 'search_analytics') === 0 && segmentRowsIn(file, 'search_analytics_segments') === segBefore, 'search_analytics holds no segment row; the segment table holds them all');
  ok(!/WHERE/.test(viewSql(file, 'gsc_rows')) && /FROM search_analytics_segments/.test(viewSql(file, 'gsc_device_rows')) && !/UNION/.test(viewSql(file, 'gsc_device_rows')), 'gsc_rows is a straight pass-through; the segment views read the segment table only');
  const st = stateOf(file);
  ok(st.state === 'done' && st.backup && existsSync(st.backup), `state done, backup kept (${st.backup && path.basename(st.backup)})`);
  { const b = new Database(st.backup, { readonly: true }); const n = b.prepare(`SELECT COUNT(*) n FROM search_analytics WHERE country <> '' OR device <> ''`).get().n; b.close(); ok(n === segBefore, 'the backup holds the pre-migration layout'); }
  const d = getDashboardData(dataDir, site);
  const jun = d.monthly.months.find(m => m.month === '2026-06');
  const junBefore = JSON.parse(before.totals).filter(x => x.date < '2026-07').reduce((s, x) => s + x.c, 0);
  ok(jun.clicks === junBefore, `dashboard monthly: June clicks = the pre-migration per-day totals (${jun.clicks} / ${junBefore})`);
  ok(d.gscShape === null && one(file, `SELECT COUNT(*) n FROM gsc_day_shape`).n === 29, `migrated: the 29 mixed days (28 Jun was per-country only) stay in gsc_day_shape as evidence, and the UI's two-row-shapes note is gone (0.16.2; gscShape ${JSON.stringify(d.gscShape)})`);

  // ── 2. Idempotent: a second run (and a reopen) changes nothing ──
  const again = await migrate(file);
  ok(!again.ran && again.state === 'done', 'a second migration is a no-op');
  ok(JSON.stringify(readerView(file)) === JSON.stringify(after) && backups(file).length === 1, 'nothing moved, no second backup');

  // ── 3. The guard: neither table accepts the other shape ──
  const w = new AuditDatabase(file);
  ok(throws(() => w.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES ('2026-08-01','q','u','u','','gbr',1,1,1,1)`).run(), /totals rows only/), 'guard: a per-country row into search_analytics is refused');
  ok(throws(() => w.db.prepare(`UPDATE search_analytics SET device = 'MOBILE' WHERE date = '2026-07-01'`).run(), /totals rows only/), 'guard: turning a totals row into a segment row is refused');
  ok(throws(() => w.db.prepare(`INSERT INTO search_analytics_segments (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES ('2026-08-01','q','u','u','','',1,1,1,1)`).run(), /segment rows only/), 'guard: an all-country row into the segment table is refused');
  w.close();
}

// ── 4. Resumable: abort after the first batch, readers stay right, then finish ───────────────────
{
  const { file } = legacyProperty('resume', srcLike);
  const before = readerView(file);
  const shapeNote = () => { const db = new Database(file, { readonly: true }); try { return gscMixedShape(db); } finally { db.close(); } };
  const pendingNote = shapeNote();
  ok(pendingNote?.mixedDays > 0, `pending: the two-row-shapes note lists the mixed days (${pendingNote?.mixedDays})`);
  const ac = new AbortController();
  const r1 = await migrate(file, { batchRows: 40, signal: ac.signal, onProgress: (p) => { if (p.phase === 'moving') ac.abort(); } });
  ok(r1.ran && r1.state === 'migrating' && r1.daysDone > 0 && r1.daysDone < 30, `aborted part-way (${r1.daysDone} of 30 days)`);
  ok(stateOf(file).state === 'migrating', 'state records the migration in progress');
  new AuditDatabase(file).close(); // a writable open mid-migration must not recompute #64's choices from the half-moved table
  const mid = readerView(file);
  ok(mid.totals === before.totals && mid.country === before.country && mid.device === before.device, 'mid-migration readers see the same totals and breakdowns');
  const midNote = shapeNote();
  ok(midNote && midNote.mixedDays < pendingNote.mixedDays, `migrating: the note counts only the days still mixed (${midNote?.mixedDays} of ${pendingNote?.mixedDays})`);
  const r2 = await migrate(file, { batchRows: 40 });
  ok(r2.ran && r2.state === 'done' && r2.backup === r1.backup && backups(file).length === 1, 'resumed to done with the original backup (no second one)');
  ok(shapeNote() === null, 'migrated: no two-row-shapes note');
  const after = readerView(file);
  ok(after.totals === before.totals && after.country === before.country && after.device === before.device, 'after resuming: totals and breakdowns unchanged');
  ok(segmentRowsIn(file, 'search_analytics') === 0, 'no segment row left in search_analytics');
}

// ── 5. Not enough disk: refused, nothing touched ─────────────────────────────────────────────────
{
  const { file } = legacyProperty('nodisk', srcLike);
  const before = readerView(file);
  const r = await migrate(file, { freeBytes: () => 1024 });
  ok(!r.ran && /not started: it needs .* free/.test(r.refused ?? '') && /Nothing was changed/.test(r.refused ?? ''), `refused with the reason (${(r.refused ?? '').slice(0, 80)}...)`);
  ok(stateOf(file).state === 'pending' && backups(file).length === 0 && JSON.stringify(readerView(file)) === JSON.stringify(before), 'still pending, no backup written, readers unchanged');
}

// ── 6. A clean (lite-only) database: nothing to migrate ─────────────────────────────────────────
{
  const site = 'sc-domain:clean.test';
  const file = dbPathFor(dataDir, site);
  const adb = new AuditDatabase(file);
  adb.upsertProperty(site, 'apex');
  const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0.1,3)`);
  for (const d of days('2026-06-01', '2026-06-10')) ins.run(d, 'q', 'https://x.test/p', 'https://x.test/p', 3, 30);
  adb.close();
  const before = readerView(file);
  const r = await migrate(file);
  ok(!r.ran && r.state === 'done' && stateOf(file).state === 'done', 'clean database: done from the first open; the migration does nothing');
  ok(backups(file).length === 0 && JSON.stringify(readerView(file)) === JSON.stringify(before) && segmentRowsIn(file, 'search_analytics_segments') === 0, 'no backup, no rows moved, totals unchanged');
}

// ── 7. GscSync routes by shape, settles totals, keeps segmenting a segmented property ─────────────
{
  /** A stub GSC client: rows for each day in the requested window, keys in the requested dimension order. */
  const stub = (rowsFor) => ({
    calls: [],
    async fetchSearchAnalytics(siteUrl, options, signal, onPage) {
      this.calls.push(options);
      const rows = [];
      for (const d of days(options.startDate, options.endDate)) rows.push(...rowsFor(d, options.dimensions));
      onPage({ rows });
    },
  });
  const rowsFor = (lite) => (d, dims) => {
    const seg = dims.includes('country');
    const out = [];
    for (const b of [{ q: 'acme widgets', p: 'https://x.test/a', c: 10, i: 100 }, { q: 'zero click', p: 'https://x.test/b', c: 0, i: 50 }]) {
      if (!seg) { if (lite === 'short' && b.c === 0) continue; out.push({ keys: [d, b.q, b.p], clicks: b.c, impressions: b.i, ctr: 0, position: 3 }); continue; }
      for (const [cty, share] of [['gbr', 0.6], ['usa', 0.4]]) {
        const keys = dims.map(x => x === 'date' ? d : x === 'query' ? b.q : x === 'page' ? b.p : x === 'country' ? cty : 'MOBILE');
        out.push({ keys, clicks: Math.round(b.c * share), impressions: b.i * share, ctr: 0, position: 3 });
      }
    }
    return out;
  };
  const site = 'sc-domain:sync.test';
  const file = dbPathFor(dataDir, site);
  const noop = () => {};
  const sig = new AbortController().signal;
  // (a) A lite sync whose all-country rows are short (the zero-click rows missing), then a country sync.
  const r1 = await new GscSync(stub(rowsFor('short')), dataDir).run(site, { startDate: '2026-06-01', endDate: '2026-06-10' }, noop, sig);
  ok(r1.table === 'search_analytics' && r1.rowsFetched === 10, `lite sync writes search_analytics (${r1.rowsFetched} rows)`);
  const r2 = await new GscSync(stub(rowsFor('short')), dataDir).run(site, { startDate: '2026-06-01', endDate: '2026-06-10', dimensions: ['date', 'query', 'page', 'country'] }, noop, sig);
  ok(r2.table === 'search_analytics_segments' && segmentRowsIn(file, 'search_analytics') === 0 && segmentRowsIn(file, 'search_analytics_segments') === 40, 'a country sync writes the segment table only: search_analytics never mixes');
  ok(r2.settled?.derivedDays === 10 && r2.settled?.recordedDays === 10, `settle: the fuller per-country rows became the totals on the 10 short days (${JSON.stringify(r2.settled)})`);
  const t = readerView(file);
  ok(JSON.parse(t.totals).every(x => x.c === 10 && x.i === 150 && x.qp === 2), 'totals = 10 clicks, 150 impressions, 2 query × page rows per day (the zero-click row recovered)');
  ok(JSON.parse(t.country).length === 20, 'the country breakdown reads the segment rows');
  // (b) The next routine lite sync on this property (its segments are current) re-aims to segments.
  const s3 = stub(rowsFor('full'));
  const r3 = await new GscSync(s3, dataDir).run(site, { startDate: '2026-06-01', endDate: '2026-06-12' }, noop, sig);
  ok(r3.table === 'search_analytics_segments' && s3.calls[0].dimensions.join() === FULL_DIMENSIONS.join(), `a lite sync over current segment history keeps segmenting (${s3.calls[0].dimensions.join(',')})`);
  ok(segmentRowsIn(file, 'search_analytics') === 0, 'still no segment row in search_analytics');
  const mixedSeg = one(file, `SELECT COUNT(*) n FROM (SELECT date FROM search_analytics_segments GROUP BY date HAVING MIN(device <> '') <> MAX(device <> ''))`).n;
  ok(mixedSeg === 0, 'the re-pulled lag window holds one segment shape per day (replaced, not mixed)');
  const tot12 = one(file, `SELECT SUM(clicks) c, SUM(impressions) i FROM gsc_rows WHERE date = '2026-06-12'`);
  ok(tot12.c === 10 && tot12.i === 150, `a day first synced as segments gets its totals from them (${tot12.c} / ${tot12.i})`);
  // (c) A sync without the stored grain is refused before any API call.
  const s4 = stub(rowsFor('full'));
  let msg = '';
  try { await new GscSync(s4, dataDir).run(site, { startDate: '2026-06-01', endDate: '2026-06-02', dimensions: ['date', 'country'] }, noop, sig); } catch (e) { msg = String(e.message); }
  ok(/needs the date, query and page dimensions/.test(msg) && s4.calls.length === 0, 'a sync without query/page is refused before any API call');
  // (d) A sync on a pending (#64-layout) database migrates it first (real free-disk check on the temp volume).
  const { site: lsite, file: lfile } = legacyProperty('syncmigrates', srcLike);
  const before = readerView(lfile);
  const r5 = await new GscSync(stub(rowsFor('full')), dataDir).run(lsite, { startDate: '2026-07-01', endDate: '2026-07-10' }, noop, sig);
  ok(r5.migration?.state === 'done' && stateOf(lfile).state === 'done' && segmentRowsIn(lfile, 'search_analytics') === 0, 'a sync on a pending database runs the migration first');
  const june = (v) => JSON.parse(v.totals).filter(x => x.date < '2026-07').map(x => `${x.date}:${x.c}:${x.i}`).join();
  ok(june(readerView(lfile)) === june(before), 'June totals untouched by the migrate-then-sync');

  // (e) plannedRange takes run()'s dimension decision: a lite request on a property whose segments
  // are current fetches segments from the SEGMENT table's resume date, and the start reply says so.
  {
    const psite = 'sc-domain:plan.test';
    const pfile = dbPathFor(dataDir, psite);
    await new GscSync(stub(rowsFor('full')), dataDir).run(psite, { startDate: '2026-06-01', endDate: '2026-06-10' }, noop, sig);
    await new GscSync(stub(rowsFor('full')), dataDir).run(psite, { startDate: '2026-06-01', endDate: '2026-06-10', dimensions: ['date', 'query', 'page', 'country'] }, noop, sig);
    const w = new AuditDatabase(pfile); // totals run two days past the segments (still within the lag)
    for (const d of ['2026-06-11', '2026-06-12']) w.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,'acme widgets','https://x.test/a','https://x.test/a','','',10,100,0,3)`).run(d);
    w.close();
    const ps = stub(rowsFor('full'));
    const syncer = new GscSync(ps, dataDir);
    const plan = syncer.plannedRange(psite, { startDate: '2026-06-01', endDate: '2026-06-14' });
    await syncer.run(psite, { startDate: '2026-06-01', endDate: '2026-06-14' }, noop, sig);
    ok(plan.segmentsKept === true && plan.dimensions.join() === ps.calls[0].dimensions.join(), `plannedRange announces the segment re-aim run() makes (${plan.dimensions.join(',')} / ${ps.calls[0].dimensions.join(',')})`);
    ok(plan.startDate === ps.calls[0].startDate && plan.startDate === '2026-06-06', `plannedRange states the range run() fetches (${plan.startDate} / ${ps.calls[0].startDate})`);
  }

  // (f) Not enough disk for the migration: the sync still runs, in the old layout, and says so.
  {
    const { site: dsite, file: dfile } = legacyProperty('deferred', srcLike);
    const before = readerView(dfile);
    const lowDisk = { freeBytes: () => 1024 };
    const progress = [];
    const ds = stub(rowsFor('full'));
    const r = await new GscSync(ds, dataDir, lowDisk).run(dsite, { startDate: '2026-07-01', endDate: '2026-07-12' }, (p) => progress.push(p), sig);
    ok(/^storage migration deferred: needs [\d.]+ GB free .*sync ran in the old layout, totals stay correct via the views/.test(r.storageMigrationDeferred ?? ''), `the result says the migration was deferred (${(r.storageMigrationDeferred ?? '').slice(0, 90)}...)`);
    ok(r.migration?.refused && r.rowsFetched > 0 && ds.calls.length === 1, `...and the sync still ran (${r.rowsFetched} rows)`);
    ok(progress.some(p => p.storageMigration?.phase === 'deferred'), 'the deferral is in the job progress');
    ok(stateOf(dfile).state === 'pending' && backups(dfile).length === 0 && r.table === 'search_analytics', 'nothing migrated, no backup: the old layout, all rows in search_analytics');
    const after = readerView(dfile);
    const tot = (v, d) => JSON.parse(v.totals).find(x => x.date === d);
    const june = (v) => JSON.parse(v.totals).filter(x => x.date < '2026-07').map(x => `${x.date}:${x.c}:${x.i}`).join();
    ok(june(after) === june(before), 'June totals untouched by the deferred sync');
    ok(['2026-07-06', '2026-07-10', '2026-07-12'].every(d => tot(after, d)?.c === 10 && tot(after, d)?.i === 150) && tot(after, '2026-07-05')?.c === 9, 'the re-pulled lag days and the new days hold the fresh totals; older days stay as stored');
    // A segment sync in the old layout: the lag days' segment rows are replaced (one segment shape per
    // day), and the views pick one shape per day, so nothing is summed twice.
    const r2 = await new GscSync(stub(rowsFor('full')), dataDir, lowDisk).run(dsite, { startDate: '2026-06-20', endDate: '2026-06-30', dimensions: ['date', 'query', 'page', 'country'] }, noop, sig);
    ok(r2.storageMigrationDeferred && r2.startDate === '2026-06-26' && r2.rowsFetched === 20, `a deferred segment sync resumes from the stored segment rows (${r2.startDate}, ${r2.rowsFetched} rows)`);
    ok(segmentRowsIn(dfile, 'search_analytics_segments') === 0, 'old layout: no segment row went to the segment table');
    const twoSegShapes = one(dfile, `SELECT COUNT(*) n FROM (SELECT date FROM search_analytics WHERE (device <> '' OR country <> '') AND date >= '2026-06-25' GROUP BY date HAVING MIN(device <> '') <> MAX(device <> ''))`).n;
    ok(twoSegShapes === 0, 'the re-pulled segment days hold one segment shape each');
    const v2 = readerView(dfile);
    ok(tot(v2, '2026-06-26')?.c === 14 && tot(v2, '2026-06-26')?.i === 360, `a mixed day reads the fuller all-country totals once, not summed with the segments (${JSON.stringify(tot(v2, '2026-06-26'))})`);
    ok(tot(v2, '2026-06-28')?.c === 10 && tot(v2, '2026-06-28')?.i === 150, `a day held only in segment rows reads them as its totals (${JSON.stringify(tot(v2, '2026-06-28'))})`);
    const c29 = JSON.parse(v2.country).filter(x => x.date === '2026-06-29').reduce((a, x) => ({ c: a.c + x.c, i: a.i + x.i }), { c: 0, i: 0 });
    ok(c29.c === 10 && c29.i === 150, `the country breakdown reads one segment shape per day (${JSON.stringify(c29)})`);
    // Once there is room, the next migration moves it and every figure stays the same.
    const m = await migrate(dfile);
    ok(m.state === 'done' && segmentRowsIn(dfile, 'search_analytics') === 0, 'with room again, the deferred database migrates');
    const v3 = readerView(dfile);
    ok(v3.totals === v2.totals && v3.country === v2.country, 'totals and breakdowns are the same after the migration');
    for (const b of backups(dfile)) rmSync(path.join(path.dirname(dfile), b), { force: true });
  }
}

// ── 8. A sync that stops part-way writes nothing (review/04) ───────────────────────────────────────
// GSC pages rows sorted by clicks across the whole window, so page 1 touches every day with only its
// top rows. A failure or cancel after page 1 used to leave every day truncated (and the next
// incremental sync resumed from the latest day, never refilling them), and a search-type wipe or a
// segment window replace that rode page 1 destroyed the previous history.
{
  const site = 'sc-domain:partial.test';
  const window = { startDate: '2026-08-01', endDate: '2026-08-30' };
  const DATES = days(window.startDate, window.endDate);
  /** 4 rows a day (one 100-click head row, three 0-click tail rows), paged 30 at a time by clicks. */
  const rowsFor = (dims) => {
    const out = [];
    for (const d of DATES) for (let i = 0; i < 4; i++) {
      const k = { date: d, query: `q${i}`, page: `https://partial.test/p${i}`, device: 'MOBILE', country: 'gbr' };
      out.push({ keys: dims.map(x => k[x]), clicks: i === 0 ? 100 : 0, impressions: i === 0 ? 1000 : 50, ctr: 0, position: 5 });
    }
    return out.sort((a, b) => b.clicks - a.clicks);
  };
  const client = (opts = {}) => ({ async fetchSearchAnalytics(_s, o, signal, onPage) {
    const rows = rowsFor(o.dimensions).filter(r => r.keys[0] >= o.startDate && r.keys[0] <= o.endDate);
    for (let st = 0, pg = 0; st < rows.length; st += 30, pg++) {
      if (signal?.aborted) break; // GscClient stops paging on abort; it doesn't throw
      if (opts.failOnPage === pg) throw new Error('quota exceeded');
      onPage({ rows: rows.slice(st, st + 30) });
      if (opts.abortAfterPage === pg) opts.ctl.abort();
    }
    return rows.length;
  } });
  const sync = async (c, o = {}, ctl = new AbortController()) => {
    try { return await new GscSync(c, dataDir).run(site, { ...window, ...o }, () => {}, ctl.signal); } catch (e) { return { error: String(e.message) }; }
  };
  const stat = (table) => { const d = new AuditDatabase(dbPathFor(dataDir, site)); try { return d.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(impressions),0) i, COUNT(DISTINCT date) days FROM ${table}`).get(); } finally { d.close(); } };
  const synced = () => { const d = new AuditDatabase(dbPathFor(dataDir, site)); try { return d.db.prepare(`SELECT last_synced_at FROM property_meta WHERE site_url = ?`).get(site)?.last_synced_at ?? null; } finally { d.close(); } };

  const first = await sync(client({ failOnPage: 1 }));
  ok(first.error && stat('gsc_rows').n === 0, `a first sync failing on page 2 writes nothing (${stat('gsc_rows').n} rows)`);
  const retry = await sync(client());
  const all = stat('gsc_rows');
  ok(retry.rowsFetched === 120 && retry.startDate === window.startDate && all.n === 120 && all.i === 34500, `the retry fetches the whole window, not from the latest day (${retry.startDate}, ${all.n} rows, ${all.i} impressions)`);

  const seg = await sync(client(), { dimensions: FULL_DIMENSIONS, fullResync: true });
  const segBefore = stat('search_analytics_segments');
  ok(!seg.error && segBefore.n === 120, `a complete segment sync stores 120 segment rows (${segBefore.n})`);
  const segFail = await sync(client({ failOnPage: 1 }), { dimensions: FULL_DIMENSIONS, fullResync: true });
  const segAfter = stat('search_analytics_segments');
  ok(segFail.error && segAfter.n === 120 && segAfter.i === segBefore.i, `a segment fullResync failing on page 2 leaves the segment rows untouched (${segAfter.n})`);

  const totalsBefore = stat('gsc_rows');
  const disc = await sync(client({ failOnPage: 1 }), { searchType: 'discover' });
  const totalsAfter = stat('gsc_rows');
  ok(disc.error && totalsAfter.n === totalsBefore.n && totalsAfter.i === totalsBefore.i && stat('search_analytics_segments').n === 120, `a discover sync failing on page 2 does not wipe the web history (${totalsAfter.n} totals rows)`);

  const at = synced();
  const ctl = new AbortController();
  const cancelled = await sync(client({ abortAfterPage: 0, ctl }), { fullResync: true, searchType: 'discover' }, ctl);
  ok(cancelled.rowsFetched === 0 && cancelled.discarded === 30, `a cancelled sync reports the fetched rows as discarded (${JSON.stringify({ r: cancelled.rowsFetched, d: cancelled.discarded })})`);
  ok(stat('gsc_rows').n === totalsBefore.n && synced() === at, 'a cancelled sync writes nothing and leaves last_synced_at alone');

  const discOk = await sync(client(), { searchType: 'discover' });
  const d = stat('gsc_rows');
  ok(!discOk.error && d.n === 120 && d.days === 30, `a complete discover sync replaces the web history whole (${d.n} rows over ${d.days} days)`);
}

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
