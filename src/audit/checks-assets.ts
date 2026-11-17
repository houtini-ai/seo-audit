/**
 * #55 summary slice 4, group C, item 7: asset checks.
 *   - broken-subresource              a CSS/JS/font file answering 4xx/5xx, with the pages loading it
 *   - render-blocking-head-resources  parser-blocking scripts / render-blocking stylesheets in <head>
 *   - static-asset-uncached           first-party CSS/JS/fonts with no cache lifetime, or under a day
 *   - image-oversized                 an <img> over 300 KB
 *   - image-legacy-format             a JPEG/PNG/GIF/BMP big enough that WebP/AVIF would save real bytes
 *   - broken-image                    an <img> src answering 4xx/5xx, or HTML instead of an image
 *
 * Data (#37): `page_resources` (every crawl since 0.15.0: what each page loads, head/body, async/defer/
 * module/preload, media), `resource_assets` (ONLY when the crawl ran with headResources:true: status,
 * content-length, cache-control per CSS/JS/font file, top 500 by use) and `image_assets` (after every
 * crawl: status, content-length, content-type per <img> src, top 500 by use). Bodies are never
 * downloaded. Same contract as checks.ts: a pure read, thresholds stated, missing data = no finding,
 * and each check's collected() says "not collected" (with how to collect it) instead of passing on an
 * empty table. A status of 0 (fetch failed, or the probe was rate-limited) or a 429/503 is unknown.
 */
import { pageRowsFor } from '../core/gscPageTotals.js';
import type { CheckContext, CheckDef, RawFinding } from './checks.js';
import { HTML_CT } from '../core/sql.js';
import { PAGE_EXPERIENCE_STAKE_SHARE } from './stakes.js';

const rows = (c: CheckContext, sql: string, ...args: unknown[]): any[] => c.db.prepare(sql).all(...args);
const one = (c: CheckContext, sql: string, ...args: unknown[]): any => c.db.prepare(sql).get(...args);
const tableExists = (c: CheckContext, t: string): boolean => !!one(c, `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t);
const count = (c: CheckContext, t: string, where = '1=1'): number => (tableExists(c, t) ? (one(c, `SELECT COUNT(*) n FROM ${t} WHERE ${where}`)?.n ?? 0) : 0);

/** 4xx/5xx is broken; 0 (no response / rate-limited probe), 429 and 503 are unknown. */
export const isBrokenStatus = (s: number | null | undefined): boolean => s != null && s >= 400 && s <= 599 && s !== 429 && s !== 503;

// ── "Not collected" notes ────────────────────────────────────────────────────────────────────
const NO_PAGE_RESOURCES = 'not collected: page_resources is empty (the latest crawl predates 0.15.0, which started recording what each page loads). Re-crawl with start_crawl or refresh_property.';
const NO_RESOURCE_ASSETS = 'not collected: resource_assets is empty. It is only filled by a crawl run with headResources:true (start_crawl headResources:true: a header-only pass over the CSS/JS/font files pages load, top 500 by use).';
const NO_IMAGE_ASSETS = 'not collected: image_assets is empty. Image headers are sampled after every completed crawl (top 500 <img> srcs by use); re-crawl with start_crawl or refresh_property.';

function pageResourcesNote(c: CheckContext): string | null {
  return count(c, 'page_resources') > 0 ? null : NO_PAGE_RESOURCES;
}
/** resource_assets is "not collected" when it is empty while pages do load CSS/JS/fonts (or we can't tell). */
function resourceAssetsNote(c: CheckContext): string | null {
  if (count(c, 'resource_assets') > 0) return null;
  if (count(c, 'page_resources') > 0 && count(c, 'page_resources', `type IN ('css','js','font')`) === 0) return null; // nothing to probe
  return NO_RESOURCE_ASSETS;
}
function imageAssetsNote(c: CheckContext): string | null {
  if (count(c, 'image_assets') > 0) return null;
  if (count(c, 'page_resources') > 0 && count(c, 'page_resources', `type = 'img'`) === 0) return null; // no images on the site
  return NO_IMAGE_ASSETS;
}

/** The image-weight checks read only rows probed with a browser Accept header (image_assets.accept). */
const BROWSER_PROBED = `accept IS NOT NULL`;
const NO_BROWSER_PROBE = 'not collected: image_assets was sampled by a crawl that sent no browser Accept header, so a CDN that negotiates WebP/AVIF (Shopify, Cloudflare Polish) was measured at its JPEG/PNG size. Re-crawl with start_crawl or refresh_property to measure what browsers are served.';
function imageWeightNote(c: CheckContext): string | null {
  const base = imageAssetsNote(c);
  if (base || count(c, 'image_assets') === 0) return base;
  return count(c, 'image_assets', BROWSER_PROBED) > 0 ? null : NO_BROWSER_PROBE;
}

// ── Which pages load an asset, and which page a finding is keyed to ───────────────────────────
interface Users { pages: number; sample: string[]; topPage: string | null }
/**
 * The pages (latest crawl) that load `url`, from page_resources. The finding is keyed to the one with
 * the most GSC clicks over the last 28 finalised days (then internal PageRank, then url_key), so the
 * engine prices it by real traffic; null when page_resources doesn't map it (older crawl).
 */
function usersLookup(c: CheckContext): (url: string) => Users {
  const has = count(c, 'page_resources') > 0;
  const clicks = new Map<string, number>();
  if (has && c.gscMaxDate) {
    for (const r of rows(c, `SELECT page_key k, SUM(clicks) n FROM ${pageRowsFor(c.db, c.gscMaxDate, 28).table}
        WHERE page_key IN (SELECT DISTINCT page_key FROM page_resources) AND date <= ? AND date > date(?, '-28 days') GROUP BY page_key`, c.gscMaxDate, c.gscMaxDate))
      clicks.set(r.k, r.n ?? 0);
  }
  const st = has ? c.db.prepare(`SELECT DISTINCT r.page_key k, COALESCE(p.ipr, 0) ipr FROM page_resources r LEFT JOIN pages p ON p.url_key = r.page_key WHERE r.resource_url = ?`) : null;
  return (url) => {
    if (!st) return { pages: 0, sample: [], topPage: null };
    const ps = (st.all(url) as { k: string; ipr: number }[])
      .sort((a, b) => (clicks.get(b.k) ?? 0) - (clicks.get(a.k) ?? 0) || b.ipr - a.ipr || a.k.localeCompare(b.k));
    return { pages: ps.length, sample: ps.slice(0, 10).map(p => p.k), topPage: ps[0]?.k ?? null };
  };
}

// ── broken-subresource ───────────────────────────────────────────────────────────────────────
/** CSS/JS/font files (resource_assets) answering 4xx/5xx. Images are broken-image's. One finding per file. */
function brokenSubresource(c: CheckContext): RawFinding[] {
  if (!tableExists(c, 'resource_assets')) return [];
  const users = usersLookup(c);
  return rows(c, `SELECT url, type, status, used_on usedOn, checked_at checkedAt FROM resource_assets WHERE status >= 400 AND status <= 599 AND status NOT IN (429, 503)`)
    .map(r => { const u = users(r.url); return { u, r }; })
    .sort((a, b) => (b.u.pages || b.r.usedOn || 0) - (a.u.pages || a.r.usedOn || 0) || a.r.url.localeCompare(b.r.url))
    .map(({ u, r }) => ({ urlKey: u.topPage, evidence: {
      asset: r.url, type: r.type, status: r.status, pagesLoadingIt: u.pages || r.usedOn, samplePages: u.sample, checkedAt: r.checkedAt,
      note: `a ${r.type} file this site loads answers ${r.status}: browsers and Googlebot render the page without it`,
    } }));
}

// ── broken-image ─────────────────────────────────────────────────────────────────────────────
/** An <img> src (image_assets) answering 4xx/5xx, or answering 200 with an HTML page instead of an image. */
function brokenImage(c: CheckContext): RawFinding[] {
  if (!tableExists(c, 'image_assets')) return [];
  const users = usersLookup(c);
  return rows(c, `SELECT url, status, content_type ct, used_on usedOn FROM image_assets
      WHERE (status >= 400 AND status <= 599 AND status NOT IN (429, 503))
         OR (status >= 200 AND status < 300 AND (LOWER(content_type) LIKE 'text/html%' OR LOWER(content_type) LIKE 'application/xhtml%'))`)
    .map(r => { const u = users(r.url); return { u, r }; })
    .sort((a, b) => (b.u.pages || b.r.usedOn || 0) - (a.u.pages || a.r.usedOn || 0) || a.r.url.localeCompare(b.r.url))
    .map(({ u, r }) => ({ urlKey: u.topPage, evidence: {
      image: r.url, status: r.status, contentType: r.ct || null, kind: isBrokenStatus(r.status) ? 'http-error' : 'not-an-image',
      pagesUsingIt: u.pages || r.usedOn, samplePages: u.sample,
      note: isBrokenStatus(r.status) ? `the image answers ${r.status}` : 'the image URL answers 200 with an HTML page (often a redirect to the homepage or a soft 404), so nothing renders',
    } }));
}

// ── image-oversized / image-legacy-format ────────────────────────────────────────────────────
/** Same line as the dashboard's crawl-health "over 300 KB" bucket (dashboardData over300kb). Bytes = Content-Length. */
export const IMAGE_OVERSIZED_BYTES = 300_000;
/**
 * Lighthouse's "Serve images in modern formats" ignores savings under 8 KiB, and Google's WebP study
 * puts WebP at 25-34% smaller than JPEG at equal quality. At the low end (25%) an 8 KiB saving needs
 * a source of at least 32 KiB, so smaller legacy images are not reported. Above IMAGE_OVERSIZED_BYTES
 * the image is image-oversized's (one finding per image).
 */
export const LEGACY_MIN_BYTES = 32 * 1024;
const LEGACY_TYPES = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/gif', 'image/bmp'];
const MODERN_TYPES = ['image/webp', 'image/avif'];
const ctList = (a: string[]): string => a.map(t => `'${t}'`).join(',');

function imageOversized(c: CheckContext): RawFinding[] {
  if (!tableExists(c, 'image_assets')) return [];
  const users = usersLookup(c);
  return rows(c, `SELECT url, bytes, content_type ct, used_on usedOn FROM image_assets
      WHERE ${BROWSER_PROBED} AND status >= 200 AND status < 300 AND bytes > ? AND LOWER(content_type) LIKE 'image/%' ORDER BY bytes * COALESCE(used_on, 1) DESC, url`, IMAGE_OVERSIZED_BYTES)
    .map(r => { const u = users(r.url); return { urlKey: u.topPage, evidence: {
      image: r.url, bytes: r.bytes, kb: Math.round(r.bytes / 1024), contentType: r.ct, threshold: IMAGE_OVERSIZED_BYTES,
      legacyFormat: LEGACY_TYPES.includes(String(r.ct).toLowerCase()), pagesUsingIt: u.pages || r.usedOn, samplePages: u.sample,
    } }; });
}

function imageLegacyFormat(c: CheckContext): RawFinding[] {
  if (!tableExists(c, 'image_assets')) return [];
  const users = usersLookup(c);
  const modern = count(c, 'image_assets', `${BROWSER_PROBED} AND status >= 200 AND status < 300 AND LOWER(content_type) IN (${ctList(MODERN_TYPES)})`);
  return rows(c, `SELECT url, bytes, content_type ct, used_on usedOn FROM image_assets
      WHERE ${BROWSER_PROBED} AND status >= 200 AND status < 300 AND LOWER(content_type) IN (${ctList(LEGACY_TYPES)}) AND bytes >= ? AND bytes <= ?
      ORDER BY bytes * COALESCE(used_on, 1) DESC, url`, LEGACY_MIN_BYTES, IMAGE_OVERSIZED_BYTES)
    .map(r => { const u = users(r.url); return { urlKey: u.topPage, evidence: {
      image: r.url, bytes: r.bytes, kb: Math.round(r.bytes / 1024), contentType: r.ct, minBytes: LEGACY_MIN_BYTES,
      siteServesWebpOrAvif: modern > 0, pagesUsingIt: u.pages || r.usedOn, samplePages: u.sample,
    } }; });
}

// ── static-asset-uncached ────────────────────────────────────────────────────────────────────
/** Below one day a visitor returning tomorrow downloads the file again. */
export const MIN_CACHE_SECONDS = 86_400;

/** Browser cache lifetime from a Cache-Control value: null header → 'none'; no-store/no-cache → 0; else max-age (s-maxage is for shared caches only). */
export function cacheLifetime(cc: string | null | undefined): { seconds: number | null; why: string } {
  if (cc == null || !cc.trim()) return { seconds: null, why: 'no Cache-Control header' };
  const v = cc.toLowerCase();
  if (/(^|,)\s*no-store\b/.test(v)) return { seconds: 0, why: 'no-store' };
  if (/(^|,)\s*no-cache\b/.test(v)) return { seconds: 0, why: 'no-cache (revalidated on every use)' };
  const m = v.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)/);
  if (!m) return { seconds: null, why: 'Cache-Control has no max-age' };
  const s = Number(m[1]);
  return { seconds: s, why: `max-age=${s}` };
}

/**
 * First-party CSS/JS/font files (page_resources.party='first': the site's host or a subdomain of it)
 * answering 2xx whose Cache-Control gives browsers less than a day. Third-party files are left out:
 * their headers are not the site's to change. The Expires header is not recorded, so a file cached
 * only by Expires reads as "no Cache-Control"; Cache-Control wins wherever both are sent.
 */
function staticAssetUncached(c: CheckContext): RawFinding[] {
  if (!tableExists(c, 'resource_assets') || count(c, 'page_resources') === 0) return [];
  const users = usersLookup(c);
  const out: RawFinding[] = [];
  for (const r of rows(c, `SELECT a.url, a.type, a.status, a.cache_control cc, a.used_on usedOn, a.checked_at checkedAt FROM resource_assets a
      WHERE a.type IN ('css','js','font') AND a.status >= 200 AND a.status < 300
        AND EXISTS (SELECT 1 FROM page_resources r WHERE r.resource_url = a.url AND r.party = 'first')
      ORDER BY a.used_on DESC, a.url`)) {
    const life = cacheLifetime(r.cc);
    if (life.seconds != null && life.seconds >= MIN_CACHE_SECONDS) continue;
    const u = users(r.url);
    out.push({ urlKey: u.topPage, evidence: {
      asset: r.url, type: r.type, cacheControl: r.cc ?? null, browserCacheSeconds: life.seconds, why: life.why, minSeconds: MIN_CACHE_SECONDS,
      pagesLoadingIt: u.pages || r.usedOn, samplePages: u.sample, checkedAt: r.checkedAt,
    } });
  }
  return out;
}

// ── render-blocking-head-resources ───────────────────────────────────────────────────────────
/** Every parser-blocking <script src> in <head> delays first render, and async/defer/type=module removes it (Lighthouse lists each one). */
export const SYNC_HEAD_SCRIPTS_MIN = 1;
/**
 * Our threshold, not Google's: a styled page needs its own stylesheet, and a font or plugin sheet
 * beside it is the usual floor, so 1-2 render-blocking stylesheets are not reported; 3 or more are.
 */
export const BLOCKING_STYLESHEETS_MIN = 3;
/** A stylesheet media value that still applies to the screen, so the sheet blocks render. Any other media query (print, a breakpoint) is not counted. */
const BLOCKING_MEDIA = `(media IS NULL OR TRIM(LOWER(media)) IN ('', 'all', 'screen', 'only screen'))`;
const SYNC_SCRIPT = `(type = 'js' AND position = 'head' AND COALESCE(is_async,0) = 0 AND COALESCE(is_defer,0) = 0 AND COALESCE(is_module,0) = 0 AND COALESCE(is_preload,0) = 0)`;
const BLOCKING_CSS = `(type = 'css' AND position = 'head' AND COALESCE(is_preload,0) = 0 AND ${BLOCKING_MEDIA})`;

/**
 * Per 200 HTML page, from page_resources: parser-blocking head scripts (no async/defer/module, not a
 * preload hint) and render-blocking head stylesheets (not a preload hint, media absent/all/screen).
 * Pages over either threshold are rolled up by their exact set of blocking files (one template = one
 * finding), keyed to the set's page with the most GSC clicks over the last 28 finalised days.
 */
function renderBlockingHeadResources(c: CheckContext): RawFinding[] {
  if (count(c, 'page_resources') === 0) return [];
  const per = new Map<string, { scripts: string[]; css: string[] }>();
  for (const r of rows(c, `SELECT r.page_key k, r.resource_url u, CASE WHEN ${SYNC_SCRIPT} THEN 'js' ELSE 'css' END kind
      FROM page_resources r JOIN pages p ON p.url_key = r.page_key
      WHERE p.status_code = 200 AND ${HTML_CT.replace(/content_type/g, 'p.content_type')} AND (${SYNC_SCRIPT} OR ${BLOCKING_CSS})
      ORDER BY r.id`)) {
    const e = per.get(r.k) ?? per.set(r.k, { scripts: [], css: [] }).get(r.k)!;
    (r.kind === 'js' ? e.scripts : e.css).push(r.u);
  }
  const clicks = new Map<string, number>();
  if (c.gscMaxDate) for (const r of rows(c, `SELECT page_key k, SUM(clicks) n FROM ${pageRowsFor(c.db, c.gscMaxDate, 28).table} WHERE date <= ? AND date > date(?, '-28 days') AND page_key IS NOT NULL GROUP BY page_key`, c.gscMaxDate, c.gscMaxDate)) clicks.set(r.k, r.n ?? 0);
  const groups = new Map<string, { scripts: string[]; css: string[]; pages: string[] }>();
  for (const [k, e] of per) {
    if (e.scripts.length < SYNC_HEAD_SCRIPTS_MIN && e.css.length < BLOCKING_STYLESHEETS_MIN) continue;
    const sig = JSON.stringify([[...e.scripts].sort(), [...e.css].sort()]);
    (groups.get(sig) ?? groups.set(sig, { scripts: e.scripts, css: e.css, pages: [] }).get(sig)!).pages.push(k);
  }
  return [...groups.values()]
    .map(g => ({ ...g, pages: g.pages.sort((a, b) => (clicks.get(b) ?? 0) - (clicks.get(a) ?? 0) || a.localeCompare(b)) }))
    .sort((a, b) => b.pages.length - a.pages.length || a.pages[0].localeCompare(b.pages[0]))
    .map(g => ({ urlKey: g.pages[0], evidence: {
      pages: g.pages.length, samplePages: g.pages.slice(0, 10),
      syncHeadScripts: g.scripts, syncHeadScriptCount: g.scripts.length,
      blockingStylesheets: g.css, blockingStylesheetCount: g.css.length,
      thresholds: { syncHeadScripts: SYNC_HEAD_SCRIPTS_MIN, blockingStylesheets: BLOCKING_STYLESHEETS_MIN },
      note: 'pages sharing exactly this set of blocking files (usually one template); inline <script>/<style> are not counted',
    } }));
}

export const ASSET_CHECKS: CheckDef[] = [
  {
    id: 'broken-subresource', category: 'crawlability', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'CSS, JavaScript or font file returns an error',
    fix: 'A stylesheet, script or font that pages load answers 4xx/5xx, so the page renders without it, for visitors and for Googlebot\'s renderer. Restore the file or update the reference (usually a deploy that renamed a hashed bundle, or a removed plugin). Each finding is one file with the pages that load it. Needs a crawl with headResources:true (resource_assets); images are reported by broken-image.',
    run: brokenSubresource, collected: resourceAssetsNote,
  },
  {
    id: 'render-blocking-head-resources', category: 'performance', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global', stakeShare: PAGE_EXPERIENCE_STAKE_SHARE,
    title: 'Render-blocking scripts or stylesheets in <head>',
    fix: `Pages load ${SYNC_HEAD_SCRIPTS_MIN}+ parser-blocking script in <head> (no async, defer or type=module), or ${BLOCKING_STYLESHEETS_MIN}+ render-blocking stylesheets (no media query that excludes the screen). Each one delays first paint and LCP. Add defer (or async for independent scripts) to head scripts; inline the critical CSS and load the rest without blocking, or merge sheets. Findings are rolled up per set of blocking files (one per template). The stylesheet threshold is ours: 1-2 sheets are the normal floor. Reads page_resources (every crawl since 0.15.0).`,
    run: renderBlockingHeadResources, collected: pageResourcesNote,
  },
  {
    id: 'static-asset-uncached', category: 'performance', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global', stakeShare: PAGE_EXPERIENCE_STAKE_SHARE,
    title: 'Static file cached for less than a day',
    fix: `A first-party CSS, JavaScript or font file has no Cache-Control, no max-age, no-store/no-cache, or a max-age under ${MIN_CACHE_SECONDS} s (one day), so returning visitors download it again. Serve versioned (hashed) static files with a long max-age (a year, plus immutable) at the server or CDN. Third-party files are not reported (not yours to change); the Expires header isn't recorded, so a file cached only by Expires reads as uncached. Needs a crawl with headResources:true (resource_assets).`,
    run: staticAssetUncached, collected: resourceAssetsNote,
  },
  {
    id: 'image-oversized', category: 'performance', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page', stakeShare: PAGE_EXPERIENCE_STAKE_SHARE,
    title: 'Image over 300 KB',
    fix: `An <img> on the site weighs more than ${IMAGE_OVERSIZED_BYTES.toLocaleString('en-GB')} bytes (Content-Length), which slows LCP on the pages using it. Resize it to the largest size it is displayed at, compress it, serve WebP/AVIF, and use srcset for smaller screens. Sizes come from a header-only probe of the 500 most-used images after each crawl (image_assets), sent with a browser's image Accept header so a CDN that negotiates WebP/AVIF is measured as browsers see it; images sampled by older crawls (no Accept recorded) are not judged until a re-crawl.`,
    run: imageOversized, collected: imageWeightNote,
  },
  {
    id: 'image-legacy-format', category: 'performance', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global', stakeShare: PAGE_EXPERIENCE_STAKE_SHARE,
    title: 'JPEG/PNG image where WebP or AVIF would be smaller',
    fix: `An <img> of ${LEGACY_MIN_BYTES / 1024} KiB to 300 KB is served as JPEG, PNG, GIF or BMP. WebP is 25-34% smaller than JPEG at equal quality (Google's WebP study), so each saves at least the 8 KiB Lighthouse counts. Convert at build time or turn on format negotiation at the CDN. The probe sends a browser's image Accept header, so a CDN that already negotiates WebP/AVIF is not reported; images sampled by older crawls (no Accept recorded) are not judged until a re-crawl. Images over 300 KB are reported by image-oversized.`,
    run: imageLegacyFormat, collected: imageWeightNote,
  },
  {
    id: 'broken-image', category: 'onpage', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page', stakeShare: PAGE_EXPERIENCE_STAKE_SHARE,
    title: 'Image returns an error or an HTML page',
    fix: 'An <img> src answers 4xx/5xx, or answers 200 with an HTML page (a redirect to the homepage, a soft 404), so the image is missing for visitors and for Google Images. Fix the src or restore the file. Each finding is one image with the pages using it. Reads image_assets (the 500 most-used images, sampled after each crawl); a failed or rate-limited probe is unknown, not broken.',
    run: brokenImage, collected: imageAssetsNote,
  },
];
