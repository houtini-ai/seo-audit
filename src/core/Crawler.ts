import { randomUUID } from 'node:crypto';
import { Agent, fetch as ufetch } from 'undici';
import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty, type UrlKeyOptions } from './url-key.js';
import { extractPage, isInternalHost } from './extract.js';
import { fetchRobots } from './robots.js';
import { finalizeLinkGraph } from './linkGraph.js';
import { fetchSitemapUrls } from './sitemap.js';

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
}

export interface CrawlResult {
  crawlId: string;
  siteUrl: string;
  crawled: number;
  failed: number;
  skipped: number;
}

const DEFAULT_UA = 'Mozilla/5.0 (compatible; seo-audit-console/0.1; +https://github.com/houtini-ai/seo-audit-console)';
const FETCH_TIMEOUT_MS = 20000;
const MAX_TRANSIENT_RETRIES = 4; // 429/503 backoff attempts before recording the status
const FLUSH_EVERY = 50;

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
  timeMs: number;
  throttled: boolean; // saw a 429/503 (after retries) — signal for adaptive pacing
}

// Per-crawl connection pool: HTTP/2 when the origin supports it (one multiplexed connection
// instead of N TCP handshakes), keep-alive reuse, bounded per-origin connections. Compression
// is negotiated explicitly (gzip/br/deflate — undici decompresses transparently; the recorded
// content_encoding header still reflects what the server actually served).
const makeDispatcher = (connections: number): Agent =>
  new Agent({ allowH2: true, connections, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 });

async function fetchWithRedirects(url: string, ua: string, dispatcher: Agent, maxHops = 5): Promise<FetchOutcome> {
  const redirects: RedirectHop[] = [];
  let current = url;
  let hops = 0;
  let transientRetries = 0; // 429/503 backoff budget
  let netRetries = 0;       // network-error (timeout/reset) budget — separate so a 503 then a timeout doesn't starve it
  const start = Date.now();
  // Always GET — never HEAD. Some servers/CDNs return a different status for HEAD than for GET
  // (e.g. a 404 on HEAD where GET is 200, or vice-versa), which would mis-record a URL's real
  // status. We still avoid downloading asset bytes by cancelling the body stream for any non-HTML
  // response below, so a GET stays as light as a HEAD for images/PDFs/etc.
  const method = 'GET';
  while (true) {
    let res: Response;
    try {
      res = (await ufetch(current, {
        method,
        redirect: 'manual',
        dispatcher,
        // pages change between crawls — ask upstream caches/CDNs for the current copy
        headers: {
          'user-agent': ua,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })) as unknown as Response;
    } catch (err) {
      // The server slowed past the timeout or dropped the connection. Don't lose the page to a
      // transient hiccup — wait (10s, 20s, 30s) and retry before giving up, so a slowdown becomes
      // latency rather than a silent coverage gap. Uses its OWN budget (not the 429/503 one) so a
      // page that 503s then times out still gets full network retries; trips `throttled` so the
      // crawl paces itself down. Surfaces as a failure only after the budget is exhausted.
      if (netRetries < MAX_TRANSIENT_RETRIES) {
        netRetries++;
        await sleep(Math.min(10000 * netRetries, 30000));
        continue;
      }
      throw err;
    }
    // Transient throttling (429 Too Many Requests / 503 Service Unavailable) is NOT a broken
    // page — back off (respecting Retry-After) and retry, so a fast crawl doesn't poison the
    // data with rate-limit statuses. Only the final status after retries is recorded.
    if ((res.status === 429 || res.status === 503) && transientRetries < MAX_TRANSIENT_RETRIES) {
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20000) : Math.min(1000 * 2 ** transientRetries, 8000);
      try { await res.body?.cancel(); } catch { /* no body */ }
      transientRetries++;
      await sleep(waitMs);
      continue;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops < maxHops) {
      const loc = new URL(res.headers.get('location')!, current).toString();
      // Drain the redirect response's body (some servers attach HTML to 301s) so the
      // keep-alive connection is released — otherwise redirect-heavy crawls leak sockets.
      try { await res.body?.cancel(); } catch { /* already closed */ }
      redirects.push({ from: current, to: loc, status: res.status });
      current = loc;
      hops++;
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    const isHtml = isHtmlContentType(contentType);
    // Read the body only for HTML; for any non-HTML response (image/PDF/asset) abort the transfer
    // so we never pull the bytes — keeping the always-GET fetch as cheap as a HEAD would have been.
    let body = '';
    if (isHtml) body = await res.text();
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
    };
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

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
    // connections, not 8 sockets. Adaptive throttling still ramps the delay on any 429/503,
    // so a struggling host slows the whole pool down.
    const concurrency = Math.max(1, Math.min(opts.maxConcurrency ?? 8, 24));
    const delayMs = opts.delayMs ?? 250;
    const ua = opts.userAgent ?? DEFAULT_UA;
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
      db.db.exec('DELETE FROM links; DELETE FROM pages;');
      wipedPrior = true;
    };

    const robots = await fetchRobots(origin, ua);

    const pageInsert = db.db.prepare(
      `INSERT INTO pages (crawl_id, url, url_key, status_code, content_type, content_encoding, cache_control,
         last_modified, etag, vary, bytes, response_time_ms, depth,
         is_internal, indexable, indexable_reason, noindex, title, title_length, meta_description, meta_description_length,
         h1, h1_count, word_count, lang, charset, canonical_url, canonical_key, robots, x_robots_tag, viewport,
         json_ld, og_tags, hreflang, redirects, internal_links, external_links,
         image_count, images_without_alt, images_missing_dimensions, canonical_count, canonical_relative,
         h2_count, heading_skips, rel_next, rel_prev, rel_amphtml, mixed_content_count, twitter_tags,
         has_microdata, has_rdfa, has_favicon, has_analytics, body_chunks, security_headers)
       VALUES (@crawl_id,@url,@url_key,@status_code,@content_type,@content_encoding,@cache_control,
         @last_modified,@etag,@vary,@bytes,@response_time_ms,@depth,
         @is_internal,@indexable,@indexable_reason,@noindex,@title,@title_length,@meta_description,@meta_description_length,
         @h1,@h1_count,@word_count,@lang,@charset,@canonical_url,@canonical_key,@robots,@x_robots_tag,@viewport,
         @json_ld,@og_tags,@hreflang,@redirects,@internal_links,@external_links,
         @image_count,@images_without_alt,@images_missing_dimensions,@canonical_count,@canonical_relative,
         @h2_count,@heading_skips,@rel_next,@rel_prev,@rel_amphtml,@mixed_content_count,@twitter_tags,
         @has_microdata,@has_rdfa,@has_favicon,@has_analytics,@body_chunks,@security_headers)
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
      `INSERT INTO links (crawl_id, source_url, source_key, target_url, target_key, anchor_text, is_internal, placement, rel)
       VALUES (@crawl_id,@source_url,@source_key,@target_url,@target_key,@anchor_text,@is_internal,@placement,@rel)`,
    );
    const errorInsert = db.db.prepare(
      `INSERT INTO errors (crawl_id, url, error_type, error_message) VALUES (?, ?, ?, ?)`,
    );
    const flushPages = db.db.transaction((rows: Record<string, unknown>[]) => { for (const r of rows) pageInsert.run(r); });
    const flushLinks = db.db.transaction((rows: Record<string, unknown>[]) => { for (const r of rows) linkInsert.run(r); });

    const pageBuf: Record<string, unknown>[] = [];
    const linkBuf: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    const emitted = new Set<string>(); // final url_keys already extracted+written
    const imageRefs = new Map<string, number>(); // distinct <img> src → pages using it
    const frontier: { url: string; depth: number }[] = [];
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
    // alone misses them (e.g. directdrivewheels: 367 sitemap URLs, only ~100 reachable via links).
    // Also stores the sitemap for crawl↔sitemap reconciliation. Off-host/junk/asset URLs filtered;
    // bounded by maxPages.
    if (!signal.aborted) {
      try {
        const sm = await fetchSitemapUrls(origin, ua, keyOpts);
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
    // the site's sitemap being complete — e.g. simracing has 334 sitemap URLs but GSC knows 1,299.
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

    const flush = (final = false): void => {
      if (pageBuf.length || linkBuf.length) ensureWiped();
      if (pageBuf.length && (final || pageBuf.length >= FLUSH_EVERY)) { flushPages(pageBuf.splice(0)); }
      if (linkBuf.length && (final || linkBuf.length >= FLUSH_EVERY)) { flushLinks(linkBuf.splice(0)); }
    };
    const saveProgress = (): void => {
      db.db.prepare(`UPDATE crawl_metadata SET urls_discovered=?, urls_crawled=?, urls_failed=?, urls_skipped=? WHERE crawl_id=?`)
        .run(discovered, crawled, failed, skipped, crawlId);
      update({ crawlId, crawled, discovered, failed, skipped });
    };

    // Adaptive pacing: start at the configured delay; ramp UP when the host throttles (429/503)
    // and decay back toward base when it's clear. Same pages crawled (no data lost) — just paced
    // so hard-throttled sites stop triggering retries (net faster + cleaner) and fast sites stay fast.
    let dynamicDelay = delayMs;
    const processOne = async (item: { url: string; depth: number }): Promise<void> => {
      if (dynamicDelay) await sleep(dynamicDelay);
      const path = (() => { try { return new URL(item.url).pathname; } catch { return '/'; } })();
      if (!robots.isAllowed(path)) {
        ensureWiped();
        try { robotsInsert.run({ crawl_id: crawlId, url: item.url, url_key: urlKey(item.url, keyOpts), depth: item.depth }); } catch { /* dup */ }
        skipped++; return;
      }
      try {
        const r = await fetchWithRedirects(item.url, ua, dispatcher);
        // Self-tune the delay from the throttle signal.
        if (r.throttled) dynamicDelay = Math.min(Math.round(dynamicDelay * 1.5) + 200, 5000);
        else if (dynamicDelay > delayMs) dynamicDelay = Math.max(delayMs, Math.round(dynamicDelay * 0.9));
        // Redirect that leaves the internal host or lands on a skip-pattern URL (e.g. an internal
        // link 301-ing into Shopify's accounts.<domain> OAuth flow): record the ORIGINAL URL as a
        // redirect-out and do NOT store the off-site target as a page or extract its links.
        let offsite = false;
        try { offsite = r.redirects.length > 0 && (!isInternalHost(new URL(r.finalUrl).hostname, baseHost) || skipUrl(r.finalUrl, excludeRes)); } catch { /* unparseable final URL */ }
        const pageUrl = offsite ? item.url : r.finalUrl;
        const finalKey = urlKey(pageUrl, keyOpts);
        // Multiple enqueued URLs can redirect to the same final page. The pages table
        // dedupes via ON CONFLICT(url_key), but re-extracting the same HTML would insert
        // its outlinks AGAIN, inflating inlink_count/iPR weights — so skip re-processing.
        if (emitted.has(finalKey)) { crawled++; flush(); return; }
        emitted.add(finalKey);
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
          meta_description: ex?.metaDescription ?? null, meta_description_length: ex?.metaDescriptionLength ?? 0,
          h1: ex?.h1 ?? null, h1_count: ex?.h1Count ?? 0, word_count: ex?.wordCount ?? 0,
          lang: ex?.lang ?? null,
          charset: ex?.charset ?? r.contentType.match(/charset=([\w-]+)/i)?.[1] ?? null, // meta, else Content-Type header
          canonical_url: ex?.canonicalUrl ?? null, canonical_key: ex?.canonicalKey ?? null,
          robots: ex?.robots ?? null, x_robots_tag: r.xRobotsTag ?? null, viewport: ex?.viewport ?? null,
          json_ld: ex?.jsonLd ?? null, og_tags: ex?.ogTags ?? null, hreflang: ex?.hreflang ?? null,
          redirects: r.redirects.length ? JSON.stringify(r.redirects) : null,
          internal_links: ex?.internalLinks ?? 0, external_links: ex?.externalLinks ?? 0,
          image_count: ex?.imageCount ?? 0, images_without_alt: ex?.imagesWithoutAlt ?? 0,
          images_missing_dimensions: ex?.imagesMissingDimensions ?? 0,
          canonical_count: ex?.canonicalCount ?? 0, canonical_relative: ex?.canonicalRelative ? 1 : 0,
          h2_count: ex?.h2Count ?? 0, heading_skips: ex?.headingSkips ?? 0,
          rel_next: ex?.relNext ? 1 : 0, rel_prev: ex?.relPrev ? 1 : 0, rel_amphtml: ex?.relAmphtml ?? null,
          mixed_content_count: ex?.mixedContentCount ?? 0, twitter_tags: ex?.twitterTags ?? null,
          has_microdata: ex?.hasMicrodata ? 1 : 0, has_rdfa: ex?.hasRdfa ? 1 : 0,
          has_favicon: ex ? (ex.hasFavicon ? 1 : 0) : null, has_analytics: ex ? (ex.hasAnalytics ? 1 : 0) : null,
          body_chunks: ex?.bodyChunks?.length ? JSON.stringify(ex.bodyChunks) : null,
          security_headers: r.securityHeaders,
        });

        if (ex) {
          for (const src of ex.imageSrcs) imageRefs.set(src, (imageRefs.get(src) ?? 0) + 1);
          for (const l of ex.links) {
            linkBuf.push({
              crawl_id: crawlId, source_url: r.finalUrl, source_key: finalKey,
              target_url: l.targetUrl, target_key: l.targetKey, anchor_text: l.anchor,
              is_internal: l.isInternal ? 1 : 0, placement: l.placement, rel: l.rel,
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
        while (running < concurrency && frontier.length > 0 && crawled < maxPages && !signal.aborted) {
          const item = frontier.shift()!;
          running++;
          processOne(item).finally(() => { running--; pump(); });
        }
      };
      pump();
    });

    flush(true);

    // Post-crawl: sample image weights. One request per distinct <img> src, most-used first,
    // reading ONLY the response headers (content-length + content-type) — the body is cancelled
    // immediately, so no image bytes are ever downloaded. Bounded so a huge site can't stall
    // the crawl; feeds the Site health image-weight report.
    if (!signal.aborted && wipedPrior) { // wipedPrior = the crawl really wrote pages; keep old sample otherwise
      db.db.exec('DELETE FROM image_assets');
    }
    // Shared header-only probe for the two post-crawl passes: fetch, read headers, cancel the
    // body immediately — the bytes are never downloaded. Politeness lives in probePool: 2
    // workers paced at (at least) the crawl delay, so the aggregate stays at a few rps.
    const headProbe = async (url: string, extraHeaders: Record<string, string>, redirect: 'follow' | 'manual'): Promise<{ status: number; header: (n: string) => string | null } | null> => {
      try {
        const res = await ufetch(url, { headers: { 'user-agent': ua, ...extraHeaders }, redirect, dispatcher, signal: AbortSignal.timeout(10000) });
        try { await res.body?.cancel(); } catch { /* already closed */ }
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
          try { const u = new URL(url); return !isInternalHost(u.hostname, baseHost) || robots.isAllowed(u.pathname); } catch { return false; }
        })
        .sort((a, b) => b[1] - a[1]).slice(0, MAX_IMAGES);
      const imgInsert = db.db.prepare(
        `INSERT INTO image_assets (url, bytes, status, content_type, used_on, fetched_at)
         VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(url) DO NOTHING`,
      );
      const rows: [string, number | null, number, string, number][] = [];
      await probePool(sample, async ([url, usedOn]) => {
        const r = await headProbe(url, {}, 'follow');
        if (r) {
          const len = Number(r.header('content-length'));
          rows.push([url, Number.isFinite(len) && len > 0 ? len : null, r.status, (r.header('content-type') ?? '').split(';')[0].trim(), usedOn]);
        } else rows.push([url, null, 0, '', usedOn]);
      });
      db.db.transaction(() => { for (const r of rows) imgInsert.run(...r); })();
    }

    // Post-crawl: in-degree (orphans), internal PageRank (iPR) + body-only click depth.
    finalizeLinkGraph(db.db, crawlId, urlKey(seed, keyOpts));

    // Post-crawl: conditional-revalidation probe. Pages that advertised validators
    // (Last-Modified / ETag) get ONE conditional re-request — a properly configured server
    // answers 304 Not Modified; a 200 means it re-serves the full body to every revalidating
    // crawler and cache, wasting crawl budget. Bounded sample, most-linked pages first.
    if (!signal.aborted) {
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
    return { crawlId, siteUrl, crawled, failed, skipped };
    } catch (err) {
      try {
        db.db.prepare(`UPDATE crawl_metadata SET status='failed', error=?, finished_at=datetime('now') WHERE crawl_id=? AND status='running'`)
          .run(err instanceof Error ? err.message : String(err), crawlId);
      } catch { /* best-effort */ }
      throw err;
    } finally {
      db.close();
      try { await dispatcher.close(); } catch { /* pool already gone */ }
    }
  }
}
