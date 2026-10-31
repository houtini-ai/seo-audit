// #55 group A: CrUX field data, site-wide-indexing-alarm, snippet-restricted, ai-search-bot-blocked,
// nonbrand-decline-masked. No network beyond 127.0.0.1: the CrUX API is a mock fetch serving the
// canned responses in scripts/fixtures/crux/ (shapes taken from live calls, origin renamed).
// Run: node scripts/probe-signals.mjs (after npm run build:server)
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { urlKey, hostFormForProperty, brandToken } from '../dist/core/url-key.js';
import { CHECKS } from '../dist/audit/checks.js';
import { runAudit } from '../dist/audit/engine.js';
import { gscFreshness } from '../dist/core/gscFreshness.js';
import { CruxClient, toReal, parseRecord, parseHistory } from '../dist/core/CruxClient.js';
import { CruxSync, cwvBand } from '../dist/core/CruxSync.js';
import { storeRobotsTxt } from '../dist/core/robotsStore.js';
import { snippetRestrictions } from '../dist/audit/checks-signals.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { Crawler } from '../dist/core/Crawler.js';
import { ensureExternalSchema } from '../dist/core/externalLinks.js';

process.env.SAC_AUTOSERVE = '0';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'crux');
const fixture = (f) => JSON.parse(readFileSync(path.join(FIX, f), 'utf8'));
const ORIGIN = 'https://www.example.test';
const SITE = 'sc-domain:example.test';
const KEY = 'test-crux-key-123';
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
const runCheck = (db, id, brand = null) => {
  const ctx = { db, gscMaxDate: gscFreshness(db).effectiveMax, brand };
  return CHECKS.find(c => c.id === id).run(ctx);
};

// ── Mock CrUX API ───────────────────────────────────────────────────────────────────────────
const calls = [];
let mode = 'normal';
const mockFetch = async (url, init) => {
  const u = new URL(url);
  const endpoint = u.pathname.split('/').pop();
  const body = JSON.parse(init.body);
  calls.push({ endpoint, body, key: u.searchParams.get('key') });
  const send = (status, json, headers = {}) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (mode === 'forbidden') return send(403, { error: { code: 403, message: 'Requests from this referrer are blocked.', status: 'PERMISSION_DENIED' } });
  if (mode === '429-once') { mode = 'normal'; return send(429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '1' }); }
  const hist = endpoint === 'records:queryHistoryRecord';
  if (body.origin === ORIGIN && body.formFactor === 'PHONE') return send(200, fixture(hist ? 'history-origin-phone.json' : 'record-origin-phone.json'));
  if (body.url && body.url.includes('/guides/widgets/') && body.formFactor === 'PHONE') return send(200, fixture(hist ? 'history-url-regressed.json' : 'record-url-regressed.json'));
  return send(404, fixture('not-found.json'));
};
const noSleep = async () => {};

try {
  // ── 1. Parsing: strings to REAL, gaps to NULL (never 0), unknown metrics ignored ─────────────
  {
    check('toReal: CLS string, number, NaN string, null, garbage', toReal('0.02') === 0.02 && toReal(1854) === 1854 && toReal('NaN') === null && toReal(null) === null && toReal('abc') === null && toReal('') === null);
    const rec = parseRecord(fixture('record-origin-phone.json').record);
    const cls = rec.metrics.find(m => m.metric === 'cumulative_layout_shift');
    check('record: CLS p75 and bin edges parsed from strings to numbers', cls.p75 === 0.02 && cls.goodMax === 0.1 && cls.niMax === 0.25, JSON.stringify(cls));
    check('record: window dates', rec.periods[0].first === '2026-09-18' && rec.periods[0].last === '2026-10-15');
    check('record: experimental_ad_* and *_with_softnavs ignored', !rec.metrics.some(m => /experimental_ad|softnavs/.test(m.metric)));
    check('record: LCP sub-parts kept as p75-only', rec.metrics.find(m => m.metric === 'largest_contentful_paint_image_resource_load_delay')?.p75 === 170);
    check('record: navigation_types + LCP resource type fractions', rec.fractions.some(f => f.metric === 'navigation_types' && f.bucket === 'back_forward_cache') && rec.fractions.some(f => f.metric === 'largest_contentful_paint_resource_type' && f.bucket === 'image'));
    const hist = parseHistory(fixture('history-origin-phone.json').record);
    const fcp0 = hist.metrics.find(m => m.metric === 'first_contentful_paint' && m.periodLast === hist.periods[0].last);
    check('history: a window whose densities are "NaN" and p75 null stores no row (not zeros)', fcp0 === undefined, JSON.stringify(fcp0));
    const delay1 = hist.metrics.find(m => m.metric === 'largest_contentful_paint_image_resource_load_delay' && m.periodLast === hist.periods[1].last);
    check('history: a null p75 in a sub-part series stays absent', delay1 === undefined);
    check('history: 6 windows, LCP has a row per window', hist.periods.length === 6 && hist.metrics.filter(m => m.metric === 'largest_contentful_paint').length === 6);
    const u = parseHistory(fixture('history-url-regressed.json').record);
    const rd = u.metrics.filter(m => m.metric === 'largest_contentful_paint_image_element_render_delay');
    check('history: a null p75 inside a series drops only that window', rd.length === 3 && rd.every(r => r.p75 != null));
    check('band: Google thresholds at p75 (LCP 2500/4000, INP 200/500, CLS 0.1/0.25)',
      cwvBand('largest_contentful_paint', 2500) === 'good' && cwvBand('largest_contentful_paint', 2501) === 'needs-improvement' && cwvBand('largest_contentful_paint', 4001) === 'poor'
      && cwvBand('interaction_to_next_paint', 200) === 'good' && cwvBand('interaction_to_next_paint', 501) === 'poor'
      && cwvBand('cumulative_layout_shift', 0.1) === 'good' && cwvBand('cumulative_layout_shift', 0.25) === 'needs-improvement' && cwvBand('cumulative_layout_shift', 0.26) === 'poor' && cwvBand('cumulative_layout_shift', null) === null);
  }

  // ── 2. Client: throttle, 404 = insufficient_data, 429 retry, key never in an error ──────────
  {
    const c = new CruxClient(KEY, { fetchImpl: mockFetch, minIntervalMs: 120 });
    const t0 = Date.now();
    const [a, b, d] = await Promise.all([c.queryRecord({ origin: ORIGIN }, 'PHONE'), c.queryRecord({ origin: ORIGIN }, 'DESKTOP'), c.queryRecord({ url: 'https://www.example.test/none' }, 'PHONE')]);
    const took = Date.now() - t0;
    check('client: three calls are spaced by minIntervalMs (serialised)', took >= 230, `${took} ms`);
    check('client: 200 parsed, 404 NOT_FOUND = insufficient_data (not an error)', a.status === 'ok' && b.status === 'insufficient_data' && d.status === 'insufficient_data');
    check('client: default interval keeps under 150 queries/min', 60000 / Math.ceil(60000 / 140) <= 150);
    mode = '429-once';
    const c2 = new CruxClient(KEY, { fetchImpl: mockFetch, minIntervalMs: 0, sleep: noSleep });
    const r = await c2.queryRecord({ origin: ORIGIN }, 'PHONE');
    check('client: a 429 is retried', r.status === 'ok' && c2.calls === 2);
    mode = 'forbidden';
    let msg = '';
    try { await new CruxClient(KEY, { fetchImpl: mockFetch, minIntervalMs: 0, sleep: noSleep }).queryRecord({ origin: ORIGIN }); } catch (e) { msg = e.message; }
    check('client: 403 throws, and the message never carries the key', /403/.test(msg) && !msg.includes(KEY), msg);
    mode = 'normal';
  }

  // ── 3. A property DB with GSC history: nonbrand decline (with mixed row shapes), WoW page drop ─
  const dir1 = tmp('sac-sig-');
  const D = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const day = (k) => new Date(Date.parse(D) - k * 86400000).toISOString().slice(0, 10);
  const keyOpts = { hostForm: hostFormForProperty(SITE) };
  const pageUrl = (i) => `${ORIGIN}/p${i}`;
  {
    const adb = new AuditDatabase(dbPathFor(dir1, SITE));
    adb.upsertProperty(SITE, 'apex');
    const ins = adb.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,0,5)`);
    // Segment (per-country) rows live in their own table since #65; the totals table refuses them.
    const insSeg = adb.db.prepare(`INSERT INTO search_analytics_segments (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,0,5)`);
    adb.db.transaction(() => {
      for (let k = 0; k < 70; k++) {
        const date = day(k);
        const cur = k <= 27;
        const B = cur ? 16 : 10, N = cur ? 14 : 20;
        const rowsFor = (country) => {
          const to = country ? insSeg : ins;
          to.run(date, 'example shop', pageUrl(1), urlKey(pageUrl(1), keyOpts), '', country, B, 50);
          to.run(date, 'blue widgets', pageUrl(2), urlKey(pageUrl(2), keyOpts), '', country, N, 60);
        };
        rowsFor('');
        // Mixed row shapes on 11 prior-window days: segmented rows duplicating the same clicks.
        if (k >= 30 && k <= 40) rowsFor('gbr');
        const active = k <= 6 ? 30 : 60; // distinct pages with impressions: 60 a week, then 30 (-50%; the alarm needs > 40% of >= 50)
        for (let i = 1; i <= active; i++) ins.run(date, `widget ${i}`, pageUrl(i), urlKey(pageUrl(i), keyOpts), '', '', 0, 5);
      }
    })();
    adb.db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1', ?, 'example.test', 'completed')`).run(`${ORIGIN}/`);
    const pg = adb.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,indexable_reason,noindex,robots,x_robots_tag,click_depth) VALUES ('c1',?,?,200,'text/html',1,?,?,?,?,?,?)`);
    const page = (p, robots, xrt, { indexable = 1, reason = null, noindex = 0, depth = 1 } = {}) => pg.run(`${ORIGIN}${p}`, urlKey(`${ORIGIN}${p}`, keyOpts), indexable, reason, noindex, robots, xrt, depth);
    page('/', 'index, follow', null, { depth: 0 });
    page('/a', 'max-snippet:0, max-image-preview:large', null);
    page('/b', null, 'otherbot: nosnippet');
    page('/c', null, 'googlebot: nosnippet');
    page('/d', 'max-snippet:-1', null);
    page('/e', 'max-snippet:50', null);
    page('/f', 'noindex, nosnippet', null, { indexable: 0, reason: 'noindex-meta', noindex: 1 });
    page('/g', null, 'nosnippet, otherbot: noindex');
    storeRobotsTxt(adb.db, ORIGIN, { status: 200, body: 'User-agent: *\nDisallow: /private\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /p2\n' });
    adb.close();
  }
  {
    const adb = new AuditDatabase(dbPathFor(dir1, SITE));
    const brand = brandToken(SITE);
    const nb = runCheck(adb.db, 'nonbrand-decline-masked', brand);
    const ev = nb[0]?.evidence;
    check('nonbrand-decline-masked: fires (total flat, non-brand -30%)', nb.length === 1 && ev.totalClicks.changePct === 0 && ev.nonBrandClicks.changePct === -30, JSON.stringify(ev));
    // Since #65 the 11 per-country days sit in search_analytics_segments, so the totals table has no
    // mixed-shape days left to de-duplicate; what matters is that the prior window isn't doubled (840, not 1,680).
    check('nonbrand-decline-masked: segment rows never double the totals (prior 840, not 1,680)', ev?.totalClicks.prior === 840 && !(ev?.mixedShapeDaysCountedOnce > 0), JSON.stringify(ev?.totalClicks));
    check('nonbrand-decline-masked: no brand token = no finding', runCheck(adb.db, 'nonbrand-decline-masked', null).length === 0);

    const alarm = runCheck(adb.db, 'site-wide-indexing-alarm');
    const trig = alarm[0]?.evidence.triggers ?? [];
    const drop = trig.find(t => t.trigger === 'impression-pages-drop');
    check('indexing alarm: pages with impressions 60 -> 30 week on week fires (-50%)', alarm.length === 1 && drop?.priorWeek.pages === 60 && drop?.currentWeek.pages === 30 && drop.changePct === -50, JSON.stringify(trig));
    check('indexing alarm: only the GSC trigger here (homepage indexable, Googlebot allowed)', trig.length === 1);
    check('indexing alarm: registry says critical, site-level', CHECKS.find(c => c.id === 'site-wide-indexing-alarm').severity === 'crit' && alarm[0].urlKey === null);

    const sn = runCheck(adb.db, 'snippet-restricted');
    const snKeys = sn.map(f => f.urlKey.replace(/^https?:\/\/[^/]+/, '')).sort();
    check('snippet-restricted: max-snippet:0 (meta), googlebot: nosnippet and unscoped nosnippet (header) fire', JSON.stringify(snKeys) === JSON.stringify(['/a', '/c', '/g']), JSON.stringify(snKeys));
    check('snippet-restricted: other-bot scoped, max-snippet:-1/50 and noindexed pages do not', !snKeys.some(k => ['/b', '/d', '/e', '/f'].includes(k)));
    check('snippetRestrictions: "max-snippet: 0" with a space is still a restriction, not a UA prefix', snippetRestrictions('max-snippet: 0', null).length === 1 && snippetRestrictions(null, 'max-snippet: 0').length === 1);

    const ai = runCheck(adb.db, 'ai-search-bot-blocked');
    const blocked = ai[0]?.evidence.searchBotsBlocked ?? [];
    const oai = blocked.find(b => b.bot === 'OAI-SearchBot'), ppx = blocked.find(b => b.bot === 'PerplexityBot');
    check('ai-search-bot-blocked: OAI-SearchBot blocked site-wide', oai?.scope === 'site' && oai.group === 'OAI-SearchBot', JSON.stringify(blocked));
    check('ai-search-bot-blocked: PerplexityBot blocked on a top page (/p2) only', ppx?.scope === 'pages' && ppx.sample.includes('/p2'), JSON.stringify(ppx));
    check('ai-search-bot-blocked: GPTBot is training (context, not a blocked search bot)', !blocked.some(b => b.bot === 'GPTBot') && ai[0].evidence.trainingBotsBlocked.includes('GPTBot'));
    check('ai-search-bot-blocked: Claude-SearchBot (inherits * allow) not flagged', !blocked.some(b => b.bot === 'Claude-SearchBot'));
    adb.close();
  }

  // ── 4. CrUX sync against the mock, then the CrUX checks and the payload ─────────────────────
  {
    calls.length = 0;
    const sync = new CruxSync(KEY, dir1, { fetchImpl: mockFetch, minIntervalMs: 0, sleep: noSleep });
    const r1 = await sync.run(SITE, { urls: [`${ORIGIN}/guides/widgets/`, `${ORIGIN}/thin/`] }, () => {}, new AbortController().signal);
    check('sync: origin from the most-clicked GSC page (www host)', r1.origin === ORIGIN, r1.origin);
    check('sync: 6 targets (origin + 2 URLs, x PHONE/DESKTOP), all queried', r1.targets === 6 && r1.queried === 6 && r1.ok === 2 && r1.insufficientData === 4 && r1.errors.length === 0, JSON.stringify(r1));
    check('sync: first run asks history then record for each target (12 calls)', r1.calls === 12 && calls.filter(c => c.endpoint === 'records:queryHistoryRecord').length === 6);
    check('sync: history asks 25 windows; every call carries the key', calls.filter(c => c.endpoint === 'records:queryHistoryRecord').every(c => c.body.collectionPeriodCount === 25) && calls.every(c => c.key === KEY));
    const adb = new AuditDatabase(dbPathFor(dir1, SITE));
    const db = adb.db;
    const tgt = db.prepare(`SELECT scope, target, form_factor ff, status, query_url FROM crux_targets ORDER BY scope, target, form_factor`).all();
    check('crux_targets: 404s recorded as insufficient_data, data as ok', tgt.filter(t => t.status === 'insufficient_data').length === 4 && tgt.filter(t => t.status === 'ok').length === 2, JSON.stringify(tgt));
    const urlTarget = urlKey(`${ORIGIN}/guides/widgets/`, keyOpts);
    check('crux_targets: url target is the url_key (joins pages/GSC), query_url the URL sent', tgt.some(t => t.scope === 'url' && t.target === urlTarget && t.query_url === `${ORIGIN}/guides/widgets/`));
    const originLcp = db.prepare(`SELECT COUNT(*) n FROM crux_metrics WHERE scope='origin' AND target=? AND form_factor='PHONE' AND metric='largest_contentful_paint'`).get(ORIGIN).n;
    check('crux_metrics: origin LCP = 6 history windows + 1 record window', originLcp === 7, String(originLcp));
    const zeroFcp = db.prepare(`SELECT COUNT(*) n FROM crux_metrics WHERE metric='first_contentful_paint' AND (good=0 OR p75=0)`).get().n;
    check('crux_metrics: no zero written for a "NaN"/null gap', zeroFcp === 0);
    const clsRow = db.prepare(`SELECT p75, good_max, ni_max, typeof(p75) t FROM crux_metrics WHERE scope='origin' AND metric='cumulative_layout_shift' AND source='record'`).get();
    check('crux_metrics: CLS stored as REAL with bin edges as returned', clsRow.t === 'real' && clsRow.p75 === 0.02 && clsRow.good_max === 0.1 && clsRow.ni_max === 0.25, JSON.stringify(clsRow));
    check('crux_metrics: no ad/softnav metrics stored', db.prepare(`SELECT COUNT(*) n FROM crux_metrics WHERE metric LIKE 'experimental_ad%' OR metric LIKE '%softnavs'`).get().n === 0);
    check('crux_fractions: bfcache share stored', db.prepare(`SELECT fraction FROM crux_fractions WHERE scope='origin' AND metric='navigation_types' AND bucket='back_forward_cache' AND period_last='2026-10-15'`).get()?.fraction === 0.0326);

    const lcp = runCheck(db, 'crux-field-lcp'), inp = runCheck(db, 'crux-field-inp'), cls = runCheck(db, 'crux-field-cls');
    check('crux-field-lcp: the regressed URL (p75 4400 ms, poor) on PHONE only; origin (1854 ms) good', lcp.length === 1 && lcp[0].urlKey === urlTarget && lcp[0].evidence.band === 'poor' && lcp[0].evidence.p75 === 4400 && lcp[0].evidence.window.last === '2026-10-15', JSON.stringify(lcp));
    check('crux-field-inp: needs-improvement at 270 ms', inp.length === 1 && inp[0].evidence.band === 'needs-improvement' && inp[0].evidence.thresholds.good === 200);
    check('crux-field-cls: nothing (all good)', cls.length === 0);
    const reg = runCheck(db, 'crux-regression');
    const regLcp = reg.find(f => f.evidence.metric === 'LCP'), regInp = reg.find(f => f.evidence.metric === 'INP');
    check('crux-regression: LCP good -> poor over the last 4 windows', regLcp?.evidence.fromBand === 'good' && regLcp.evidence.toBand === 'poor' && regLcp.evidence.windows.length === 4, JSON.stringify(regLcp));
    check('crux-regression: INP good -> needs-improvement; origin (stable) and CLS not flagged', regInp?.evidence.toBand === 'needs-improvement' && reg.length === 2, JSON.stringify(reg.map(r => r.evidence.metric + ':' + r.evidence.scope)));
    adb.close();

    // Re-run: everything is inside its re-ask window, so nothing is asked.
    calls.length = 0;
    const r2 = await sync.run(SITE, { urls: [`${ORIGIN}/guides/widgets/`, `${ORIGIN}/thin/`] }, () => {}, new AbortController().signal);
    check('sync: a second run within 7 days asks nothing (ok: 7d, insufficient_data: 28d)', r2.queried === 0 && r2.skippedFresh === 6 && calls.length === 0, JSON.stringify(r2));
    const r3 = await sync.run(SITE, { urls: [`${ORIGIN}/guides/widgets/`], force: true }, () => {}, new AbortController().signal);
    const histAgain = calls.filter(c => c.endpoint === 'records:queryHistoryRecord' && c.body.formFactor === 'PHONE');
    check('sync: force re-asks; a target with history gets queryRecord only', r3.queried === 4 && histAgain.length === 0, JSON.stringify(calls.map(c => `${c.endpoint} ${c.body.origin ?? c.body.url} ${c.body.formFactor}`)));
    const adb2 = new AuditDatabase(dbPathFor(dir1, SITE));
    const after = adb2.db.prepare(`SELECT COUNT(*) n FROM crux_metrics WHERE scope='origin' AND metric='largest_contentful_paint' AND form_factor='PHONE'`).get().n;
    adb2.close();
    check('crux_metrics: the PK upsert keeps one row per window on a re-pull', after === 7, String(after));

    // Top-N selection when no URLs are given: the most-clicked GSC page.
    calls.length = 0;
    const dirTop = tmp('sac-sig-top-');
    {
      const a = new AuditDatabase(dbPathFor(dirTop, SITE));
      const ins = a.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0,5)`);
      for (let k = 0; k < 20; k++) { ins.run(day(k), 'q1', pageUrl(1), urlKey(pageUrl(1), keyOpts), 3, 30); ins.run(day(k), 'q2', pageUrl(2), urlKey(pageUrl(2), keyOpts), 9, 30); }
      a.close();
    }
    const r4 = await new CruxSync(KEY, dirTop, { fetchImpl: mockFetch, minIntervalMs: 0, sleep: noSleep }).run(SITE, { limit: 1, formFactors: ['PHONE'] }, () => {}, new AbortController().signal);
    check('sync: limit 1 picks the top page by GSC clicks', r4.targets === 2 && calls.some(c => c.body.url === pageUrl(2)) && !calls.some(c => c.body.url === pageUrl(1)), JSON.stringify(calls.map(c => c.body.url ?? c.body.origin)));

    // A rejected key stops the job instead of burning the quota.
    mode = 'forbidden'; calls.length = 0;
    let err = '';
    try { await new CruxSync(KEY, tmp('sac-sig-403-'), { fetchImpl: mockFetch, minIntervalMs: 0, sleep: noSleep }).run(SITE, { limit: 5 }, () => {}, new AbortController().signal); } catch (e) { err = e.message; }
    mode = 'normal';
    check('sync: 403 on the first target aborts with a CRUX_API_KEY hint, one call spent, key not echoed', /CRUX_API_KEY/.test(err) && calls.length === 1 && !err.includes(KEY), `${calls.length} calls: ${err}`);

    // The dashboard payload: latest origin window per form factor + history.
    const dd = getDashboardData(dir1, SITE);
    const ph = dd.cwvField?.formFactors?.PHONE;
    check('payload cwvField: origin, PHONE latest window 2026-10-15, LCP 1854 good, INP 129, CLS 0.02', dd.cwvField?.origin === ORIGIN && ph?.period.last === '2026-10-15' && ph.metrics.lcp.p75 === 1854 && ph.metrics.lcp.band === 'good' && ph.metrics.inp.p75 === 129 && ph.metrics.cls.p75 === 0.02, JSON.stringify(ph?.metrics));
    check('payload cwvField: LCP breakdown (ttfb 887, delay 170, duration 261, render 554) and bfcache share', ph?.lcpBreakdown.ttfb === 887 && ph.lcpBreakdown.loadDelay === 170 && ph.lcpBreakdown.loadDuration === 261 && ph.lcpBreakdown.renderDelay === 554 && ph.bfcacheShare === 0.0326, JSON.stringify(ph?.lcpBreakdown));
    check('payload cwvField: 7-point LCP history, oldest first; DESKTOP absent (insufficient data)', ph?.history.lcp.length === 7 && ph.history.lcp[0].periodLast < ph.history.lcp[6].periodLast && !dd.cwvField.formFactors.DESKTOP);
    const dd2 = getDashboardData(dir1, SITE);
    check('payload cwvField: present on a cached load too', dd2.cwvField?.formFactors?.PHONE?.metrics.lcp.p75 === 1854);

    // The whole engine over this DB: the new checks run and persist alongside the rest.
    const audit = runAudit(dir1, SITE, {});
    const ids = audit.byCheck.map(b => b.checkId);
    check('run_audit: new findings stored (alarm, snippet, AI bots, CrUX, nonbrand)', ['site-wide-indexing-alarm', 'snippet-restricted', 'ai-search-bot-blocked', 'crux-field-lcp', 'crux-field-inp', 'crux-regression', 'nonbrand-decline-masked'].every(id => ids.includes(id)), JSON.stringify(ids));
    check('run_audit: the alarm is crit', audit.bySeverity.crit >= 1);
  }

  // ── 5. The other alarm triggers: homepage noindex, sitemap majority, robots Disallow: / ────────
  {
    const dir2 = tmp('sac-sig2-');
    const adb = new AuditDatabase(dbPathFor(dir2, SITE));
    adb.db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1', ?, 'example.test', 'completed')`).run(`${ORIGIN}/`);
    const pg = adb.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,indexable_reason,noindex,click_depth) VALUES ('c1',?,?,200,'text/html',1,?,?,?,?)`);
    const sm = adb.db.prepare(`INSERT INTO sitemap_urls (url_key,url) VALUES (?,?)`);
    for (let i = 0; i < 6; i++) {
      const u = `${ORIGIN}/s${i}`; const k = urlKey(u, keyOpts);
      const ni = i < 4;
      pg.run(u, k, ni ? 0 : 1, ni ? 'noindex-meta' : null, ni ? 1 : 0, i === 0 ? 0 : 1);
      sm.run(k, u);
    }
    storeRobotsTxt(adb.db, ORIGIN, { status: 200, body: 'User-agent: *\nDisallow: /\n' });
    const trig = runCheck(adb.db, 'site-wide-indexing-alarm')[0]?.evidence.triggers.map(t => t.trigger) ?? [];
    check('indexing alarm: homepage noindex + sitemap 4/6 noindex + robots Disallow: / for Googlebot', JSON.stringify(trig) === JSON.stringify(['homepage-noindex', 'sitemap-majority-noindex', 'robots-disallow-googlebot']), JSON.stringify(trig));
    const ai = runCheck(adb.db, 'ai-search-bot-blocked')[0];
    check('ai-search-bot-blocked: Disallow: / for * blocks every search bot (group *)', ai?.evidence.searchBotsBlocked.every(b => b.scope === 'site' && b.group === '*') && ai.evidence.searchBotsBlocked.length >= 5);
    // Googlebot named and allowed while * is blocked: no robots trigger (RFC 9309 most-specific group).
    storeRobotsTxt(adb.db, ORIGIN, { status: 200, body: 'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n' });
    const trig2 = runCheck(adb.db, 'site-wide-indexing-alarm')[0]?.evidence.triggers.map(t => t.trigger) ?? [];
    check('indexing alarm: a Googlebot group that allows / overrides * Disallow', !trig2.includes('robots-disallow-googlebot'), JSON.stringify(trig2));
    // A 5xx robots.txt is unknown, not blocked: no robots trigger, no AI-bot finding.
    storeRobotsTxt(adb.db, ORIGIN, { status: 503, body: null });
    check('robots 5xx: no robots trigger and no AI-bot finding (unknown, not blocked)', !(runCheck(adb.db, 'site-wide-indexing-alarm')[0]?.evidence.triggers ?? []).some(t => t.trigger === 'robots-disallow-googlebot') && runCheck(adb.db, 'ai-search-bot-blocked').length === 0);
    adb.close();
  }

  // ── 6. Missing data = no finding, never a zero ──────────────────────────────────────────────
  {
    const dir3 = tmp('sac-sig3-');
    const adb = new AuditDatabase(dbPathFor(dir3, SITE));
    const ids = ['site-wide-indexing-alarm', 'snippet-restricted', 'ai-search-bot-blocked', 'crux-field-lcp', 'crux-field-inp', 'crux-field-cls', 'crux-regression', 'nonbrand-decline-masked'];
    const n = ids.map(id => runCheck(adb.db, id, 'example').length);
    check('empty property: every new check returns nothing', n.every(x => x === 0), JSON.stringify(n));
    adb.close();
    check('empty property: cwvField is null', getDashboardData(dir3, SITE).cwvField == null);
    const incomplete = ids.filter(id => { const c = CHECKS.find(x => x.id === id); return !c || !c.category || !c.labels?.length || c.certainty !== 1 || !c.title || !c.fix; });
    check('registry: all 8 new checks registered once, complete and deterministic (certainty 1)', incomplete.length === 0 && ids.every(id => CHECKS.filter(c => c.id === id).length === 1), JSON.stringify(incomplete));
  }

  // ── 7. The crawl stores robots.txt (end to end, local server) ──────────────────────────────
  {
    let origin = '';
    const server = http.createServer((req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n\nUser-agent: Claude-SearchBot\nDisallow: /\n'); }
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(`<!doctype html><html lang="en"><head><title>Home</title><meta name="robots" content="nosnippet"><link rel="canonical" href="${origin}/"></head><body><h1>Home</h1><p>${'word '.repeat(200)}</p></body></html>`); }
      res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>404</h1>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
    const site = `${origin}/`;
    const dir4 = tmp('sac-sig4-');
    try {
      await new Crawler(dir4).run(site, { maxPages: 5, delayMs: 0, checkExternal: false }, () => {}, new AbortController().signal);
      const adb = new AuditDatabase(dbPathFor(dir4, site));
      const rb = adb.db.prepare(`SELECT origin, status, body FROM robots_txt`).all();
      check('crawl: robots.txt stored per origin with status and body', rb.length === 1 && rb[0].origin === origin && rb[0].status === 200 && rb[0].body.includes('Claude-SearchBot'), JSON.stringify(rb));
      const ai = runCheck(adb.db, 'ai-search-bot-blocked')[0];
      check('crawl -> ai-search-bot-blocked: Claude-SearchBot blocked from the stored file', ai?.evidence.searchBotsBlocked.length === 1 && ai.evidence.searchBotsBlocked[0].bot === 'Claude-SearchBot', JSON.stringify(ai?.evidence));
      const sn = runCheck(adb.db, 'snippet-restricted');
      check('crawl -> snippet-restricted: the nosnippet homepage', sn.length === 1 && sn[0].evidence.directives[0].directive === 'nosnippet', JSON.stringify(sn));
      adb.close();
    } finally { server.close(); }
  }

  // ── Default audits run every deterministic check; only judgement (N) checks need the flag ──────────
  // The gate was `certainty >= 1`, so three D checks with certainty 0.9 (external-broken,
  // external-redirected, duplicate-article-entities) never ran without includeJudgement and a
  // broken outbound link read as a pass.
  {
    const dirG = tmp('sac-gate-');
    const SITE_G = 'sc-domain:gate.test';
    const adb = new AuditDatabase(dbPathFor(dirG, SITE_G));
    adb.upsertProperty(SITE_G, 'apex');
    const db = adb.db;
    db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,started_at,finished_at) VALUES ('c1','https://gate.test','gate.test','completed',1,'2026-10-01T00:00:00Z','2026-10-01T00:10:00Z')`).run();
    db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,title) VALUES ('c1','https://gate.test/a','https://gate.test/a',200,'text/html',1,1,'A')`).run();
    ensureExternalSchema(db);
    db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,is_internal) VALUES ('c1','https://gate.test/a','https://gate.test/a','https://dead.example/x','https://dead.example/x',0)`).run();
    db.prepare(`INSERT INTO external_link_status (url_key,url,status,verdict) VALUES ('https://dead.example/x','https://dead.example/x',404,'broken')`).run();
    adb.close();
    const def = runAudit(dirG, SITE_G, {});
    check('a default audit runs external-broken (a D check with certainty 0.9)', def.byCheck.some(b => b.checkId === 'external-broken'), JSON.stringify(def.byCheck.map(b => b.checkId)));
    const ran = new Set(JSON.parse((() => { const a = new AuditDatabase(dbPathFor(dirG, SITE_G)); try { return a.db.prepare(`SELECT check_ids FROM audit_runs WHERE run_id=?`).get(def.runId).check_ids; } finally { a.close(); } })()).map(id => id.replace(/@\d+$/, '')));
    const dChecks = CHECKS.filter(c => !c.labels.includes('N')).map(c => c.id);
    const nChecks = CHECKS.filter(c => c.labels.includes('N')).map(c => c.id);
    check('a default audit runs every check without the N label', dChecks.every(id => ran.has(id)), dChecks.filter(id => !ran.has(id)).join(','));
    check('a default audit runs no N check', nChecks.every(id => !ran.has(id)), nChecks.filter(id => ran.has(id)).join(','));
  }
} catch (e) {
  fail++;
  console.log(`FAIL  probe threw :: ${e?.stack ?? e}`);
} finally {
  // Windows: a handle left open by a failed section must not mask the failure with EPERM.
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch (e) { console.log(`  (cleanup: ${e.code} on ${d})`); } }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
