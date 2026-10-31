// Regression test for the bot-block → Chrome fallback in the crawler, the outbound-link checker
// and probe_urls. A local "WAF" returns a Cloudflare-style 403 to any non-Chrome user agent.
// Run: node scripts/probe-blocking.mjs (after build:server)
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Crawler } from '../dist/core/Crawler.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { checkExternal } from '../dist/core/externalLinks.js';
import { probeUrls } from '../dist/core/probeUrls.js';
import { allowPrivateAddressesForTests } from '../dist/core/netGuard.js';
// Local 127.0.0.1 servers stand in for third-party hosts here; the SSRF guard (netGuard.ts) would refuse them.
allowPrivateAddressesForTests(true);

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };

// Site A: only /walled/ is behind the WAF. Site B: every page is (to exercise the sticky switch).
const mkSite = (mode) => {
  const log = [];
  let origin = '';
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, origin).pathname;
    const chrome = /Chrome\//.test(req.headers['user-agent'] ?? '');
    log.push({ p, chrome, cond: !!req.headers['if-none-match'] });
    if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    if (p.endsWith('.xml')) { res.writeHead(404); return res.end(); }
    if (mode === 'forbidden' && p === '/admin/') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('Forbidden'); } // for everyone
    const walled = mode === 'all' ? true : mode === 'section' ? p.startsWith('/docs/') : mode === 'waf503' ? true : p === '/walled/';
    if (walled && !chrome) {
      if (mode === 'waf503') { res.writeHead(503, { server: 'cloudflare', 'cf-mitigated': 'challenge', 'content-type': 'text/html' }); return res.end('Checking your browser'); }
      res.writeHead(403, { server: 'cloudflare', 'content-type': 'text/html' }); return res.end('Attention Required');
    }
    if (req.headers['if-none-match']) { res.writeHead(304); return res.end(); }
    const links = mode === 'all' || mode === 'waf503' ? Array.from({ length: 8 }, (_, i) => `<a href="/p${i}/">p</a>`).join('')
      : mode === 'section' ? [...Array.from({ length: 6 }, (_, i) => `<a href="/open${i}/">o</a>`), ...Array.from({ length: 4 }, (_, i) => `<a href="/docs/d${i}/">d</a>`)].join('')
      : mode === 'forbidden' ? '<a href="/admin/">a</a><a href="/open/">o</a>'
      : '<a href="/walled/">w</a><a href="/open/">o</a>';
    res.writeHead(200, { 'content-type': 'text/html', etag: '"v1"' }); res.end(`<html><head><title>${p}</title></head><body>${links}</body></html>`);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${srv.address().port}`; r({ srv, log, get origin() { return origin; } }); }));
};

const dir = mkdtempSync(path.join(tmpdir(), 'sac-block-'));
const crawl = (site, extra = {}) => new Crawler(dir).run(`${site.origin}/`, { maxPages: 30, delayMs: 0, maxConcurrency: 1, checkExternal: false, ...extra }, () => {}, new AbortController().signal);
const t0 = Date.now();
const pagesOf = (site) => { const d = new AuditDatabase(dbPathFor(dir, `${site.origin}/`)); try { return Object.fromEntries(d.db.prepare('SELECT url, status_code, fetched_as FROM pages').all().map(r => [new URL(r.url).pathname, r])); } finally { d.close(); } };

const A = await mkSite('one'), B = await mkSite('all'), C = await mkSite('section'), D = await mkSite('forbidden'), E = await mkSite('waf503');
try {
  // ── Crawler: one walled page ──
  const ra = await crawl(A);
  const pa = pagesOf(A);
  check('walled page crawled as 200 via the Chrome retry', pa['/walled/']?.status_code === 200 && pa['/walled/'].fetched_as === 'chrome', JSON.stringify(pa['/walled/']));
  check('open pages stay on the crawler UA', pa['/open/']?.fetched_as === 'bot' && pa['/']?.fetched_as === 'bot', JSON.stringify(pa));
  check('crawl result reports the blocking', ra.blocking?.blockedAsBot === 1 && ra.blocking.okAsChrome === 1 && !ra.blocking.switchedToChrome, JSON.stringify(ra.blocking));

  // ── Crawler: whole site walled → sticky switch after 3 ──
  const rb = await crawl(B);
  const pb = pagesOf(B);
  const botPageHits = B.log.filter(h => !h.chrome && h.p !== '/robots.txt' && !h.p.endsWith('.xml')).length;
  check('every page fetched (as Chrome)', Object.values(pb).length === 9 && Object.values(pb).every(r => r.status_code === 200 && r.fetched_as === 'chrome'), JSON.stringify(pb));
  check('switches to Chrome after 3 blocked pages (no double request per page after that)', rb.blocking?.switchedToChrome && botPageHits === 3, `bot page hits ${botPageHits}, ${JSON.stringify(rb.blocking)}`);
  check('post-crawl header probes follow the switch (conditional-304 probes sent as Chrome)', B.log.some(h => h.cond) && B.log.filter(h => h.cond).every(h => h.chrome), JSON.stringify(B.log.filter(h => h.cond)));

  // ── Only one section walled, under concurrency: no sticky switch, honest per-page record ──
  const rcs = await crawl(C, { maxConcurrency: 8 });
  const pc = pagesOf(C);
  const docs = Object.entries(pc).filter(([k]) => k.startsWith('/docs/')), open = Object.entries(pc).filter(([k]) => !k.startsWith('/docs/'));
  check('partially walled site: walled pages via Chrome, open pages stay bot, no switch', docs.every(([, r]) => r.fetched_as === 'chrome') && open.every(([, r]) => r.fetched_as === 'bot') && !rcs.blocking?.switchedToChrome, JSON.stringify({ blocking: rcs.blocking, pc }));

  // ── A real 403 that Chrome also gets is NOT bot protection ──
  const rd = await crawl(D);
  check('403 for everyone: not reported as blocking', !rd.blocking && pagesOf(D)['/admin/']?.status_code === 403, JSON.stringify({ blocking: rd.blocking, admin: pagesOf(D)['/admin/'] }));

  // ── WAF challenge as a 503: Chrome retry fires immediately, not after the 429/503 backoff ──
  const tw = Date.now();
  const re = await crawl(E);
  const waf = Date.now() - tw;
  check('503 challenge → Chrome retry before any backoff (whole crawl well under one backoff step)', re.blocking?.okAsChrome >= 3 && Object.values(pagesOf(E)).every(r => r.status_code === 200) && waf < 5000, `${waf}ms ${JSON.stringify(re.blocking)}`);

  // ── Explicit userAgent disables the fallback ──
  B.log.length = 0;
  const rc = await crawl(B, { userAgent: 'MyAuditBot/1.0' });
  check('explicit userAgent: no Chrome retry, the 403 is recorded', !rc.blocking && pagesOf(B)['/']?.status_code === 403 && !B.log.some(h => h.chrome), JSON.stringify({ blocking: rc.blocking, home: pagesOf(B)['/'] }));

  // ── Outbound-link checker ──
  const ext = await checkExternal(`${B.origin}/somewhere/`, { userAgent: 'probe-bot', timeoutMs: 3000, chromeFallback: true });
  check('outbound link behind a bot wall → ok via Chrome, recorded', ext.verdict === 'ok' && ext.fetchedAs === 'chrome', JSON.stringify(ext));
  const extNo = await checkExternal(`${B.origin}/somewhere/`, { userAgent: 'probe-bot', timeoutMs: 3000, chromeFallback: false });
  check('fallback off → stays unverifiable, never broken', extNo.verdict === 'unverifiable' && extNo.fetchedAs === 'bot', JSON.stringify(extNo));
  const rl = http.createServer((_q, r) => { r.writeHead(429); r.end(); }); await new Promise(r => rl.listen(0, '127.0.0.1', r));
  const hitsBefore = 0; let rlHits = 0; rl.on('request', () => rlHits++);
  const ext429 = await checkExternal(`http://127.0.0.1:${rl.address().port}/x`, { userAgent: 'probe-bot', timeoutMs: 3000, chromeFallback: true });
  rl.close();
  check('plain 429 → unverifiable with NO Chrome retry (identity cannot help a rate limit)', ext429.verdict === 'unverifiable' && ext429.fetchedAs === 'bot' && rlHits <= 2, `hits ${rlHits} ${JSON.stringify(ext429)}`);

  // ── probe_urls ──
  const [pr] = await probeUrls([{ url: `${A.origin}/walled/` }], '127.0.0.1');
  check('probe_urls: walled URL answered via Chrome, flagged blockedAsBot', pr.finalStatus === 200 && pr.fetchedAs === 'chrome' && pr.blockedAsBot === true, JSON.stringify(pr));
  const [po] = await probeUrls([{ url: `${A.origin}/open/` }], '127.0.0.1');
  check('probe_urls: open URL stays on the probe UA', po.fetchedAs === 'bot' && !po.blockedAsBot, JSON.stringify(po));
} finally {
  for (const s of [A, B, C, D, E]) s.srv.close(); rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
