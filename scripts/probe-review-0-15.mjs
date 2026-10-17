// Regression probe for the 0.15.0 review fixes that need a network or a populated payload:
//   #4  probe_urls never follows a redirect off the property
//   #10 sitemap discovery dedupes by urlKey and redirect target (no re-parse, no false "undeclared")
//   #3  crawl-health URL flow counts redirects from redirect_sources
//   #6  one DataForSEO cache-days default
//   recon competitor fetch works with no API keys
// Everything runs against a local HTTP server - no external network.
// Run: npm run build:server && node scripts/probe-review-0-15.mjs
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { probeUrls } from '../dist/core/probeUrls.js';
import { fetchSitemapUrls } from '../dist/core/sitemap.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { dbPathFor } from '../dist/core/paths.js';
import { DEFAULT_DFS_CACHE_DAYS, dfsCacheDaysFromEnv } from '../dist/core/DataForSeoClient.js';
import { fetchCompetitorContent } from '../dist/core/reconResearch.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };

// ── Local site ────────────────────────────────────────────────────────────────────────────────
const hits = {};
let robotsDecl = '';
const html = (title, body = '') => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  hits[p] = (hits[p] ?? 0) + 1;
  const base = `http://localhost:${server.address().port}`;
  const redirect = (to, code = 301) => { res.writeHead(code, { location: to }); res.end(); };
  const xml = (s) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(s); };
  switch (p) {
    case '/out': return redirect('http://example.invalid/latest/meta-data/');       // open redirect off-property
    case '/hop': return redirect('/ok');
    case '/ok': res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html('OK page', 'A competitor page with real body text about direct drive wheelbases and torque.'));
    case '/robots.txt': res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(robotsDecl.replace('BASE', base));
    case '/sitemap_index.xml': return xml(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${base}/post-sitemap.xml</loc></sitemap></sitemapindex>`);
    case '/post-sitemap.xml': return xml(`<?xml version="1.0"?><urlset><url><loc>${base}/a</loc></url><url><loc>${base}/b</loc></url></urlset>`);
    case '/sitemap.xml': return redirect('/sitemap_index.xml');                   // Yoast-style
    case '/wp-sitemap.xml': return redirect('/sitemap_index.xml');
    default: res.writeHead(404); return res.end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;

// ── #4 probe_urls: the own-host guard applies at every hop ─────────────────────────────────────
{
  const [out, hop] = await probeUrls([{ url: `${base}/out` }, { url: `${base}/hop` }], 'localhost', { chromeFallback: false, budgetMs: 15000 });
  check('an open redirect off the property is recorded, not followed', !!out.redirectsOffProperty && out.finalUrl === 'http://example.invalid/latest/meta-data/' && out.finalStatus === 301, JSON.stringify(out));
  check('...so nothing from the off-property target comes back (no title, no hash, no fetch error)', out.title === null && out.contentHash === null && !out.error, JSON.stringify({ title: out.title, hash: out.contentHash, error: out.error }));
  check('an on-property redirect is still followed to the page', hop.redirectChain.length === 1 && hop.finalStatus === 200 && hop.title === 'OK page', JSON.stringify(hop));
}

// ── #10 sitemap discovery ───────────────────────────────────────────────────────────────────────
{
  for (const k of Object.keys(hits)) delete hits[k];
  robotsDecl = 'Sitemap: BASE/sitemap_index.xml\n';
  const r = await fetchSitemapUrls(base, 'probe', { hostForm: 'asis' });
  check('redirecting conventional sitemaps are not reported as undeclared', r.undeclared.length === 0, JSON.stringify(r.undeclared));
  check('the URL set is complete', r.urls.length === 2, JSON.stringify(r.urls.map(u => u.url)));
  check('the child sitemap is fetched once', hits['/post-sitemap.xml'] === 1, JSON.stringify(hits));

  // The declared spelling fails (https on an http-only host); the conventional spelling of the SAME
  // sitemap must still be tried rather than deduped away.
  for (const k of Object.keys(hits)) delete hits[k];
  robotsDecl = `Sitemap: ${base.replace('http://', 'https://')}/sitemap_index.xml\n`;
  const r2 = await fetchSitemapUrls(base, 'probe', { hostForm: 'asis' });
  check('a declared sitemap that fails under one spelling is still read under another', r2.urls.length === 2, JSON.stringify(r2));
  check('...and, being the declared one, it is not reported as undeclared', r2.undeclared.length === 0, JSON.stringify(r2.undeclared));
}

// ── #3 crawl-health URL flow ─────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sac-flow-'));
  const site = 'https://flow.test/';
  const db = new AuditDatabase(dbPathFor(dir, site));
  const sa = db.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,?,?)`);
  for (let d = 1; d <= 20; d++) sa.run(`2026-09-${String(d).padStart(2, '0')}`, 'flow query', 'https://flow.test/a', 'https://flow.test/a', 5, 100, 0.05, 4);
  db.db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1', ?, 'flow.test', 'completed')`).run(site);
  const pg = db.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,canonical_url,inlink_count) VALUES ('c1',?,?,?,?,1,?,?,?)`);
  pg.run('https://flow.test/a', 'https://flow.test/a', 200, 'text/html', 1, 'https://flow.test/a', 5);
  pg.run('https://flow.test/b', 'https://flow.test/b', 200, 'text/html', 1, 'https://flow.test/b', 3); // final URL of internal redirects
  pg.run('https://flow.test/gone', 'https://flow.test/gone', 404, 'text/html', 0, null, 1);
  pg.run('https://flow.test/out', 'https://flow.test/out', 301, null, 0, null, 1);                   // redirect-out: in BOTH tables
  pg.run('https://flow.test/noloc', 'https://flow.test/noloc', 302, null, 0, null, 0);               // 3xx, never followed
  const rs = db.db.prepare(`INSERT INTO redirect_sources (url_key,url,status,final_url,final_key,hops,crawl_id) VALUES (?,?,?,?,?,1,'c1')`);
  rs.run('https://flow.test/old1', 'https://flow.test/old1', 301, 'https://flow.test/b', 'https://flow.test/b');
  rs.run('https://flow.test/old2', 'https://flow.test/old2', 308, 'https://flow.test/b', 'https://flow.test/b');
  rs.run('https://flow.test/old3', 'https://flow.test/old3', 302, 'https://flow.test/b', 'https://flow.test/b');
  rs.run('https://flow.test/out', 'https://flow.test/out', 301, 'https://elsewhere.test/', 'https://elsewhere.test/');
  const ln = db.db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,is_internal) VALUES ('c1','https://flow.test/a','https://flow.test/a',?,?,1)`);
  for (let i = 0; i < 4; i++) ln.run('https://flow.test/old2', 'https://flow.test/old2');
  ln.run('https://flow.test/old1', 'https://flow.test/old1');
  db.close();
  const flow = getDashboardData(dir, site).crawlHealth?.urlFlow ?? [];
  const get = (label) => flow.find(f => f.label === label);
  const perm = get('Permanent redirect (301/308)'), temp = get('Temporary redirect (302/303/307)');
  check('permanent redirects counted from redirect_sources, the off-site one once (3)', perm?.count === 3, JSON.stringify(flow));
  check('temporary redirects include the never-followed 3xx (2)', temp?.count === 2, JSON.stringify(flow));
  check('the example redirect is the most-linked source', perm?.example === 'https://flow.test/old2', JSON.stringify(perm));
  check('non-redirect buckets are unaffected', get('Not found (404)')?.count === 1, JSON.stringify(flow));
  rmSync(dir, { recursive: true, force: true });
}

// ── #6 one DataForSEO cache-days default ────────────────────────────────────────────────────────
{
  const saved = process.env.DATAFORSEO_CACHE_DAYS;
  delete process.env.DATAFORSEO_CACHE_DAYS;
  check('the shared default is used when the env var is unset', dfsCacheDaysFromEnv() === DEFAULT_DFS_CACHE_DAYS && DEFAULT_DFS_CACHE_DAYS === 20, `${dfsCacheDaysFromEnv()} / ${DEFAULT_DFS_CACHE_DAYS}`);
  process.env.DATAFORSEO_CACHE_DAYS = '7';
  check('the env var still overrides it', dfsCacheDaysFromEnv() === 7, String(dfsCacheDaysFromEnv()));
  if (saved === undefined) delete process.env.DATAFORSEO_CACHE_DAYS; else process.env.DATAFORSEO_CACHE_DAYS = saved;
}

// ── Recon competitor fetch: no keys, every route free ───────────────────────────────────────────
{
  const page = await fetchCompetitorContent(`${base}/ok`, { maxChars: 500 });
  check('a competitor page is fetched with no API key (plain fetch)', page.via === 'plain-fetch' && /direct drive/.test(page.content) && !page.error, JSON.stringify(page));
  const vid = await fetchCompetitorContent('https://www.youtube.com/watch?v=abc', { maxChars: 500 });
  check('a ranking video is reported, not fetched', vid.kind === 'video' && vid.via === 'none' && /not fetched/.test(vid.error ?? ''), JSON.stringify(vid));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
