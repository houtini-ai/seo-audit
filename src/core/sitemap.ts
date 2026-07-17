import { gunzipSync } from 'node:zlib';
import { urlKey, type UrlKeyOptions } from './url-key.js';

/**
 * Sitemap discovery + parse for reconciliation against the crawl. Finds sitemaps via robots.txt
 * `Sitemap:` directives (falling back to /sitemap.xml), follows <sitemapindex> children, handles
 * gzipped sitemaps, and returns the listed URLs normalised to url_key. Bounded (count + timeout)
 * so a giant sitemap set can't stall a crawl.
 */
const LOC = /<loc>\s*([^<\s]+?)\s*<\/loc>/gi;

// XML sitemaps legally escape URL characters (?a=1&b=2 is stored as ?a=1&amp;b=2). Decode
// numeric + the five predefined entities so stored URLs match crawl/GSC url_keys and the
// crawler seeds fetch the real URL, not the literal `&amp;` form. `&amp;` is decoded last
// so `&amp;lt;` correctly yields `&lt;` rather than `<`.
const decodeXmlEntities = (s: string): string => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

async function fetchText(url: string, ua: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (url.toLowerCase().endsWith('.gz') || ct.includes('gzip')) {
      try { return gunzipSync(buf).toString('utf8'); } catch { return buf.toString('utf8'); }
    }
    return buf.toString('utf8');
  } catch { return null; }
}

export interface SitemapResult { urls: { urlKey: string; url: string }[]; sitemapsFetched: number; sources: string[] }

export async function fetchSitemapUrls(
  origin: string, ua: string, keyOpts: UrlKeyOptions, opts: { maxSitemaps?: number; maxUrls?: number } = {},
): Promise<SitemapResult> {
  const maxSitemaps = opts.maxSitemaps ?? 60;
  const maxUrls = opts.maxUrls ?? 100000;

  // Discover sitemap locations from robots.txt; fall back to /sitemap.xml.
  const sources: string[] = [];
  const robots = await fetchText(new URL('/robots.txt', origin).toString(), ua);
  if (robots) for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) sources.push(m[1].trim());
  if (!sources.length) sources.push(new URL('/sitemap.xml', origin).toString());

  const out = new Map<string, string>(); // urlKey → url (dedup)
  const queue = [...new Set(sources)];
  let fetched = 0;
  while (queue.length && fetched < maxSitemaps && out.size < maxUrls) {
    const sm = queue.shift()!;
    const txt = await fetchText(sm, ua);
    fetched++;
    if (!txt) continue;
    const isIndex = /<sitemapindex[\s>]/i.test(txt);
    for (const m of txt.matchAll(LOC)) {
      const loc = decodeXmlEntities(m[1]);
      if (isIndex) {
        if (queue.length + fetched < maxSitemaps) queue.push(loc); // child sitemap
      } else {
        try { const k = urlKey(loc, keyOpts); if (!out.has(k)) out.set(k, loc); } catch { /* skip bad loc */ }
        if (out.size >= maxUrls) break;
      }
    }
  }
  return { urls: [...out].map(([urlKey, url]) => ({ urlKey, url })), sitemapsFetched: fetched, sources };
}
