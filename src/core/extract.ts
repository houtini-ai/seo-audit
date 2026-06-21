import * as cheerio from 'cheerio';
import { urlKey, type UrlKeyOptions } from './url-key.js';

export interface ExtractedLink {
  targetUrl: string;
  targetKey: string;
  anchor: string;
  placement: 'navigation' | 'footer' | 'body';
  rel: string;
  isInternal: boolean;
}

export interface ExtractedPage {
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
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
  imagesWithoutAlt: number;
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
  links: ExtractedLink[];
}

function placementOf($: cheerio.CheerioAPI, el: any): 'navigation' | 'footer' | 'body' {
  const $el = $(el);
  if ($el.closest('nav, header').length) return 'navigation';
  if ($el.closest('footer').length) return 'footer';
  return 'body';
}

/**
 * Extract the SEO-relevant surface from raw HTML. Pure function of bytes (D).
 * `baseHost` is the seed apex host for internal/external classification;
 * `keyOpts` is the url-key normalisation config for this property.
 */
export function extractPage(
  html: string,
  pageUrl: string,
  baseHost: string,
  keyOpts: UrlKeyOptions,
  xRobotsTag?: string | null,
): ExtractedPage {
  const $ = cheerio.load(html);

  const title = $('head > title').first().text().trim() || null;
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? null;
  const h1Els = $('h1');
  const h1 = h1Els.first().text().trim() || null;
  const lang = $('html').attr('lang')?.trim() ?? null;
  const charset = $('meta[charset]').attr('charset')?.trim()
    ?? ($('meta[http-equiv="Content-Type"]').attr('content')?.match(/charset=([\w-]+)/i)?.[1] ?? null);
  const canonicalEls = $('link[rel="canonical"]');
  const canonicalRaw = canonicalEls.first().attr('href')?.trim() ?? null;
  const canonicalUrl = canonicalRaw ? new URL(canonicalRaw, pageUrl).toString() : null;
  const canonicalRelative = canonicalRaw != null && !/^https?:\/\//i.test(canonicalRaw);
  const robots = $('meta[name="robots"]').attr('content')?.trim() ?? null;
  const viewport = $('meta[name="viewport"]').attr('content')?.trim() ?? null;
  const noindex = /noindex/i.test(robots ?? '') || /noindex/i.test(xRobotsTag ?? '');

  // word count excluding script/style/noscript/template (fixes inline-script inflation)
  const $body = cheerio.load(html);
  $body('script, style, noscript, template').remove();
  const bodyText = $body('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;

  const jsonLdBlocks: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const t = $(el).contents().text().trim();
    if (t) jsonLdBlocks.push(t);
  });

  const og: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const p = $(el).attr('property');
    const c = $(el).attr('content');
    if (p && c) og[p] = c;
  });

  const hreflang: { lang: string; href: string }[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const l = $(el).attr('hreflang');
    const href = $(el).attr('href');
    if (l && href) hreflang.push({ lang: l, href });
  });

  // Twitter Card tags (alongside Open Graph) — share-appearance completeness.
  const tw: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const n = $(el).attr('name');
    const c = $(el).attr('content');
    if (n && c) tw[n] = c;
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
  const relAmphtml = $('link[rel="amphtml"]').attr('href')?.trim() ?? null;

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

  // Images: count those lacking a non-empty alt (decorative alt="" is intentional, not flagged),
  // and those lacking both width & height attributes (a deterministic CLS signal).
  const imgEls = $('img');
  let imagesWithoutAlt = 0;
  let imagesMissingDimensions = 0;
  imgEls.each((_, el) => {
    const $e = $(el);
    if ($e.attr('alt') === undefined) imagesWithoutAlt++;
    if ($e.attr('width') === undefined && $e.attr('height') === undefined) imagesMissingDimensions++;
  });

  const links: ExtractedLink[] = [];
  let internalLinks = 0;
  let externalLinks = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let target: URL;
    try {
      target = new URL(href, pageUrl);
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
    const apex = (h: string): string => (h.startsWith('www.') ? h.slice(4) : h);
    const apexBase = apex(baseHost.toLowerCase());
    const targetHost = target.hostname.toLowerCase();
    const isInternal = targetHost === apexBase || targetHost === `www.${apexBase}`;
    if (isInternal) internalLinks++;
    else externalLinks++;
    links.push({
      targetUrl: target.toString(),
      targetKey: urlKey(target.toString(), keyOpts),
      anchor: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 300),
      placement: placementOf($, el),
      rel: $(el).attr('rel')?.trim() ?? '',
      isInternal,
    });
  });

  return {
    title,
    titleLength: title?.length ?? 0,
    metaDescription,
    metaDescriptionLength: metaDescription?.length ?? 0,
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
    links,
  };
}
