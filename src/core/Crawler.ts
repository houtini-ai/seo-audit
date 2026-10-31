import { readCapped, MAX_HTML_BYTES } from './cappedBody.js';
import { randomUUID } from 'node:crypto';
import { Agent, fetch as ufetch } from 'undici';
import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty, type UrlKeyOptions } from './url-key.js';
import { extractPage, isInternalHost, decodeHtmlBody } from './extract.js';
import { fetchRobotsTxt, rulesFromText, robotsUnreachable } from './robots.js';
import { storeRobotsTxt } from './robotsStore.js';
import { finalizeLinkGraph } from './linkGraph.js';
import { crawlRate, type CrawlStage } from './crawlProgress.js';
import { fetchSitemapUrls } from './sitemap.js';
import { snapshotCrawl } from '../audit/drift.js';
import { checkExternalLinks, type ExternalSummary } from './externalLinks.js';
import { runSiteProbes, type SiteProbeSummary } from './siteProbes.js';
import { CLEAR_CRAWL_FTS } from './fts.js';
import { BOT_UA, CHROME_HEADERS, looksBotBlocked, type FetchedAs } from './userAgents.js';
import {
  AimdLimiter, isRateLimited, looksLikeShopify, rateLimitWaitMs, retrySpacingMs,
  RATE_LIMIT_RETRIES, SHOPIFY_START_CONCURRENCY, PLATFORM_SNIFF_RESPONSES, RETRY_AFTER_CAP_MS, type RateLimitReport,
} from './rateLimit.js';

// Robust HTML detection from a Content-Type header: take the MIME type before any
// parameters (charset, boundary), normalised — text/html and XHTML count as HTML.
const HTML_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml']);
export const isHtmlContentType = (ct: string | null | undefined): boolean =>
  HTML_MIME_TYPES.has((ct ?? '').split(';')[0].trim().toLowerCase());

// File types we never need the body of — images, media, fonts, archives, office docs, css/js,
// pdf. We HEAD these (status + content-type only, no download) — a big bandwidth/time win on
// asset-heavy sites. We still record them (status/type) so broken-link checks work.
const ASSET_EXT = /\.(jpe?g|png|gif|webp|avif|svg|svgz|ico|bmp|tiff?|heic|psd|pdf|zip|rar|7z|gz|tgz|tar|bz2|mp4|mpeg|mpg|m4v|webm|mov|avi|mkv|flv|wmv|mp3|m4a|aac|opus|weba|wav|ogg|oga|flac|wma|css|js|mjs|cjs|map|woff2?|ttf|otf|eot|dmg|exe|msi|apk|bin|doc|docx|xls|xlsx|ppt|pptx)$/i;
const isAssetUrl = (u: string): boolean => { try { return ASSET_EXT.test(new URL(u).pathname); } catch { return false; } };

// URL patterns never worth crawling — internal site-search, infinite param spaces, cart/builder
// states and CMS infrastructure. Skipped at enqueue (never fetched) so large sites stay light
// and the crawl doesn't drown in low-value URLs. Extend per-crawl via opts.excludePatterns.
const SKIP_PATTERNS: RegExp[] = [
  /[?&](sps_query|s|q|search|keyword|orderby|sort_by|add-to-cart|fl_builder|elementor-preview)=/i,
  /[?&](pf_|filter[._]|dppref|variant=)/i, // Shopify/WooCommerce faceted filters + variant duplicates
  /[?&](client_id|redirect_uri|response_type)=|\/authentication\/|\/oauth\/|\/login_with_shop\//i, // auth/login flows (no SEO value)
  /\/search(-results)?\//i,
  /[?&]replytocom=/i,
  /\/(wp-json|wp-admin|wp-login\.php|xmlrpc\.php)(\/|$|\?)/i,
  /\/(cart|checkout|my-account|basket)(\/|$)/i,
];
const skipUrl = (u: string, extra: RegExp[]): boolean =>
  SKIP_PATTERNS.some(re => re.test(u)) || extra.some(re => re.test(u));

// Classify a fetched URL's indexability + the REASON it's not indexable, so an audit can
// report *why* Google would skip a page (status, directives, canonical, type) — not just yes/no.
function classifyIndexability(
  isHtml: boolean, status: number, noindexMeta: boolean, xRobotsTag: string | null, canonicalKey: string | null, finalKey: string,
): { indexable: 0 | 1; reason: string | null } {
  if (status >= 400) return { indexable: 0, reason: `http-${status}` };       // 404, 410, 500, 503, …
  if (status >= 300) return { indexable: 0, reason: 'redirect' };             // redirect chain exceeded maxHops
  if (!isHtml) return { indexable: 0, reason: 'non-html' };
  if (/noindex/i.test(xRobotsTag ?? '')) return { indexable: 0, reason: 'noindex-header' }; // X-Robots-Tag
  if (noindexMeta) return { indexable: 0, reason: 'noindex-meta' };
  if (canonicalKey && canonicalKey !== finalKey) return { indexable: 0, reason: 'canonicalised' };
  return { indexable: 1, reason: null };
}

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  maxConcurrency?: number;
  delayMs?: number;
  userAgent?: string;
  excludePatterns?: string[]; // extra URL regexes to never crawl (on top of the junk defaults)
  headResources?: boolean;    // header-only pass over css/js/font subresources → resource_assets (#37)
  checkExternal?: boolean;    // check outbound link targets after the crawl (default true) (#36)
  externalCacheDays?: number; // reuse external results younger than this (default 7)
  chromeFallback?: boolean;   // retry bot-blocked requests once as Chrome (default true; off when userAgent is set)
  siteProbes?: boolean;       // soft-404 + host-variant probes after the crawl, at most 5 requests (default true) (#55 group D)
}

export interface CrawlResult {
  crawlId: string;
  siteUrl: string;
  crawled: number;
  failed: number;
  skipped: number;
  /** Sitemaps found: declared in robots.txt, plus conventional locations robots.txt didn't declare (#25). */
  sitemaps?: { declared: string[]; undeclared: string[]; fetched: number; urls: number; /** Sitemaps over 50 MB uncompressed: not parsed. */ oversized?: string[] };
  /** Outbound link status pass (#36). */
  external?: ExternalSummary;
  /** Soft-404 and host-variant probes (#55 group D): what was probed and each verdict. */
  siteProbes?: SiteProbeSummary;
  /** Bot blocking seen on the site's own pages: requests blocked for the crawler UA, how many got
   *  through as Chrome, and whether the crawl switched to Chrome for the rest. */
  blocking?: { blockedAsBot: number; okAsChrome: number; blockedForBoth: number; switchedToChrome: boolean };
  /** Host rate limiting (#54): AIMD concurrency, URLs re-queued, URLs never fetched. Always present. */
  rateLimited: RateLimitReport;
  /** Hosting platform recognised from response headers (#54); it sets the starting concurrency. */
  platform?: CrawlPlatform;
}

/** A platform recognised from the crawl's first responses, and what the crawl did about it. */
export interface CrawlPlatform { name: 'shopify'; startConcurrency: number; userSetConcurrency: boolean }

const DEFAULT_UA = BOT_UA;
const FETCH_TIMEOUT_MS = 20000;
const MAX_TRANSIENT_RETRIES = 6; // plain-503 backoff attempts before recording the status (429s are re-queued instead, #54)
const MAX_NET_RETRIES = 4;       // network-error (timeout/reset) retries — separate budget so a slow URL can't stall a worker for minutes
const BACKOFF_CAP_MS = 15000;     // cap for the exponential fallback when no Retry-After is given
const FLUSH_EVERY = 50;
/** Chrome's Accept for <img> requests: the image-weight probe measures what a browser is served. */
export const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

// Shared throttle gate: a 429/503 on ONE request backs off the WHOLE worker pool, not just that
// request's own retries — otherwise the other N-1 workers keep hammering a rate-limited host and it
// never recovers (how 56 Shopify product pages ended up recorded as 429 despite per-request retries).
// Since #54 the gate carries the Retry-After pause for a 429 ONCE (set by the pool, not slept in the
// request as well), and the AIMD limiter lowers how many requests the pool runs at all.
interface ThrottleGate { until: number }
const gateWaitMs = (g: ThrottleGate): number => Math.max(0, g.until - Date.now());
const gatePenalise = (g: ThrottleGate, ms: number): void => { g.until = Math.max(g.until, Date.now() + ms); };

interface RedirectHop { from: string; to: string; status: number; }

interface FetchOutcome {
  finalUrl: string;
  status: number;
  contentType: string;
  contentEncoding: string | null;
  cacheControl: string | null;
  lastModified: string | null;
  etag: string | null;
  vary: string | null;
  securityHeaders: string | null; // JSON {csp,hsts,xFrame,xContentType,referrerPolicy,permissionsPolicy,server}
  body: string;
  redirects: RedirectHop[];
  xRobotsTag: string | null;
  bytes: number | null;
  /** The HTML body was longer than MAX_HTML_BYTES and was read only up to it. */
  truncated?: boolean;
  timeMs: number;
  throttled: boolean; // saw a plain 503 or a network error (after retries) — signal for adaptive pacing
  fetchedAs: FetchedAs; // which user agent produced this response
  /** Set when the host rate limited this request (429, or 503 + Retry-After): NOT a page status (#54). */
  rateLimited: { retryAfter: string | null } | null;
  /** When the request that produced this outcome went out (ms): AIMD reacts once per generation. */
  sentAt: number;
  /** Any response on the way carried Shopify storefront headers. */
  shopify: boolean;
  /** Set when a redirect hop was NOT followed: it left the property (another host, a skip pattern,
   *  a non-http scheme) or robots.txt disallows it. `finalUrl` is then the unfetched target. */
  stoppedAt?: RedirectStop;
}

/** Why a redirect hop was not followed. */
export type RedirectStop = 'offsite' | 'robots';

/** Per-crawl bot-block bookkeeping: whether the Chrome fallback is allowed, and how it's going. */
export interface UaState { fallback: boolean; preferChrome: boolean; botTried: number; blockedAsBot: number; okAsChrome: number; blockedAsChrome: number }

// Per-crawl connection pool: HTTP/2 when the origin supports it (one multiplexed connection
// instead of N TCP handshakes), keep-alive reuse, bounded per-origin connections. Compression
// is negotiated explicitly (gzip/br/deflate — undici decompresses transparently; the recorded
// content_encoding header still reflects what the server actually served).
const makeDispatcher = (connections: number): Agent =>
  new Agent({ allowH2: true, connections, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 });

// `stopAt` is asked about every redirect target BEFORE it is requested. The crawler passes one that
// stops at a target off the property or disallowed by robots.txt: following first and checking the
// final URL afterwards sent a request to whatever host a Location header named (an SSRF through any
// open redirect) and fetched robots-disallowed paths.
async function fetchWithRedirects(url: string, ua: string, dispatcher: Agent, gate: ThrottleGate, signal: AbortSignal, maxHops = 5, uaState?: UaState, stopAt?: (target: URL) => RedirectStop | null): Promise<FetchOutcome> {
  // Starts as the crawler's own UA unless this crawl already switched to Chrome (see below).
  let asChrome = !!uaState?.preferChrome;
  let retriedAsChrome = false;
  const redirects: RedirectHop[] = [];
  let current = url;
  let hops = 0;
  let transientRetries = 0; // plain-503 backoff budget
  let shopify = false;
  let sentAt = Date.now();
  let netRetries = 0;       // network-error (timeout/reset) budget — separate so a 503 then a timeout doesn't starve it
  const start = Date.now();
  // Always GET — never HEAD. Some servers/CDNs return a different status for HEAD than for GET
  // (e.g. a 404 on HEAD where GET is 200, or vice-versa), which would mis-record a URL's real
  // status. We still avoid downloading asset bytes by cancelling the body stream for any non-HTML
  // response below, so a GET stays as light as a HEAD for images/PDFs/etc.
  const method = 'GET';
  while (true) {
    // Respect a pool-wide cooldown another worker set after a 429/503 before firing this request.
    // Add per-worker jitter so the whole pool doesn't wake in lockstep and stampede the host again.
    const cool = gateWaitMs(gate);
    if (cool) await sleep(Math.min(cool, RETRY_AFTER_CAP_MS) + Math.floor(Math.random() * 500));
    let res: Response;
    try {
      sentAt = Date.now();
      res = (await ufetch(current, {
        method,
        redirect: 'manual',
        dispatcher,
        // pages change between crawls — ask upstream caches/CDNs for the current copy
        headers: {
          ...(asChrome ? CHROME_HEADERS : { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
          'accept-encoding': 'gzip, deflate, br',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
        // Abort on either the per-request timeout OR the crawl being cancelled, so a cancel
        // stops in-flight fetches instead of letting them run to completion/timeout.
        signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), signal]),
      })) as unknown as Response;
    } catch (err) {
      // A cancelled crawl is not a transient network hiccup — don't burn the retry budget on it.
      if (signal.aborted) throw err;
      // The server slowed past the timeout or dropped the connection. Don't lose the page to a
      // transient hiccup — wait (10s, 20s, 30s) and retry before giving up, so a slowdown becomes
      // latency rather than a silent coverage gap. Uses its OWN budget (not the 429/503 one) so a
      // page that 503s then times out still gets full network retries; trips `throttled` so the
      // crawl paces itself down. Surfaces as a failure only after the budget is exhausted.
      if (netRetries < MAX_NET_RETRIES) {
        netRetries++;
        await sleep(Math.min(10000 * netRetries, 30000));
        continue;
      }
      throw err;
    }
    // Bot block (403 / 999 / WAF challenge, which can arrive as a 429 or 503 too) under our own UA:
    // retry this URL once as Chrome, BEFORE the throttling backoff below so a WAF challenge doesn't
    // burn the retry budget and penalise the whole pool. Counts feed the crawl result.
    if (uaState?.fallback && !asChrome && looksBotBlocked(res.status, n => res.headers.get(n))) {
      try { await res.body?.cancel(); } catch { /* no body */ }
      uaState.botTried++;
      uaState.blockedAsBot++;
      asChrome = true;
      retriedAsChrome = true;
      continue;
    }
    const header = (name: string): string | null => res.headers.get(name);
    if (!shopify && looksLikeShopify(header)) shopify = true;
    // Rate limiting (429, or 503 with Retry-After) is NOT a page status and is not retried here
    // (#54): the outcome goes back to the pool, which halves its concurrency, sets the pool-wide
    // Retry-After pause once and re-queues the URL at the end of the frontier. Retrying in place
    // held a worker for 46-91 s per URL and still ended by storing the 429 as the page's status.
    if (isRateLimited(res.status, header)) {
      try { await res.body?.cancel(); } catch { /* no body */ }
      return {
        finalUrl: current, status: res.status, contentType: '', contentEncoding: null, cacheControl: null, lastModified: null,
        etag: null, vary: null, securityHeaders: null, body: '', redirects, xRobotsTag: null, bytes: null,
        timeMs: Date.now() - start, throttled: false, fetchedAs: asChrome ? 'chrome' : 'bot',
        rateLimited: { retryAfter: header('retry-after') }, sentAt, shopify,
      };
    }
    // A plain 503 (no Retry-After) is a server that is down or overloaded: back off and retry, and
    // record the status only if it persists (a real outage is a real 503).
    if (res.status === 503 && transientRetries < MAX_TRANSIENT_RETRIES) {
      const waitMs = Math.min(1000 * 2 ** transientRetries, BACKOFF_CAP_MS);
      try { await res.body?.cancel(); } catch { /* no body */ }
      transientRetries++;
      gatePenalise(gate, waitMs); // back the whole pool off, not just this request
      await sleep(waitMs);
      continue;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops < maxHops) {
      const loc = new URL(res.headers.get('location')!, current).toString();
      // Drain the redirect response's body (some servers attach HTML to 301s) so the
      // keep-alive connection is released — otherwise redirect-heavy crawls leak sockets.
      try { await res.body?.cancel(); } catch { /* already closed */ }
      redirects.push({ from: current, to: loc, status: res.status });
      const stop = stopAt ? stopAt(new URL(loc)) : null;
      if (stop) {
        return {
          finalUrl: loc, status: res.status, contentType: '', contentEncoding: null, cacheControl: null, lastModified: null,
          etag: null, vary: null, securityHeaders: null, body: '', redirects, xRobotsTag: null, bytes: null,
          timeMs: Date.now() - start, throttled: transientRetries > 0 || netRetries > 0, fetchedAs: asChrome ? 'chrome' : 'bot',
          rateLimited: null, sentAt, shopify, stoppedAt: stop,
        };
      }
      current = loc;
      hops++;
      continue;
    }
    // Fallback bookkeeping. Switch the whole crawl to Chrome only when the evidence says the SITE
    // walls crawlers: at least 3 pages got through only as Chrome AND they are the majority of pages
    // tried under the crawler UA so far. A site that walls one section (/docs/*) under concurrency
    // keeps paying the one retry per walled page, and fetched_as stays an honest per-page record.
    if (uaState && retriedAsChrome) {
      if (res.status < 400) {
        uaState.okAsChrome++;
        if (uaState.okAsChrome >= 3 && uaState.okAsChrome * 2 >= uaState.botTried) uaState.preferChrome = true;
      } else uaState.blockedAsChrome++; // a real 403 (e.g. /admin/): identity made no difference
    } else if (uaState && !asChrome) uaState.botTried++;
    const contentType = res.headers.get('content-type') ?? '';
    const isHtml = isHtmlContentType(contentType);
    // Read the body only for HTML; for any non-HTML response (image/PDF/asset) abort the transfer
    // so we never pull the bytes — keeping the always-GET fetch as cheap as a HEAD would have been.
    let body = '';
    // Decode ONCE, honouring the response charset (Content-Type → <meta charset> → UTF-8). Using
    // res.text() would force UTF-8 regardless of the declared charset — fine for a UTF-8 site, but
    // it mojibakes a page served as Latin-1/Windows-1252. decodeHtmlBody reads the declared charset.
    // Bounded (cappedBody.ts): a page over MAX_HTML_BYTES is read up to it and flagged, never buffered whole.
    let truncated = false;
    if (isHtml) { const got = await readCapped(res as unknown as { body: ReadableStream<Uint8Array> | null }, MAX_HTML_BYTES); truncated = got.truncated; body = decodeHtmlBody(got.buf, contentType); }
    else { try { await res.body?.cancel(); } catch { /* already closed */ } }
    const h = (name: string): string | null => res.headers.get(name);
    const sec: Record<string, string> = {};
    for (const [k, name] of [
      ['csp', 'content-security-policy'], ['hsts', 'strict-transport-security'],
      ['xFrame', 'x-frame-options'], ['xContentType', 'x-content-type-options'],
      ['referrerPolicy', 'referrer-policy'], ['permissionsPolicy', 'permissions-policy'],
      ['server', 'server'],
    ] as const) {
      const v = h(name);
      if (v) sec[k] = v;
    }
    return {
      finalUrl: current,
      status: res.status,
      contentType,
      contentEncoding: h('content-encoding'),
      cacheControl: h('cache-control'),
      lastModified: h('last-modified'),
      etag: h('etag'),
      vary: h('vary'),
      securityHeaders: Object.keys(sec).length ? JSON.stringify(sec) : null,
      body,
      redirects,
      xRobotsTag: h('x-robots-tag'),
      // For HTML (body read) always the DECODED size — content-length on a compressed
      // response is the wire size, and downstream transfer estimates (×0.22) assume raw.
      // Non-HTML: content-length when given, else null (body isn't read; 0 would mislead).
      bytes: body ? Buffer.byteLength(body) : (Number(h('content-length')) || null),
      timeMs: Date.now() - start,
      throttled: transientRetries > 0 || netRetries > 0,
      fetchedAs: asChrome ? 'chrome' : 'bot',
      rateLimited: null,
      sentAt,
      shopify,
      ...(truncated ? { truncated } : {}),
    };
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
/** sleep() that returns early when the crawl is cancelled (a re-queued URL can wait several seconds). */
const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, ms);
  const done = (): void => { clearTimeout(t); resolve(); };
  signal.addEventListener('abort', done, { once: true });
});

/** Self-contained, stdio-safe HTTP crawler writing into a property's AuditDatabase. */
export class Crawler {
  constructor(private readonly dataDir: string) {}

  async run(
    siteUrl: string,
    opts: CrawlOptions,
    update: (p: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<CrawlResult> {
    const maxPages = opts.maxPages ?? 4000;
    const maxDepth = opts.maxDepth ?? 10;
    // Default 8 parallel fetches (was 4) — with HTTP/2 multiplexing this is one or two
    // connections, not 8 sockets. That is the CEILING: the AIMD limiter (#54) halves the effective
    // concurrency on each 429 and adds one back after every 20 clean responses.
    const concurrency = Math.max(1, Math.min(opts.maxConcurrency ?? 8, 24));
    const userSetConcurrency = opts.maxConcurrency != null;
    const limiter = new AimdLimiter(concurrency);
    let platform: CrawlPlatform | undefined;
    let sniffed = 0;           // responses checked for platform headers so far
    let retriedUrls = 0;       // distinct URLs re-queued after a rate limit
    const unfetched: { url: string; depth: number }[] = []; // still rate limited after every retry
    const delayMs = opts.delayMs ?? 250;
    const ua = opts.userAgent ?? DEFAULT_UA;
    // Chrome fallback on bot blocks, unless the user chose a user agent explicitly.
    const uaState: UaState = { fallback: !opts.userAgent && opts.chromeFallback !== false, preferChrome: false, botTried: 0, blockedAsBot: 0, okAsChrome: 0, blockedAsChrome: 0 };
    const excludeRes = (opts.excludePatterns ?? []).flatMap(p => { try { return [new RegExp(p, 'i')]; } catch { return []; } });

    const seed = siteUrl.startsWith('sc-domain:') ? `https://${siteUrl.slice('sc-domain:'.length)}/` : siteUrl;
    const baseHost = new URL(seed).hostname;
    const keyOpts: UrlKeyOptions = { hostForm: hostFormForProperty(siteUrl) };
    const origin = new URL(seed).origin;

    const dispatcher = makeDispatcher(Math.min((opts.maxConcurrency ?? 8) * 2, 32));
    const db = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
    db.upsertProperty(siteUrl, keyOpts.hostForm ?? 'asis');
    const crawlId = randomUUID().slice(0, 8);
    const startedAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, max_depth, max_pages, user_agent, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(crawlId, seed, baseHost, maxDepth, maxPages, ua, startedAt);

    try {
    // A crawl is a fresh snapshot of the current site — prior crawl data is cleared so
    // re-crawls reflect changes (the "fix → re-crawl → verify" loop) instead of
    // accumulating stale pages / duplicate links. GSC/inspection/findings are separate.
    // The pages/links wipe is DEFERRED until the first successful page write: if the crawl
    // dies before fetching anything (site down, seed unreachable), the previous good
    // snapshot survives instead of leaving every downstream consumer an empty table.
    // (It must still run before the first insert — old rows would otherwise absorb the
    // new crawl's writes via ON CONFLICT(url_key) DO NOTHING.)
    db.db.exec('DELETE FROM errors;'); // per-crawl diagnostics, not part of the snapshot
    let wipedPrior = false;
    const ensureWiped = (): void => {
      if (wipedPrior) return;
      // One transaction, so the FTS indexes are cleared exactly when the rows they index are (#35).
      db.db.transaction(() => db.db.exec(`DELETE FROM links; DELETE FROM pages; DELETE FROM redirect_sources; DELETE FROM page_resources; ${CLEAR_CRAWL_FTS}`))();
      wipedPrior = true;
    };

    // robots.txt: the crawl's own politeness gate, and the stored bytes the audit reads for
    // Googlebot / AI-bot verdicts (#55). RFC 9309: a 4xx means no robots.txt (crawl everything); an
    // UNREACHABLE file (5xx, 429, no response) means crawl nothing, as Google does: the crawl stops
    // (failed, with the reason) before it writes anything.
    const robotsTxt = await fetchRobotsTxt(origin, ua);
    try { storeRobotsTxt(db.db, origin, robotsTxt); } catch (err) { console.error('[crawl] robots.txt not stored:', err instanceof Error ? err.message : String(err)); }
    const robotsDown = robotsUnreachable(robotsTxt.status);
    const robots = rulesFromText(robotsTxt.body ?? '', 'seo-audit-console');
    const robotsNote = `robots.txt was unreachable (${robotsTxt.status ? `HTTP ${robotsTxt.status}` : 'no response'}): RFC 9309 treats that as "disallow everything", as Google does, so nothing was crawled. Fix robots.txt (it should answer 200, or 404 for none) and crawl again.`;

    const pageInsert = db.db.prepare(
      `INSERT INTO pages (crawl_id, url, url_key, status_code, content_type, content_encoding, cache_control,
         last_modified, etag, vary, bytes, response_time_ms, depth,
         is_internal, indexable, indexable_reason, noindex, title, title_length, meta_description, meta_description_length,
         h1, h1_count, word_count, lang, charset, canonical_url, canonical_key, robots, x_robots_tag, viewport,
         json_ld, og_tags, hreflang, redirects, internal_links, external_links,
         image_count, images_without_alt, images_empty_alt, images_empty_alt_content, fetched_as, images_missing_dimensions, canonical_count, canonical_relative,
         h2_count, heading_skips, rel_next, rel_prev, rel_amphtml, mixed_content_count, twitter_tags,
         has_microdata, has_rdfa, has_favicon, has_analytics, body_chunks, security_headers,
         a11y_links_no_name, a11y_buttons_no_name, a11y_inputs_no_label, a11y_viewport_zoom_disabled, a11y_positive_tabindex, a11y_duplicate_ids, a11y_samples)
       VALUES (@crawl_id,@url,@url_key,@status_code,@content_type,@content_encoding,@cache_control,
         @last_modified,@etag,@vary,@bytes,@response_time_ms,@depth,
         @is_internal,@indexable,@indexable_reason,@noindex,@title,@title_length,@meta_description,@meta_description_length,
         @h1,@h1_count,@word_count,@lang,@charset,@canonical_url,@canonical_key,@robots,@x_robots_tag,@viewport,
         @json_ld,@og_tags,@hreflang,@redirects,@internal_links,@external_links,
         @image_count,@images_without_alt,@images_empty_alt,@images_empty_alt_content,@fetched_as,@images_missing_dimensions,@canonical_count,@canonical_relative,
         @h2_count,@heading_skips,@rel_next,@rel_prev,@rel_amphtml,@mixed_content_count,@twitter_tags,
         @has_microdata,@has_rdfa,@has_favicon,@has_analytics,@body_chunks,@security_headers,
         @a11y_links_no_name,@a11y_buttons_no_name,@a11y_inputs_no_label,@a11y_viewport_zoom_disabled,@a11y_positive_tabindex,@a11y_duplicate_ids,@a11y_samples)
       ON CONFLICT(url_key) DO NOTHING`,
    );
    // Robots-disallowed URLs are NOT fetched (we respect robots), but we record them as
    // known + not-indexable with the reason, so the audit can report what robots is blocking.
    const robotsInsert = db.db.prepare(
      `INSERT INTO pages (crawl_id, url, url_key, status_code, is_internal, indexable, indexable_reason, depth)
       VALUES (@crawl_id,@url,@url_key,NULL,1,0,'robots-disallowed',@depth)
       ON CONFLICT(url_key) DO NOTHING`,
    );
    const linkInsert = db.db.prepare(
      `INSERT INTO links (crawl_id, source_url, source_key, target_url, target_key, anchor_text, is_internal, placement, rel, href_form)
       VALUES (@crawl_id,@source_url,@source_key,@target_url,@target_key,@anchor_text,@is_internal,@placement,@rel,@href_form)`,
    );
    const errorInsert = db.db.prepare(
      `INSERT INTO errors (crawl_id, url, error_type, error_message) VALUES (?, ?, ?, ?)`,
    );
    // Stop before anything is written: the previous crawl's pages stay as they were (the wipe is
    // deferred to the first write, and there is none). The crawl is marked failed with the reason.
    if (robotsDown) { errorInsert.run(crawlId, `${origin}/robots.txt`, 'robots-unreachable', robotsNote); throw new Error(robotsNote); }
    const redirectInsert = db.db.prepare(
      `INSERT INTO redirect_sources (url_key, url, status, final_url, final_key, hops, chain, crawl_id) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(url_key) DO UPDATE SET url=excluded.url, status=excluded.status, final_url=excluded.final_url,
         final_key=excluded.final_key, hops=excluded.hops, chain=excluded.chain, crawl_id=excluded.crawl_id`,
    );
    const resourceInsert = db.db.prepare(
      `INSERT INTO page_resources (crawl_id, page_key, resource_url, type, party, position, is_async, is_defer, is_preload, is_module, crossorigin, media)
       VALUES (@crawl_id,@page_key,@resource_url,@type,@party,@position,@is_async,@is_defer,@is_preload,@is_module,@crossorigin,@media)`,
    );
    const flushResources = db.db.transaction((rows: Record<string, unknown>[]) => { for (const r of rows) resourceInsert.run(r); });
    const resourceBuf: Record<string, unknown>[] = [];
    const resourceRefs = new Map<string, { type: string; usedOn: number }>(); // for the optional HEAD pass
    const flushPages = db.db.transaction((rows: Record<string, unknown>[]) => { for (const r of rows) pageInsert.run(r); });
    const flushLinks = db.db.transaction((rows: Record<string, unknown>[]) => { for (const r of rows) linkInsert.run(r); });

    const pageBuf: Record<string, unknown>[] = [];
    const linkBuf: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    const emitted = new Set<string>(); // final url_keys already extracted+written
    const imageRefs = new Map<string, number>(); // distinct <img> src → pages using it
    // attempt/notBefore: set on a URL re-queued after a rate limit (#54).
    type FrontierItem = { url: string; depth: number; attempt?: number; notBefore?: number };
    const frontier: FrontierItem[] = [];
    let crawled = 0, failed = 0, skipped = 0, discovered = 0;

    const enqueue = (url: string, depth: number): void => {
      const key = urlKey(url, keyOpts);
      if (visited.has(key)) return;
      visited.add(key);
      discovered++;
      frontier.push({ url, depth });
    };
    enqueue(seed, 0);

    // Seed the frontier from the XML sitemap so unlinked/orphan pages get crawled — link-following
    // alone misses them (e.g. one site: 367 sitemap URLs, only ~100 reachable via links).
    // Also stores the sitemap for crawl↔sitemap reconciliation. Off-host/junk/asset URLs filtered;
    // bounded by maxPages.
    let sitemaps: CrawlResult['sitemaps'];
    if (!signal.aborted) {
      try {
        const sm = await fetchSitemapUrls(origin, ua, keyOpts);
        sitemaps = { declared: sm.sources, undeclared: sm.undeclared, fetched: sm.sitemapsFetched, urls: sm.urls.length, ...(sm.oversized.length ? { oversized: sm.oversized } : {}) };
        const smInsert = db.db.prepare(`INSERT INTO sitemap_urls (url_key, url, lastmod, fetched_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(url_key) DO NOTHING`);
        db.db.transaction(() => { db.db.exec('DELETE FROM sitemap_urls'); for (const u of sm.urls) smInsert.run(u.urlKey, u.url, u.lastmod); })();
        for (const u of sm.urls) {
          if (discovered >= maxPages) break;
          let host: string; try { host = new URL(u.url).hostname; } catch { continue; }
          if (!isInternalHost(host, baseHost) || skipUrl(u.url, excludeRes) || isAssetUrl(u.url)) continue;
          enqueue(u.url, 1); // sitemap URLs are top-level entry points
        }
      } catch (err) { console.error('[crawl] sitemap seed skipped:', err instanceof Error ? err.message : String(err)); }
    }

    // Also seed from GSC-known URLs (pages Google sends traffic to) so coverage doesn't depend on
    // the site's sitemap being complete — e.g. one property has 334 sitemap URLs but GSC knows 1,299.
    // page_key is already a normalised URL; off-host/junk/asset filtered; bounded by maxPages.
    try {
      // Seed with the RAW GSC page URL, not the normalised page_key — the key strips
      // trailing slashes / sorts params, so fetching it can add a phantom 301 hop (or 404)
      // on sites where the canonical form matters. Fall back to page_key for old rows.
      for (const row of db.db.prepare(`SELECT DISTINCT COALESCE(page, page_key) AS u FROM search_analytics WHERE COALESCE(page, page_key) IS NOT NULL`).all() as { u: string }[]) {
        if (discovered >= maxPages) break;
        let host: string; try { host = new URL(row.u).hostname; } catch { continue; }
        if (!isInternalHost(host, baseHost) || skipUrl(row.u, excludeRes) || isAssetUrl(row.u)) continue;
        enqueue(row.u, 1);
      }
    } catch (err) { console.error('[crawl] GSC seed skipped:', err instanceof Error ? err.message : String(err)); }

    // Seed backlinked URLs (top 200 by backlinks) so every crawl re-verifies what external links
    // actually land on — a URL fixed with a 301 since the backlink pull stops reading as dead (#32).
    try {
      for (const row of db.db.prepare(`SELECT url FROM page_backlinks WHERE backlinks > 0 ORDER BY backlinks DESC LIMIT 200`).all() as { url: string }[]) {
        if (discovered >= maxPages) break;
        let host: string; try { host = new URL(row.url).hostname; } catch { continue; }
        if (!isInternalHost(host, baseHost) || skipUrl(row.url, excludeRes) || isAssetUrl(row.url)) continue;
        enqueue(row.url, 1);
      }
    } catch { /* no page_backlinks table yet */ }

    const flush = (final = false): void => {
      if (pageBuf.length || linkBuf.length) ensureWiped();
      if (pageBuf.length && (final || pageBuf.length >= FLUSH_EVERY)) { flushPages(pageBuf.splice(0)); }
      if (linkBuf.length && (final || linkBuf.length >= FLUSH_EVERY)) { flushLinks(linkBuf.splice(0)); }
      if (resourceBuf.length && (final || resourceBuf.length >= FLUSH_EVERY)) { ensureWiped(); flushResources(resourceBuf.splice(0)); }
    };
    // Progress the client can read (#52): counts, pages/sec and an ETA for the fetch stage, then a
    // stage name for each post-crawl phase so a long run never looks stalled.
    const t0 = Date.now();
    let linksSeen = 0;
    const rateLimitReport = (): RateLimitReport => ({
      events: limiter.events, currentConcurrency: limiter.limit, minConcurrency: limiter.min, maxConcurrency: limiter.max,
      retried: retriedUrls, unfetched: unfetched.length,
    });
    // pages/sec is a FETCH rate: frozen when fetching ends, so the slower post-crawl stages (outbound
    // link checks can take minutes) don't drag the reported crawl speed down to a misleading average.
    let fetchPagesPerSec: number | null = null;
    const stage = (name: CrawlStage, extra: Record<string, unknown> = {}): void => {
      const rate = crawlRate(crawled, failed, frontier.length, maxPages, Date.now() - t0);
      if (name === 'fetching') fetchPagesPerSec = rate.pagesPerSec;
      update({ crawlId, stage: name, crawled, discovered, failed, skipped, maxPages, linksSeen, elapsedSeconds: rate.elapsedSeconds,
        pagesPerSec: name === 'fetching' ? rate.pagesPerSec : fetchPagesPerSec, pagesRemaining: name === 'fetching' ? rate.pagesRemaining : 0, etaSeconds: name === 'fetching' ? rate.etaSeconds : null,
        rateLimited: rateLimitReport(), ...(platform ? { platform } : {}), ...extra });
    };
    const saveProgress = (): void => {
      db.db.prepare(`UPDATE crawl_metadata SET urls_discovered=?, urls_crawled=?, urls_failed=?, urls_skipped=? WHERE crawl_id=?`)
        .run(discovered, crawled, failed, skipped, crawlId);
      stage('fetching');
    };

    // Adaptive pacing: start at the configured delay; ramp UP when the host throttles (429/503)
    // and decay back toward base when it's clear. Same pages crawled (no data lost) — just paced
    // so hard-throttled sites stop triggering retries (net faster + cleaner) and fast sites stay fast.
    let dynamicDelay = delayMs;
    // One throttle gate shared by every worker: a 429/503 anywhere pauses the whole pool.
    const gate: ThrottleGate = { until: 0 };
    // Asked before every redirect hop is requested (see fetchWithRedirects).
    const redirectStop = (target: URL): RedirectStop | null => {
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'offsite';
      if (!isInternalHost(target.hostname, baseHost) || skipUrl(target.toString(), excludeRes)) return 'offsite';
      return robots.isAllowed(target.pathname + target.search) ? null : 'robots';
    };
    const processOne = async (item: FrontierItem): Promise<void> => {
      // A re-queued rate-limited URL waits out its spacing (usually long past by the time it is reached).
      if (item.notBefore && item.notBefore > Date.now()) await sleepUnlessAborted(item.notBefore - Date.now(), signal);
      if (signal.aborted) return;
      if (dynamicDelay) await sleep(dynamicDelay);
      const path = (() => { try { const u = new URL(item.url); return u.pathname + u.search; } catch { return '/'; } })();
      if (!robots.isAllowed(path)) {
        ensureWiped();
        try { robotsInsert.run({ crawl_id: crawlId, url: item.url, url_key: urlKey(item.url, keyOpts), depth: item.depth }); } catch { /* dup */ }
        skipped++; return;
      }
      try {
        const r = await fetchWithRedirects(item.url, ua, dispatcher, gate, signal, 5, uaState, redirectStop);
        // Platform sniff on the first responses (#54): Shopify rate-limits hard at concurrency 8, so
        // start it at 3 unless the user chose maxConcurrency. AIMD can still climb back from there.
        if (sniffed < PLATFORM_SNIFF_RESPONSES && !platform) {
          sniffed++;
          if (r.shopify) {
            const start = userSetConcurrency ? limiter.limit : Math.min(concurrency, SHOPIFY_START_CONCURRENCY);
            if (!userSetConcurrency) limiter.capAt(start);
            platform = { name: 'shopify', startConcurrency: start, userSetConcurrency };
          }
        }
        // Rate limited (#54): never a page status. Halve the pool, pause it once for Retry-After,
        // and put the URL at the END of the frontier for up to RATE_LIMIT_RETRIES more attempts,
        // spaced out. Still limited after that = stored as not fetched (status NULL), never as 429.
        if (r.rateLimited) {
          const lowered = limiter.onRateLimited(r.sentAt);
          const waitMs = rateLimitWaitMs(r.rateLimited.retryAfter, limiter.consecutive);
          gatePenalise(gate, waitMs);
          const attempt = item.attempt ?? 0;
          if (attempt < RATE_LIMIT_RETRIES) {
            if (attempt === 0) retriedUrls++;
            frontier.push({ url: item.url, depth: item.depth, attempt: attempt + 1, notBefore: Date.now() + retrySpacingMs(attempt + 1, waitMs) + Math.floor(Math.random() * 1000) }); // jitter: re-queued URLs don't all wake together
          } else {
            unfetched.push({ url: item.url, depth: item.depth });
          }
          if (lowered) stage('fetching');
          return;
        }
        limiter.onSuccess();
        // Self-tune the delay from the throttle signal (plain 503s and network errors; 429s are AIMD's).
        if (r.throttled) dynamicDelay = Math.min(Math.round(dynamicDelay * 1.5) + 200, 5000);
        else if (dynamicDelay > delayMs) dynamicDelay = Math.max(delayMs, Math.round(dynamicDelay * 0.9));
        // Redirect that leaves the internal host or lands on a skip-pattern URL (e.g. an internal
        // link 301-ing into Shopify's accounts.<domain> OAuth flow): record the ORIGINAL URL as a
        // redirect-out and do NOT store the off-site target as a page or extract its links.
        // A hop that was not followed (stoppedAt) is handled the same way: the source is the redirect
        // and the target is never fetched; a robots-disallowed target is recorded as such.
        let offsite = r.stoppedAt != null;
        try { offsite ||= r.redirects.length > 0 && (!isInternalHost(new URL(r.finalUrl).hostname, baseHost) || skipUrl(r.finalUrl, excludeRes)); } catch { /* unparseable final URL */ }
        if (r.stoppedAt === 'robots') {
          ensureWiped();
          try { robotsInsert.run({ crawl_id: crawlId, url: r.finalUrl, url_key: urlKey(r.finalUrl, keyOpts), depth: item.depth + 1 }); } catch { /* dup */ }
        }
        const pageUrl = offsite ? item.url : r.finalUrl;
        const finalKey = urlKey(pageUrl, keyOpts);
        // Record the redirect SOURCE before the dedupe below can drop it (#32).
        if (r.redirects.length) {
          try {
            const srcKey = urlKey(item.url, keyOpts);
            if (srcKey !== urlKey(r.finalUrl, keyOpts)) {
              ensureWiped();
              redirectInsert.run(srcKey, item.url, r.redirects[0].status, r.finalUrl, urlKey(r.finalUrl, keyOpts), r.redirects.length, JSON.stringify(r.redirects), crawlId);
            }
          } catch { /* unparseable URL: nothing to record */ }
        }
        // Multiple enqueued URLs can redirect to the same final page. The pages table
        // dedupes via ON CONFLICT(url_key), but re-extracting the same HTML would insert
        // its outlinks AGAIN, inflating inlink_count/iPR weights — so skip re-processing.
        if (emitted.has(finalKey)) { crawled++; flush(); return; }
        emitted.add(finalKey);
        if (r.truncated) errorInsert.run(crawlId, r.finalUrl, 'body-truncated', `HTML body over ${MAX_HTML_BYTES / 1024 / 1024} MB: read and extracted up to that size only`);
        const status = offsite ? (r.redirects[0]?.status ?? r.status) : r.status;
        const isHtml = !offsite && isHtmlContentType(r.contentType);
        const ex = isHtml && r.status === 200 ? extractPage(r.body, r.finalUrl, baseHost, keyOpts, r.xRobotsTag) : null;
        // Only HTML 200s are indexable; otherwise capture WHY not (status/type/directive/canonical).
        const { indexable, reason } = offsite
          ? { indexable: 0, reason: 'redirect' as const }
          : classifyIndexability(isHtml, r.status, !!ex?.noindex, r.xRobotsTag, ex?.canonicalKey ?? null, finalKey);

        pageBuf.push({
          crawl_id: crawlId, url: pageUrl, url_key: finalKey, status_code: status,
          content_type: r.contentType, content_encoding: r.contentEncoding, cache_control: r.cacheControl,
          last_modified: r.lastModified, etag: r.etag, vary: r.vary,
          bytes: r.bytes, response_time_ms: r.timeMs, depth: item.depth,
          is_internal: 1, indexable, indexable_reason: reason, noindex: ex?.noindex ? 1 : 0,
          title: ex?.title ?? null, title_length: ex?.titleLength ?? 0,
          meta_description: ex?.metaDescription ?? null, meta_description_length: ex ? ex.metaDescriptionLength : null,
          h1: ex?.h1 ?? null, h1_count: ex?.h1Count ?? 0, word_count: ex?.wordCount ?? 0,
          lang: ex?.lang ?? null,
          charset: ex?.charset ?? r.contentType.match(/charset=([\w-]+)/i)?.[1] ?? null, // meta, else Content-Type header
          canonical_url: ex?.canonicalUrl ?? null, canonical_key: ex?.canonicalKey ?? null,
          robots: ex?.robots ?? null, x_robots_tag: r.xRobotsTag ?? null, viewport: ex?.viewport ?? null,
          json_ld: ex?.jsonLd ?? null, og_tags: ex?.ogTags ?? null, hreflang: ex?.hreflang ?? null,
          redirects: r.redirects.length ? JSON.stringify(r.redirects) : null,
          internal_links: ex?.internalLinks ?? 0, external_links: ex?.externalLinks ?? 0,
          image_count: ex?.imageCount ?? 0, images_without_alt: ex?.imagesWithoutAlt ?? 0,
          images_empty_alt: ex ? ex.imagesEmptyAlt : null, images_empty_alt_content: ex ? ex.imagesEmptyAltContent : null,
          fetched_as: r.fetchedAs,
          images_missing_dimensions: ex?.imagesMissingDimensions ?? 0,
          canonical_count: ex?.canonicalCount ?? 0, canonical_relative: ex?.canonicalRelative ? 1 : 0,
          h2_count: ex?.h2Count ?? 0, heading_skips: ex?.headingSkips ?? 0,
          rel_next: ex?.relNext ? 1 : 0, rel_prev: ex?.relPrev ? 1 : 0, rel_amphtml: ex?.relAmphtml ?? null,
          mixed_content_count: ex?.mixedContentCount ?? 0, twitter_tags: ex?.twitterTags ?? null,
          has_microdata: ex?.hasMicrodata ? 1 : 0, has_rdfa: ex?.hasRdfa ? 1 : 0,
          has_favicon: ex ? (ex.hasFavicon ? 1 : 0) : null, has_analytics: ex ? (ex.hasAnalytics ? 1 : 0) : null,
          body_chunks: ex?.bodyChunks?.length ? JSON.stringify(ex.bodyChunks) : null,
          security_headers: r.securityHeaders,
          // Accessibility (static axe subset) — NULL when the page wasn't HTML-extracted, so checks skip it.
          a11y_links_no_name: ex ? ex.a11yLinksNoName : null,
          a11y_buttons_no_name: ex ? ex.a11yButtonsNoName : null,
          a11y_inputs_no_label: ex ? ex.a11yInputsNoLabel : null,
          a11y_viewport_zoom_disabled: ex ? (ex.a11yViewportZoomDisabled ? 1 : 0) : null,
          a11y_positive_tabindex: ex ? ex.a11yPositiveTabindex : null,
          a11y_duplicate_ids: ex ? ex.a11yDuplicateIds : null,
          a11y_samples: ex ? JSON.stringify(ex.a11ySamples) : null,
        });

        if (ex) {
          for (const src of ex.imageSrcs) imageRefs.set(src, (imageRefs.get(src) ?? 0) + 1);
          for (const res of ex.resources) {
            resourceBuf.push({ crawl_id: crawlId, page_key: finalKey, resource_url: res.url, type: res.type, party: res.party, position: res.position,
              is_async: res.async ? 1 : 0, is_defer: res.defer ? 1 : 0, is_preload: res.preload ? 1 : 0, is_module: res.module ? 1 : 0, crossorigin: res.crossorigin, media: res.media });
            if (res.type !== 'img') { const ref = resourceRefs.get(res.url); if (ref) ref.usedOn++; else resourceRefs.set(res.url, { type: res.type, usedOn: 1 }); }
          }
          for (const l of ex.links) {
            linksSeen++;
            linkBuf.push({
              crawl_id: crawlId, source_url: r.finalUrl, source_key: finalKey,
              target_url: l.targetUrl, target_key: l.targetKey, anchor_text: l.anchor,
              is_internal: l.isInternal ? 1 : 0, placement: l.placement, rel: l.rel, href_form: l.hrefForm,
            });
            if (l.isInternal && !skipUrl(l.targetUrl, excludeRes) && item.depth + 1 <= maxDepth && (crawled + frontier.length) < maxPages) {
              enqueue(l.targetUrl, item.depth + 1);
            }
          }
        }
        crawled++;
        flush();
        if (crawled % 10 === 0) saveProgress();
      } catch (err: unknown) {
        failed++;
        errorInsert.run(crawlId, item.url, 'fetch', err instanceof Error ? err.message : String(err));
      }
    };

    // Concurrency pool over the shared frontier. Only resolve once all in-flight
    // work has drained — never while requests are still running (avoids late
    // writes after the DB is closed when the page cap is hit mid-flight).
    await new Promise<void>((resolve) => {
      let running = 0;
      let finished = false;
      const pump = (): void => {
        if (finished) return;
        const capHit = crawled >= maxPages || signal.aborted;
        if (running === 0 && (capHit || frontier.length === 0)) {
          finished = true;
          resolve();
          return;
        }
        if (capHit) return; // stop starting new work; let in-flight drain via finally → pump
        // limiter.limit, not the configured ceiling: the AIMD-adjusted effective concurrency (#54).
        // After a decrease, in-flight requests above the new limit drain before anything new starts.
        while (running < limiter.limit && frontier.length > 0 && crawled < maxPages && !signal.aborted) {
          const item = frontier.shift()!;
          running++;
          processOne(item).finally(() => { running--; pump(); });
        }
      };
      pump();
    });

    stage('writing-links');
    flush(true);
    // URLs the host never let us fetch (#54): recorded so the crawl's coverage is honest, but as
    // fetch_state='rate_limited' with status NULL and indexable NULL (unknown), never as a 429 the
    // audit would read as a broken page. Written after the final flush so a real row for the same
    // url_key (reached via a redirect) wins.
    if (unfetched.length) {
      ensureWiped();
      const rlInsert = db.db.prepare(
        `INSERT INTO pages (crawl_id, url, url_key, status_code, is_internal, indexable, indexable_reason, depth, fetch_state)
         VALUES (@crawl_id,@url,@url_key,NULL,1,NULL,'rate-limited',@depth,'rate_limited')
         ON CONFLICT(url_key) DO NOTHING`,
      );
      db.db.transaction(() => {
        for (const u of unfetched) {
          try { rlInsert.run({ crawl_id: crawlId, url: u.url, url_key: urlKey(u.url, keyOpts), depth: u.depth }); } catch { /* unparseable URL */ }
        }
      })();
    }
    saveProgress();

    // Post-crawl: sample image weights. One request per distinct <img> src, most-used first,
    // reading ONLY the response headers (content-length + content-type) — the body is cancelled
    // immediately, so no image bytes are ever downloaded. Bounded so a huge site can't stall
    // the crawl; feeds the Site health image-weight report.
    if (!signal.aborted && wipedPrior) { // wipedPrior = the crawl really wrote pages; keep old sample otherwise
      stage('image-weights');
      db.db.exec('DELETE FROM image_assets');
    }
    // Shared header-only probe for the two post-crawl passes: fetch, read headers, cancel the
    // body immediately — the bytes are never downloaded. Politeness lives in probePool: 2
    // workers paced at (at least) the crawl delay, so the aggregate stays at a few rps.
    const headProbe = async (url: string, extraHeaders: Record<string, string>, redirect: 'follow' | 'manual'): Promise<{ status: number; header: (n: string) => string | null } | null> => {
      try {
        // Same identity the page crawl ended on: a walled site would otherwise 403 every probe and
        // record false conditional-304 / asset statuses seconds after storing the pages as 200.
        const res = await ufetch(url, { headers: { ...(uaState.preferChrome ? CHROME_HEADERS : { 'user-agent': ua }), ...extraHeaders }, redirect, dispatcher, signal: AbortSignal.timeout(10000) });
        try { await res.body?.cancel(); } catch { /* already closed */ }
        // #54: a throttled probe measured nothing - treat it like a fetch error (no status stored;
        // a conditional probe that got 429 must not read as "returned 200 instead of 304").
        if (isRateLimited(res.status, n => res.headers.get(n))) return null;
        return { status: res.status, header: (n: string) => res.headers.get(n) };
      } catch { return null; }
    };
    const probePool = async <T>(items: T[], run: (item: T) => Promise<void>): Promise<void> => {
      let idx = 0;
      const worker = async (): Promise<void> => {
        while (idx < items.length && !signal.aborted) {
          await run(items[idx++]);
          if (delayMs) await sleep(Math.max(delayMs, 250));
        }
      };
      await Promise.all(Array.from({ length: 2 }, worker));
    };

    if (!signal.aborted && imageRefs.size) {
      const MAX_IMAGES = 500;
      // Same-host images obey the site's robots rules (same gate as the page crawl). Off-host
      // (CDN) images are kept — the SEO question is what the page loads, not where it's hosted —
      // but they go through the paced pool like everything else.
      const sample = [...imageRefs.entries()]
        .filter(([url]) => {
          try { const u = new URL(url); return !isInternalHost(u.hostname, baseHost) || robots.isAllowed(u.pathname + u.search); } catch { return false; }
        })
        .sort((a, b) => b[1] - a[1]).slice(0, MAX_IMAGES);
      const imgInsert = db.db.prepare(
        `INSERT INTO image_assets (url, bytes, status, content_type, used_on, fetched_at, accept)
         VALUES (?,?,?,?,?,datetime('now'),?) ON CONFLICT(url) DO NOTHING`,
      );
      const rows: [string, number | null, number, string, number, string][] = [];
      await probePool(sample, async ([url, usedOn]) => {
        // A browser's image Accept, so a CDN that negotiates WebP/AVIF answers with what visitors get
        // (Shopify's CDN sends a 2.1 MB PNG without it and a 222 KB WebP with it).
        const r = await headProbe(url, { accept: IMAGE_ACCEPT }, 'follow');
        if (r) {
          const len = Number(r.header('content-length'));
          rows.push([url, Number.isFinite(len) && len > 0 ? len : null, r.status, (r.header('content-type') ?? '').split(';')[0].trim(), usedOn, IMAGE_ACCEPT]);
        } else rows.push([url, null, 0, '', usedOn, IMAGE_ACCEPT]);
      });
      db.db.transaction(() => { for (const r of rows) imgInsert.run(...r); })();
    }

    // Optional (#37): header-only pass over css/js/font subresources — status, size and caching —
    // most-used first, capped, through the same paced pool. Bodies are never downloaded.
    if (opts.headResources && !signal.aborted && wipedPrior && resourceRefs.size) {
      stage('resource-headers');
      const MAX_RESOURCES = 500;
      const sample = [...resourceRefs.entries()]
        .filter(([url]) => { try { const u = new URL(url); return !isInternalHost(u.hostname, baseHost) || robots.isAllowed(u.pathname + u.search); } catch { return false; } })
        .sort((a, b) => b[1].usedOn - a[1].usedOn).slice(0, MAX_RESOURCES);
      const rows: [string, string, number, number | null, string, string | null, number][] = [];
      await probePool(sample, async ([url, ref]) => {
        const r = await headProbe(url, {}, 'follow');
        const len = r ? Number(r.header('content-length')) : NaN;
        rows.push([url, ref.type, r?.status ?? 0, Number.isFinite(len) && len > 0 ? len : null, (r?.header('content-type') ?? '').split(';')[0].trim(), r?.header('cache-control') ?? null, ref.usedOn]);
      });
      const ins = db.db.prepare(`INSERT INTO resource_assets (url, type, status, content_length, content_type, cache_control, used_on, checked_at) VALUES (?,?,?,?,?,?,?,datetime('now'))`);
      db.db.transaction(() => { db.db.exec('DELETE FROM resource_assets'); for (const r of rows) ins.run(...r); })();
    }

    // Post-crawl: in-degree (orphans), internal PageRank (iPR) + body-only click depth.
    stage('link-graph');
    finalizeLinkGraph(db.db, crawlId, urlKey(seed, keyOpts));

    // Post-crawl: conditional-revalidation probe. Pages that advertised validators
    // (Last-Modified / ETag) get ONE conditional re-request — a properly configured server
    // answers 304 Not Modified; a 200 means it re-serves the full body to every revalidating
    // crawler and cache, wasting crawl budget. Bounded sample, most-linked pages first.
    if (!signal.aborted) {
      stage('revalidation-probe');
      const cands = db.db.prepare(
        `SELECT url, url_key, last_modified lm, etag FROM pages
         WHERE status_code=200 AND is_internal=1 AND (last_modified IS NOT NULL OR etag IS NOT NULL)
         ORDER BY inlink_count DESC LIMIT 30`,
      ).all() as { url: string; url_key: string; lm: string | null; etag: string | null }[];
      const upd = db.db.prepare('UPDATE pages SET conditional_304=? WHERE url_key=?');
      await probePool(cands, async (p) => {
        const headers: Record<string, string> = {};
        if (p.etag) headers['if-none-match'] = p.etag;
        if (p.lm) headers['if-modified-since'] = p.lm;
        const r = await headProbe(p.url, headers, 'manual');
        if (r) upd.run(r.status === 304 ? 1 : 0, p.url_key); // fetch error → leave NULL, never counted against the server
      });
    }

    // (Sitemap is now fetched + stored + used as crawl seeds at the start of the crawl.)

    const finishedAt = new Date().toISOString();
    db.db.prepare(
      `UPDATE crawl_metadata SET status=?, urls_discovered=?, urls_crawled=?, urls_failed=?, urls_skipped=?,
         finished_at=?, duration_ms=? WHERE crawl_id=?`,
    ).run(
      signal.aborted ? 'cancelled' : 'completed', discovered, crawled, failed, skipped,
      finishedAt, Date.parse(finishedAt) - Date.parse(startedAt), crawlId,
    );
    db.db.prepare(`UPDATE property_meta SET last_crawl_id=? WHERE site_url=?`).run(crawlId, siteUrl);

    // Drift snapshot — the crawl OWNS its own history. This used to happen only in runAudit, so a
    // crawl that wasn't followed by an audit never entered page_snapshots and detect_changes
    // silently diffed older crawls while presenting them as current. Idempotent per crawl_id, so
    // the runAudit call stays as a self-heal for legacy/killed crawls.
    // Skipped on cancel: a partial page set would read as hundreds of pages "removed" next diff.
    if (!signal.aborted) {
      // Never fail a good crawl over its history — but say so, because a silently missing
      // snapshot is the exact failure this fix exists to remove. diffLatest also reports the gap.
      try {
        stage('snapshot');
        snapshotCrawl(db.db, crawlId, finishedAt);
      } catch (e) {
        console.error(`[crawl ${crawlId}] snapshot failed (change-detection will report this crawl as missing):`, e);
      }
    }
    // Post-crawl (#55 group D): at most 5 requests the crawl never makes - two random non-existent URLs
    // (soft-404 handling) and the http/https + www/apex twins of the homepage and one deep URL (host
    // variants). Same UA (Chrome if the crawl switched), Chrome fallback and delay as the crawl; one at a
    // time. Never fails the crawl.
    let siteProbes: SiteProbeSummary | undefined;
    if (opts.siteProbes !== false && !signal.aborted && wipedPrior) {
      try {
        stage('site-probes');
        siteProbes = await runSiteProbes(db.db, siteUrl, { crawlId, userAgent: ua, chromeFallback: uaState.fallback, preferChrome: uaState.preferChrome, delayMs, signal, isAllowed: u => robots.isAllowed(u.pathname + u.search) });
      } catch (e) { console.error(`[crawl ${crawlId}] site probes skipped:`, e instanceof Error ? e.message : String(e)); }
    }

    // Post-crawl (#36): status of every distinct outbound link target — cached, host-throttled,
    // HEAD with a ranged-GET fallback. On by default; checkExternal:false skips it. Runs AFTER the
    // crawl is marked completed and snapshotted: it can take minutes, and dying here must not leave a
    // finished crawl looking like a dead 'running' one.
    let external: ExternalSummary | undefined;
    if (opts.checkExternal !== false && !signal.aborted && wipedPrior) {
      try {
        stage('external-links');
        external = await checkExternalLinks(db.db, { userAgent: ua, chromeFallback: uaState.fallback, signal, update: p => update({ crawlId, stage: 'external-links', ...p }), cacheDays: opts.externalCacheDays });
      } catch (e) { console.error(`[crawl ${crawlId}] external link check skipped:`, e instanceof Error ? e.message : String(e)); }
    }

    // Report blocking only when Chrome actually got past it: a 403 that Chrome also gets is a
    // forbidden URL, not bot protection.
    stage('done');
    const blocking = uaState.okAsChrome ? { blockedAsBot: uaState.blockedAsBot, okAsChrome: uaState.okAsChrome, blockedForBoth: uaState.blockedAsChrome, switchedToChrome: uaState.preferChrome } : undefined;
    return { crawlId, siteUrl, crawled, failed, skipped, ...(sitemaps ? { sitemaps } : {}), ...(external ? { external } : {}), ...(siteProbes ? { siteProbes } : {}), ...(blocking ? { blocking } : {}),
      rateLimited: rateLimitReport(), ...(platform ? { platform } : {}) };
    } catch (err) {
      try {
        db.db.prepare(`UPDATE crawl_metadata SET status='failed', error=?, finished_at=? WHERE crawl_id=? AND status='running'`)
          .run(err instanceof Error ? err.message : String(err), new Date().toISOString(), crawlId);
      } catch { /* best-effort */ }
      throw err;
    } finally {
      db.close();
      try { await dispatcher.close(); } catch { /* pool already gone */ }
    }
  }
}
