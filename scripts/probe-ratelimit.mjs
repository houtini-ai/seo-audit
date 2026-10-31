// #54 rate limiting. A local server that answers 429 + Retry-After once more
// than K requests are in flight (and, separately, for a path prefix), crawled for real:
//   - AIMD: concurrency drops on 429 and climbs back on clean responses
//   - no page is ever stored with status 429
//   - a prefix that never recovers leaves fetch_state='rate_limited' rows (status NULL, indexable NULL)
//   - checks and drift treat those rows as unknown, not as errors
//   - Shopify headers start the crawl at concurrency 3 unless maxConcurrency was set
// Plus the pure helpers (AimdLimiter, Retry-After, summaries). (#58's optionalSecret is in smoke.mjs.)
// No network beyond 127.0.0.1. Run: node scripts/probe-ratelimit.mjs (after npm run build:server)
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Crawler } from '../dist/core/Crawler.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { CHECKS } from '../dist/audit/checks.js';
import { diffLatest } from '../dist/audit/drift.js';
import { urlKey, hostFormForProperty } from '../dist/core/url-key.js';
import { AimdLimiter, parseRetryAfter, rateLimitWaitMs, isRateLimited, looksLikeShopify, rateLimitSummary, RETRY_AFTER_CAP_MS } from '../dist/core/rateLimit.js';
import { crawlNotes } from '../dist/core/crawlProgress.js';
import { probeUrls } from '../dist/core/probeUrls.js';
import { looksBotBlocked } from '../dist/core/userAgents.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const hdr = (o) => (n) => o[n.toLowerCase()] ?? null;

// ── Pure helpers ────────────────────────────────────────────────────────────
{
  const l = new AimdLimiter(8, 8, 20);
  const t0 = 1000;
  // Eight requests in flight since t0 all come back 429: ONE halving, not eight.
  let lowered = 0;
  for (let i = 0; i < 8; i++) if (l.onRateLimited(t0, t0 + 100 + i)) lowered++;
  check('AIMD: a burst of 429s from one generation halves once (8 -> 4)', l.limit === 4 && lowered === 1 && l.events === 8, JSON.stringify({ limit: l.limit, lowered }));
  // A request sent after that decrease is a new generation.
  l.onRateLimited(t0 + 200, t0 + 300);
  check('AIMD: a 429 on a request sent after the decrease halves again (4 -> 2)', l.limit === 2 && l.min === 2, `${l.limit}`);
  l.onRateLimited(t0 + 400, t0 + 500); l.onRateLimited(t0 + 600, t0 + 700);
  check('AIMD: floor is 1', l.limit === 1 && l.min === 1, `${l.limit}`);
  for (let i = 0; i < 19; i++) l.onSuccess();
  check('AIMD: 19 clean responses do not grow', l.limit === 1);
  l.onSuccess();
  check('AIMD: the 20th clean response adds 1', l.limit === 2 && l.consecutive === 0);
  for (let i = 0; i < 2000; i++) l.onSuccess();
  check('AIMD: growth stops at max', l.limit === 8 && l.min === 1, `${l.limit}`);
  const s = new AimdLimiter(8); s.capAt(3);
  check('AIMD: capAt lowers the start (Shopify)', s.limit === 3 && s.max === 8 && s.min === 3);

  const now = Date.parse('2026-10-17T10:00:00Z');
  check('Retry-After: delta seconds', parseRetryAfter('120', now) === 120_000 && parseRetryAfter(' 1.5 ', now) === 1500);
  check('Retry-After: HTTP date', parseRetryAfter('Sat, 17 Oct 2026 10:00:42 GMT', now) === 42_000);
  check('Retry-After: past date is 0, garbage/absent is null', parseRetryAfter('Fri, 16 Oct 2026 10:00:00 GMT', now) === 0 && parseRetryAfter('soon', now) === null && parseRetryAfter(null, now) === null);
  check('wait: Retry-After capped', rateLimitWaitMs('3600', 1, now) === RETRY_AFTER_CAP_MS);
  check('wait: no Retry-After = 1s doubling, capped at 15s', rateLimitWaitMs(null, 1) === 1000 && rateLimitWaitMs(null, 3) === 4000 && rateLimitWaitMs(null, 10) === 15000);
  check('isRateLimited: 429 always, 503 only with Retry-After', isRateLimited(429, hdr({})) && isRateLimited(503, hdr({ 'retry-after': '5' })) && !isRateLimited(503, hdr({})) && !isRateLimited(404, hdr({})));
  check('looksLikeShopify: x-shopid / powered-by', looksLikeShopify(hdr({ 'x-shopid': '123' })) && looksLikeShopify(hdr({ 'powered-by': 'Shopify' })) && !looksLikeShopify(hdr({ server: 'nginx' })));
  const sum = rateLimitSummary({ events: 40, currentConcurrency: 2, minConcurrency: 1, maxConcurrency: 8, retried: 37, unfetched: 3 });
  check('summary wording', sum === 'rate limited by the host: concurrency reduced to 2 (low 1); 37 URLs retried, 3 not fetched', sum);
  check('summary: nothing when no events', rateLimitSummary({ events: 0, currentConcurrency: 8, minConcurrency: 8, maxConcurrency: 8, retried: 0, unfetched: 0 }) === null);
  const notes = crawlNotes({ platform: { name: 'shopify', startConcurrency: 3, userSetConcurrency: false }, rateLimited: { events: 2, currentConcurrency: 2, minConcurrency: 2, maxConcurrency: 8, retried: 2, unfetched: 0 } });
  check('crawlNotes: Shopify + rate-limit notes for check_crawl_status', notes === '; Shopify host: started at concurrency 3; rate limited by the host: concurrency reduced to 2; 2 URLs retried, 0 not fetched', notes);
  check('crawlNotes: empty for a clean crawl', crawlNotes({ rateLimited: { events: 0, currentConcurrency: 8, minConcurrency: 8, maxConcurrency: 8, retried: 0, unfetched: 0 } }) === '');
}

// ── A CDN's `server` header is not a bot wall (review/10) ─────────────────────
// Shopify and most CDN-fronted sites send `server: cloudflare` on ordinary rate-limit 429s. Read
// as a WAF challenge, every rate-limited URL was retried at once as Chrome (no backoff), the crawl
// switched to Chrome after three, and probe_urls stored the 429 as the page's status.
{
  check('a 429 from server: cloudflare is a rate limit, not a bot wall', !looksBotBlocked(429, hdr({ server: 'cloudflare', 'retry-after': '5' })));
  check('a 503 + Retry-After from server: cloudflare is a rate limit, not a bot wall', !looksBotBlocked(503, hdr({ server: 'cloudflare', 'retry-after': '5' })));
  check('a challenge marker still makes a 429 a bot wall', looksBotBlocked(429, hdr({ server: 'cloudflare', 'cf-mitigated': 'challenge' })) && looksBotBlocked(429, hdr({ 'x-datadome': '1' })));
  check('403 and 999 are still bot walls', looksBotBlocked(403, hdr({})) && looksBotBlocked(999, hdr({})));
  const seen = new Map(); const log = [];
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const ua = /Chrome\//.test(req.headers['user-agent'] ?? '') ? 'chrome' : 'bot';
    if (p === '/robots.txt' || /sitemap/.test(p)) { res.writeHead(404); return res.end(); }
    if (p === '/always429') { log.push(`${p} ${ua}`); res.writeHead(429, { server: 'cloudflare', 'retry-after': '1', 'content-type': 'text/html' }); return res.end('slow down'); }
    const n = (seen.get(p) ?? 0) + 1; seen.set(p, n);
    log.push(`${p} ${ua}`);
    if (n === 1) { res.writeHead(429, { server: 'cloudflare', 'retry-after': '1', 'content-type': 'text/html' }); return res.end('rate limited'); }
    res.writeHead(200, { server: 'cloudflare', 'content-type': 'text/html' });
    res.end(`<html><head><title>${p}</title></head><body>${[1, 2, 3, 4].map(i => `<a href="/p${i}">x</a>`).join('')}</body></html>`);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const dirC = mkdtempSync(path.join(tmpdir(), 'sac-cf429-'));
  try {
    const r = await new Crawler(dirC).run(`${origin}/`, { maxPages: 5, delayMs: 0, maxConcurrency: 1, checkExternal: false, siteProbes: false }, () => {}, new AbortController().signal);
    const adb = new AuditDatabase(dbPathFor(dirC, `${origin}/`));
    const rows = adb.db.prepare('SELECT fetched_as, status_code FROM pages').all();
    adb.close();
    check('crawl: Cloudflare rate limits never trigger the Chrome retry', !log.some(l => l.endsWith('chrome')) && !r.blocking?.switchedToChrome, log.join(' | '));
    check('crawl: every page is fetched as the bot, after backing off, with status 200', rows.length === 5 && rows.every(x => x.fetched_as === 'bot' && x.status_code === 200) && (r.rateLimited?.events ?? 0) >= 5, JSON.stringify({ rows, rl: r.rateLimited }));
    const [pr] = await probeUrls([{ url: `${origin}/always429` }], '127.0.0.1', { budgetMs: 15000 });
    check('probe_urls: a persistent Cloudflare 429 is "rate limited", never stored as status 429', pr.rateLimited === true && pr.status == null && pr.finalStatus == null, JSON.stringify({ s: pr.status, f: pr.finalStatus, rl: pr.rateLimited }));
  } finally { srv.close(); rmSync(dirC, { recursive: true, force: true }); }
}

// ── Local rate-limiting host ───────────────────────────────────────────────
let origin = '';
// Enough pages that, after dropping to 1, the crawl gets the 20+ clean responses per step it needs to climb back.
const PRODUCTS = Array.from({ length: 140 }, (_, i) => `/products/p${i + 1}`);
const COLLECTIONS = Array.from({ length: 6 }, (_, i) => `/collections/c${i + 1}`);
const state = { mode: 'open', globalLimit: 3, prefixLimit: 2, inFlight: 0, prefixInFlight: 0, peak: 0, peakWindow: 0, requests: 0, served429: 0, shopify: false };
const html = (body, head = '') => `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, origin).pathname;
  const extra = state.shopify ? { 'x-shopid': '4242', 'powered-by': 'Shopify' } : {};
  if (pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain', ...extra }); return res.end('User-agent: *\nAllow: /\n'); }
  if (pathname.endsWith('.xml')) { res.writeHead(404, extra); return res.end(); }
  state.requests++;
  const isCollection = pathname.startsWith('/collections/');
  state.inFlight++; if (isCollection) state.prefixInFlight++;
  state.peak = Math.max(state.peak, state.inFlight);
  // Requests 11-20: after Shopify detection capped the pool, before AIMD's first +1 (20 clean responses).
  if (state.requests > 10 && state.requests <= 20) state.peakWindow = Math.max(state.peakWindow, state.inFlight);
  const done = () => { state.inFlight--; if (isCollection) state.prefixInFlight--; };
  const tooMany = (state.mode === 'throttle' && (state.inFlight > state.globalLimit || (isCollection && state.prefixInFlight > state.prefixLimit)))
    || (state.mode === 'wall' && isCollection);
  await new Promise(r => setTimeout(r, 25));
  if (tooMany) {
    state.served429++;
    done();
    res.writeHead(429, { 'content-type': 'text/html', 'retry-after': state.mode === 'wall' ? '0' : '1', ...extra });
    return res.end('<h1>Too Many Requests</h1>');
  }
  let body;
  if (pathname === '/') {
    // hreflang alternate on a collection: a rate-limited target must not read as a broken alternate.
    body = html(`<main>${[...PRODUCTS, ...COLLECTIONS].map(p => `<a href="${p}">${p}</a>`).join('')}</main>`,
      `<link rel="alternate" hreflang="en" href="${origin}/"><link rel="alternate" hreflang="en-au" href="${origin}/collections/c1">`);
  } else if (PRODUCTS.includes(pathname) || COLLECTIONS.includes(pathname)) {
    body = html(`<h1>${pathname}</h1><p>${'word '.repeat(300)}</p><a href="/">home</a><a href="/collections/c2">c2</a>`);
  }
  done();
  if (!body) { res.writeHead(404, { 'content-type': 'text/html', ...extra }); return res.end('<h1>404</h1>'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${server.address().port}`;
const site = `${origin}/`;
const key = (p) => urlKey(`${origin}${p}`, { hostForm: hostFormForProperty(site) });
const reset = (mode) => Object.assign(state, { mode, inFlight: 0, prefixInFlight: 0, peak: 0, peakWindow: 0, requests: 0, served429: 0 });
const crawl = async (dir, opts = {}) => {
  const progress = [];
  const result = await new Crawler(dir).run(site, { maxPages: 200, delayMs: 0, checkExternal: false, ...opts }, (p) => progress.push(p), new AbortController().signal);
  return { result, progress };
};
const ALL = ['/', ...PRODUCTS, ...COLLECTIONS];

const dirs = [];
try {
  // 1) A host that throttles above 3 in flight (and /collections/ above 2): the crawl adapts and
  //    every page lands as a 200. Nothing is stored as 429.
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'sac-rl-')); dirs.push(dir);
    reset('throttle');
    const t = Date.now();
    const { result, progress } = await crawl(dir, { maxConcurrency: 8 });
    const rl = result.rateLimited;
    const db = new AuditDatabase(dbPathFor(dir, site));
    const statuses = db.db.prepare(`SELECT status_code s, COUNT(*) n FROM pages GROUP BY 1`).all();
    const n429 = db.db.prepare(`SELECT COUNT(*) n FROM pages WHERE status_code=429`).get().n;
    const ok200 = db.db.prepare(`SELECT COUNT(*) n FROM pages WHERE status_code=200`).get().n;
    const rlRows = db.db.prepare(`SELECT COUNT(*) n FROM pages WHERE fetch_state='rate_limited'`).get().n;
    db.close();
    console.log(`  .. throttled crawl: ${result.crawled} pages in ${Date.now() - t} ms, server served ${state.served429} x 429, peak in-flight ${state.peak}; ${JSON.stringify(rl)}`);
    check('throttle: the host did rate limit the crawl', state.served429 > 0 && rl.events > 0, JSON.stringify(rl));
    check('throttle: concurrency dropped below the ceiling', rl.minConcurrency < 8 && rl.maxConcurrency === 8, JSON.stringify(rl));
    // Recovery: after a drop, some later progress report shows the limit stepping back up. (Not
    // "after the global low": on a host that keeps throttling the low can be the last report.)
    const seq = progress.map(p => p.rateLimited?.currentConcurrency).filter(n => typeof n === 'number');
    const firstDrop = seq.findIndex(n => n < 8);
    check('throttle: concurrency recovers after a drop (AIMD additive increase)', firstDrop >= 0 && seq.some((n, i) => i > firstDrop && n > seq[i - 1]), JSON.stringify(seq));
    check('throttle: no page stored with status 429', n429 === 0, JSON.stringify(statuses));
    check('throttle: every page fetched as 200 (retries recovered them)', ok200 === ALL.length && rlRows === 0 && rl.unfetched === 0, JSON.stringify({ ok200, rlRows, statuses }));
    check('throttle: rate-limited URLs were re-queued, counted as retried', rl.retried > 0 && rl.retried <= rl.events, JSON.stringify(rl));
    const fetching = progress.filter(p => p.stage === 'fetching' && p.rateLimited?.events > 0).at(-1);
    check('throttle: progress carries rateLimited for check_crawl_status', !!fetching && /rate limited by the host: concurrency (reduced to|back at) \d+/.test(crawlNotes(fetching)), crawlNotes(fetching));
  }

  // 2) The same site crawled clean (baseline), then with /collections/ walled by 429 for good:
  //    those URLs become fetch_state='rate_limited' rows, and no check or drift entry calls them broken.
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'sac-rl-')); dirs.push(dir);
    reset('open');
    // GSC demand for a collection, so traffic-to-dead-url gets a chance to misfire.
    {
      const pre = new AuditDatabase(dbPathFor(dir, site));
      pre.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,clicks,impressions,position) VALUES ('2026-10-01','castors',?,?,40,900,4.2)`).run(`${origin}/collections/c3`, key('/collections/c3'));
      pre.close();
    }
    const base = await crawl(dir, { maxConcurrency: 4 });
    check('wall: baseline crawl is clean', base.result.rateLimited.events === 0 && base.result.crawled === ALL.length, JSON.stringify(base.result.rateLimited));
    reset('wall');
    const t = Date.now();
    const { result } = await crawl(dir, { maxConcurrency: 4 });
    const rl = result.rateLimited;
    console.log(`  .. walled crawl: ${result.crawled} pages in ${Date.now() - t} ms; ${JSON.stringify(rl)}`);
    const db = new AuditDatabase(dbPathFor(dir, site));
    // A sitemap row for a collection (the crawl rewrites sitemap_urls, so add it after), so
    // sitemap-non-indexable gets a chance to misfire.
    db.db.prepare(`INSERT OR IGNORE INTO sitemap_urls (url_key,url,fetched_at) VALUES (?,?,datetime('now'))`).run(key('/collections/c4'), `${origin}/collections/c4`);
    const rows = db.db.prepare(`SELECT url_key, status_code, indexable, indexable_reason, fetch_state FROM pages WHERE fetch_state='rate_limited' ORDER BY url_key`).all();
    const n429 = db.db.prepare(`SELECT COUNT(*) n FROM pages WHERE status_code=429`).get().n;
    check('wall: every walled URL stored as rate_limited, status NULL, indexable NULL', rows.length === COLLECTIONS.length && rows.every(r => r.status_code === null && r.indexable === null && r.indexable_reason === 'rate-limited'), JSON.stringify(rows));
    check('wall: result reports them as retried and not fetched', rl.unfetched === COLLECTIONS.length && rl.retried === COLLECTIONS.length && rl.events === COLLECTIONS.length * 3, JSON.stringify(rl));
    check('wall: still no page stored with status 429', n429 === 0);
    check('wall: the rest of the site was crawled normally', result.crawled === ALL.length - COLLECTIONS.length, `${result.crawled}`);

    // Checks: nothing keyed on a rate-limited URL, and no crawl-wide check counts them as waste.
    const rlKeys = new Set(rows.map(r => r.url_key));
    const ctx = { db: db.db, gscMaxDate: '2026-10-05' };
    const flagged = [], threw = [];
    for (const chk of CHECKS) {
      let out = [];
      try { out = chk.run(ctx); } catch (e) { threw.push(`${chk.id}: ${e.message}`); continue; }
      for (const f of out) {
        const ev = JSON.stringify(f.evidence ?? {});
        if ((f.urlKey && rlKeys.has(f.urlKey)) || [...rlKeys].some(k => ev.includes(k))) flagged.push(chk.id);
      }
    }
    check('checks: all run on a DB with rate_limited rows', threw.length === 0, JSON.stringify(threw));
    check('checks: no finding treats a rate-limited URL as an error (broken links, hreflang, sitemap, dead-URL traffic, ...)', flagged.length === 0, JSON.stringify([...new Set(flagged)]));

    // Drift: the clean crawl had them at 200; the walled crawl has them unknown - not a crit change.
    const drift = diffLatest(db.db);
    const driftHits = drift.changes.filter(c => rlKeys.has(c.urlKey));
    check('drift: rate-limited URLs are not reported as 200 -> null / de-indexed', drift.currentCrawl === result.crawlId && driftHits.length === 0, JSON.stringify(driftHits.slice(0, 2)));
    db.close();

    // probe_urls: a host still rate limiting after one wait reports "unknown", never a 429 status.
    const [walled, open] = await probeUrls([{ url: `${origin}/collections/c1` }, { url: `${origin}/products/p1` }], '127.0.0.1', { budgetMs: 10000 });
    check('probe_urls: rate-limited URL has no status, a rateLimited flag and a reason', walled.rateLimited === true && walled.status === null && walled.finalStatus === null && /rate limited by the host \(HTTP 429/.test(walled.error ?? ''), JSON.stringify(walled));
    check('probe_urls: other URLs on the host are unaffected', open.status === 200 && !open.rateLimited, JSON.stringify(open));
  }

  // 3) Shopify: detected from headers on the first responses; starts at 3 unless maxConcurrency is set.
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'sac-rl-')); dirs.push(dir);
    state.shopify = true;
    reset('open');
    const { result, progress } = await crawl(dir);
    check('shopify: detected from response headers', result.platform?.name === 'shopify' && result.platform.startConcurrency === 3 && result.platform.userSetConcurrency === false, JSON.stringify(result.platform));
    check('shopify: the pool dropped to 3 once detected (peak in-flight over requests 11-20)', state.peakWindow <= 3 && result.rateLimited.minConcurrency === 3, JSON.stringify({ peakWindow: state.peakWindow, rl: result.rateLimited }));
    check('shopify: AIMD still climbs from the lower start on a clean host', result.rateLimited.currentConcurrency > 3, JSON.stringify(result.rateLimited));
    const last = progress.filter(p => p.stage === 'fetching').at(-1);
    check('shopify: noted in the crawl status', /Shopify host: started at concurrency 3/.test(crawlNotes(last)), crawlNotes(last));

    const dir2 = mkdtempSync(path.join(tmpdir(), 'sac-rl-')); dirs.push(dir2);
    reset('open');
    const r2 = await crawl(dir2, { maxConcurrency: 5 });
    check('shopify: an explicit maxConcurrency is kept', r2.result.platform?.userSetConcurrency === true && r2.result.platform.startConcurrency === 5 && r2.result.rateLimited.minConcurrency === 5, JSON.stringify(r2.result.platform));
    state.shopify = false;
  }
} finally {
  server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

// ── Bounded body reads (cappedBody.ts) ────────────────────────────────────────
// A response body is never buffered whole: a 40 MB page was read and extracted whole (50 MB
// crashed the process), and a 1 MB gzip sitemap inflated to ~1 GB. Reads stop at the cap and say so.
{
  const { gzipSync } = await import('node:zlib');
  const { readCapped, MAX_HTML_BYTES } = await import('../dist/core/cappedBody.js');
  const big = Buffer.alloc(MAX_HTML_BYTES + 25 * 1024 * 1024, 0x61); // 40 MB of "a"
  const bomb = gzipSync(Buffer.alloc(60 * 1024 * 1024, 0x20));      // ~60 KB on the wire, 60 MB inflated
  let bigServed = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: *\nAllow: /\nSitemap: http://127.0.0.1:${srv.address().port}/sitemap.xml.gz\n`); }
    if (req.url === '/sitemap.xml.gz') { res.writeHead(200, { 'content-type': 'application/gzip' }); return res.end(bomb); }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>Home</title></head><body><a href="/big">big</a></body></html>'); }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><head><title>Big</title></head><body>');
      let off = 0;
      const pump = () => { while (off < big.length) { const ok = res.write(big.subarray(off, off + 1024 * 1024)); off += 1024 * 1024; bigServed = off; if (!ok) return res.once('drain', pump); } res.end('</body></html>'); };
      res.on('error', () => {}); req.socket.on('error', () => {});
      return pump();
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await readCapped(await fetch(`${origin}/big`), 1024 * 1024);
    check('readCapped stops at the cap and says so', r.truncated === true && r.buf.length === 1024 * 1024, `${r.truncated} ${r.buf.length}`);
    const small = await readCapped(await fetch(`${origin}/`), 1024 * 1024);
    check('readCapped reads a small body whole', small.truncated === false && /<title>Home/.test(small.buf.toString()), `${small.truncated}`);
    const dirB = mkdtempSync(path.join(tmpdir(), 'sac-bigbody-'));
    dirs.push(dirB);
    const heapBefore = process.memoryUsage().rss;
    const res = await new Crawler(dirB).run(`${origin}/`, { maxPages: 5, delayMs: 0, maxConcurrency: 1, checkExternal: false, siteProbes: false }, () => {}, new AbortController().signal);
    const grew = (process.memoryUsage().rss - heapBefore) / 1024 / 1024;
    const adb = new AuditDatabase(dbPathFor(dirB, `${origin}/`));
    const pg = adb.db.prepare(`SELECT status_code, title FROM pages WHERE url LIKE '%/big'`).get();
    const err = adb.db.prepare(`SELECT error_type, error_message FROM errors WHERE url LIKE '%/big'`).get();
    adb.close();
    check('a 40 MB page is crawled up to 5 MB: stored with its title, and the truncation is recorded', pg?.status_code === 200 && pg?.title === 'Big' && err?.error_type === 'body-truncated', JSON.stringify({ pg, err }));
    check('the oversized gzip sitemap is reported, not inflated', JSON.stringify(res.sitemaps?.oversized ?? []).includes('sitemap.xml.gz'), JSON.stringify(res.sitemaps));
    check(`memory stays bounded while crawling them (RSS grew ${Math.round(grew)} MB)`, grew < 800, `${grew}`);
  } finally { srv.close(); }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
