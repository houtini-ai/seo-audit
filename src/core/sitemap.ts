import { gunzipSync } from 'node:zlib';
import { urlKey, type UrlKeyOptions } from './url-key.js';

/**
 * Sitemap discovery + parse for reconciliation against the crawl. Finds sitemaps via robots.txt
 * `Sitemap:` directives AND the conventional locations (/sitemap_index.xml, /sitemap.xml,
 * /wp-sitemap.xml), follows <sitemapindex> children recursively, handles
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

/** GET with redirects followed. `finalUrl` is where it landed - Yoast answers /sitemap.xml and
 * /wp-sitemap.xml with a redirect to /sitemap_index.xml, and that has to be known to avoid fetching
 * and reporting the same document three times. */
async function fetchText(url: string, ua: string): Promise<{ text: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const finalUrl = res.url || url;
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (finalUrl.toLowerCase().endsWith('.gz') || url.toLowerCase().endsWith('.gz') || ct.includes('gzip')) {
      try { return { text: gunzipSync(buf).toString('utf8'), finalUrl }; } catch { return { text: buf.toString('utf8'), finalUrl }; }
    }
    return { text: buf.toString('utf8'), finalUrl };
  } catch { return null; }
}

export interface SitemapResult {
  urls: { urlKey: string; url: string; lastmod: string | null }[];
  sitemapsFetched: number;
  /** Sitemaps declared in robots.txt. */
  sources: string[];
  /** Conventional locations that existed but robots.txt didn't declare (e.g. a Yoast sitemap_index.xml). */
  undeclared: string[];
}

// Probed on every crawl, not only when robots.txt is silent (#25): robots.txt often lists just a
// couple of child sitemaps (post-sitemap.xml, page-sitemap.xml) while the index also carries
// category/tag/author sitemaps, which made indexable-not-in-sitemap over-report.
const CONVENTIONAL = ['/sitemap_index.xml', '/sitemap.xml', '/wp-sitemap.xml'];

export async function fetchSitemapUrls(
  origin: string, ua: string, keyOpts: UrlKeyOptions, opts: { maxSitemaps?: number; maxUrls?: number } = {},
): Promise<SitemapResult> {
  const maxSitemaps = opts.maxSitemaps ?? 60;
  const maxUrls = opts.maxUrls ?? 100000;

  // Discover sitemap locations from robots.txt; fall back to /sitemap.xml.
  const sources: string[] = [];
  const robots = (await fetchText(new URL('/robots.txt', origin).toString(), ua))?.text;
  if (robots) for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) sources.push(m[1].trim());
  const conventional = CONVENTIONAL.map(p => new URL(p, origin).toString());
  const undeclared: string[] = [];

  // Sitemaps are compared by urlKey, never by raw string: robots.txt declaring
  // https://www.example.com/sitemap_index.xml while the crawl origin is https://example.com made
  // the declared index look undeclared, and it was fetched again under each spelling.
  const keyOf = (u: string): string => { try { return urlKey(u, keyOpts); } catch { return u; } };
  const declaredKeys = new Set(sources.map(keyOf));
  const conventionalKeys = new Set(conventional.map(keyOf));

  const out = new Map<string, { url: string; lastmod: string | null }>(); // urlKey → entry (dedup)
  // Declared sitemaps first, then the conventional locations. Every SPELLING of the starting set is
  // queued - if the declared spelling fails to fetch, the conventional one still gets its chance.
  // What stops duplicate work is `parsed`: keys of documents successfully parsed, including the
  // target a redirect landed on, so /sitemap.xml → /sitemap_index.xml (or a www/apex respelling of a
  // declared index) is neither parsed nor reported again. `queuedKeys` stops an index's children
  // (which usually include the declared ones) from being queued twice.
  const queue: string[] = [];
  const queuedKeys = new Set<string>();
  const parsed = new Set<string>();
  for (const u of new Set([...sources, ...conventional])) { queue.push(u); queuedKeys.add(keyOf(u)); }
  let fetched = 0;
  const URL_BLOCK = /<url>([\s\S]*?)<\/url>/gi;
  const LOC_ONE = /<loc>\s*([^<\s]+?)\s*<\/loc>/i;
  const LASTMOD_ONE = /<lastmod>\s*([^<\s]+?)\s*<\/lastmod>/i;
  const add = (loc: string, lastmod: string | null): void => {
    try { const k = urlKey(loc, keyOpts); if (!out.has(k)) out.set(k, { url: loc, lastmod }); } catch { /* skip bad loc */ }
  };
  while (queue.length && fetched < maxSitemaps && out.size < maxUrls) {
    const sm = queue.shift()!;
    const smKey = keyOf(sm);
    if (parsed.has(smKey)) continue; // this document was already parsed (another spelling, or a redirect target): no fetch
    const got = await fetchText(sm, ua);
    fetched++;
    const txt = got?.text;
    // A catch-all route can answer 200 with HTML for /sitemap.xml: only count real sitemap XML.
    // A failed fetch is NOT marked parsed, so another spelling of the same sitemap is still tried.
    if (!got || !txt || !/<(urlset|sitemapindex)[\s>]/i.test(txt)) continue;
    const finalKey = keyOf(got.finalUrl);
    if (declaredKeys.has(smKey)) declaredKeys.add(finalKey);  // a declared sitemap's redirect target is declared too
    if (finalKey !== smKey && parsed.has(finalKey)) { parsed.add(smKey); continue; } // landed on a document already parsed
    parsed.add(smKey);
    parsed.add(finalKey);
    if (conventionalKeys.has(smKey) && !declaredKeys.has(smKey) && !declaredKeys.has(finalKey)) undeclared.push(sm);
    if (/<sitemapindex[\s>]/i.test(txt)) {
      for (const m of txt.matchAll(LOC)) {
        const child = decodeXmlEntities(m[1]);
        const ck = keyOf(child);
        if (queuedKeys.has(ck) || parsed.has(ck)) continue;
        if (queue.length + fetched < maxSitemaps) { queue.push(child); queuedKeys.add(ck); } // child sitemap (recursive: an index may list indexes)
      }
      continue;
    }
    // Parse per-<url> block so each <lastmod> claim stays paired with its <loc>.
    let sawBlock = false;
    for (const b of txt.matchAll(URL_BLOCK)) {
      sawBlock = true;
      const loc = b[1].match(LOC_ONE)?.[1];
      if (!loc) continue;
      add(decodeXmlEntities(loc), b[1].match(LASTMOD_ONE)?.[1] ?? null);
      if (out.size >= maxUrls) break;
    }
    // Defensive fallback for malformed sitemaps that list bare <loc>s without <url> wrappers.
    if (!sawBlock) {
      for (const m of txt.matchAll(LOC)) {
        add(decodeXmlEntities(m[1]), null);
        if (out.size >= maxUrls) break;
      }
    }
  }
  return { urls: [...out].map(([k, v]) => ({ urlKey: k, url: v.url, lastmod: v.lastmod })), sitemapsFetched: fetched, sources, undeclared };
}
