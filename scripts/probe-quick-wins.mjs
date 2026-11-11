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
} finally { server.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
