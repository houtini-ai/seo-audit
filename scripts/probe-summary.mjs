#!/usr/bin/env node
// Site summary page, slice 1: the payload aggregations (src/core/summaryData.ts) over fixture DBs,
// one per property state the spec names ("Missing never renders as
// zero"): full history, under 13 months of GSC, no GSC, no crawl, one crawl, a stale snapshot.
// Run:  npm run build:server && node scripts/probe-summary.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { dbPathFor } from '../dist/core/paths.js';
import { robotsVerdict } from '../dist/core/robots.js';
import { AI_BOTS, AI_BOT_PATTERN } from '../dist/core/aiBots.js';
import { monthlyClicks, yearOnYear, clickWindows } from '../dist/core/summaryData.js';
import { buildVerdict } from '../dist/core/summaryVerdict.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const dataDir = path.join(tmpdir(), `sac-summary-${Date.now()}`);
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

/** Open a fresh property DB; the caller closes it before getDashboardData opens its own handle. */
function property(name) {
  const site = `sc-domain:${name}.test`;
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  return { site, adb, db: adb.db };
}
/** One GSC row per day from `from` to `to` (inclusive), skipping `skip` dates. */
function gscDays(db, from, to, clicks = 10, skip = new Set()) {
  const ins = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) {
      const d = iso(t);
      if (skip.has(d)) continue;
      ins.run(d, 'acme widgets', 'https://x.test/a', 'https://x.test/a', '', '', clicks, clicks * 10, 0.1, 4);
    }
  })();
}
const PAGE = (crawl, key, o = {}) => ({ crawl_id: crawl, url: key, url_key: key, status_code: 200, content_type: 'text/html', is_internal: 1, indexable: 1, title: 'T', ...o });
function pages(db, rows) {
  for (const r of rows) {
    const cols = Object.keys(r);
    db.prepare(`INSERT OR REPLACE INTO pages (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`).run(r);
  }
}
function crawl(db, id, finishedAt, status = 'completed') {
  db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,started_at,finished_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, 'https://x.test', 'x.test', status, 3, finishedAt, finishedAt);
}
function snapshot(db, crawlId, at, rows) {
  const ins = db.prepare(`INSERT INTO page_snapshots (crawl_id,url_key,captured_at,status_code,indexable,indexable_reason,title,meta_description,h1,canonical_key,robots,x_robots_tag,word_count,schema_types)
    VALUES (@crawl_id,@url_key,@captured_at,@status_code,@indexable,NULL,@title,NULL,NULL,@canonical_key,@robots,NULL,NULL,'')`);
  for (const r of rows) ins.run({ crawl_id: crawlId, captured_at: at, status_code: 200, indexable: 1, title: 'T', canonical_key: null, robots: null, ...r });
}
const CHECKS = JSON.stringify(['a-check', 'b-check']);
function audit(db, runId, at, crawlId, findings, checkIds = CHECKS) {
  db.prepare(`INSERT INTO audit_runs (run_id,crawl_id,scope,started_at,finished_at,finding_count,status,check_ids,health_basis) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(runId, crawlId, 'full', at, at, findings.length, 'completed', checkIds, 'audit');
  const ins = db.prepare(`INSERT INTO findings (run_id,check_id,category,severity,labels,certainty,url_key,evidence,traffic_at_risk,effort,priority,recommendation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [check, cat, sev, url, clicks = 0, labels = '["D"]'] of findings) {
    ins.run(runId, check, cat, sev, labels, 1, url, '{}', JSON.stringify({ clicks, impressions: clicks * 10, position: 4 }), '{}', 1 + clicks, JSON.stringify({ title: check, text: 'fix' }));
  }
}

// ── 1. Full property: 17 months of GSC, two crawls, two comparable audits, recon, bots ─────────
{
  const { site, adb, db } = property('full');
  const max = '2026-10-10';
  // From May 2025, with a gap day in May 2026 (that month is partial, never "complete").
  gscDays(db, '2025-05-20', max, 10, new Set(['2026-05-14']));
  // A page whose clicks jump (gaining) and one that falls (losing), plus one under the prior minimum.
  const ins = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0.1,3)`);
  for (let i = 0; i < 28; i++) {
    const cur = iso(Date.parse(max) - i * DAY), prev = iso(Date.parse(max) - (28 + i) * DAY);
    ins.run(cur, 'g', 'https://x.test/up', 'https://x.test/up', 5, 50); ins.run(prev, 'g', 'https://x.test/up', 'https://x.test/up', 1, 10);
    ins.run(cur, 'l', 'https://x.test/down', 'https://x.test/down', 0, 5); ins.run(prev, 'l', 'https://x.test/down', 'https://x.test/down', 3, 30);
    ins.run(cur, 'n', 'https://x.test/new', 'https://x.test/new', 9, 90);
    if (i === 0) ins.run(prev, 'n', 'https://x.test/new', 'https://x.test/new', 1, 10); // prior 1 click: below the minimum
  }
  crawl(db, 'c1', '2026-09-20T10:00:00Z');
  crawl(db, 'c2', '2026-10-09T10:00:00Z');
  snapshot(db, 'c1', '2026-09-20 10:00:00', [
    { url_key: 'https://x.test/a' }, { url_key: 'https://x.test/b' }, { url_key: 'https://x.test/c' }, { url_key: 'https://x.test/gone' },
  ]);
  snapshot(db, 'c2', '2026-10-09 10:00:00', [
    { url_key: 'https://x.test/a', status_code: 404 },              // now erroring
    { url_key: 'https://x.test/b', robots: 'noindex, follow' },      // noindex added
    { url_key: 'https://x.test/c', title: 'New title', canonical_key: 'https://x.test/a' },
    { url_key: 'https://x.test/added' },
  ]);
  pages(db, [PAGE('c2', 'https://x.test/a', { status_code: 404, indexable: 0 }), PAGE('c2', 'https://x.test/b', { indexable: 0 }), PAGE('c2', 'https://x.test/c'), PAGE('c2', 'https://x.test/added')]);
  audit(db, 'r1', '2026-09-20 11:00:00', 'c1', [
    ['a-check', 'indexation', 'crit', 'https://x.test/a'], ['a-check', 'indexation', 'crit', 'https://x.test/b'],
    ['b-check', 'onpage', 'med', 'https://x.test/c'],
  ]);
  audit(db, 'r2', '2026-10-09 11:00:00', 'c2', [
    ['a-check', 'indexation', 'crit', 'https://x.test/a', 40], ['a-check', 'indexation', 'high', 'https://x.test/added', 7],
    ['b-check', 'onpage', 'med', null, 0, '["D","N"]'],
  ]);
  const recon = db.prepare(`INSERT INTO recon_page (url_key,query,aio_present,aio_cites_us,researched_at) VALUES (?,?,?,?,?)`);
  recon.run('https://x.test/a', 'q1', 1, 1, '2026-10-01 00:00:00');
  recon.run('https://x.test/b', 'q2', 1, 0, '2026-10-01 00:00:00');
  recon.run('https://x.test/c', 'q3', 1, null, '2026-10-02 00:00:00');
  recon.run('https://x.test/added', 'q4', 0, 0, '2026-10-02 00:00:00');

  const m = monthlyClicks(db, max);
  const y = yearOnYear(db, max);
  adb.close();
  const d = getDashboardData(dataDir, site);

  ok(m.months.length === 16 && m.truncated?.monthsHeld === 18, `monthly: 16 months shown of 18 held, truncation reported (${m.months.length}/${m.truncated?.monthsHeld})`);
  ok(m.months.at(-1).month === '2026-10' && m.months.at(-1).partial && m.months.at(-1).days === 10, 'monthly: the current month is flagged partial (10 of 31 days)');
  const may = m.months.find(x => x.month === '2026-05');
  ok(may.partial && may.days === 30 && may.clicks === 300, `monthly: a month with a missing day is partial, its clicks are the real sum (${may.clicks})`);
  const sep = m.months.find(x => x.month === '2026-09');
  ok(!sep.partial && sep.days === 30, 'monthly: a full month is not partial');
  ok(y.available && y.priorWindow.start === '2025-09-14' && y.priorWindow.end === '2025-10-11', `yoy: prior window is 364 days earlier (${y.priorWindow?.start}..${y.priorWindow?.end})`);
  ok(y.available && y.priorYearDays === 28, 'yoy: the prior-year window is fully held');
  ok(d.monthly?.months?.length === 16 && d.yoy?.available === true, 'payload carries monthly + yoy');

  ok(d.drift?.snapshots === 2 && !!d.drift.counts, 'drift: two snapshots give counts');
  const c = d.drift.counts;
  ok(c.nowErroring === 1 && c.noindexAdded === 1 && c.canonicalChanged === 1 && c.titleChanged === 1, `drift: erroring 1, noindex 1, canonical 1, title 1 (${JSON.stringify(c)})`);
  ok(c.added === 1 && c.removed === 1, 'drift: one page added, one removed');
  ok(!d.drift.staleness, 'drift: the latest crawl is snapshotted, so no staleness banner');

  const cats = new Map(d.findings.byCategory.map(r => [r.category, r]));
  const ix = cats.get('indexation');
  ok(ix.crit === 1 && ix.high === 1 && ix.pages === 2, `byCategory: indexation crit 1 / high 1 over 2 pages (${JSON.stringify(ix)})`);
  ok(ix.opened === 1 && ix.resolved === 1, `byCategory: indexation opened 1 (added) and resolved 1 (b) since r1 (${ix.opened}/${ix.resolved})`);
  const op = cats.get('onpage');
  ok(op.site && op.pages === 0 && op.med === 1 && op.judgement === 1, `byCategory: a site-wide finding counts as one "site" row, judgement counted (${JSON.stringify(op)})`);
  ok(op.opened === 1 && op.resolved === 1, 'byCategory: onpage page finding resolved, site-wide one opened');
  const ac = d.findings.byCheck.find(b => b.check_id === 'a-check');
  ok(ac.clicksAtRisk === 47, `clicksAtRisk: summed over the check's distinct pages (${ac.clicksAtRisk})`);
  ok(d.findings.byCheck.find(b => b.check_id === 'b-check').clicksAtRisk === null, 'clicksAtRisk: null (not 0) when the check flags no page');
  ok(d.findings.top.every(f => typeof f.labels === 'string'), 'top findings carry their D/N labels');

  ok(d.aiOverview?.checked === 4 && d.aiOverview.present === 3 && d.aiOverview.cited === 1, 'aiOverview: 4 checked, 3 with an AI Overview, 1 cited');
  ok(d.aiOverview.unknown === 1 && d.aiOverview.notCited === 1, 'aiOverview: an unresolved citation (NULL) is unknown, never "not cited"');

  ok(d.pageMovers.gaining[0]?.urlKey === 'https://x.test/up' && d.pageMovers.losing[0]?.urlKey === 'https://x.test/down', 'pageMovers: biggest gainer and loser');
  ok(!d.pageMovers.gaining.some(g => g.urlKey === 'https://x.test/new') && d.pageMovers.minPriorClicks === 10, 'pageMovers: a page under the stated 10-prior-click minimum is not ranked');

  ok(d.events.filter(e => e.kind === 'crawl').length === 2 && d.events.filter(e => e.kind === 'audit').length === 2, 'events: two crawls and two audits');
  ok(d.coverage.inspected === 0 && d.coverage.inspectedIndexable === 0 && d.coverage.indexablePages === 2, `coverage: inspection counts only indexable crawled pages (${d.coverage.inspectedIndexable} of ${d.coverage.indexablePages})`);
  ok(d.coverage.gsc.months === 18 && d.coverage.crawlPages === 4, `coverage: 18 months of GSC, 4 crawled pages (${JSON.stringify(d.coverage.gsc)})`);
  ok(d.freshness.auditVsCrawl?.predatesCrawl === false && d.freshness.auditVsCrawl.auditCrawlId === 'c2', 'freshness: the audit read the latest crawl');
}

// ── 2. Under 13 months of GSC; one crawl; the audit predates the latest crawl ──────────────────
{
  const { site, adb, db } = property('young');
  gscDays(db, '2026-06-15', '2026-10-10');
  crawl(db, 'c1', '2026-10-01T10:00:00Z');
  snapshot(db, 'c1', '2026-10-01 10:00:00', [{ url_key: 'https://x.test/a' }]);
  pages(db, [PAGE('c1', 'https://x.test/a')]);
  audit(db, 'r1', '2026-09-01 11:00:00', null, [['a-check', 'indexation', 'crit', 'https://x.test/a']]);
  adb.close();
  const d = getDashboardData(dataDir, site);
  ok(d.yoy?.available === false && d.yoy.reason === 'needs-13-months', 'yoy: unavailable with a reason under 13 months (never "0%")');
  ok(d.monthly.months[0].month === '2026-06' && d.monthly.months[0].partial && !d.monthly.truncated, 'monthly: the first month (history starts mid-month) is partial; nothing truncated');
  ok(d.drift.snapshots === 1 && d.drift.counts === null, 'drift: one crawl gives null counts ("needs two crawls"), not zeros');
  ok(d.freshness.auditVsCrawl?.predatesCrawl === true, 'freshness: an audit older than the latest completed crawl is flagged');
  ok(d.findings.byCategory[0].opened === null, 'byCategory: no comparable previous audit gives null deltas, not 0');
}

// ── 3. No GSC (crawl + audit only) ─────────────────────────────────────────────────────────────
{
  const { site, adb, db } = property('nogsc');
  crawl(db, 'c1', '2026-10-01T10:00:00Z');
  snapshot(db, 'c1', '2026-10-01 10:00:00', [{ url_key: 'https://x.test/a' }, { url_key: 'https://x.test/b' }]);
  pages(db, [PAGE('c1', 'https://x.test/a'), PAGE('c1', 'https://x.test/b')]);
  audit(db, 'r1', '2026-10-01 11:00:00', 'c1', [['a-check', 'indexation', 'crit', 'https://x.test/a']]);
  adb.close();
  const d = getDashboardData(dataDir, site);
  ok(d.empty === true && !d.summary && d.monthly === undefined && d.yoy === undefined && d.pageMovers === undefined, 'no GSC: empty, and no traffic field is present (none faked as 0)');
  ok(d.healthScore?.score === 50 && d.findings?.byCategory?.length === 1, `no GSC: health and findings by area still ship (health ${d.healthScore?.score})`);
  ok(d.coverage.gsc === null && d.coverage.crawlPages === 2, 'no GSC: coverage says no Search Console, 2 crawled pages');
  ok(d.drift.counts === null && d.events.length === 2, 'no GSC: drift and events still ship');
  const again = getDashboardData(dataDir, site);
  ok(again.empty === true && again.healthScore?.score === 50, 'no GSC: the cached crawl-only payload round-trips');
}

// ── 4. No crawl (GSC only) ─────────────────────────────────────────────────────────────────────
{
  const { site, adb, db } = property('nocrawl');
  gscDays(db, '2026-08-01', '2026-10-10');
  adb.close();
  const d = getDashboardData(dataDir, site);
  ok(!d.empty && d.monthly.months.length === 3, 'no crawl: traffic panels build');
  ok(d.findings === null && d.healthScore === null, 'no crawl: no findings, no health (not 0, not 100)');
  ok(d.drift.snapshots === 0 && d.drift.counts === null && d.coverage.crawlPages === 0, 'no crawl: drift has no snapshots');
  ok(d.aiOverview === null, 'no recon: aiOverview is null');
}

// ── 4b. A prior window that isn't held is missing, never zero or a partial window ─────────────────
// Flat traffic, 10 clicks a day. With 28 days held, the prior 28 read as 0 ("up from none"); with
// 40 days held, 12 of the prior 28 days made flat traffic "+133%".
{
  const max = '2026-10-10';
  const text = (v) => v.segments.map(x => x.text).join('');
  const flat = (name, daysHeld, skip = new Set()) => {
    const { site, adb, db } = property(name);
    gscDays(db, iso(Date.parse(max) - (daysHeld - 1) * DAY), max, 10, skip);
    const w = clickWindows(db, max);
    adb.close();
    return { site, w };
  };
  for (const held of [28, 40]) {
    const { site, w } = flat(`held${held}`, held);
    const p = getDashboardData(dataDir, site);
    ok(w.prior === null && w.current === 280, `${held} days held: the prior 28 days are missing (null), not ${held === 28 ? '0' : 'a partial sum'} (${w.prior})`);
    ok(p.summary.prior === null, `${held} days held: the KPI prior is null (${JSON.stringify(p.summary.prior)})`);
    ok(p.topKeywords[0]?.prevClicks === null && p.topKeywords[0]?.prevPosition === null, `${held} days held: top keywords carry no prior clicks or position`);
    const v = text(buildVerdict({ clicks: { current: p.clickWindows.current, prior: p.clickWindows.prior } }));
    ok(!/up from none|%/.test(v) && /no comparison/.test(v), `${held} days held: the verdict makes no comparison (${v})`);
  }
  const full = flat('held60', 60);
  ok(full.w.prior === 280 && text(buildVerdict({ clicks: { current: full.w.current, prior: full.w.prior } })) === 'Organic clicks are flat on the prior 28 days.', `60 days held: the prior 28 compare, and flat reads flat (${full.w.prior})`);
  const gaps = new Set(Array.from({ length: 10 }, (_, i) => iso(Date.parse(max) - (35 + i) * DAY)));
  const gappy = flat('gappy', 60, gaps);
  ok(gappy.w.prior === null && gappy.w.priorDays === 18, `a 10-day sync gap in the prior window: no comparison (${gappy.w.prior}, ${gappy.w.priorDays} days)`);
  // Year on year: 400 days held, but 21 days missing from the prior-year window.
  const yGaps = new Set(Array.from({ length: 21 }, (_, i) => iso(Date.parse(max) - (364 + 3 + i) * DAY)));
  const { db: ydb, adb: yadb } = property('yoygaps');
  gscDays(ydb, iso(Date.parse(max) - 399 * DAY), max, 10, yGaps);
  const y = yearOnYear(ydb, max);
  yadb.close();
  ok(y.available === false && y.reason === 'prior-year-gaps' && y.priorYearDays === 7 && y.currentDays === 28, `year-on-year with 7 of 28 prior-year days held is unavailable, not "+300%" (${JSON.stringify(y)})`);
}

// ── 5. A completed crawl that never made it into page_snapshots: staleness, not a current diff ─
{
  const { site, adb, db } = property('stale');
  crawl(db, 'c1', '2026-09-01T10:00:00Z'); crawl(db, 'c2', '2026-09-15T10:00:00Z'); crawl(db, 'c3', '2026-10-01T10:00:00Z');
  snapshot(db, 'c1', '2026-09-01 10:00:00', [{ url_key: 'https://x.test/a' }]);
  snapshot(db, 'c2', '2026-09-15 10:00:00', [{ url_key: 'https://x.test/a', title: 'changed' }]);
  pages(db, [PAGE('c3', 'https://x.test/a')]);
  adb.close();
  const d = getDashboardData(dataDir, site);
  ok(d.drift.staleness?.newestCrawl === 'c3', 'drift: a newer unsnapshotted crawl sets staleness, so the UI shows the banner instead of the counts');
}

// ── 5b. Mixed GSC row shapes (all-country AND per-country rows for the same days) ─────────────
// Found live on simracingcockpit.gg: a plain SUM counts those days twice. Every total reads gsc_rows,
// which reads one shape per mixed day (the one with more impressions: here the per-country rows), so
// each day counts once (#61; the full regression is scripts/probe-gsc-rows.mjs).
{
  const { site, adb, db } = property('mixed');
  // The #64 layout (mixed shapes in search_analytics) only exists in databases written before #65: drop the guard to build one.
  db.exec(`DROP TRIGGER IF EXISTS sa_totals_only; DROP TRIGGER IF EXISTS sa_totals_only_upd; DELETE FROM gsc_storage_state;`);
  const ins = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (let t = Date.parse('2026-08-01'); t <= Date.parse('2026-10-10'); t += DAY) {
      const d = iso(t);
      const u = 'https://x.test/p';
      ins.run(d, 'q', u, u, '', '', 10, 50, 0.2, 3);                    // all-country (lite): clicks right, impressions short
      if (d <= '2026-09-05') { ins.run(d, 'q', u, u, '', 'gbr', 6, 70, 0.1, 3); ins.run(d, 'q', u, u, '', 'usa', 4, 30, 0.1, 3); } // per-country: 10 clicks, 100 impressions
    }
  })();
  adb.close();
  const d = getDashboardData(dataDir, site);
  ok(d.gscShape?.mixedDays === 36 && d.gscShape.from === '2026-08-01' && d.gscShape.to === '2026-09-05' && d.gscShape.shapes.join() === 'all-country,per-country', `gscShape: 36 mixed days reported (${JSON.stringify(d.gscShape)})`);
  const aug = d.monthly.months.find(m => m.month === '2026-08');
  ok(aug.clicks === 310 && aug.impressions === 3100, `monthly: a mixed month counts each day once, read from the fuller per-country rows (${aug.clicks} / ${aug.impressions})`);
  const sep = d.monthly.months.find(m => m.month === '2026-09');
  ok(sep.clicks === 300 && sep.impressions === 5 * 100 + 25 * 50, `monthly: a month that changes shape mid-way (${sep.clicks} / ${sep.impressions})`);
  ok(d.clickWindows.current === 280 && d.clickWindows.prior === 280, `clickWindows: 280 vs 280, not inflated by the mixed days (${d.clickWindows.current} vs ${d.clickWindows.prior})`);
  ok(d.summary.prior.clicks === d.clickWindows.prior && d.summary.prior.impressions === 21 * 100 + 7 * 50, `the dashboard KPI totals count each day once too (${d.summary.prior.clicks} / ${d.summary.prior.impressions})`);
  ok(d.pageMovers.gaining.length === 0 && d.pageMovers.losing.length === 0, 'pageMovers: no phantom loser from doubled prior clicks');
}

// ── 5c. Average position is weighted by impressions, never a plain mean of rows ─────────────────
// One query, two pages: page A 1,000 impressions at #2, page B 1 impression at #50. The true
// average position is (1000×2 + 1×50) / 1001 = 2.05; a plain mean of rows says 26.
{
  const { site, adb, db } = property('weighted');
  const max = '2026-10-10';
  const ins = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const seg = db.prepare(`INSERT INTO search_analytics_segments (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (let i = 0; i < 60; i++) {
      const d = iso(Date.parse(max) - i * DAY);
      ins.run(d, 'widgets', 'https://x.test/a', 'https://x.test/a', '', '', 50, 1000, 0.05, 2);
      ins.run(d, 'widgets', 'https://x.test/b', 'https://x.test/b', '', '', 0, 1, 0, 50);
      // Device segments: desktop 900 impressions at #2 plus 1 at #50 (weighted 2.05), mobile 1 at #40.
      seg.run(d, 'widgets', 'https://x.test/a', 'https://x.test/a', 'DESKTOP', '', 45, 900, 0.05, 2);
      seg.run(d, 'widgets', 'https://x.test/b', 'https://x.test/b', 'DESKTOP', '', 0, 1, 0, 50);
      seg.run(d, 'widgets', 'https://x.test/a', 'https://x.test/a', 'MOBILE', '', 0, 1, 0, 40);
    }
  })();
  adb.close();
  const p = getDashboardData(dataDir, site);
  const near = (v, want) => v != null && Math.abs(v - want) < 0.06;
  ok(near(p.summary.current.position, 2.05), `weighted: Summary average position is impression-weighted (${p.summary.current.position})`);
  ok(near(p.topKeywords[0]?.position, 2.05), `weighted: top keyword position is impression-weighted (${p.topKeywords[0]?.position})`);
  ok(near(p.rankTrend.at(-1)?.position, 2.05), `weighted: daily rank trend position is impression-weighted (${p.rankTrend.at(-1)?.position})`);
  ok(!p.strikingDistance.some(r => r.query === 'widgets'), 'weighted: a query averaging #2 is not listed as striking distance (11-20)');
  ok(p.quickWins.find(r => r.query === 'widgets')?.position === p.topKeywords[0]?.position, 'weighted: the quick-wins and top-keyword positions agree');
  const a = p.pagePerformance.find(r => r.urlKey === 'https://x.test/a');
  ok(a && a.position < 3, `weighted: page position is impression-weighted (${a?.position})`);
  const mobile = p.deviceBreakdown.find(d => d.device === 'MOBILE'), desktop = p.deviceBreakdown.find(d => d.device === 'DESKTOP');
  ok(desktop?.position === 2.1 && mobile?.position === 40, `weighted: device positions are impression-weighted per device (${desktop?.position}, ${mobile?.position})`);
}

// ── 6. AI bots: one list, robots verdicts per RFC 9309 group matching ─────────────────────────
{
  const robots = 'User-agent: *\nDisallow: /cart\n\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: CCBot\nDisallow: /\n';
  const gpt = robotsVerdict(robots, 'GPTBot'), cc = robotsVerdict(robots, 'CCBot'), oai = robotsVerdict(robots, 'OAI-SearchBot');
  ok(gpt.named && gpt.allowed, 'robotsVerdict: a named Allow group');
  ok(cc.named && !cc.allowed, 'robotsVerdict: a named Disallow: / group is blocked');
  ok(!oai.named && oai.allowed, 'robotsVerdict: an unnamed bot falls under * (allowed at the root)');
  ok(!robotsVerdict('User-agent: *\nDisallow: /\n', 'ClaudeBot').allowed, 'robotsVerdict: * Disallow: / blocks an unnamed bot');
  const group = Object.fromEntries(AI_BOTS.map(b => [b.token, b.group]));
  ok(group.GPTBot === 'training' && group['OAI-SearchBot'] === 'search' && group['ChatGPT-User'] === 'search', 'aiBots: GPTBot is training; OAI-SearchBot and ChatGPT-User are search');
  ok(group.ClaudeBot === 'training' && group['Google-Extended'] === 'training' && group.PerplexityBot === 'search', 'aiBots: ClaudeBot and Google-Extended training, PerplexityBot search');
  ok(AI_BOT_PATTERN.test('User-agent: anthropic-ai') && !AI_BOT_PATTERN.test('User-agent: Googlebot'), 'aiBots: the rules pattern covers legacy tokens and not Googlebot');
}

// ── 7. The verdict template: built only from panel values, clauses omitted when missing ─────────
{
  const text = (v) => v.segments.map(x => x.text).join('');
  const full = buildVerdict({ clicks: { current: 880, prior: 1000 }, nonBrand: { current: 410, prior: 500, brand: 'acme' }, criticalOpen: 3, resolvedSinceLastAudit: 14, pagesChanged: 27 });
  ok(text(full) === 'Organic clicks are down 12% on the prior 28 days (non-brand down 18%); 3 critical issues are open, 14 resolved since the last audit; 27 pages changed since the last crawl.', `verdict: the full sentence (${text(full)})`);
  const nbFromNone = buildVerdict({ clicks: { current: 880, prior: 1000 }, nonBrand: { current: 40, prior: 0, brand: 'acme' } });
  ok(text(nbFromNone) === 'Organic clicks are down 12% on the prior 28 days (non-brand up from none).', `verdict: non-brand from zero says "up from none", not nothing (${text(nbFromNone)})`);
  const nbNone = buildVerdict({ clicks: { current: 880, prior: 1000 }, nonBrand: { current: 0, prior: 0, brand: 'acme' } });
  ok(text(nbNone) === 'Organic clicks are down 12% on the prior 28 days (non-brand flat).', `verdict: non-brand zero in both windows reads flat (${text(nbNone)})`);
  ok(full.chips.map(c => c.direction).join() === 'down,neutral,neutral', 'verdict: chips coloured by direction only');
  ok(text(buildVerdict({ clicks: { current: 1030, prior: 1000 } })) === 'Organic clicks are flat on the prior 28 days.', 'verdict: inside the ±5% dead band reads flat');
  const noGsc = buildVerdict({ criticalOpen: 1, pagesChanged: 0 });
  ok(text(noGsc) === '1 critical issue is open; 0 pages changed since the last crawl.' && !/clicks/i.test(text(noGsc)), 'verdict, no GSC: traffic clauses dropped');
  const noAudit = buildVerdict({ clicks: { current: 1200, prior: 1000 }, pagesChanged: null });
  ok(text(noAudit) === 'Organic clicks are up 20% on the prior 28 days.', 'verdict, no audit or one crawl: only the traffic clause, never "0 critical"');
  ok(!/resolved/.test(text(buildVerdict({ criticalOpen: 2, resolvedSinceLastAudit: null }))), 'verdict: no comparable audit pair, no "resolved" clause');
  ok(buildVerdict({}).empty === true, 'verdict: nothing to say renders the empty state');
}

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
