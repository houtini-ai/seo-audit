import { randomUUID } from 'node:crypto';
import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty, type UrlKeyOptions } from './url-key.js';
import { extractPage } from './extract.js';
import { fetchRobots } from './robots.js';
import { computeLinkGraph } from './linkGraph.js';

// Robust HTML detection from a Content-Type header: take the MIME type before any
// parameters (charset, boundary), normalised — text/html and XHTML count as HTML.
const HTML_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml']);
export const isHtmlContentType = (ct: string | null | undefined): boolean =>
  HTML_MIME_TYPES.has((ct ?? '').split(';')[0].trim().toLowerCase());

// File types we never need the body of — images, media, fonts, archives, office docs, css/js,
// pdf. We HEAD these (status + content-type only, no download) — a big bandwidth/time win on
// asset-heavy sites. We still record them (status/type) so broken-link checks work.
const ASSET_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|pdf|zip|rar|7z|gz|tgz|tar|bz2|mp4|webm|mov|avi|mkv|m4v|mp3|wav|ogg|flac|css|js|mjs|cjs|map|woff2?|ttf|otf|eot|dmg|exe|msi|apk|doc|docx|xls|xlsx|ppt|pptx)$/i;
const isAssetUrl = (u: string): boolean => { try { return ASSET_EXT.test(new URL(u).pathname); } catch { return false; } };

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  maxConcurrency?: number;
  delayMs?: number;
  userAgent?: string;
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
}

async function fetchWithRedirects(url: string, ua: string, maxHops = 5): Promise<FetchOutcome> {
  const redirects: RedirectHop[] = [];
  let current = url;
  let hops = 0;
  const start = Date.now();
  // Known asset file-types: HEAD only (no body download). Falls back to GET if HEAD is refused.
  let method: 'GET' | 'HEAD' = isAssetUrl(url) ? 'HEAD' : 'GET';
  while (true) {
    const res = await fetch(current, {
      method,
      redirect: 'manual',
      // pages change between crawls — ask upstream caches/CDNs for the current copy
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops < maxHops) {
      const loc = new URL(res.headers.get('location')!, current).toString();
      redirects.push({ from: current, to: loc, status: res.status });
      current = loc;
      hops++;
      continue;
    }
    // Server refuses HEAD → retry the same URL with GET (body cancelled below if non-HTML).
    if (method === 'HEAD' && (res.status === 405 || res.status === 501)) { method = 'GET'; continue; }
    const contentType = res.headers.get('content-type') ?? '';
    const isHtml = isHtmlContentType(contentType);
    // Only download the body for HTML pages we GET. For everything else (HEAD, or a GET that
    // turned out non-HTML), abort the transfer so we never pull image/PDF/asset bytes.
    let body = '';
    if (method === 'GET') {
      if (isHtml) body = await res.text();
      else { try { await res.body?.cancel(); } catch { /* already closed */ } }
    }
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
      // content-length when given; else the decoded HTML size; else null (non-HTML w/o
      // content-length — body isn't read, so 0 would be misleading).
      bytes: Number(h('content-length')) || (body ? Buffer.byteLength(body) : null),
      timeMs: Date.now() - start,
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
    const maxPages = opts.maxPages ?? 1000;
    const maxDepth = opts.maxDepth ?? 10;
    const concurrency = Math.max(1, Math.min(opts.maxConcurrency ?? 4, 16));
    const delayMs = opts.delayMs ?? 250;
    const ua = opts.userAgent ?? DEFAULT_UA;

    const seed = siteUrl.startsWith('sc-domain:') ? `https://${siteUrl.slice('sc-domain:'.length)}/` : siteUrl;
    const baseHost = new URL(seed).hostname;
    const keyOpts: UrlKeyOptions = { hostForm: hostFormForProperty(siteUrl) };
    const origin = new URL(seed).origin;

    const db = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
    db.upsertProperty(siteUrl, keyOpts.hostForm ?? 'asis');
    const crawlId = randomUUID().slice(0, 8);
    const startedAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, max_depth, max_pages, user_agent, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(crawlId, seed, baseHost, maxDepth, maxPages, ua, startedAt);

    try {
    // A crawl is a fresh snapshot of the current site — clear prior crawl data so
    // re-crawls reflect changes (the "fix → re-crawl → verify" loop) instead of
    // accumulating stale pages / duplicate links. GSC/inspection/findings are separate.
    db.db.exec('DELETE FROM links; DELETE FROM errors; DELETE FROM pages;');

    const robots = await fetchRobots(origin, ua);

    const pageInsert = db.db.prepare(
      `INSERT INTO pages (crawl_id, url, url_key, status_code, content_type, content_encoding, cache_control,
         last_modified, etag, vary, bytes, response_time_ms, depth,
         is_internal, indexable, noindex, title, title_length, meta_description, meta_description_length,
         h1, h1_count, word_count, lang, charset, canonical_url, canonical_key, robots, x_robots_tag, viewport,
         json_ld, og_tags, hreflang, redirects, internal_links, external_links,
         image_count, images_without_alt, images_missing_dimensions, canonical_count, canonical_relative,
         h2_count, heading_skips, rel_next, rel_prev, rel_amphtml, mixed_content_count, twitter_tags,
         has_microdata, has_rdfa, security_headers)
       VALUES (@crawl_id,@url,@url_key,@status_code,@content_type,@content_encoding,@cache_control,
         @last_modified,@etag,@vary,@bytes,@response_time_ms,@depth,
         @is_internal,@indexable,@noindex,@title,@title_length,@meta_description,@meta_description_length,
         @h1,@h1_count,@word_count,@lang,@charset,@canonical_url,@canonical_key,@robots,@x_robots_tag,@viewport,
         @json_ld,@og_tags,@hreflang,@redirects,@internal_links,@external_links,
         @image_count,@images_without_alt,@images_missing_dimensions,@canonical_count,@canonical_relative,
         @h2_count,@heading_skips,@rel_next,@rel_prev,@rel_amphtml,@mixed_content_count,@twitter_tags,
         @has_microdata,@has_rdfa,@security_headers)
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

    const flush = (final = false): void => {
      if (pageBuf.length && (final || pageBuf.length >= FLUSH_EVERY)) { flushPages(pageBuf.splice(0)); }
      if (linkBuf.length && (final || linkBuf.length >= FLUSH_EVERY)) { flushLinks(linkBuf.splice(0)); }
    };
    const saveProgress = (): void => {
      db.db.prepare(`UPDATE crawl_metadata SET urls_discovered=?, urls_crawled=?, urls_failed=?, urls_skipped=? WHERE crawl_id=?`)
        .run(discovered, crawled, failed, skipped, crawlId);
      update({ crawlId, crawled, discovered, failed, skipped });
    };

    const processOne = async (item: { url: string; depth: number }): Promise<void> => {
      if (delayMs) await sleep(delayMs);
      const path = (() => { try { return new URL(item.url).pathname; } catch { return '/'; } })();
      if (!robots.isAllowed(path)) { skipped++; return; }
      try {
        const r = await fetchWithRedirects(item.url, ua);
        const finalKey = urlKey(r.finalUrl, keyOpts);
        const isHtml = isHtmlContentType(r.contentType);
        const ex = isHtml && r.status === 200 ? extractPage(r.body, r.finalUrl, baseHost, keyOpts, r.xRobotsTag) : null;
        // Only HTML documents are "indexable pages". Non-HTML resources (images, PDFs, RSS
        // feeds, plain text) are stored for link/status analysis but must not be treated as
        // indexable content — otherwise they pollute on-page checks and internal-link donors.
        const indexable = isHtml && r.status === 200 && !(ex?.noindex ?? /noindex/i.test(r.xRobotsTag ?? ''))
          && (!ex?.canonicalKey || ex.canonicalKey === finalKey) ? 1 : 0;

        pageBuf.push({
          crawl_id: crawlId, url: r.finalUrl, url_key: finalKey, status_code: r.status,
          content_type: r.contentType, content_encoding: r.contentEncoding, cache_control: r.cacheControl,
          last_modified: r.lastModified, etag: r.etag, vary: r.vary,
          bytes: r.bytes, response_time_ms: r.timeMs, depth: item.depth,
          is_internal: 1, indexable, noindex: ex?.noindex ? 1 : 0,
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
          security_headers: r.securityHeaders,
        });

        if (ex) {
          for (const l of ex.links) {
            linkBuf.push({
              crawl_id: crawlId, source_url: r.finalUrl, source_key: finalKey,
              target_url: l.targetUrl, target_key: l.targetKey, anchor_text: l.anchor,
              is_internal: l.isInternal ? 1 : 0, placement: l.placement, rel: l.rel,
            });
            if (l.isInternal && item.depth + 1 <= maxDepth && (crawled + frontier.length) < maxPages) {
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

    // Post-crawl: in-degree (orphan detection) from the link graph.
    db.db.prepare(
      `UPDATE pages SET inlink_count = (
        SELECT COUNT(*) FROM links
        WHERE links.target_key = pages.url_key AND links.is_internal = 1
          AND links.source_key != pages.url_key AND links.crawl_id = pages.crawl_id
      ) WHERE crawl_id = ?`,
    ).run(crawlId);

    // Post-crawl: internal PageRank (iPR) + body-only click depth from the homepage.
    computeLinkGraph(db.db, crawlId, urlKey(seed, keyOpts));

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
    }
  }
}
