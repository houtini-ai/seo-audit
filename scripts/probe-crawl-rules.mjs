#!/usr/bin/env node
// Crawl rules (crawl-rules review): what the crawler may fetch, and how it decides.
//   - robots.txt matching is percent-encoding-normalised on both sides (RFC 9309 §2.2.2)
//   - a custom userAgent obeys the robots group written for its own token
//   - noindex: every robots/googlebot meta, any case, `none`; an X-Robots-Tag scoped to another bot doesn't count
//   - a bot-walled site: robots.txt and sitemaps are retried as Chrome, so its Disallow rules still hold
//   - robots.txt redirects and off-host asset probes never reach a private or local address
//   - invalid excludePatterns fail the crawl with the pattern named
//   - a redirect's target is fetched once; maxPages counts requests in flight
//   - a bare-hostname property seeds https://; CDATA <loc> and a relative `Sitemap:` line are read
// Local 127.0.0.1 servers only; `localhost` stands in for the "other host" an attacker would aim at.
// Run: npm run build:server && node scripts/probe-crawl-rules.mjs
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Crawler } from '../dist/core/Crawler.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { rulesFromText, robotsTokenFor, normaliseRobotsPath, fetchRobotsTxt } from '../dist/core/robots.js';
import { googleDirectives, metaNoindex, headerNoindex } from '../dist/core/robotsDirectives.js';
import { extractPage } from '../dist/core/extract.js';
import { fetchSitemapUrls } from '../dist/core/sitemap.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', r));
const html = (body, head = '') => `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;
const isChrome = (req) => /Chrome\//.test(req.headers['user-agent'] ?? '');
const QUIET = { delayMs: 0, checkExternal: false, siteProbes: false };
const noSignal = () => new AbortController().signal;
const pathOf = (u) => { const x = new URL(u); return x.pathname + x.search; };

// ── robots.txt: percent-encoding normalisation (finding 2) ─────────────────────
{
  const r = rulesFromText('User-agent: *\nDisallow: /café/\nDisallow: /my files/\nDisallow: /caf%c3%a9-menu\nDisallow: /%7Euser/\nDisallow: /*.pdf$\nAllow: /café/public\n', 'seo-audit-console');
  check('a non-ASCII rule matches the encoded request path', r.isAllowed(pathOf('https://x.test/café/menu')) === false);
  check('a rule with a space matches %20', r.isAllowed(pathOf('https://x.test/my files/a')) === false);
  check('percent-encoding hex case does not matter (rule lower, path upper, and the reverse)', r.isAllowed('/caf%C3%A9-menu') === false && r.isAllowed('/CAF%C3%A9-menu') === true && rulesFromText('User-agent: *\nDisallow: /caf%C3%A9\n', 'x').isAllowed('/caf%c3%a9') === false);
  check('an encoded unreserved character equals the literal one (%7E = ~)', r.isAllowed('/~user/a') === false && r.isAllowed('/%7euser/a') === false);
  check('longest match still wins after normalisation (Allow: /café/public)', r.isAllowed(pathOf('https://x.test/café/public/x')) === true);
  check('wildcards and $ are untouched', r.isAllowed('/a/b.pdf') === false && r.isAllowed('/a/b.pdf?x=1') === true && r.isAllowed('/plain') === true);
  check('normaliseRobotsPath leaves an ASCII path as it is', normaliseRobotsPath('/a/b?x=1&y=%2F*$') === '/a/b?x=1&y=%2F*$', normaliseRobotsPath('/a/b?x=1&y=%2F*$'));
}

// ── robots.txt: the token a custom userAgent answers to (finding 6) ────────────
{
  check('no userAgent, or a plain browser string, keeps seo-audit-console', robotsTokenFor(undefined) === 'seo-audit-console' && robotsTokenFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36') === 'seo-audit-console');
  check('MyBot/1.0 -> mybot', robotsTokenFor('MyBot/1.0 (+https://x.test/bot)') === 'mybot', robotsTokenFor('MyBot/1.0'));
  check('a "compatible; Googlebot/2.1" string -> googlebot', robotsTokenFor('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/131.0.0.0 Safari/537.36') === 'googlebot');
  check('the crawler\'s own UA string -> seo-audit-console', robotsTokenFor('Mozilla/5.0 (compatible; seo-audit-console/0.1; +https://github.com/houtini-ai/seo-audit)') === 'seo-audit-console');
  const txt = 'User-agent: Googlebot\nDisallow: /staging/\n\nUser-agent: *\nAllow: /\n';
  check('a crawl as Googlebot obeys Googlebot\'s group', rulesFromText(txt, robotsTokenFor('Googlebot/2.1')).isAllowed('/staging/x') === false && rulesFromText(txt, robotsTokenFor(undefined)).isAllowed('/staging/x') === true);
}

// ── noindex detection (finding 3) ──────────────────────────────────────────────
{
  const ex = (head, xr = null) => extractPage(html('<p>x</p>', head), 'https://example.com/p', 'example.com', { hostForm: 'apex' }, xr);
  check('<meta name="ROBOTS" content="NOINDEX"> is noindex', ex('<meta name="ROBOTS" content="NOINDEX, FOLLOW">').noindex === true);
  check('<meta name="googlebot" content="noindex"> is noindex', ex('<meta name="googlebot" content="noindex">').noindex === true);
  const two = ex('<meta name="robots" content="max-image-preview:large"><meta name="robots" content="noindex">');
  check('a second robots meta is read, and both are stored', two.noindex === true && two.robots === 'max-image-preview:large, noindex', two.robots);
  check('content="none" is noindex', ex('<meta name="robots" content="none">').noindex === true);
  check('one plain robots meta is stored as written', ex('<meta name="robots" content="index, follow">').robots === 'index, follow' && ex('').robots === null);
  check('index,follow / nofollow / a word containing "noindex" is not noindex', !ex('<meta name="robots" content="index, follow">').noindex && !ex('<meta name="robots" content="nofollow">').noindex && !metaNoindex('noindexing-is-not-a-directive'));
  check('X-Robots-Tag: bingbot: noindex does not apply to Google', ex('', 'bingbot: noindex').noindex === false && headerNoindex('bingbot: noindex, nofollow') === false);
  check('X-Robots-Tag: noindex / googlebot: noindex / none do', headerNoindex('noindex') && headerNoindex('googlebot: noindex') && headerNoindex('NONE') && ex('', 'noindex, nofollow').noindex === true);
  check('a scope ends where the next one starts', headerNoindex('otherbot: nofollow, googlebot: noindex') === true && headerNoindex('googlebot: nofollow, otherbot: noindex') === false);
  check('a valued directive is not a user-agent scope', JSON.stringify(googleDirectives('max-snippet: 0, noindex', 'header')) === '["max-snippet: 0","noindex"]', JSON.stringify(googleDirectives('max-snippet: 0, noindex', 'header')));
}

// "Internal service" on another host name (localhost): must never receive a request.
const internalHits = [];
const internal = http.createServer((req, res) => { internalHits.push(req.url); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /secret-from-internal\n'); });
await listen(internal);
const internalOrigin = `http://localhost:${internal.address().port}`;

try {
  // ── robots.txt fetch: Chrome fallback and guarded redirects (findings 1, 5) ──
  {
    const seen = [];
    const srv = http.createServer((req, res) => {
      seen.push(`${req.url} ${isChrome(req) ? 'chrome' : 'bot'}`);
      if (req.url === '/hop') { res.writeHead(302, { location: '/robots-real.txt' }); return res.end(); }
      if (req.url === '/robots-real.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /own-redirect\n'); }
      if (!isChrome(req)) { res.writeHead(403); return res.end('blocked'); }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /private/\n');
    });
    await listen(srv);
    const origin = `http://127.0.0.1:${srv.address().port}`;
    try {
      const walled = await fetchRobotsTxt(origin, 'seo-audit-console/0.1', { chromeFallback: true });
      check('robots.txt 403 for the bot is retried as Chrome and its rules are read', walled.status === 200 && walled.fetchedAs === 'chrome' && /Disallow: \/private\//.test(walled.body ?? ''), JSON.stringify(walled));
      const off = await fetchRobotsTxt(origin, 'seo-audit-console/0.1');
      check('without the fallback (custom userAgent / chromeFallback:false) the 403 stands', off.status === 403 && off.body === null, JSON.stringify(off));
    } finally { srv.close(); }

    const redir = http.createServer((req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(302, { location: redir.mode === 'own' ? '/hop' : `${internalOrigin}/latest/meta-data/` }); return res.end(); }
      if (req.url === '/hop') { res.writeHead(301, { location: '/robots-real.txt' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /own-redirect\n');
    });
    await listen(redir);
    const rOrigin = `http://127.0.0.1:${redir.address().port}`;
    try {
      redir.mode = 'own';
      const own = await fetchRobotsTxt(rOrigin, 'probe');
      check('robots.txt redirects on the property\'s own host are followed', own.status === 200 && /own-redirect/.test(own.body ?? ''), JSON.stringify(own));
      redir.mode = 'internal';
      const bad = await fetchRobotsTxt(rOrigin, 'probe');
      check('robots.txt redirecting to a local address on another host is refused: unreachable, nothing read', bad.status === 0 && bad.body === null, JSON.stringify(bad));
      check('and that host received no request', internalHits.length === 0, JSON.stringify(internalHits));
    } finally { redir.close(); }
  }

  // ── Sitemaps: CDATA <loc>, a relative Sitemap: line (finding 15) ─────────────
  {
    const srv = http.createServer((req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\nSitemap: /maps/main.xml\n'); }
      if (req.url === '/maps/main.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc><![CDATA[http://127.0.0.1:${srv.address().port}/a?x=1&y=2]]></loc><lastmod>2026-01-02</lastmod></url>
          <url><loc>http://127.0.0.1:${srv.address().port}/b</loc></url></urlset>`);
      }
      res.writeHead(404); res.end();
    });
    await listen(srv);
    const origin = `http://127.0.0.1:${srv.address().port}`;
    try {
      const sm = await fetchSitemapUrls(origin, 'probe', { hostForm: 'asis' });
      const file = sm.files.find(f => f.url.endsWith('/maps/main.xml'));
      check('a relative `Sitemap:` line is resolved against the origin and fetched', sm.sources[0] === `${origin}/maps/main.xml` && file?.outcome === 'ok' && file?.source === 'robots', JSON.stringify({ sources: sm.sources, file }));
      check('a CDATA-wrapped <loc> is a valid entry, paired with its lastmod', sm.urls.length === 2 && file?.invalidLocs === 0 && sm.urls.some(u => u.url === `${origin}/a?x=1&y=2` && u.lastmod === '2026-01-02'), JSON.stringify({ urls: sm.urls, file }));
    } finally { srv.close(); }
  }

  // ── A bot-walled site, crawled (findings 1, 4, 15 end to end) ────────────────
  {
    const seen = [];
    const srv = http.createServer((req, res) => {
      const p = req.url.split('?')[0];
      seen.push(`${p} ${isChrome(req) ? 'chrome' : 'bot'}`);
      if (p === '/redir.png') { res.writeHead(302, { location: `${internalOrigin}/via-own-redirect.png` }); return res.end(); }
      if (p === '/own.png') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': '5' }); return res.end('12345'); }
      if (!isChrome(req)) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('blocked'); }
      if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /private/\nSitemap: /sm.xml\n'); }
      if (p === '/sm.xml') {
        const o = `http://127.0.0.1:${srv.address().port}`;
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<urlset><url><loc><![CDATA[${o}/from-sitemap]]></loc></url><url><loc>${o}/private/in-sitemap</loc></url></urlset>`);
      }
      if (p.endsWith('.xml')) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html(`<a href="/private/linked">p</a><a href="/open">o</a><img src="${internalOrigin}/img.png" alt="x"><img src="/redir.png" alt="y"><img src="/own.png" alt="z">`));
    });
    await listen(srv);
    const origin = `http://127.0.0.1:${srv.address().port}`;
    const dir = mkdtempSync(path.join(tmpdir(), 'sac-rules-wall-'));
    try {
      const r = await new Crawler(dir).run(`${origin}/`, { maxPages: 20, maxConcurrency: 1, ...QUIET }, () => {}, noSignal());
      const adb = new AuditDatabase(dbPathFor(dir, `${origin}/`));
      const pages = adb.db.prepare('SELECT url, status_code, indexable_reason reason, fetched_as FROM pages').all();
      const images = adb.db.prepare('SELECT url, status FROM image_assets').all();
      const sitemapUrls = adb.db.prepare('SELECT url FROM sitemap_urls').all().map(x => x.url);
      const robotsRow = adb.db.prepare('SELECT status, body FROM robots_txt').get();
      adb.close();
      check('walled site: robots.txt was read (as Chrome) and stored', robotsRow?.status === 200 && /Disallow: \/private\//.test(robotsRow?.body ?? ''), JSON.stringify(robotsRow));
      check('walled site: nothing under the disallowed path was requested', !seen.some(l => l.startsWith('/private/')), seen.filter(l => l.startsWith('/private/')).join(' | '));
      check('walled site: disallowed URLs are recorded as robots-disallowed (linked and from the sitemap)', pages.filter(p => p.reason === 'robots-disallowed' && p.status_code == null).length === 2, JSON.stringify(pages));
      check('walled site: the sitemap (relative Sitemap: line, CDATA loc) was read and seeded the crawl', sitemapUrls.includes(`${origin}/from-sitemap`) && pages.some(p => p.url === `${origin}/from-sitemap` && p.status_code === 200), JSON.stringify({ sitemapUrls, sitemaps: r.sitemaps }));
      check('walled site: pages were crawled as Chrome', pages.filter(p => p.status_code === 200).length === 3 && pages.filter(p => p.status_code === 200).every(p => p.fetched_as === 'chrome'), JSON.stringify(pages));
      check('asset probes: an off-host image on a local address, and an own-host image redirecting to one, are not requested', internalHits.length === 0, JSON.stringify(internalHits));
      const st = (u) => images.find(i => i.url === u)?.status;
      check('asset probes: those two are stored as not fetched; the own-host image is still measured', st(`${internalOrigin}/img.png`) === 0 && st(`${origin}/redir.png`) === 0 && st(`${origin}/own.png`) === 200, JSON.stringify(images));
    } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
  }

  // ── A custom userAgent, redirect targets, maxPages (findings 6, 10, 14) ──────
  {
    const hits = new Map();
    let inFlight = 0, peak = 0;
    const MANY = Array.from({ length: 60 }, (_, i) => `/m${i + 1}`);
    const srv = http.createServer(async (req, res) => {
      const p = req.url.split('?')[0];
      hits.set(p, (hits.get(p) ?? 0) + 1);
      if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: MyBot\nDisallow: /for-mybot\n\nUser-agent: *\nDisallow: /for-star\n'); }
      if (p.endsWith('.xml')) { res.writeHead(404); return res.end(); }
      if (p === '/old') { res.writeHead(301, { location: '/new' }); return res.end(); }
      if (p === '/old2') { res.writeHead(301, { location: '/new' }); return res.end(); }
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      res.writeHead(200, { 'content-type': 'text/html' });
      if (p === '/') return res.end(html(srv.mode === 'many' ? MANY.map(m => `<a href="${m}">m</a>`).join('') : '<a href="/old">1</a><a href="/new">2</a><a href="/for-mybot">3</a><a href="/for-star">4</a><a href="/later">5</a>'));
      if (p === '/later') return res.end(html('<a href="/old2">again</a><a href="/new">direct</a>'));
      res.end(html(`<p>${p}</p>`));
    });
    await listen(srv);
    const origin = `http://127.0.0.1:${srv.address().port}`;
    const dirA = mkdtempSync(path.join(tmpdir(), 'sac-rules-ua-'));
    const dirB = mkdtempSync(path.join(tmpdir(), 'sac-rules-cap-'));
    try {
      srv.mode = 'small';
      const r = await new Crawler(dirA).run(`${origin}/`, { maxPages: 50, maxConcurrency: 1, userAgent: 'MyBot/1.0', ...QUIET }, () => {}, noSignal());
      const adb = new AuditDatabase(dbPathFor(dirA, `${origin}/`));
      const pages = adb.db.prepare('SELECT url, status_code, indexable_reason reason FROM pages').all();
      const redirects = adb.db.prepare('SELECT url, final_url FROM redirect_sources').all();
      adb.close();
      check('custom userAgent: the group naming it is obeyed (/for-mybot not requested, /for-star is)', !hits.has('/for-mybot') && hits.get('/for-star') === 1 && pages.some(p => p.url === `${origin}/for-mybot` && p.reason === 'robots-disallowed'), JSON.stringify([...hits]));
      check('a redirect target is downloaded once, whether linked directly or redirected to again later', hits.get('/new') === 1 && hits.get('/old') === 1 && hits.get('/old2') === 1, JSON.stringify([...hits]));
      check('both redirect sources are still recorded', redirects.length === 2 && redirects.every(x => x.final_url === `${origin}/new`), JSON.stringify(redirects));
      const stored = pages.filter(p => p.status_code === 200).length;
      check('crawled counts stored pages only (a redirect onto a page already stored is not counted)', r.crawled === stored && stored === 4, JSON.stringify({ crawled: r.crawled, stored, pages }));

      srv.mode = 'many'; hits.clear(); peak = 0;
      const cap = await new Crawler(dirB).run(`${origin}/`, { maxPages: 10, maxConcurrency: 8, ...QUIET }, () => {}, noSignal());
      const bdb = new AuditDatabase(dbPathFor(dirB, `${origin}/`));
      const n = bdb.db.prepare('SELECT COUNT(*) n FROM pages WHERE status_code = 200').get().n;
      bdb.close();
      const fetched = [...hits.keys()].filter(p => p === '/' || p.startsWith('/m')).length;
      check('maxPages 10 at concurrency 8: exactly 10 pages requested and stored, not up to 17', cap.crawled === 10 && n === 10 && fetched === 10, JSON.stringify({ crawled: cap.crawled, stored: n, fetched }));
      check('and the crawl still ran in parallel', peak > 1, `peak ${peak}`);
    } finally { srv.close(); rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); }
  }

  // ── Invalid excludePatterns, a bare-hostname property (findings 7, 13) ───────
  {
    const hits = [];
    const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('<a href="/tag/a">t</a><a href="/keep">k</a>')); });
    await listen(srv);
    const origin = `http://127.0.0.1:${srv.address().port}`;
    const dir = mkdtempSync(path.join(tmpdir(), 'sac-rules-excl-'));
    try {
      let err = null;
      try { await new Crawler(dir).run(`${origin}/`, { excludePatterns: ['/author/', '*/tag/*'], ...QUIET }, () => {}, noSignal()); } catch (e) { err = e; }
      check('an invalid excludePattern fails the crawl and names the pattern', /excludePatterns: "\*\/tag\/\*" is not a valid regular expression/.test(err?.message ?? ''), err?.message ?? 'no error');
      check('and nothing was requested', hits.length === 0, JSON.stringify(hits));
      await new Crawler(dir).run(`${origin}/`, { excludePatterns: ['/tag/'], maxConcurrency: 1, ...QUIET }, () => {}, noSignal());
      check('a valid pattern still excludes', hits.includes('/keep') && !hits.includes('/tag/a'), JSON.stringify(hits));
    } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }

    // A bare hostname seeds https://<host>/. Nothing listens on 127.0.0.1:443 here, so the crawl stops
    // at robots.txt (unreachable) - which proves the seed parsed: it used to throw "Invalid URL".
    const dirH = mkdtempSync(path.join(tmpdir(), 'sac-rules-bare-'));
    try {
      let err = null;
      try { await new Crawler(dirH).run('127.0.0.1', { ...QUIET }, () => {}, noSignal()); } catch (e) { err = e; }
      const adb = new AuditDatabase(dbPathFor(dirH, '127.0.0.1'));
      const meta = adb.db.prepare('SELECT base_url, status FROM crawl_metadata').get();
      adb.close();
      check('a bare-hostname property is seeded as https://<host>/', meta?.base_url === 'https://127.0.0.1/' && !/Invalid URL/.test(err?.message ?? ''), JSON.stringify({ meta, err: err?.message }));
    } finally { rmSync(dirH, { recursive: true, force: true }); }
  }
} finally { internal.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
