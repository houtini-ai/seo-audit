import * as cheerio from 'cheerio';
import { urlKey, type UrlKeyOptions } from './url-key.js';

/** Collapse runs of whitespace to a single space and trim — a browser renders a multi-line
 * `<title>` / meta / heading that way, so a stored value with an embedded newline (" ...\n – x")
 * over-counts its length and reads wrong in reports. Apply to every short SEO text field. */
export const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Decode an HTML response body to a string ONCE, honouring the charset in this order:
 *   1. the Content-Type response header (`charset=…`),
 *   2. a `<meta charset>` / `<meta http-equiv="Content-Type">` declaration in the first bytes,
 *   3. UTF-8 (the HTML5 default).
 * Reading UTF-8 bytes as Latin-1 (or guessing then re-decoding) is the classic source of
 * mojibake — "–" (E2 80 93) surfacing as "â\x80\x93". Decoding once from the declared charset
 * avoids both the wrong-charset read and the double decode. An unknown/invalid label falls back
 * to UTF-8 rather than throwing.
 */
export function decodeHtmlBody(buf: Buffer, contentTypeHeader?: string | null): string {
  let label = contentTypeHeader?.match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  if (!label) {
    // Sniff the first 2KB as Latin-1 (every byte maps 1:1, so the ASCII meta tag survives intact)
    // for a declared charset — HTML5 requires the declaration within the first 1024 bytes.
    const head = buf.subarray(0, 2048).toString('latin1');
    label = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
      ?? head.match(/<meta[^>]+http-equiv=["']?content-type["'][^>]*;\s*charset=([\w-]+)/i)?.[1])?.toLowerCase();
  }
  try {
    return new TextDecoder(label || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf); // unknown/invalid label → safe default
  }
}

/**
 * Internal = the seed host or its www/apex twin ONLY — not arbitrary sibling subdomains.
 * accounts./shop./blog. etc. are separate properties; crawling (or following redirects into)
 * them pulls in junk like Shopify's accounts.<domain> OAuth login pages. Shared by the
 * link-classifier here and the crawler's redirect-target guard.
 */
export const isInternalHost = (targetHost: string, baseHost: string): boolean => {
  const apex = (h: string): string => (h.startsWith('www.') ? h.slice(4) : h);
  const a = apex(baseHost.toLowerCase());
  const t = targetHost.toLowerCase();
  return t === a || t === `www.${a}`;
};

export interface ExtractedLink {
  targetUrl: string;
  targetKey: string;
  anchor: string;
  placement: 'navigation' | 'footer' | 'body';
  rel: string;
  isInternal: boolean;
  /** How the href was WRITTEN, before resolution (#26): absolute | protocol-relative | root-relative | relative. */
  hrefForm: HrefForm;
}

/** A subresource the page loads (#37): recorded from the HTML parse, never downloaded. */
export interface ExtractedResource {
  url: string;
  type: 'css' | 'js' | 'font' | 'img' | 'other';
  party: 'first' | 'third';      // first = the site's host or any subdomain of it (e.g. cdn.example.com)
  position: 'head' | 'body';
  async: boolean;
  defer: boolean;
  preload: boolean;              // <link rel=preload|modulepreload>
  module: boolean;               // <script type=module> / modulepreload
  crossorigin: string | null;
  media: string | null;          // stylesheet media (print-only CSS isn't render-blocking)
}

export type HrefForm = 'absolute' | 'protocol-relative' | 'root-relative' | 'relative';

/** Classify a raw href by how it is written. Pure string test, no resolution. */
export function hrefFormOf(raw: string): HrefForm {
  const h = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return 'absolute';
  if (h.startsWith('//')) return 'protocol-relative';
  if (h.startsWith('/')) return 'root-relative';
  return 'relative';
}

export interface ExtractedPage {
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  /** NULL when there is no <meta name="description"> at all; 0 when the tag is present but empty (#24). */
  metaDescriptionLength: number | null;
  h1: string | null;
  h1Count: number;
  wordCount: number;
  lang: string | null;
  charset: string | null;
  canonicalUrl: string | null;
  canonicalKey: string | null;
  robots: string | null;
  viewport: string | null;
  noindex: boolean;
  jsonLd: string | null; // JSON array string of raw blocks
  ogTags: string | null;
  hreflang: string | null;
  internalLinks: number;
  externalLinks: number;
  imageCount: number;
  imagesWithoutAlt: number;        // <img> with NO alt attribute
  imagesEmptyAlt: number;          // <img alt=""> (correct for decorative images, often wrong for content images) (#21)
  imagesEmptyAltContent: number;   // the subset of imagesEmptyAlt inside <main>/<article>/<figure>, outside nav/header/footer
  imagesMissingDimensions: number; // <img> lacking both width & height (CLS)
  canonicalCount: number;
  canonicalRelative: boolean;
  h2Count: number;
  headingSkips: number;            // skipped heading levels (e.g. h1→h3) in document order
  relNext: boolean;
  relPrev: boolean;
  relAmphtml: string | null;
  mixedContentCount: number;       // http subresources on an https page
  twitterTags: string | null;      // JSON of twitter:* meta
  hasMicrodata: boolean;
  hasRdfa: boolean;
  hasFavicon: boolean;             // any <link rel*=icon> declared
  hasAnalytics: boolean;           // a client-side analytics/tag-manager snippet detected
  // Accessibility (static subset — the axe-core rules decidable from raw HTML, no render needed).
  a11yLinksNoName: number;         // <a href> with no discernible accessible name (axe link-name)
  a11yButtonsNoName: number;       // button / [role=button] / submit|button input with no accessible name (axe button-name)
  a11yInputsNoLabel: number;       // visible form control with no <label>/aria-label/title (axe label)
  a11yViewportZoomDisabled: boolean; // <meta viewport> blocks pinch-zoom: user-scalable=no / maximum-scale<2 (axe meta-viewport)
  a11yPositiveTabindex: number;    // elements with tabindex>0 — breaks the natural focus order (axe tabindex)
  a11yDuplicateIds: number;        // id values used more than once in the document (axe duplicate-id)
  /** 0.16.1: WHICH elements failed (signature -> occurrences, up to A11Y_SAMPLE_MAX each), so the audit
   * can roll a theme's shared nameless links/buttons up into one finding per template. */
  a11ySamples: A11ySamples;
  /** Navigation Google can't follow (#79): internal targets reached only by script, or null when none. */
  nonCrawlableLinks: { total: number; items: NonCrawlableLink[] } | null;
  /** data-nosnippet coverage (#79), or null when the page has none on span/div/section. */
  nosnippet: NosnippetSummary | null;
  bodyChunks: { heading: string; level: number; text: string }[]; // content segmented by heading (RAG layer)
  links: ExtractedLink[];
  imageSrcs: string[];             // distinct absolute <img> src URLs (capped) — image-weight sampling
  resources: ExtractedResource[];  // subresources the page loads (css/js/fonts/images), capped at 200 (#37)
}

/** A <header> that belongs to the site chrome. One inside <article> or <main> is the content's own
 * header (title, standfirst, byline links), so it is not navigation. */
const isSiteHeader = ($: cheerio.CheerioAPI, h: any): boolean => $(h).parents('article, main').length === 0;

function placementOf($: cheerio.CheerioAPI, el: any): 'navigation' | 'footer' | 'body' {
  const $el = $(el);
  if ($el.closest('nav').length) return 'navigation';
  const header = $el.closest('header');
  if (header.length && isSiteHeader($, header[0])) return 'navigation';
  if ($el.closest('footer').length) return 'footer';
  return 'body';
}

/**
 * Extract the SEO-relevant surface from raw HTML. Pure function of bytes (D).
 * `baseHost` is the seed apex host for internal/external classification;
 * `keyOpts` is the url-key normalisation config for this property.
 */
/** Signatures of the elements behind the a11y counts: `a.icon[href="/cart"]`, `button.menu-toggle`, `#main`. */
export interface A11ySamples { links: Record<string, number>; buttons: Record<string, number>; dupIds: Record<string, number> }
export const A11Y_SAMPLE_MAX = 25;

/** A link Google can't follow: the kind of construct, a template-stable selector, the internal target it names. */
export interface NonCrawlableLink {
  kind: 'javascript-href' | 'placeholder-href' | 'no-href' | 'non-link-element';
  selector: string;
  target: string;
  placement: 'navigation' | 'footer' | 'body';
}
/** Share of the page's text an element holding an <article>/<h1> must carry to count as wrapping the main content. */
const NOSNIPPET_WRAP_SHARE = 0.25;
/** Items kept per page; `total` always carries the full count. */
export const NON_CRAWLABLE_MAX = 25;
export interface NosnippetSummary {
  /** Outermost span/div/section elements carrying data-nosnippet. */
  elements: number;
  /** Share of the visible body text inside them (0-1). */
  textShare: number;
  /** One of them contains <main>, <article> or the <h1>. */
  wrapsMain: boolean;
  /** Selector of the element holding the most text. */
  largest: string | null;
  /** data-nosnippet on other tags (main, article, p...), which Google ignores. */
  ignoredOn: number;
}
const SIG_MAX = 120;

export function extractPage(
  html: string,
  pageUrl: string,
  baseHost: string,
  keyOpts: UrlKeyOptions,
  xRobotsTag?: string | null,
): ExtractedPage {
  const $ = cheerio.load(html);

  // Browsers and Googlebot resolve relative URLs against the first <base href> (itself resolved
  // against the page URL), not the page URL. Ignoring it turns a site that pairs a root
  // <base href> with relative nav hrefs into thousands of phantom nested 404s. Browsers ignore a
  // data: or javascript: base, and no other non-http(s) base yields a crawlable target, so those
  // fall back to the page URL.
  const docBase = (() => {
    const baseHref = $('base[href]').first().attr('href')?.trim();
    if (!baseHref) return pageUrl;
    try {
      const u = new URL(baseHref, pageUrl);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : pageUrl;
    } catch { return pageUrl; }
  })();

  // Whitespace-normalise short text fields: a multi-line <title>/heading in the source otherwise
  // stores embedded newlines that over-count length and render as stray gaps in reports.
  const title = collapseWs($('head > title').first().text()) || null;
  const metaDescription = (() => { const c = $('meta[name="description"]').attr('content'); return c != null ? collapseWs(c) || null : null; })();
  const h1Els = $('h1');
  const h1 = collapseWs(h1Els.first().text()) || null;
  const lang = $('html').attr('lang')?.trim() ?? null;
  const charset = $('meta[charset]').attr('charset')?.trim()
    ?? ($('meta[http-equiv="Content-Type"]').attr('content')?.match(/charset=([\w-]+)/i)?.[1] ?? null);
  const canonicalEls = $('link[rel="canonical"]');
  const canonicalRaw = canonicalEls.first().attr('href')?.trim() ?? null;
  // A malformed canonical href (e.g. `href="http://"`) must not make the whole page
  // extraction throw — that would record a fine 200 page as a fetch failure.
  const canonicalUrl = canonicalRaw ? (() => { try { return new URL(canonicalRaw, docBase).toString(); } catch { return null; } })() : null;
  const canonicalRelative = canonicalRaw != null && !/^https?:\/\//i.test(canonicalRaw);
  const robots = $('meta[name="robots"]').attr('content')?.trim() ?? null;
  const viewport = $('meta[name="viewport"]').attr('content')?.trim() ?? null;
  const noindex = /noindex/i.test(robots ?? '') || /noindex/i.test(xRobotsTag ?? '');

  // word count excluding script/style/noscript/template (fixes inline-script inflation)
  const $body = cheerio.load(html);
  $body('script, style, noscript, template').remove();
  const bodyText = collapseWs($body('body').text());
  const wordCount = bodyText ? bodyText.split(' ').length : 0;

  // Body chunks: visible content segmented by heading, boilerplate stripped — the data layer for the
  // content-cluster checks (phrase gaps, RAG alignment, extractability). Depth-first reading-order
  // walk: a heading starts a new chunk; other text accrues to the current one. No DOM mutation.
  const bodyChunks: { heading: string; level: number; text: string }[] = [];
  {
    const $c = cheerio.load(html);
    $c('script, style, noscript, template, nav, footer, aside').remove();
    // Site headers go; an article's own <header> (its H1, standfirst, byline) stays in the content.
    $c('header').filter((_, h) => isSiteHeader($c, h)).remove();
    const root = ($c('main').first()[0] ?? $c('article').first()[0] ?? $c('body')[0]) as any;
    const ws = collapseWs; // local alias — the whitespace rule lives once, in collapseWs
    let cur: { heading: string; level: number; parts: string[] } = { heading: '', level: 0, parts: [] };
    const flush = (): void => {
      const text = ws(cur.parts.join(' '));
      if (cur.heading || text) bodyChunks.push({ heading: cur.heading, level: cur.level, text: text.slice(0, 1500) });
    };
    const walk = (node: any): void => {
      for (const child of node.children ?? []) {
        if (child.type === 'tag') {
          if (/^h[1-6]$/.test(child.name)) {
            flush();
            cur = { heading: ws($c(child).text()), level: Number(child.name[1]), parts: [] };
          } else {
            walk(child);
          }
        } else if (child.type === 'text' && child.data && child.data.trim()) {
          cur.parts.push(child.data);
        }
      }
    };
    if (root) { walk(root); flush(); }
    const kept = bodyChunks.filter(c => c.heading || c.text.length > 20).slice(0, 40);
    bodyChunks.length = 0;
    bodyChunks.push(...kept);
  }

  const jsonLdBlocks: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const t = $(el).contents().text().trim();
    if (t) jsonLdBlocks.push(t);
  });

  // URL-valued social tags are resolved against the document base like links (#12), so a
  // relative og:image on a <base href> site doesn't point under the current path.
  const absOrRaw = (v: string): string => { try { const u = new URL(v, docBase); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : v; } catch { return v; } };
  const URL_OG = /^og:(url|image|image:url|image:secure_url|video|video:url|video:secure_url|audio|audio:url|audio:secure_url)$/;
  const og: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const p = $(el).attr('property');
    const c = $(el).attr('content');
    if (p && c) og[p] = URL_OG.test(p) ? absOrRaw(c.trim()) : c;
  });

  const hreflang: { lang: string; href: string }[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const l = $(el).attr('hreflang');
    const href = $(el).attr('href');
    if (!l || !href) return;
    // Stored absolute because later consumers no longer have the <base href> to resolve against.
    let abs = href;
    try { abs = new URL(href, docBase).toString(); } catch { /* keep raw; consumers skip unparseable hrefs */ }
    hreflang.push({ lang: l, href: abs });
  });

  // Twitter Card tags (alongside Open Graph) — share-appearance completeness.
  const tw: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const n = $(el).attr('name');
    const c = $(el).attr('content');
    if (n && c) tw[n] = /^twitter:(image|image:src|player)$/.test(n) ? absOrRaw(c.trim()) : c;
  });

  // Heading hierarchy: levels in document order → count skipped jumps (h1→h3 etc.).
  const headingLevels: number[] = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const lvl = Number((el as { name?: string }).name?.[1]);
    if (lvl >= 1 && lvl <= 6) headingLevels.push(lvl);
  });
  let headingSkips = 0;
  for (let i = 1; i < headingLevels.length; i++) if (headingLevels[i] - headingLevels[i - 1] > 1) headingSkips++;
  const h2Count = headingLevels.filter(l => l === 2).length;

  // rel link relations Google still reads / we don't otherwise capture.
  const relNext = $('link[rel="next"]').length > 0;
  const relPrev = $('link[rel="prev"]').length > 0;
  const relAmphtmlRaw = $('link[rel="amphtml"]').attr('href')?.trim() || null;
  const relAmphtml = relAmphtmlRaw ? absOrRaw(relAmphtmlRaw) : null;

  // Mixed content: insecure (http) subresources on an https page.
  const isHttps = /^https:/i.test(pageUrl);
  let mixedContentCount = 0;
  if (isHttps) {
    $('img[src], script[src], link[rel="stylesheet"][href], iframe[src], source[src], video[src], audio[src]').each((_, el) => {
      const u = $(el).attr('src') || $(el).attr('href') || '';
      if (/^http:\/\//i.test(u)) mixedContentCount++;
    });
  }

  // Structured-data formats beyond JSON-LD (RDFa via typeof/vocab, not property — OG meta uses property).
  const hasMicrodata = $('[itemscope]').length > 0;
  const hasRdfa = $('[typeof], [vocab]').length > 0;

  // Favicon: any icon link relation (icon / shortcut icon / apple-touch-icon).
  const hasFavicon = $('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').length > 0;
  // Client-side analytics: a known snippet/host anywhere in the raw HTML. Deliberately a tight
  // allow-list of real analytics products — absence means "no CLIENT-SIDE analytics detected",
  // not "no analytics" (server-side measurement is invisible to a crawl).
  const hasAnalytics = /googletagmanager\.com|google-analytics\.com|gtag\(|plausible\.io|matomo|_paq\b|usefathom\.com|clarity\.ms|cloudflareinsights\.com|mixpanel|heap-\d|segment\.com\/analytics/i.test(html);

  // Accessibility (static subset of axe-core — only the rules decidable from raw HTML; the full
  // rule set needs the rendered DOM, which is the render tier). An element's "accessible name" here
  // = visible text OR aria-label OR aria-labelledby OR title (and, for links, an <img alt> child).
  const hasAccName = (el: any, viaImgAlt = false): boolean => {
    const $e = $(el);
    if ($e.text().replace(/\s+/g, ' ').trim()) return true;
    if (($e.attr('aria-label') ?? '').trim()) return true;
    if (($e.attr('aria-labelledby') ?? '').trim()) return true;
    if (($e.attr('title') ?? '').trim()) return true;
    if (viaImgAlt && $e.find('img[alt]').filter((_, i) => (($(i).attr('alt') ?? '').trim() !== '')).length) return true;
    return false;
  };
  // A short, template-stable selector: tag, an id without a long number (WordPress post-123 ids differ
  // per page), the first two classes. With the link's href shape it identifies the same theme element
  // across pages; the audit groups pages by these to report one finding per template (0.16.1).
  const elSelector = (el: any): string => {
    const $e = $(el);
    const tag = String(el.name ?? 'el').toLowerCase();
    const id = ($e.attr('id') ?? '').trim();
    const cls = ($e.attr('class') ?? '').trim().split(/\s+/).filter(c => c && !/\d{3,}/.test(c)).slice(0, 2);
    const role = ($e.attr('role') ?? '').trim();
    const type = tag === 'input' ? ($e.attr('type') ?? '').trim() : '';
    return `${tag}${id && !/\d{3,}/.test(id) ? `#${id}` : ''}${cls.map(c => `.${c}`).join('')}${role ? `[role=${role}]` : ''}${type ? `[type=${type}]` : ''}`;
  };
  // The href's shape, not its exact value: a share link's ?u=<this page> differs on every page.
  const pageNoHash = pageUrl.split('#')[0];
  const hrefShape = (href: string): string => {
    const h = href.trim();
    if (!h || h === '#') return '#';
    if (h.startsWith('#')) return '#fragment';
    try {
      const u = new URL(h, docBase);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol;
      if (u.href.split('#')[0] === pageNoHash) return '(this page)';
      return u.hostname === new URL(pageUrl).hostname ? (u.pathname || '/') : `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`;
    } catch { return h.slice(0, 60); }
  };
  const a11ySamples: A11ySamples = { links: {}, buttons: {}, dupIds: {} };
  const sample = (m: Record<string, number>, sig: string): void => {
    const s = sig.length > SIG_MAX ? `${sig.slice(0, SIG_MAX - 1)}…` : sig;
    if (s in m) m[s]++;
    else if (Object.keys(m).length < A11Y_SAMPLE_MAX) m[s] = 1;
  };
  let a11yLinksNoName = 0;
  $('a[href]').each((_, el) => {
    if (hasAccName(el, true)) return;
    a11yLinksNoName++;
    sample(a11ySamples.links, `${elSelector(el)}[href="${hrefShape($(el).attr('href') ?? '')}"]`);
  });
  let a11yButtonsNoName = 0;
  // submit/reset inputs self-name via a UA default, so axe doesn't flag them — only type=button does.
  $('button, [role="button"], input[type="button"]').each((_, el) => {
    const $e = $(el);
    if ((el as { name?: string }).name === 'input') {
      if (!(($e.attr('value') ?? '').trim() || ($e.attr('aria-label') ?? '').trim() || ($e.attr('title') ?? '').trim())) { a11yButtonsNoName++; sample(a11ySamples.buttons, elSelector(el)); }
      return;
    }
    if (!hasAccName(el, true)) { a11yButtonsNoName++; sample(a11ySamples.buttons, elSelector(el)); }
  });
  let a11yInputsNoLabel = 0;
  // Precompute the set of label[for] targets — a per-input `label[for="<id>"]` selector would throw
  // from css-select on an id with selector-significant characters and abort the whole extraction.
  const labelFors = new Set<string>();
  $('label[for]').each((_, l) => { const f = ($(l).attr('for') ?? '').trim(); if (f) labelFors.add(f); });
  $('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea').each((_, el) => {
    const $e = $(el);
    if (($e.attr('aria-label') ?? '').trim() || ($e.attr('aria-labelledby') ?? '').trim() || ($e.attr('title') ?? '').trim()) return;
    if ($e.closest('label').length) return;                                   // wrapped in a <label>
    const id = ($e.attr('id') ?? '').trim();
    if (id && labelFors.has(id)) return;                                      // referenced by a <label for>
    a11yInputsNoLabel++;
  });
  // Viewport that blocks pinch-zoom (user-scalable=no, or maximum-scale<2) — axe meta-viewport.
  const vpContent = (viewport ?? '').toLowerCase();
  const vpMaxScale = Number(vpContent.match(/maximum-scale\s*=\s*([0-9.]+)/)?.[1]);
  const a11yViewportZoomDisabled = /user-scalable\s*=\s*(no|0)/.test(vpContent) || (Number.isFinite(vpMaxScale) && vpMaxScale < 2);
  const a11yPositiveTabindex = $('[tabindex]').filter((_, el) => (Number($(el).attr('tabindex')) || 0) > 0).length;
  const idCounts = new Map<string, number>();
  $('[id]').each((_, el) => { const id = ($(el).attr('id') ?? '').trim(); if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1); });
  let a11yDuplicateIds = 0;
  for (const [id, n] of idCounts) if (n > 1) { a11yDuplicateIds++; sample(a11ySamples.dupIds, `#${id}`); if (`#${id}` in a11ySamples.dupIds) a11ySamples.dupIds[`#${id}`] = n; }

  // Non-crawlable navigation (#79): Google follows only <a> elements with a resolvable href. Counted
  // only when a navigation TARGET is evident (a URL in onclick / data-href / routerLink, or a
  // javascript: href that names one) and that target is on this site: a "#" button opening a modal,
  // or a share widget whose data-href is the page itself, is not navigation and isn't counted.
  const nonCrawlableItems: NonCrawlableLink[] = [];
  let nonCrawlableTotal = 0;
  const URL_IN_JS = /(?:location(?:\.href)?|window\.open|navigate(?:ByUrl)?|router\.push|href)\s*(?:=|\()\s*['"`]([^'"`\s]+)['"`]/i;
  const internalTarget = (raw: string | undefined | null): string | null => {
    if (!raw || !raw.trim()) return null;
    try {
      const u = new URL(raw.trim(), docBase);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (!isInternalHost(u.hostname, baseHost) || sameKey(u.href, pageUrl)) return null;
      return u.toString();
    } catch { return null; }
  };
  // Compared as url_keys: https://example.com/post/ and https://www.example.com/post are one page.
  const sameKey = (a: string, b: string): boolean => { try { return urlKey(a, keyOpts) === urlKey(b, keyOpts); } catch { return false; } };
  // A clickable wrapper (<li onclick>) around a real <a href> to the same place is fine: Google follows the link.
  const wrapsRealLink = (el: any, target: string): boolean =>
    $(el).find('a[href]').toArray().some(a => { try { return sameKey(new URL(($(a).attr('href') ?? '').trim(), docBase).toString(), target); } catch { return false; } });
  const recordNc = (el: any, kind: NonCrawlableLink['kind'], target: string): void => {
    nonCrawlableTotal++;
    if (nonCrawlableItems.length < NON_CRAWLABLE_MAX) nonCrawlableItems.push({ kind, selector: elSelector(el).slice(0, SIG_MAX), target, placement: placementOf($, el) });
  };
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const onclick = $(el).attr('onclick') ?? '';
    if (/^javascript:/i.test(href)) {
      const t = internalTarget(href.match(URL_IN_JS)?.[1] ?? onclick.match(URL_IN_JS)?.[1]);
      if (t) recordNc(el, 'javascript-href', t);
    } else if (href === '#' || href === '') {
      const t = internalTarget(onclick.match(URL_IN_JS)?.[1] ?? $(el).attr('data-href'));
      if (t) recordNc(el, 'placeholder-href', t);
    }
  });
  $('a:not([href])').each((_, el) => {
    const $e = $(el);
    const t = internalTarget($e.attr('routerlink') ?? $e.attr('ng-href') ?? $e.attr('data-href') ?? $e.attr('onclick')?.match(URL_IN_JS)?.[1]);
    if (t) recordNc(el, 'no-href', t);
  });
  $('[onclick], [data-href], [routerlink]').not('a').each((_, el) => {
    const $e = $(el);
    const t = internalTarget($e.attr('routerlink') ?? $e.attr('data-href') ?? $e.attr('onclick')?.match(URL_IN_JS)?.[1]);
    if (t && !wrapsRealLink(el, t)) recordNc(el, 'non-link-element', t);
  });

  // data-nosnippet (#79): Google honours it on span, div and section only. Measure how much of the
  // visible body text sits inside the outermost such elements, and whether one wraps the main
  // content (contains <main>, <article> or the <h1>): then the page's own text can't be shown in a
  // snippet. On other tags the attribute is ignored, which is counted separately.
  const NS_TAGS = 'span[data-nosnippet], div[data-nosnippet], section[data-nosnippet]';
  const nsOuter = $body(NS_TAGS).filter((_, el) => $body(el).parents(NS_TAGS).length === 0);
  let nosnippet: NosnippetSummary | null = null;
  if (nsOuter.length) {
    let chars = 0, wrapsMain = false, biggest = { chars: -1, el: null as any };
    nsOuter.each((_, el) => {
      const c = collapseWs($body(el).text()).length;
      chars += c;
      // Containing <main> is enough. An <article> or <h1> inside only counts when the element also
      // holds a real share of the text: a related-posts block of <article> cards, or a branding div
      // holding the site-title <h1>, is not the main content.
      if ($body(el).find('main').length || ($body(el).find('article, h1').length && bodyText.length > 0 && c / bodyText.length >= NOSNIPPET_WRAP_SHARE)) wrapsMain = true;
      if (c > biggest.chars) biggest = { chars: c, el };
    });
    nosnippet = {
      elements: nsOuter.length,
      textShare: bodyText.length ? Math.min(1, Math.round((chars / bodyText.length) * 100) / 100) : 0,
      wrapsMain,
      largest: biggest.el ? elSelector(biggest.el).slice(0, SIG_MAX) : null,
      ignoredOn: $('[data-nosnippet]').not('span, div, section').length,
    };
  }

  // Images: count those lacking a non-empty alt (decorative alt="" is intentional, not flagged),
  // and those lacking both width & height attributes (a deterministic CLS signal).
  const imgEls = $('img');
  let imagesWithoutAlt = 0;
  let imagesEmptyAlt = 0;
  let imagesEmptyAltContent = 0;
  let imagesMissingDimensions = 0;
  // Distinct absolute image URLs, capped per page — the crawler samples their content-length
  // after the crawl for the image-weight report (CDN-hosted images count; SEO cares about
  // what the page loads, not where it's hosted).
  const imageSrcSet = new Set<string>();
  imgEls.each((_, el) => {
    const $e = $(el);
    const alt = $e.attr('alt');
    if (alt === undefined) imagesWithoutAlt++;
    else if (alt.trim() === '') {
      imagesEmptyAlt++;
      if ($e.closest('main, article, figure').length && !$e.closest('nav, header, footer').length) imagesEmptyAltContent++;
    }
    if ($e.attr('width') === undefined && $e.attr('height') === undefined) imagesMissingDimensions++;
    const src = ($e.attr('src') ?? '').trim();
    if (src && !src.startsWith('data:') && imageSrcSet.size < 15) {
      try {
        const u = new URL(src, docBase);
        if (u.protocol === 'http:' || u.protocol === 'https:') imageSrcSet.add(u.toString());
      } catch { /* skip bad src */ }
    }
  });

  // ── Subresource inventory (#37): what the page loads, from the parse already happening. ──────
  const resources: ExtractedResource[] = [];
  {
    const seenRes = new Set<string>();
    const apexOf = (h: string): string => h.toLowerCase().replace(/^www\./, '');
    const siteApex = apexOf(baseHost);
    const partyOf = (u: URL): 'first' | 'third' => { const h = apexOf(u.hostname); return h === siteApex || h.endsWith(`.${siteApex}`) ? 'first' : 'third'; };
    const add = (el: any, raw: string | undefined, type: ExtractedResource['type'], extra: Partial<ExtractedResource> = {}): void => {
      if (!raw || resources.length >= 200) return;
      const v = raw.trim();
      if (!v || v.startsWith('data:') || v.startsWith('blob:')) return;
      let u: URL;
      try { u = new URL(v, docBase); } catch { return; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      const key = `${type} ${u.toString()}`;
      if (seenRes.has(key)) return;
      seenRes.add(key);
      const $e = el ? $(el) : null;
      resources.push({
        url: u.toString(), type, party: partyOf(u), position: $e && !$e.closest('head').length ? 'body' : 'head',
        async: !!$e && $e.attr('async') !== undefined, defer: !!$e && $e.attr('defer') !== undefined,
        preload: false, module: !!$e && ($e.attr('type') ?? '').toLowerCase() === 'module',
        crossorigin: $e?.attr('crossorigin') ?? null, media: $e?.attr('media')?.trim() || null, ...extra,
      });
    };
    const relHas = (el: any, r: string): boolean => (($(el).attr('rel') ?? '').toLowerCase().split(/\s+/)).includes(r);
    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (relHas(el, 'stylesheet')) add(el, href, 'css');
      else if (relHas(el, 'modulepreload')) add(el, href, 'js', { preload: true, module: true });
      else if (relHas(el, 'preload')) {
        const as = ($(el).attr('as') ?? '').toLowerCase();
        add(el, href, as === 'font' ? 'font' : as === 'style' ? 'css' : as === 'script' ? 'js' : as === 'image' ? 'img' : 'other', { preload: true });
      } else if (relHas(el, 'icon') || relHas(el, 'apple-touch-icon')) add(el, href, 'img');
    });
    $('script[src]').each((_, el) => add(el, $(el).attr('src'), 'js'));
    $('img[src]').each((_, el) => add(el, $(el).attr('src'), 'img'));
    // Fonts declared in inline <style> @font-face blocks ("where visible": external CSS isn't fetched).
    $('style').each((_, el) => {
      const css = $(el).text();
      for (const face of css.matchAll(/@font-face\s*{([^}]*)}/gi)) {
        for (const m of face[1].matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) add(el, m[1], 'font');
      }
    });
  }

  const links: ExtractedLink[] = [];
  let internalLinks = 0;
  let externalLinks = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let target: URL;
    try {
      target = new URL(href, docBase);
    } catch {
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return;
    // Cloudflare-reserved infrastructure (/cdn-cgi/l/email-protection, rocket-loader, …) —
    // never real content and 404s to bots by design; skip so it's neither crawled nor counted
    // as an internal link (otherwise it shows up as a high-equity "broken link" false positive).
    if (/^\/cdn-cgi\//i.test(target.pathname)) return;
    // Internal = the seed host or its www/apex twin ONLY — not arbitrary sibling subdomains.
    // (accounts./shop./blog. etc. are separate properties; crawling them pulls in junk like
    // Shopify's accounts.<domain> OAuth login pages — infinite param URLs, no SEO value.)
    const isInternal = isInternalHost(target.hostname, baseHost);
    if (isInternal) internalLinks++;
    else externalLinks++;
    links.push({
      targetUrl: target.toString(),
      targetKey: urlKey(target.toString(), keyOpts),
      anchor: collapseWs($(el).text()).slice(0, 300),
      placement: placementOf($, el),
      rel: $(el).attr('rel')?.trim() ?? '',
      isInternal,
      hrefForm: hrefFormOf(href),
    });
  });

  return {
    title,
    titleLength: title?.length ?? 0,
    metaDescription,
    metaDescriptionLength: $('meta[name="description"]').length ? (metaDescription?.length ?? 0) : null,
    h1,
    h1Count: h1Els.length,
    wordCount,
    lang,
    charset,
    canonicalUrl,
    canonicalKey: canonicalUrl ? urlKey(canonicalUrl, keyOpts) : null,
    robots,
    viewport,
    noindex,
    jsonLd: jsonLdBlocks.length ? JSON.stringify(jsonLdBlocks) : null,
    ogTags: Object.keys(og).length ? JSON.stringify(og) : null,
    hreflang: hreflang.length ? JSON.stringify(hreflang) : null,
    internalLinks,
    externalLinks,
    imageCount: imgEls.length,
    imagesWithoutAlt,
    imagesEmptyAlt,
    imagesEmptyAltContent,
    imagesMissingDimensions,
    canonicalCount: canonicalEls.length,
    canonicalRelative,
    h2Count,
    headingSkips,
    relNext,
    relPrev,
    relAmphtml,
    mixedContentCount,
    twitterTags: Object.keys(tw).length ? JSON.stringify(tw) : null,
    hasMicrodata,
    hasRdfa,
    hasFavicon,
    hasAnalytics,
    a11yLinksNoName,
    a11yButtonsNoName,
    a11yInputsNoLabel,
    a11yViewportZoomDisabled,
    a11yPositiveTabindex,
    a11yDuplicateIds,
    a11ySamples,
    nonCrawlableLinks: nonCrawlableTotal ? { total: nonCrawlableTotal, items: nonCrawlableItems } : null,
    nosnippet,
    bodyChunks,
    links,
    imageSrcs: [...imageSrcSet],
    resources,
  };
}
