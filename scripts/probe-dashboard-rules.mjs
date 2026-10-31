#!/usr/bin/env node
// Dashboard display rules (src/core/displayRules.ts) and the real-data fixes from the
// directdrivewheels.com rehearsal (#68 follow-up): rank changes in positions, the small-base rule,
// one share-rounding rule, the health cap, one freshness rule, run labels on same-day runs, the
// empty-state reasons, and the brand rule on exact-match domains.
// Run:  npm run build:server && node scripts/probe-dashboard-rules.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { CAT_NAME } from '../dist/audit/report.js';
import {
  countChange, shareText, sharePct, capHealth, rankChange, SMALL_BASE_MIN,
  assessField, fieldValue, fieldWindowLagDays, quickWinsEmptyReason, trappedEmptyReason,
  sourceFreshness, freshnessDot, GSC_STALE_DAYS, SNAPSHOT_STALE_DAYS, runLabels, CATEGORY_LABEL, categoryLabel, breakdownsEmptyReason,
} from '../dist/core/displayRules.js';
import { cwvFieldPayload } from '../dist/core/CruxSync.js';
import { loadBrandQueries, spacedIsUncertain } from '../dist/core/brand.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { listFindings } from '../dist/core/findingsQuery.js';
import { runSingleCheck } from '../dist/audit/engine.js';
import { domainPickerOptions, currentPickerValue } from '../dist/core/domainPicker.js';
import { META_DESC_MAX_CHARS } from '../dist/core/onPageLimits.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { computeHealth } from '../dist/audit/history.js';
import { dbPathFor } from '../dist/core/paths.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const dataDir = path.join(tmpdir(), `sac-rules-${Date.now()}`);

// ── 1. Rank change: positions, never a % of a rank ───────────────────────────────────────────
console.log('rank change');
{
  const worse = rankChange(29.3, 17.0);
  ok(worse.positions === 12.3 && !worse.better && !worse.flat, `17.0 -> 29.3 is 12.3 positions worse (${JSON.stringify(worse)})`);
  const better = rankChange(5.1, 8.5);
  ok(better.positions === 3.4 && better.better, `8.5 -> 5.1 is 3.4 positions better (${JSON.stringify(better)})`);
  ok(rankChange(4.02, 4.0).flat, 'a 0.02 move is flat');
}

// ── 2. Small-base rule ─────────────────────────────────────────────────────────────────────────
console.log('small-base change');
{
  const zeroToOne = countChange(1, 0);
  ok(zeroToOne.mode === 'abs' && zeroToOne.value === 1, `0 -> 1 is "+1", not +100% (${JSON.stringify(zeroToOne)})`);
  ok(countChange(6, 2).mode === 'abs', '2 -> 6 is a count change, not +200%');
  ok(countChange(3, SMALL_BASE_MIN - 1).mode === 'abs', `a prior of ${SMALL_BASE_MIN - 1} is still a small base`);
  const big = countChange(28, 84);
  ok(big.mode === 'pct' && Math.round(big.value) === -67, `84 -> 28 is -67% (${big.value.toFixed(1)})`);
  ok(countChange(5, SMALL_BASE_MIN).mode === 'pct', `a prior of exactly ${SMALL_BASE_MIN} takes a percentage`);
}

// ── 3. One share-rounding rule ─────────────────────────────────────────────────────────────────
console.log('share rounding');
{
  ok(shareText(2, 495) === '<1', `2 of 495 reads "<1" (got ${shareText(2, 495)})`);
  ok(shareText(0, 495) === '0', '0 of 495 reads "0"');
  ok(shareText(493, 495) === '>99', `493 of 495 reads ">99", never 100 (got ${shareText(493, 495)})`);
  ok(shareText(495, 495) === '100', 'all of them reads "100"');
  ok(sharePct(63, 495) === '13%', `63 of 495 reads 13% (got ${sharePct(63, 495)})`);
  ok(shareText(5, 0) === '0', 'an empty base reads "0", not NaN');
}

// ── 4. Health never reads 100 with a critical or high page ─────────────────────────────────────
console.log('health cap');
{
  ok(capHealth(100, 1) === 99, '100 with one error page is capped at 99');
  ok(capHealth(100, 0) === 100, '100 with no error page stays 100');
  ok(capHealth(87, 12) === 87, 'scores under 100 are untouched');
  const site = 'sc-domain:health.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  adb.db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,started_at,finished_at) VALUES ('c1','https://health.test','health.test','completed',495,datetime('now'),datetime('now'))`).run();
  const ins = adb.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable) VALUES ('c1',?,?,200,'text/html',1,1)`);
  for (let i = 0; i < 495; i++) ins.run(`https://health.test/p${i}`, `https://health.test/p${i}`);
  adb.db.prepare(`INSERT INTO audit_runs (run_id,crawl_id,scope,started_at,finished_at,finding_count,status) VALUES ('r1','c1','full',datetime('now'),datetime('now'),1,'completed')`).run();
  adb.db.prepare(`INSERT INTO findings (run_id,check_id,category,severity,url_key,labels,evidence,recommendation) VALUES ('r1','x','onpage','high','https://health.test/p3','[]','{}','{}')`).run();
  const h = computeHealth(adb.db, 'r1');
  ok(h.score === 99 && h.errorPages === 1, `1 high page of 495: stored health is 99, not 100 (${JSON.stringify(h)})`);
  adb.close();
}

// ── 5. Field CWV: thin CrUX data is shown honestly ────────────────────────────────────────────
console.log('field CWV (CrUX)');
{
  const good = (p75) => ({ p75, band: 'good' });
  const thin = assessField({ lcp: good(722), inp: null, cls: good(0) });
  ok(thin.status === 'pass' && thin.missing.join() === 'INP', `LCP + CLS good, no INP: pass on what was measured, INP listed as missing (${JSON.stringify(thin)})`);
  ok(fieldValue('inp', null) === null && fieldValue('inp', undefined) === null, 'a missing INP renders as no value (the UI says "not enough Chrome traffic"), never 0');
  ok(fieldValue('cls', 0) === '0.00' && fieldValue('lcp', 722) === '0.72 s' && fieldValue('inp', 180) === '180 ms', 'a measured zero stays a value: CLS 0.00; LCP in s, INP in ms');
  ok(assessField({ lcp: { p75: 3100, band: 'needs-improvement' }, inp: null, cls: good(0.02) }).status === 'fail', 'a needs-improvement LCP fails the assessment');
  ok(assessField({ lcp: null, inp: null, cls: good(0.02) }).status === 'unknown', 'no LCP: not assessable, never a pass');
  ok(fieldWindowLagDays('2026-08-01', '2026-10-17 16:20:57') === 78, 'a window ending 1 Aug checked 17 Oct is 78 days old');

  // The directdrivewheels.com shape: two weekly history windows, no current record, no INP.
  const site = 'sc-domain:crux.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  const ins = adb.db.prepare(`INSERT INTO crux_metrics (scope,target,form_factor,metric,period_first,period_last,p75,good,ni,poor,source) VALUES ('origin','https://crux.test',?,?,?,?,?,?,?,?,'history')`);
  for (const ff of ['PHONE', 'DESKTOP']) {
    ins.run(ff, 'cumulative_layout_shift', '2026-06-28', '2026-07-25', 0, 0.95, 0.04, 0.01);
    ins.run(ff, 'cumulative_layout_shift', '2026-07-05', '2026-08-01', 0, 0.95, 0.04, 0.01);
    ins.run(ff, 'largest_contentful_paint', '2026-07-05', '2026-08-01', 722, 0.98, 0.02, 0);
  }
  adb.db.prepare(`INSERT INTO crux_targets (scope,target,form_factor,status,last_checked) VALUES ('origin','https://crux.test','PHONE','ok','2026-10-17 16:20:57')`).run();
  const cf = cwvFieldPayload(adb.db);
  const ph = cf?.formFactors?.PHONE;
  ok(ph?.source === 'history' && ph?.windows === 2, `history-only origin: source "history", 2 windows held (${ph?.source}, ${ph?.windows})`);
  ok(ph?.metrics?.inp === null && ph?.history?.inp?.length === 0, 'no INP rows: inp is null and its history empty (not zeros)');
  ok(cf?.lastChecked === '2026-10-17 16:20:57', 'the last check date ships, so the UI can say how old the window is');
  adb.close();
}

// ── 5b. A failed or still-running audit never replaces the latest completed one ──────────────
// A failed run's findings are rolled back and a running one has none yet: reading either as "the
// latest audit" showed health 100 and "0 critical" on a site with open critical issues.
console.log('latest completed audit');
{
  const site = 'sc-domain:runs.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  const db = adb.db;
  db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,started_at,finished_at) VALUES ('c1','https://runs.test','runs.test','completed',10,'2026-10-01 10:00:00','2026-10-01 10:10:00')`).run();
  const insPage = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,title) VALUES ('c1',?,?,200,'text/html',1,1,'T')`);
  for (let i = 0; i < 10; i++) insPage.run(`https://runs.test/p${i}`, `https://runs.test/p${i}`);
  const insRun = db.prepare(`INSERT INTO audit_runs (run_id,crawl_id,scope,started_at,finished_at,finding_count,status) VALUES (?,?,?,?,?,?,?)`);
  insRun.run('good', 'c1', 'core', '2026-10-02 09:00:00', '2026-10-02 09:01:00', 5, 'completed');
  const insF = db.prepare(`INSERT INTO findings (run_id,check_id,category,severity,labels,certainty,url_key,evidence,traffic_at_risk,effort,priority,recommendation) VALUES ('good','x-crit','indexation','crit','["D"]',1,?,'{}','{}','{}',1,'{"title":"x","text":"y"}')`);
  for (let i = 0; i < 5; i++) insF.run(`https://runs.test/p${i}`);
  insRun.run('broke', 'c1', 'core', '2026-10-03 09:00:00', '2026-10-03 09:00:30', 0, 'failed');
  adb.close();
  const failed = getDashboardData(dataDir, site);
  ok(failed.findings?.runId === 'good', `a later FAILED run: the dashboard still shows the completed run (${failed.findings?.runId})`);
  ok(failed.healthScore?.score === 50, `a later FAILED run: health stays 50, not 100 (${failed.healthScore?.score})`);
  const listed = listFindings(dataDir, site, { severity: 'crit' });
  ok(listed.runId === 'good' && listed.total === 5, `a later FAILED run: list_findings pages the completed run (${listed.runId}, ${listed.total})`);
  const adb2 = new AuditDatabase(dbPathFor(dataDir, site));
  adb2.db.prepare(`INSERT INTO audit_runs (run_id,crawl_id,scope,started_at,finished_at,finding_count,status) VALUES ('busy','c1','core','2026-10-04 09:00:00',NULL,NULL,'running')`).run();
  adb2.close();
  const running = getDashboardData(dataDir, site);
  ok(running.findings?.runId === 'good' && running.healthScore?.score === 50, `a RUNNING audit: the completed run is still shown (${running.findings?.runId}, ${running.healthScore?.score})`);
}

// ── 6. Empty states name the true reason ──────────────────────────────────────────────────────
console.log('empty-state reasons');
{
  const noRows = quickWinsEmptyReason({ hasGsc: true, plotted: 0, wins: 0 });
  ok(!/sync/i.test(noRows) && /50 impressions/.test(noRows) && /20 or better/.test(noRows), `GSC held, nothing qualifies: names the rule, never "sync Search Console" (${noRows})`);
  ok(/sync_gsc/.test(quickWinsEmptyReason({ hasGsc: false, plotted: 0, wins: 0 })), 'no GSC at all: asks for sync_gsc');
  ok(/each of the 7 queries/.test(quickWinsEmptyReason({ hasGsc: true, plotted: 7, wins: 0 })), 'queries plotted but no win: says they click at the expected rate');
  ok(quickWinsEmptyReason({ hasGsc: true, plotted: 7, wins: 3 }) === null, 'with wins there is no empty state');
  const stored = trappedEmptyReason({ backlinkPages: 2, hasKey: false });
  ok(/2 backlinked pages stored/.test(stored) && !/connect|key/i.test(stored), `backlinks stored but no key: reads the stored data, not the key (${stored})`);
  ok(/DataForSEO key/.test(trappedEmptyReason({ backlinkPages: 0, hasKey: false })), 'nothing stored and no key: says a key is needed');
  ok(/pull_backlinks/.test(trappedEmptyReason({ backlinkPages: 0, hasKey: true })), 'nothing stored, key set: asks for pull_backlinks');
}

// ── 7. Brand on exact-match domains ──────────────────────────────────────────────────────────
console.log('brand on exact-match domains');
{
  ok(spacedIsUncertain({ impressions: 68 }, { impressions: 0, clicks: 0 }), 'spaced phrase with impressions, one-word brand never searched: uncertain');
  ok(!spacedIsUncertain({ impressions: 66444 }, { impressions: 7668, clicks: 180 }), 'SRC shape: spaced out-draws the one-word brand, but the one-word brand earns clicks: stays brand');
  ok(!spacedIsUncertain({ impressions: 10 }, { impressions: 40, clicks: 0 }), 'the one-word brand out-draws the spaced phrase: stays brand');

  const gsc = (site, host, rows) => {
    const adb = new AuditDatabase(dbPathFor(dataDir, site));
    adb.upsertProperty(site, 'apex');
    const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0.1,8)`);
    const u = `https://${host}/`;
    adb.db.transaction(() => {
      for (let t = Date.parse('2026-08-01'); t <= Date.parse('2026-09-30'); t += 86_400_000) {
        const d = new Date(t).toISOString().slice(0, 10);
        for (const [q, c, i] of rows) ins.run(d, q, u, u, c, i);
      }
    })();
    return adb;
  };
  // directdrivewheels.com: the stem is the category; nobody types the brand as one word.
  {
    const site = 'sc-domain:directdrivewheels.test';
    const adb = gsc(site, 'directdrivewheels.test', [['direct drive wheels', 1, 40], ['best direct drive wheels', 0, 20], ['moza r9 review', 2, 30]]);
    const m = loadBrandQueries(adb.db, site);
    ok(m.queries === 0 && m.uncertain?.reason === 'exact-match-domain' && m.uncertain.spellings.join() === 'direct drive wheels', `"direct drive wheels" is set aside as uncertain, not branded (${JSON.stringify(m)})`);
    adb.close();
    const b = getDashboardData(dataDir, site).brandedSplit;
    ok(b.branded.clicks === 0 && b.nonBranded.clicks === 28 * 3, `branded split counts the generic phrase as non-brand (${b.branded.clicks} / ${b.nonBranded.clicks})`);
    ok(b.uncertain?.spellings?.[0] === 'direct drive wheels', 'the payload carries the uncertain spelling for the UI');
  }
  // The same domain once people search the brand as one word: concatenated and dotted forms
  // are always brand, and their clicks bring the spaced spelling back.
  {
    const site = 'sc-domain:directdrivewheelsuk.test';
    const adb = gsc(site, 'directdrivewheelsuk.test', [['direct drive wheels uk', 0, 40], ['directdrivewheelsuk', 1, 5], ['directdrivewheelsuk.test', 0, 2]]);
    const m = loadBrandQueries(adb.db, site);
    ok(m.uncertain === null && ['directdrivewheelsuk', 'direct drive wheels uk'].every(v => m.variants.includes(v)), `joined spelling with clicks: spaced spelling counts as brand again (${m.variants.join(' | ')})`);
    adb.close();
  }
  {
    const site = 'sc-domain:directdrivewheelseu.test';
    const adb = gsc(site, 'directdrivewheelseu.test', [['direct drive wheels eu', 0, 40], ['directdrivewheelseu.test', 0, 3]]);
    const m = loadBrandQueries(adb.db, site);
    ok(m.variants.includes('directdrivewheelseu') && m.uncertain?.spellings?.[0] === 'direct drive wheels eu', `the dotted form stays brand while the spaced form is uncertain (${JSON.stringify(m)})`);
    adb.close();
  }
}

// ── 8. One meta-description limit for Crawl health and the audit ─────────────────────────────
console.log('meta description limit');
{
  const site = 'sc-domain:meta.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  adb.db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,started_at,finished_at) VALUES ('m1','https://meta.test','meta.test','completed',4,datetime('now'),datetime('now'))`).run();
  const ins = adb.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,title,meta_description,meta_description_length) VALUES ('m1',?,?,200,'text/html',1,1,?,?,?)`);
  [150, 158, 161, 175].forEach((len, i) => ins.run(`https://meta.test/p${i}`, `https://meta.test/p${i}`, `Title ${i}`, 'x'.repeat(len), len));
  adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES ('2026-09-01','q','https://meta.test/p0','https://meta.test/p0','','',1,10,0.1,5)`).run();
  adb.close();
  const metas = getDashboardData(dataDir, site).crawlHealth?.metas ?? [];
  const over = metas.find(r => /^Over/.test(r.label));
  const check = runSingleCheck(dataDir, site, 'meta-description-length');
  ok(over?.label === `Over ${META_DESC_MAX_CHARS} characters` && over.count === 2, `Crawl health counts meta descriptions over ${META_DESC_MAX_CHARS} (${JSON.stringify(over)})`);
  ok(check.total === over?.count, `the audit check flags the same pages (${check.total} vs ${over?.count})`);
}

// ── 9. One freshness rule for the Summary strip and the sidebar ─────────────────────────────
console.log('freshness');
{
  const now = Date.parse('2026-10-17T16:30:00Z');
  const done = (at) => ({ state: 'completed', at });
  const sync = sourceFreshness('sync', done('2026-08-16 09:47:21'), { gscEnd: '2026-08-15', now });
  ok(sync.stale && freshnessDot('completed', sync.stale) === 'dot-high', `Search Console ending 15 Aug is stale on 17 Oct (> ${GSC_STALE_DAYS} days), amber dot`);
  ok(!sourceFreshness('sync', done('2026-10-16 09:00:00'), { gscEnd: '2026-10-14', now }).stale, 'Search Console ending 3 days ago is fresh');
  for (const kind of ['crawl', 'inspect', 'ranks']) {
    const f = sourceFreshness(kind, done('2026-08-16T09:48:13.956Z'), { now });
    ok(f.stale, `${kind} from 16 Aug is stale on 17 Oct (> ${SNAPSHOT_STALE_DAYS} days): the same rule for every snapshot source`);
  }
  const audit = sourceFreshness('audit', done('2026-10-17 16:21:38'), { now });
  ok(!audit.stale && freshnessDot('completed', audit.stale) === 'dot-ok', 'an audit from minutes ago is fresh, green dot');
  ok(freshnessDot('failed', false) === 'dot-bad' && freshnessDot('queued', false) === 'dot-run' && freshnessDot('never', false) === 'dot-never', 'failed / queued / never keep their own dots');
  ok(!sourceFreshness('crawl', { state: 'never', at: null }, { now }).stale, 'a source that never ran is "never", not stale');
}

// ── 10. Same-day runs are told apart ─────────────────────────────────────────────────────────
console.log('run labels');
{
  const same = runLabels(['2026-10-17 16:20:50', '2026-10-17 16:21:38']);
  ok(same[0] === '17 Oct 16:20' && same[1] === '17 Oct 16:21', `two audits on one day carry their time (${same.join(' | ')})`);
  const mixed = runLabels(['2026-10-10 09:00:00', '2026-10-17 16:20:50', '2026-10-17T16:21:38Z']);
  ok(mixed[0] === '10 Oct' && mixed[1] === '17 Oct 16:20' && mixed[2] === '17 Oct 16:21', `only the colliding days get a time (${mixed.join(' | ')})`);
  ok(runLabels([null])[0] === '-', 'a missing date reads "-"');
}

// ── 0.16.2: every check category has a display label; none shows as a raw id ──
{
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const cats = [...(/const CHECK_CATEGORIES = \[([^\]]+)\]/.exec(src)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  const missing = cats.filter(c => !CATEGORY_LABEL[c]);
  ok(cats.length > 5 && missing.length === 0, `every CHECK_CATEGORIES entry has a label (${missing.join(', ') || 'none missing'})`);
  ok(categoryLabel('accessibility') === 'Accessibility', `accessibility reads "Accessibility" (${categoryLabel('accessibility')})`);
  ok(categoryLabel('some-new-area') === 'Some new area' && categoryLabel(null) === 'Other', 'an unlabelled category is still capitalised, never raw');
  ok(categoryLabel('merged', { merged: 'Search demand' }) === 'Search demand', 'a surface can override a label (the Summary says "Search demand")');
  ok(CAT_NAME.accessibility === 'Accessibility' && CAT_NAME.performance === 'Performance (CWV)', 'the run_audit report uses the shared labels');
}

// ── 0.16.2: device / country breakdowns say why they are empty ──
{
  const r = (o) => breakdownsEmptyReason({ devices: 0, countries: 0, windowStart: '2026-09-18', ...o });
  ok(/No country\/device data in this window: the last segment sync covered up to 5 Sep\. Run <code>sync_gsc<\/code> with <code>segments:true<\/code> to refresh\./.test(r({ segmentsLastDate: '2026-09-05' }) ?? ''), `segments stopped before the window: says so (${r({ segmentsLastDate: '2026-09-05' })})`);
  ok(/synced without segments/.test(r({ segmentsLastDate: null }) ?? ''), 'never synced with segments: says how to add them');
  ok(r({ segmentsLastDate: '2026-10-15', countries: 3 }) === null && r({ segmentsLastDate: '2026-10-15' }) === null, 'rows in the window (or segments reaching it): nothing to explain');
  ok(r({ segmentsLastDate: undefined }) === null, 'an older payload without segmentsLastDate keeps the old behaviour');

  // The payload: SRC's shape (per-country rows to 5 Sep, totals to 15 Oct, migrated layout).
  const site = 'sc-domain:segments-stale.test';
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  const tot = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const seg = adb.db.prepare(`INSERT INTO search_analytics_segments (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  adb.db.transaction(() => {
    for (let t = Date.parse('2026-08-01'); t <= Date.parse('2026-10-15'); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10), u = 'https://segments-stale.test/a';
      tot.run(d, 'q', u, u, '', '', 10, 100, 0.1, 3);
      if (d <= '2026-09-05') { seg.run(d, 'q', u, u, '', 'gbr', 6, 60, 0.1, 3); seg.run(d, 'q', u, u, '', 'usa', 4, 40, 0.1, 3); }
    }
  })();
  adb.close();
  const dd = getDashboardData(dataDir, site);
  ok(dd.segmentsLastDate === '2026-09-05' && dd.breakdownWindowStart === '2026-09-18', `payload: segmentsLastDate and the window start (${dd.segmentsLastDate}, ${dd.breakdownWindowStart})`);
  ok(dd.countryBreakdown.length === 0 && dd.deviceBreakdown.length === 0, 'payload: the window has no country or device rows');
  ok(/up to 5 Sep/.test(breakdownsEmptyReason({ devices: 0, countries: 0, segmentsLastDate: dd.segmentsLastDate, windowStart: dd.breakdownWindowStart }) ?? ''), 'the panel shows the empty state for that payload');
}

// ── Domain picker: the open property is always a selected option, hidden or not ──────────────────
// Opening /dashboard?siteUrl=<hidden> showed "All domains" in the dropdown (the hidden property is
// left out of properties/others, so nothing matched and the <select> fell back to its first option).
console.log('domain picker');
{
  const lists = { properties: ['sc-domain:owned.test'], others: ['rival.test'], hidden: ['sc-domain:hidden.test'], watched: [{ domain: 'watch.test', group: 'A' }] };
  const sel = (ctx) => { const o = domainPickerOptions(ctx, lists); return o.find(x => x.selected); };
  const owned = sel({ siteUrl: 'sc-domain:owned.test' });
  ok(owned?.value === 'p:sc-domain:owned.test' && owned.label === 'sc-domain:owned.test', `an owned property is selected (${JSON.stringify(owned)})`);
  const hidden = sel({ siteUrl: 'sc-domain:hidden.test' });
  ok(hidden?.value === 'p:sc-domain:hidden.test' && /hidden/.test(hidden?.label ?? ''), `a hidden property opened by URL is a selected option, labelled hidden (${JSON.stringify(hidden)})`);
  ok(domainPickerOptions({ siteUrl: 'sc-domain:hidden.test' }, lists).filter(o => o.selected).length === 1, 'exactly one option is selected');
  ok(sel({ view: 'domains', siteUrl: '' })?.value === '__all', 'the All-domains view selects All domains');
  ok(sel({ siteUrl: '', domain: 'watch.test' })?.value === 'd:watch.test', 'an open watched domain is selected');
  const absent = sel({ siteUrl: 'sc-domain:never-seen.test' });
  ok(absent?.value === 'p:sc-domain:never-seen.test', 'a property in no list (not even hidden) is still shown and selected, never falling back to All domains');
  ok(currentPickerValue({ siteUrl: 'sc-domain:owned.test' }) === 'p:sc-domain:owned.test', 'currentPickerValue keys a property by p:<siteUrl>');
}

rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
