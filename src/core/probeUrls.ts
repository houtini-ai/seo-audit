/**
 * probe_urls (#30): fetch arbitrary URLs on the property's own host(s) — including ones the model
 * generates to test a hypothesis — and report status, the redirect chain, canonical, robots
 * directives, a content fingerprint and cache headers. The crawler only fetches what it discovers,
 * so questions like "does /Sim-Racing-Wheels/ serve the same page as /sim-racing-wheels/?" had to
 * fall back to curl. `variantsOf` is the url-variant-handling preset on top: it generates case,
 * slash, index.php, unknown-param, scheme and host variants of a URL and summarises whether the
 * site normalises each.
 */
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { isInternalHost } from './extract.js';
import { CHROME_HEADERS, looksBotBlocked, type FetchedAs } from './userAgents.js';

export interface ProbeHop { url: string; status: number; location: string | null }
export interface ProbeResult {
  url: string;
  variantType?: string;
  status: number | null;            // first response's status
  redirectChain: ProbeHop[];        // every 3xx hop, in order
  finalUrl: string | null;
  finalStatus: number | null;
  contentType: string | null;
  title: string | null;
  canonical: string | null;         // absolute
  metaRobots: string | null;
  xRobotsTag: string | null;
  contentHash: string | null;       // sha1 of the whitespace-collapsed body text: equal hash = same page
  cache: { cfCacheStatus: string | null; xCache: string | null; age: string | null; cacheControl: string | null };
  ms: number;
  fetchedAs: FetchedAs;             // which user agent produced this result
  blockedAsBot?: boolean;           // the crawler's UA was bot-blocked; this result is the Chrome retry
  /** Set when a redirect points off the property: the target was recorded (as finalUrl, with the
   * redirect's own status as finalStatus) but NOT fetched. */
  redirectsOffProperty?: string;
  error?: string;
}

export interface ProbeOptions { followRedirects?: boolean; userAgent?: string; concurrency?: number; budgetMs?: number; chromeFallback?: boolean }

const emptyResult = (url: string): ProbeResult => ({ url, status: null, redirectChain: [], finalUrl: null, finalStatus: null, contentType: null, title: null, canonical: null, metaRobots: null, xRobotsTag: null, contentHash: null, cache: { cfCacheStatus: null, xCache: null, age: null, cacheControl: null }, ms: 0, fetchedAs: 'bot' });

const UA = 'Mozilla/5.0 (compatible; seo-audit-console probe; +https://github.com/houtini-ai/seo-audit)';
const MAX_BODY = 2_000_000;

async function probeOne(url: string, o: Required<ProbeOptions>, deadline: number, baseHost: string, chrome = false): Promise<ProbeResult & { botBlocked?: boolean }> {
  const t0 = Date.now();
  const out: ProbeResult & { botBlocked?: boolean } = { ...emptyResult(url), fetchedAs: chrome ? 'chrome' : 'bot' };
  let current = url;
  try {
    for (let hop = 0; hop <= 10; hop++) {
      const left = Math.max(1000, Math.min(10000, deadline - Date.now()));
      const res = await fetch(current, { redirect: 'manual', headers: chrome ? CHROME_HEADERS : { 'user-agent': o.userAgent, accept: 'text/html,*/*;q=0.8' }, signal: AbortSignal.timeout(left) });
      if (out.status == null) out.status = res.status;
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        out.redirectChain.push({ url: current, status: res.status, location: loc });
        try { await res.body?.cancel(); } catch { /* already closed */ }
        if (!o.followRedirects) { out.finalUrl = current; out.finalStatus = res.status; break; }
        let nextUrl: URL;
        try { nextUrl = new URL(loc, current); } catch {
          out.finalUrl = current; out.finalStatus = res.status; out.error = `unparseable redirect Location: ${loc}`; break;
        }
        // The same own-host guard as the input URLs, at EVERY hop. Checking only the input let an
        // open redirect on the property (/out?to=...) turn the probe into a fetch of an arbitrary
        // or internal-network URL whose title, canonical and content hash came back to the model.
        if ((nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') || !isInternalHost(nextUrl.hostname, baseHost)) {
          out.finalUrl = nextUrl.toString();
          out.finalStatus = res.status;
          out.redirectsOffProperty = `redirects to ${nextUrl.protocol}//${nextUrl.host}, outside ${baseHost} - recorded, not fetched`;
          break;
        }
        current = nextUrl.toString();
        continue;
      }
      out.finalUrl = current;
      out.finalStatus = res.status;
      if (!chrome && looksBotBlocked(res.status, n => res.headers.get(n))) out.botBlocked = true;
      out.contentType = res.headers.get('content-type');
      out.xRobotsTag = res.headers.get('x-robots-tag');
      out.cache = { cfCacheStatus: res.headers.get('cf-cache-status'), xCache: res.headers.get('x-cache'), age: res.headers.get('age'), cacheControl: res.headers.get('cache-control') };
      if ((out.contentType ?? '').toLowerCase().includes('html')) {
        const buf = Buffer.from(await res.arrayBuffer());
        const html = buf.subarray(0, MAX_BODY).toString('utf8');
        const $ = cheerio.load(html);
        out.title = $('head > title').first().text().replace(/\s+/g, ' ').trim() || null;
        const can = $('link[rel="canonical"]').first().attr('href')?.trim();
        if (can) {
          const baseHref = $('base[href]').first().attr('href');
          try { out.canonical = new URL(can, baseHref ? new URL(baseHref, current) : current).toString(); } catch { out.canonical = can; }
        }
        out.metaRobots = $('meta[name="robots"]').attr('content')?.trim() ?? null;
        $('script, style, noscript').remove();
        const text = $('body').text().replace(/\s+/g, ' ').trim();
        out.contentHash = text ? createHash('sha1').update(text).digest('hex').slice(0, 16) : null;
      } else {
        try { await res.body?.cancel(); } catch { /* already closed */ }
      }
      break;
    }
    if (out.finalUrl == null) out.error = 'more than 10 redirects';
  } catch (e) {
    out.error = e instanceof Error ? (e.name === 'TimeoutError' ? 'timed out' : e.message) : String(e);
  }
  out.ms = Date.now() - t0;
  return out;
}

/** Probe up to 50 URLs on the property's host(s) within a time budget; unprobed URLs are marked. */
export async function probeUrls(urls: { url: string; variantType?: string }[], baseHost: string, opts: ProbeOptions = {}): Promise<ProbeResult[]> {
  const o: Required<ProbeOptions> = { followRedirects: opts.followRedirects ?? true, userAgent: opts.userAgent ?? UA, concurrency: opts.concurrency ?? 4, budgetMs: opts.budgetMs ?? 45000, chromeFallback: opts.chromeFallback ?? !opts.userAgent };
  for (const u of urls) {
    let h: URL;
    try { h = new URL(u.url); } catch { throw new Error(`Not a URL: ${u.url}`); }
    if (h.protocol !== 'http:' && h.protocol !== 'https:') throw new Error(`Only http(s) URLs can be probed: ${u.url}`);
    if (!isInternalHost(h.hostname, baseHost)) throw new Error(`probe_urls only fetches the property's own host (${baseHost} or www.): ${u.url}`);
  }
  const deadline = Date.now() + o.budgetMs;
  const results: ProbeResult[] = new Array(urls.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(o.concurrency, urls.length) }, async () => {
    while (next < urls.length) {
      const i = next++;
      const u = urls[i];
      if (Date.now() > deadline - 1000) {
        results[i] = { ...emptyResult(u.url), ...(u.variantType ? { variantType: u.variantType } : {}), error: 'not probed: time budget reached (probe fewer URLs per call)' };
        continue;
      }
      let r = await probeOne(u.url, o, deadline, baseHost);
      // Bot-blocked under our own UA: one retry as Chrome, flagged so the reader knows (and so a
      // site that walls crawlers is visible as such).
      if (r.botBlocked && o.chromeFallback && Date.now() < deadline - 1000) r = { ...(await probeOne(u.url, o, deadline, baseHost, true)), blockedAsBot: true };
      delete r.botBlocked;
      results[i] = { ...r, ...(u.variantType ? { variantType: u.variantType } : {}) };
    }
  }));
  return results;
}

/** The url-variant-handling preset: variants of one URL, each labelled with what it tests. */
export function urlVariants(raw: string): { url: string; variantType: string }[] {
  const u = new URL(raw);
  const out: { url: string; variantType: string }[] = [{ url: u.toString(), variantType: 'baseline' }];
  const add = (variantType: string, mut: (x: URL) => void): void => {
    const x = new URL(u.toString()); mut(x);
    const s = x.toString();
    if (!out.some(v => v.url === s)) out.push({ url: s, variantType });
  };
  if (/[a-z]/.test(u.pathname)) add('uppercase-path', x => { x.pathname = x.pathname.toUpperCase(); });
  add('titlecase-path', x => { x.pathname = x.pathname.split('/').map(seg => seg.replace(/(^|-)([a-z])/g, (_, p, c) => p + c.toUpperCase())).join('/'); });
  if (u.pathname !== '/') add(u.pathname.endsWith('/') ? 'no-trailing-slash' : 'trailing-slash', x => { x.pathname = x.pathname.endsWith('/') ? x.pathname.slice(0, -1) : x.pathname + '/'; });
  add('index-php', x => { x.pathname = (x.pathname.endsWith('/') ? x.pathname : x.pathname + '/') + 'index.php'; });
  add('unknown-param', x => { x.searchParams.set('utm_source', 'probe'); });
  if (u.protocol === 'https:') add('http-scheme', x => { x.protocol = 'http:'; });
  add(u.hostname.startsWith('www.') ? 'apex-host' : 'www-host', x => { x.hostname = x.hostname.startsWith('www.') ? x.hostname.slice(4) : `www.${x.hostname}`; });
  return out;
}

export type VariantVerdict = 'redirects' | 'redirect-chain' | 'serves-200-canonicalised' | 'serves-200-duplicate' | 'error-status' | 'unreachable';

/** Judge each variant against the baseline: does the site normalise it? */
export function judgeVariants(results: ProbeResult[]): { variantType: string; url: string; verdict: VariantVerdict; detail: string }[] {
  const base = results.find(r => r.variantType === 'baseline');
  const baseFinal = base?.finalUrl ?? null;
  const strip = (s: string | null): string => (s ?? '').replace(/#.*$/, '');
  return results.filter(r => r.variantType && r.variantType !== 'baseline').map(r => {
    const t = r.variantType!;
    if (r.error || r.finalStatus == null) return { variantType: t, url: r.url, verdict: 'unreachable' as const, detail: r.error ?? 'no response' };
    if (r.redirectChain.length) {
      // One hop straight to the baseline is the goal; more hops, or landing elsewhere, is not.
      const lands = strip(r.finalUrl) === strip(baseFinal);
      const verdict: VariantVerdict = lands && r.redirectChain.length === 1 ? 'redirects' : 'redirect-chain';
      return { variantType: t, url: r.url, verdict, detail: `${r.redirectChain.map(h => h.status).join('→')} to ${r.finalUrl} (${r.finalStatus})${lands ? '' : ', NOT the baseline URL'}` };
    }
    if (r.finalStatus >= 400) return { variantType: t, url: r.url, verdict: 'error-status' as const, detail: `${r.finalStatus}` };
    const canonicalised = !!baseFinal && strip(r.canonical) === strip(baseFinal);
    const cache = r.cache.cfCacheStatus ?? r.cache.xCache;
    return { variantType: t, url: r.url, verdict: canonicalised ? 'serves-200-canonicalised' as const : 'serves-200-duplicate' as const,
      detail: `200 without redirecting${canonicalised ? ', canonical points to the baseline' : ', canonical does not point to the baseline'}${r.contentHash && r.contentHash === base?.contentHash ? ', same content' : ''}${cache ? `, cache: ${cache}` : ''}` };
  });
}
