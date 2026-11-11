// #79 quick-win checks: internal-nofollow, robots-txt-unreachable/-health, sitemap-invalid/-too-large,
// hreflang-missing-x-default, plus the per-file sitemap record in fetchSitemapUrls.
//   npm run build:server && node scripts/probe-quick-wins.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { rmSync, mkdirSync } from 'node:fs';
import { CHECKS } from '../dist/audit/checks.js';
import { lintRobotsTxt } from '../dist/audit/checks-hygiene.js';
import { fetchSitemapUrls } from '../dist/core/sitemap.js';
import { storeRobotsTxt } from '../dist/core/robotsStore.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { newCriticalFindings } from '../dist/core/portfolioData.js';
import { PortfolioStore } from '../dist/core/PortfolioStore.js';
import { extractPage } from '../dist/core/extract.js';
import { storeTls, tlsTwin } from '../dist/core/tlsProbe.js';
import { buildPrintReport, PRINT_PORTFOLIO_ROWS } from '../dist/core/printReport.js';
import { isOwnedGscProperty } from '../dist/core/webServer.js';

let pass = 0, fail = 0;
const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? pass++ : fail++; };
const kinds = (body) => lintRobotsTxt(body).map(p => p.kind);

function withDb(seed, fn) {
  const dir = path.join(tmpdir(), `sac-qw-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const adb = new AuditDatabase(path.join(dir, 'x.db'));
  const db = adb.db;
  db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,max_pages) VALUES ('c1','https://x.test','x.test','completed',1,100)`).run();
  try { seed(db); return fn(db); } finally { adb.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ } }
}
const run = (db, id) => CHECKS.find(c => c.id === id).run({ db, gscMaxDate: null, brand: null, siteUrl: 'sc-domain:x.test' });
const collected = (db, id) => CHECKS.find(c => c.id === id).collected?.({ db, gscMaxDate: null }) ?? null;
const page = (db, url, extra = {}) => db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,hreflang) VALUES ('c1',?,?,?,?,?)`)
  .run(url, url, extra.status ?? 200, extra.indexable ?? 1, extra.hreflang ? JSON.stringify(extra.hreflang) : null);
const link = (db, from, to, rel) => db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,is_internal,placement,rel) VALUES ('c1',?,?,?,?,1,'body',?)`)
  .run(from, from, to, to, rel);

// ── robots.txt lint ──────────────────────────────────────────────────────────────────────────
const CLEAN = 'User-agent: *\nDisallow: /admin\nAllow:\n\nSitemap: https://x.test/sitemap.xml\n';
t('robots: clean file -> no problems', lintRobotsTxt(CLEAN).length === 0);
t('robots: Content-Signal is a known directive (Cloudflare)', lintRobotsTxt('User-agent: *\nContent-Signal: search=yes\nAllow: /\nSitemap: https://x.test/s.xml').length === 0);
t('robots: misspelt Dissallow -> unknown-directive', kinds('User-agent: *\nDissallow: /x\nSitemap: https://x.test/s.xml').includes('unknown-directive'));
t('robots: noindex line -> ignored-by-google', kinds('User-agent: *\nNoindex: /x\nSitemap: https://x.test/s.xml').includes('ignored-by-google'));
t('robots: rule before any User-agent -> rule-before-user-agent', kinds('Disallow: /x\nUser-agent: *\nAllow: /\nSitemap: https://x.test/s.xml').includes('rule-before-user-agent'));
t('robots: line without a colon -> malformed-line', kinds('User-agent *\nSitemap: https://x.test/s.xml').includes('malformed-line'));
t('robots: no Sitemap: line -> no-sitemap-line', kinds('User-agent: *\nDisallow:').includes('no-sitemap-line'));
t('robots: relative Sitemap: -> sitemap-not-absolute', kinds('User-agent: *\nDisallow:\nSitemap: /sitemap.xml').includes('sitemap-not-absolute'));
t('robots: same agent in two groups -> split-groups', kinds('User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b\nSitemap: https://x.test/s.xml').includes('split-groups'));
t('robots: same path allowed and disallowed -> conflicting-rules', kinds('User-agent: *\nAllow: /x\nDisallow: /x\nSitemap: https://x.test/s.xml').includes('conflicting-rules'));
t('robots: stacked User-agent lines form ONE group (no split-groups)', !kinds('User-agent: a\nUser-agent: b\nDisallow: /x\nSitemap: https://x.test/s.xml').includes('split-groups'));
t('robots: comments and BOM ignored', lintRobotsTxt('﻿# hello: world\nUser-agent: * # all\nDisallow: /x\nSitemap: https://x.test/s.xml').length === 0);
t('robots: 500 KiB file -> too-large', kinds('User-agent: *\nSitemap: https://x.test/s.xml\n' + '#'.repeat(500 * 1024)).includes('too-large'));

t('robots-txt-unreachable: 503 stored -> fires', withDb(db => storeRobotsTxt(db, 'https://x.test', { status: 503, body: null }), db => run(db, 'robots-txt-unreachable').length === 1));
t('robots-txt-unreachable: no response (0) -> fires', withDb(db => storeRobotsTxt(db, 'https://x.test', { status: 0, body: null }), db => run(db, 'robots-txt-unreachable')[0]?.evidence.status === 'no response'));
t('robots-txt-unreachable: 404 (allow-all) -> silent', withDb(db => storeRobotsTxt(db, 'https://x.test', { status: 404, body: null }), db => run(db, 'robots-txt-unreachable').length === 0));
t('robots-txt-health: stored clean 200 -> silent', withDb(db => storeRobotsTxt(db, 'https://x.test', { status: 200, body: CLEAN }), db => run(db, 'robots-txt-health').length === 0));
t('robots-txt-health: stored typo -> one finding listing problems', withDb(db => storeRobotsTxt(db, 'https://x.test', { status: 200, body: 'User-agent: *\nDissallow: /x' }), db => {
  const f = run(db, 'robots-txt-health'); return f.length === 1 && f[0].evidence.problems.length === 2;
}));

// ── internal-nofollow ────────────────────────────────────────────────────────────────────────
const NF = (db) => {
  for (const u of ['https://x.test/', 'https://x.test/a', 'https://x.test/review', 'https://x.test/cart', 'https://x.test/gone']) page(db, u, u.endsWith('gone') ? { status: 404, indexable: 0 } : {});
  link(db, 'https://x.test/', 'https://x.test/review', 'sponsored nofollow');   // reported
  link(db, 'https://x.test/a', 'https://x.test/review', null);                  // followed link to same target
  link(db, 'https://x.test/a', 'https://x.test/a', 'nofollow noopener');        // "#" self-anchor: excluded
  link(db, 'https://x.test/', 'https://x.test/cart', 'nofollow');               // utility route: excluded
  link(db, 'https://x.test/', 'https://x.test/gone', 'nofollow');               // target not indexable: excluded
  link(db, 'https://x.test/', 'https://x.test/a', 'nofollowing');               // not the nofollow token: excluded
};
withDb(NF, db => {
  const f = run(db, 'internal-nofollow');
  t('internal-nofollow: exactly one target reported (the review page)', f.length === 1 && f[0].urlKey === 'https://x.test/review');
  t('internal-nofollow: counts the followed links too', f[0]?.evidence.followedInternalLinks === 1);
  t('internal-nofollow: rel tokens surfaced', JSON.stringify(f[0]?.evidence.rel) === '["sponsored nofollow"]');
});

// ── hreflang-missing-x-default ───────────────────────────────────────────────────────────────
const cluster = (self, withX) => [{ lang: 'en-GB', href: self }, { lang: 'en-US', href: 'https://x.test/us' + self.slice(-2) }, { lang: 'de', href: 'https://x.test/de' + self.slice(-2) },
  ...(withX ? [{ lang: 'x-default', href: 'https://x.test/' }] : [])];
withDb(db => { page(db, 'https://x.test/p1', { hreflang: cluster('https://x.test/p1', false) }); page(db, 'https://x.test/p2', { hreflang: cluster('https://x.test/p2', false) }); }, db => {
  const f = run(db, 'hreflang-missing-x-default');
  t('x-default: no set uses it -> ONE site-level finding', f.length === 1 && f[0].urlKey === null && f[0].evidence.clusterPages === 2);
});
withDb(db => { page(db, 'https://x.test/p1', { hreflang: cluster('https://x.test/p1', true) }); page(db, 'https://x.test/p2', { hreflang: cluster('https://x.test/p2', false) }); }, db => {
  const f = run(db, 'hreflang-missing-x-default');
  t('x-default: used inconsistently -> per-page finding for the one without', f.length === 1 && f[0].urlKey === 'https://x.test/p2');
});
withDb(db => { page(db, 'https://x.test/p1', { hreflang: cluster('https://x.test/p1', true) }); }, db => t('x-default: present -> silent', run(db, 'hreflang-missing-x-default').length === 0));
withDb(db => { page(db, 'https://x.test/p1', { hreflang: [{ lang: 'en', href: 'https://x.test/p1' }, { lang: 'de', href: 'https://x.test/de' }] }); }, db =>
  t('x-default: a two-version pair (one alternate) is not a cluster -> silent', run(db, 'hreflang-missing-x-default').length === 0));

// ── sitemap checks over stored rows ─────────────────────────────────────────────────────────
const smRow = (db, r) => db.prepare(`INSERT INTO sitemap_files (url,source,outcome,http_status,kind,entries,bytes,invalid_locs,walk_capped) VALUES (?,?,?,?,?,?,?,?,?)`)
  .run(r.url, r.source, r.outcome, r.st ?? null, r.kind ?? null, r.entries ?? null, r.bytes ?? null, r.inv ?? 0, r.capped ?? 0);
withDb(() => {}, db => {
  t('sitemap checks: nothing recorded -> collected() explains the re-crawl', /Re-crawl/.test(collected(db, 'sitemap-invalid') ?? '') && run(db, 'sitemap-invalid').length === 0);
});
withDb(db => {
  smRow(db, { url: 'https://x.test/sitemap.xml', source: 'conventional', outcome: 'http-error', st: 404 });          // probe miss: not reported
  smRow(db, { url: 'https://x.test/declared.xml', source: 'robots', outcome: 'http-error', st: 500 });              // reported
  smRow(db, { url: 'https://x.test/html.xml', source: 'index', outcome: 'not-sitemap', st: 200, bytes: 900 });      // reported
  smRow(db, { url: 'https://x.test/rel.xml', source: 'index', outcome: 'ok', st: 200, kind: 'urlset', entries: 10, bytes: 999, inv: 3 }); // reported
  smRow(db, { url: 'https://x.test/big.xml', source: 'index', outcome: 'ok', st: 200, kind: 'urlset', entries: 50001, bytes: 9e6, capped: 1 });
  smRow(db, { url: 'https://x.test/fine.xml', source: 'index', outcome: 'ok', st: 200, kind: 'urlset', entries: 50000, bytes: 9e6 });
}, db => {
  const inv = run(db, 'sitemap-invalid');
  t('sitemap-invalid: declared 500, HTML sitemap, relative locs reported; conventional 404 probe not', inv.length === 3 && !inv.some(f => f.evidence.sitemap.endsWith('/sitemap.xml')));
  const big = run(db, 'sitemap-too-large');
  t('sitemap-too-large: 50,001 entries fires, exactly 50,000 does not', big.length === 1 && big[0].evidence.sitemap.endsWith('big.xml'));
  t('sitemap-too-large: walk cap is reported, not silent', big[0]?.evidence.walkCapped === true);
});

// ── homepage lookup: the root URL wins when click depth is empty (ehi.com.au, /agents.md picked) ──
withDb(db => {
  db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,inlink_count,json_ld) VALUES ('c1','https://x.test/agents.md','https://x.test/agents.md',200,1,0,NULL)`).run();
  db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,inlink_count,json_ld) VALUES ('c1','https://x.test/','https://x.test/',200,1,0,?)`)
    .run(JSON.stringify([JSON.stringify({ '@type': 'Organization', name: 'X' })]));
}, db => t('homepage lookup: root URL chosen with no click depth -> no false "missing Organization"', run(db, 'homepage-missing-org-schema').length === 0));

// ── portfolio "needs attention": new critical findings, named ───────────────────────────────
const auditRun = (db, id, scope, ids, at) => db.prepare(`INSERT INTO audit_runs (run_id,scope,status,started_at,finished_at,check_ids) VALUES (?,?,?,?,?,?)`).run(id, scope, 'completed', at, at, JSON.stringify(ids));
const finding = (db, run, check, url, sev = 'crit') => db.prepare(`INSERT INTO findings (run_id,check_id,severity,url_key) VALUES (?,?,?,?)`).run(run, check, sev, url);
const twoRuns = db => { auditRun(db, 'r1', 'core', ['site-wide-indexing-alarm', 'broken-internal-links'], '2026-11-01 10:00:00'); auditRun(db, 'r2', 'core', ['site-wide-indexing-alarm', 'broken-internal-links', 'robots-txt-unreachable'], '2026-11-08 10:00:00'); };
let nc = withDb(db => { twoRuns(db); finding(db, 'r2', 'site-wide-indexing-alarm', null); }, newCriticalFindings);
t('new critical: named with its check title and count', nc.length === 1 && nc[0].checkId === 'site-wide-indexing-alarm' && /indexing/i.test(nc[0].title) && nc[0].findings === 1);
t('new critical: carried over from the last run -> not new', withDb(db => { twoRuns(db); finding(db, 'r1', 'site-wide-indexing-alarm', null); finding(db, 'r2', 'site-wide-indexing-alarm', null); }, newCriticalFindings).length === 0);
t('new critical: a check the previous run lacked (an upgrade) -> not new', withDb(db => { twoRuns(db); finding(db, 'r2', 'robots-txt-unreachable', null); }, newCriticalFindings).length === 0);
t('new critical: high severity ignored', withDb(db => { twoRuns(db); finding(db, 'r2', 'broken-internal-links', 'https://x.test/a', 'high'); }, newCriticalFindings).length === 0);
t('new critical: different scopes not compared', withDb(db => { auditRun(db, 'r1', 'full', ['site-wide-indexing-alarm'], '2026-11-01'); auditRun(db, 'r2', 'core', ['site-wide-indexing-alarm'], '2026-11-08'); finding(db, 'r2', 'site-wide-indexing-alarm', null); }, newCriticalFindings).length === 0);

// ── portfolio: move a watched domain to another country (browser picker) ────────────────────
{
  const dir = path.join(tmpdir(), `sac-pf-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const store = new PortfolioStore(dir);
  try {
    store.addWatched('rival.com', { locationCode: 2826, group: 'rivals' });
    const moved = store.moveWatched('rival.com', 2826, 2036);
    const active = store.list().filter(d => d.domain === 'rival.com');
    t('move: domain now watched in the new country only, group kept', moved.locationCode === 2036 && active.length === 1 && active[0].groupLabel === 'rivals');
    store.addWatched('rival.com', { locationCode: 2840 });
    let msg = ''; try { store.moveWatched('rival.com', 2036, 2840); } catch (e) { msg = e.message; }
    t('move: onto a country it is already watched in -> clear error, nothing changed', /already in the portfolio for United States/.test(msg) && store.list().filter(d => d.domain === 'rival.com').length === 2);
    msg = ''; try { store.moveWatched('rival.com', 2124, 2250); } catch (e) { msg = e.message; }
    t('move: from a country it is not watched in -> error', /not watched at that location/.test(msg));
  } finally { store.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ } }
}

// ── Medium items: non-crawlable links + data-nosnippet extraction ───────────────────────────
const EX = (body) => extractPage(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`, 'https://x.test/page', 'x.test', { hostForm: 'asis' });
const ncx = EX(`<nav><a onclick="location.href='/pricing'">Pricing</a><span data-href="/about">About</span></nav>
  <a href="javascript:window.location='/blog'">Blog</a>
  <a href="#" onclick="openModal()">Open modal</a>
  <button onclick="window.open('https://other.example/x')">External</button>
  <div class="share" data-href="https://x.test/page">Share</div>
  <a href="/real">Real link</a>`).nonCrawlableLinks;
const ncKinds = (ncx?.items ?? []).map(i => `${i.kind}:${new URL(i.target).pathname}`).sort();
t('non-crawlable: onclick <a>, data-href <span>, javascript: href are recorded', JSON.stringify(ncKinds) === JSON.stringify(['javascript-href:/blog', 'no-href:/pricing', 'non-link-element:/about']));
t('non-crawlable: modal "#" button, external target, share-to-self and real links are not', ncx?.total === 3);
t('non-crawlable: nav placement captured', (ncx?.items ?? []).find(i => i.target.endsWith('/pricing'))?.placement === 'navigation');
t('non-crawlable: a clean page -> null', EX('<a href="/a">a</a>').nonCrawlableLinks === null);

const wrap = EX(`<div data-nosnippet><main><h1>Title</h1><p>${'word '.repeat(200)}</p></main></div><footer>small footer</footer>`).nosnippet;
t('nosnippet: wrapper holding <main> -> wrapsMain, high share', wrap?.wrapsMain === true && wrap.textShare > 0.9);
const small = EX(`<main><h1>Title</h1><p>${'word '.repeat(200)}</p><span data-nosnippet>Price: 10</span></main>`).nosnippet;
t('nosnippet: one small span -> recorded, not main, low share', small?.elements === 1 && small.wrapsMain === false && small.textShare < 0.1);
const ignored = EX(`<main data-nosnippet><p>${'word '.repeat(50)}</p></main>`).nosnippet;
t('nosnippet: on <main> itself Google ignores it -> not counted', ignored === null);

withDb(db => {
  db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,nosnippet) VALUES ('c1','https://x.test/a','https://x.test/a',200,1,?)`).run(JSON.stringify(wrap));
  db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,nosnippet) VALUES ('c1','https://x.test/b','https://x.test/b',200,1,?)`).run(JSON.stringify(small));
  db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,nosnippet) VALUES ('c1','https://x.test/c','https://x.test/c',200,1,'{"elements":0}')`).run();
}, db => {
  const f = run(db, 'data-nosnippet-on-main');
  t('data-nosnippet-on-main: only the page whose main content is wrapped', f.length === 1 && f[0].urlKey === 'https://x.test/a');
});
withDb(() => {}, db => t('data-nosnippet-on-main: pre-1.0.2 crawl -> collected() asks for a re-crawl', /Re-crawl/.test(collected(db, 'data-nosnippet-on-main') ?? '')));

withDb(db => {
  const ins = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,non_crawlable_links) VALUES ('c1',?,?,200,1,?)`);
  const item = (target) => ({ kind: 'no-href', selector: 'a.menu-item', target, placement: 'navigation' });
  ins.run('https://x.test/1', 'https://x.test/1', JSON.stringify({ total: 2, items: [item('https://x.test/pricing'), item('https://x.test/hidden')] }));
  ins.run('https://x.test/2', 'https://x.test/2', JSON.stringify({ total: 1, items: [item('https://x.test/pricing')] }));
  ins.run('https://x.test/pricing', 'https://x.test/pricing', JSON.stringify({ total: 0, items: [] }));
  link(db, 'https://x.test/2', 'https://x.test/pricing', null); // pricing also has an ordinary link; /hidden has none
}, db => {
  const f = run(db, 'non-crawlable-links');
  t('non-crawlable-links: one finding per template element, with page count', f.length === 1 && f[0].evidence.pages === 2 && f[0].evidence.targetCount === 2);
  t('non-crawlable-links: names the target reachable only by script', JSON.stringify(f[0]?.evidence.reachableOnlyByScript) === '["https://x.test/hidden"]');
});

// ── tls-expiring over stored certificates (days counted from audit time) ─────────────────────
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
withDb(db => {
  storeTls(db, { host: 'ok.x.test', reached: true, validFrom: inDays(-30), validTo: inDays(60), issuer: 'CA', altNames: null, authError: null, error: null });
  storeTls(db, { host: 'soon.x.test', reached: true, validFrom: inDays(-80), validTo: inDays(10), issuer: 'CA', altNames: null, authError: null, error: null });
  storeTls(db, { host: 'old.x.test', reached: true, validFrom: inDays(-400), validTo: inDays(-3), issuer: 'CA', altNames: null, authError: 'CERT_HAS_EXPIRED', error: null });
  storeTls(db, { host: 'www.x.test', reached: true, validFrom: inDays(-10), validTo: inDays(80), issuer: 'CA', altNames: 'DNS:x.test', authError: 'ERR_TLS_CERT_ALTNAME_INVALID', error: null });
  storeTls(db, { host: 'chain.x.test', reached: true, validFrom: inDays(-10), validTo: inDays(80), issuer: 'CA', altNames: null, authError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', error: null });
  storeTls(db, { host: 'down.x.test', reached: false, validFrom: null, validTo: null, issuer: null, altNames: null, authError: null, error: 'ECONNREFUSED' });
}, db => {
  const by = Object.fromEntries(run(db, 'tls-expiring').map(f => [f.evidence.host, f.evidence.problem]));
  t('tls: 60 days left -> silent; unreachable host -> silent', !('ok.x.test' in by) && !('down.x.test' in by));
  t('tls: 10 days left -> "expires in 10 day(s)"', /expires in (9|10) day/.test(by['soon.x.test'] ?? ''));
  t('tls: expired -> "expired 3 day(s) ago"', /expired (3|4) day/.test(by['old.x.test'] ?? ''));
  t('tls: hostname mismatch named', /does not cover www\.x\.test/.test(by['www.x.test'] ?? ''));
  t('tls: missing intermediate explained', /intermediate/.test(by['chain.x.test'] ?? ''));
});
withDb(() => {}, db => t('tls: never probed -> collected() asks for a re-crawl', /Re-crawl/.test(collected(db, 'tls-expiring') ?? '')));

// ── printable A4 report (pure builder) ──────────────────────────────────────────────────────
{
  const metric = (value) => ({ value, source: 'history', asOf: null, month: null, year: null, spark: [], partial: null });
  const pfRow = (domain, kind = 'watched') => ({ domain, locationCode: 2840, country: 'US', countryName: 'United States', kind, group: null, siteUrls: [], clicks28: null, audit: null,
    organicKeywords: metric(null), organicTraffic: metric(null), paidKeywords: metric(null), paidTraffic: metric(null), referringDomains: metric(null), domainRank: metric(null),
    aiMentions: { ...metric(null), platforms: { google: null, chat_gpt: null }, chatgptUsOnly: false }, attention: [] });
  const portfolio = { version: '1', generatedAt: '', months: { lastComplete: '2026-10', previous: '2026-09', yearAgo: '2025-10', current: '2026-11' }, counts: { owned: 1, watched: 34 }, groups: [], locations: [],
    refresh: { weeklyCapturedAt: null, monthlyCapturedAt: null, schedule: null, spentThisMonth: 0, lastRuns: [] },
    rows: [pfRow('x.test', 'owned'), ...Array.from({ length: 34 }, (_, i) => pfRow(`rival${i}.test`))], empty: false, notes: [] };
  const empty = buildPrintReport({ data: { siteUrl: 'sc-domain:x.test' }, portfolio: null, domain: 'x.test', version: '9.9.9', now: new Date('2026-11-11T00:00:00Z') });
  t('print: no data -> says what to do, no sections', /No Search Console, audit or portfolio data yet/.test(empty) && !/<h2>01\./.test(empty));
  const evil = buildPrintReport({ data: { siteUrl: 'sc-domain:<b>x</b>' }, portfolio: null, domain: '<script>x</script>', version: '1', now: new Date('2026-11-11T00:00:00Z') });
  t('print: domain and siteUrl are escaped', !evil.includes('<script>x') && evil.includes('&lt;script&gt;'));
  const withPf = buildPrintReport({ data: { siteUrl: 'sc-domain:x.test', clickWindows: { current: 120, prior: 100 } }, portfolio, domain: 'x.test', version: '1', now: new Date('2026-11-11T00:00:00Z') });
  t('print: portfolio capped with the cap stated', new RegExp(`Showing ${PRINT_PORTFOLIO_ROWS} of 35 domains`).test(withPf) && (withPf.match(/rival\d+\.test/g) ?? []).length === PRINT_PORTFOLIO_ROWS - 1);
  t('print: own row highlighted, click change with its window', /class="hl"><td>x\.test/.test(withPf) && /\+20% vs the prior 28/.test(withPf));
  t('print: no en or em dashes', !/[–—]/.test(withPf + empty));
}

// ── 1.0.2 code-review fixes ──────────────────────────────────────────────────────────────────
t('tls twin: www <-> apex only', tlsTwin('www.example.com') === 'example.com' && tlsTwin('example.com') === 'www.example.com' && tlsTwin('example.co.uk') === 'www.example.co.uk');
t('tls twin: a subdomain has none (no false wildcard mismatch)', tlsTwin('blog.example.com') === null && tlsTwin('shop.example.co.uk') === null);

t('robots lint groups like the crawl gate: Crawl-delay between User-agent lines splits them',
  kinds('User-agent: a\nCrawl-delay: 5\nUser-agent: a\nDisallow: /x\nSitemap: https://x.test/s.xml').includes('split-groups'));

const widget = EX(`<main><h1>Title</h1><p>${'word '.repeat(300)}</p></main><div data-nosnippet class="related"><article class="card"><h2>Other</h2><p>teaser</p></article></div>`).nosnippet;
t('nosnippet: related-posts block of <article> cards is not "main content"', widget?.wrapsMain === false);
const brand = EX(`<div data-nosnippet class="branding"><h1 class="site-title">Brand</h1></div><main><p>${'word '.repeat(300)}</p></main>`).nosnippet;
t('nosnippet: branding div holding the site-title <h1> is not "main content"', brand?.wrapsMain === false);

const ncShare = extractPage('<html><body><div class="fb" data-href="https://www.x.test/page/">Share</div><li onclick="location.href=\'/p\'"><a href="/p">P</a></li></body></html>',
  'https://x.test/page', 'x.test', { hostForm: 'apex' }).nonCrawlableLinks;
t('non-crawlable: share-to-self matched by url_key (www, trailing slash) and a wrapper around a real link -> not flagged', ncShare === null);

const art = extractPage(`<html><body><header class="site"><a href="/home">Home</a></header><main><article><header class="entry-header"><h1>Post title</h1><a href="/author/x">Author</a></header><p>${'word '.repeat(80)}</p></article></main></body></html>`,
  'https://x.test/post', 'x.test', { hostForm: 'asis' });
t('article <header>: its links are body, the site header stays navigation',
  art.links.find(l => l.targetUrl.endsWith('/author/x'))?.placement === 'body' && art.links.find(l => l.targetUrl.endsWith('/home'))?.placement === 'navigation');
t('article <header>: its H1 stays in body_chunks', art.bodyChunks.some(c => c.heading === 'Post title'));

withDb(db => {
  for (let i = 0; i < 30; i++) db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,non_crawlable_links) VALUES ('c1',?,?,200,1,?)`)
    .run(`https://x.test/m${i}`, `https://x.test/m${i}`, JSON.stringify({ total: 120, items: [{ kind: 'no-href', selector: 'a.mega', target: 'https://x.test/t', placement: 'navigation' }] }));
}, db => {
  const f = run(db, 'non-crawlable-links');
  t('non-crawlable-links: links beyond the per-page cap are counted and stated, not dropped', f[0]?.evidence.notItemised === 30 * 119 && /counted but not itemised/.test(f[0]?.evidence.capNote ?? ''));
});

withDb(db => {
  twoRuns(db);
  for (let i = 0; i < 500; i++) { finding(db, 'r1', 'site-wide-indexing-alarm', `https://x.test/a${i}`); finding(db, 'r2', 'site-wide-indexing-alarm', `https://x.test/b${i}`); }
}, db => t('new critical: a check at the 500-per-run cap is not diffed (no false "new")', newCriticalFindings(db).length === 0));

t('owned GSC: sc-domain counts unsynced; a crawled URL-prefix site does not until synced',
  isOwnedGscProperty('sc-domain:richardbaxter.co', null) && !isOwnedGscProperty('https://www.reed.co.uk/', null) && isOwnedGscProperty('https://x.test/', '2026-11-01') && !isOwnedGscProperty('reed.co.uk', '2026-11-01'));

{
  const dir = path.join(tmpdir(), `sac-pf2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const store = new PortfolioStore(dir);
  try {
    store.db.prepare(`INSERT INTO portfolio_domain (domain, location_code, kind, removed_at) VALUES ('old.test', 2036, 'owned', datetime('now'))`).run();
    store.addWatched('old.test', { locationCode: 2826 });
    const moved = store.moveWatched('old.test', 2826, 2036);
    t('move onto a retired owned row revives it as watched, not owned', moved.kind === 'watched');
  } finally { store.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ } }
}

// ── fetchSitemapUrls per-file record, against a local server ────────────────────────────────
const urlset = (n, rel = 0) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
  Array.from({ length: n }, (_, i) => `<url><loc>${i < rel ? `/rel-${i}` : `ORIGIN/p-${i}`}</loc></url>`).join('')}</urlset>`;
const server = http.createServer((req, res) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const body = {
    '/robots.txt': `User-agent: *\nDisallow:\nSitemap: ${origin}/index.xml\nSitemap: ${origin}/missing.xml\n`,
    '/index.xml': `<sitemapindex><sitemap><loc>${origin}/a.xml</loc></sitemap><sitemap><loc>${origin}/html.xml</loc></sitemap></sitemapindex>`,
    '/a.xml': urlset(5, 2).replaceAll('ORIGIN', origin),
    '/html.xml': '<!doctype html><html><body>not a sitemap</body></html>',
  }[req.url];
  if (body == null) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': req.url.endsWith('.txt') ? 'text/plain' : 'application/xml' }); res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sm = await fetchSitemapUrls(origin, 'probe', { hostForm: 'asis' });
  const f = Object.fromEntries(sm.files.map(x => [new URL(x.url).pathname, x]));
  t('fetch: index recorded as sitemapindex with 2 children, from robots.txt', f['/index.xml']?.kind === 'sitemapindex' && f['/index.xml'].entries === 2 && f['/index.xml'].source === 'robots');
  t('fetch: child urlset counts all 5 entries and 2 relative locs', f['/a.xml']?.kind === 'urlset' && f['/a.xml'].entries === 5 && f['/a.xml'].invalidLocs === 2 && f['/a.xml'].source === 'index');
  t('fetch: only the 3 absolute URLs are collected', sm.urls.length === 3);
  t('fetch: HTML child recorded as not-sitemap', f['/html.xml']?.outcome === 'not-sitemap');
  t('fetch: declared 404 recorded as http-error 404', f['/missing.xml']?.outcome === 'http-error' && f['/missing.xml'].httpStatus === 404);
  t('fetch: conventional probes recorded with source=conventional', f['/sitemap.xml']?.source === 'conventional');
  t('fetch: nothing was capped', sm.capped === false);
  // SSRF guard: from origin "localhost", a sitemap declared on 127.0.0.1 is another host, so it goes
  // through the public-only agent and is refused at connect time (loopback), never fetched.
  const guarded = await fetchSitemapUrls(`http://localhost:${server.address().port}`, 'probe', { hostForm: 'asis' });
  const leak = guarded.files.find(x => x.url.includes('127.0.0.1') && x.url.endsWith('/index.xml'));
  t('fetch: a declared sitemap on another, private host is refused (no-response), its URLs not collected', leak?.outcome === 'no-response' && guarded.urls.length === 0);
  const ac = new AbortController(); ac.abort();
  const cancelled = await fetchSitemapUrls(origin, 'probe', { hostForm: 'asis' }, { signal: ac.signal });
  t('fetch: an aborted crawl stops the sitemap walk', cancelled.sitemapsFetched === 0);
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
