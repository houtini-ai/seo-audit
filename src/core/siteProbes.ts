/**
 * #55 group D (gap analysis item 8): the crawl's own site probes. After a crawl, a handful of requests
 * (at most 5) that the crawl itself never makes, because they test URLs nothing links to:
 *   - soft-404 handling: a random, non-existent slug under "/" and under the site's most common section.
 *     A site set up properly answers 404 or 410; a 200 (or a redirect to the homepage) means every typo
 *     or removed URL is a soft 404.
 *   - host variants: the http/https and www/apex twins of the homepage and of one deep URL. Each should
 *     answer one permanent redirect (301/308) to the canonical host.
 *
 * The requests go through probe_urls' machinery (same own-host guard at every hop, rate-limit handling,
 * bot-block Chrome retry) under the crawler's user agent, one at a time with the crawler's delay between
 * them. Results are stored in `probes` with source = 'site-probe' and the crawl id; the previous crawl's
 * site-probe rows are replaced. Read by the soft-404-handling and host-variant-split checks.
 */
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { probeUrls, type ProbeResult } from './probeUrls.js';
import { urlKey, hostFormForProperty } from './url-key.js';
import { HTML_CT } from './sql.js';

export const SITE_PROBE_SOURCE = 'site-probe';
/** Hard cap on requests (probe URLs) per crawl. */
export const MAX_SITE_PROBES = 5;

export type SiteProbeKind = 'soft404-root' | 'soft404-section' | 'host-home-scheme' | 'host-home-host' | 'host-deep';
export interface SiteProbePlan { url: string; kind: SiteProbeKind; expected: string }

export type Soft404Verdict = 'ok' | 'serves-200' | 'redirects-to-home' | 'redirects-to-200' | 'other-status' | 'unknown';
export type HostVerdict = 'ok' | 'serves-200' | 'temporary-redirect' | 'redirect-chain' | 'wrong-target' | 'error-status' | 'unknown';
/** Verdicts that are findings. */
export const SOFT404_FAIL: Soft404Verdict[] = ['serves-200', 'redirects-to-home', 'redirects-to-200'];
export const HOST_FAIL: HostVerdict[] = ['serves-200', 'temporary-redirect', 'redirect-chain', 'wrong-target'];

const PERMANENT = [301, 308];
const isIpOrLocal = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h === 'localhost' || h.endsWith('.localhost');
const flipHost = (h: string): string => (h.startsWith('www.') ? h.slice(4) : `www.${h}`);
/** Same scheme, host, path (trailing slash ignored) and query. */
export const samePage = (a: string | null, b: string): boolean => {
  if (!a) return false;
  try {
    const x = new URL(a), y = new URL(b);
    const p = (s: string): string => (s.length > 1 ? s.replace(/\/+$/, '') : s);
    return x.protocol === y.protocol && x.host.toLowerCase() === y.host.toLowerCase() && p(x.pathname) === p(y.pathname) && x.search === y.search;
  } catch { return false; }
};

/** A slug no site has: a fixed, recognisable prefix (so the owner can see it in their logs) plus 10 random hex chars. */
export const randomSlug = (): string => `seo-audit-probe-${randomBytes(5).toString('hex')}`;

/**
 * What to probe, from the latest crawl. The canonical homepage is where the property's seed URL ended
 * up (pages are keyed by the final URL); the section is the most common first path segment among
 * crawled 200 HTML pages that sit at least two segments deep; the deep URL is the most internally linked
 * 200 indexable page on the canonical host. Host flips are skipped for an IP or localhost host, scheme
 * flips for a URL with an explicit port (neither is a real-world variant).
 */
export function planSiteProbes(db: Database.Database, siteUrl: string, slug: () => string = randomSlug): { plan: SiteProbePlan[]; home: string; skipped: string[] } {
  const seed = siteUrl.startsWith('sc-domain:') ? `https://${siteUrl.slice('sc-domain:'.length)}/` : siteUrl;
  const keyOpts = { hostForm: hostFormForProperty(siteUrl) };
  const homeRow = db.prepare(`SELECT url, status_code s FROM pages WHERE url_key = ? LIMIT 1`).get(urlKey(seed, keyOpts)) as { url: string; s: number } | undefined;
  const home = homeRow?.s === 200 && homeRow.url ? new URL('/', homeRow.url).toString() : new URL('/', seed).toString();
  const h = new URL(home);
  const skipped: string[] = [];
  const plan: SiteProbePlan[] = [];

  plan.push({ url: new URL(`/${slug()}`, home).toString(), kind: 'soft404-root', expected: home });
  const segs = new Map<string, number>();
  for (const r of db.prepare(`SELECT url FROM pages WHERE status_code = 200 AND ${HTML_CT} AND url LIKE 'http%' LIMIT 20000`).all() as { url: string }[]) {
    try {
      const u = new URL(r.url);
      if (u.host !== h.host) continue;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) segs.set(parts[0], (segs.get(parts[0]) ?? 0) + 1);
    } catch { /* unparseable stored URL */ }
  }
  const section = [...segs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (section) plan.push({ url: new URL(`/${section}/${slug()}`, home).toString(), kind: 'soft404-section', expected: home });
  else skipped.push('soft404-section: no crawled page sits under a section (every page is one segment deep)');

  const canFlipHost = !isIpOrLocal(h.hostname);
  const canFlipScheme = !h.port;
  const variant = (url: string, scheme: boolean, host: boolean): string => {
    const x = new URL(url);
    if (scheme) x.protocol = x.protocol === 'https:' ? 'http:' : 'https:';
    if (host) x.hostname = flipHost(x.hostname);
    return x.toString();
  };
  if (canFlipScheme) plan.push({ url: variant(home, true, false), kind: 'host-home-scheme', expected: home });
  else skipped.push('host-home-scheme: the host has an explicit port');
  if (canFlipHost) plan.push({ url: variant(home, false, true), kind: 'host-home-host', expected: home });
  else skipped.push('host-home-host: the host is an IP address or localhost');
  const deep = (db.prepare(`SELECT url FROM pages WHERE status_code = 200 AND indexable = 1 AND ${HTML_CT} AND url LIKE 'http%' ORDER BY COALESCE(inlink_count, 0) DESC, url LIMIT 200`).all() as { url: string }[])
    .map(r => r.url).find(u => { try { const x = new URL(u); return x.host === h.host && x.pathname !== '/'; } catch { return false; } });
  if (!deep) skipped.push('host-deep: no indexable deep page in the crawl');
  else if (canFlipHost || canFlipScheme) plan.push({ url: variant(deep, canFlipScheme, canFlipHost), kind: 'host-deep', expected: deep });
  else skipped.push('host-deep: neither the scheme nor the host can be varied');
  return { plan: plan.slice(0, MAX_SITE_PROBES), home, skipped };
}

const unknownReason = (r: ProbeResult): string | null =>
  r.rateLimited ? 'rate limited' : r.error ? r.error : r.finalStatus == null ? 'no response' : null;

/** A non-existent URL should end on 404/410 (a redirect first is tolerated). */
export function judgeSoft404(r: ProbeResult, home: string): { verdict: Soft404Verdict; detail: string } {
  const unk = unknownReason(r);
  if (unk) return { verdict: 'unknown', detail: unk };
  if (r.redirectsOffProperty) return { verdict: 'other-status', detail: r.redirectsOffProperty };
  const hops = r.redirectChain.map(x => x.status).join('→');
  if (r.finalStatus === 404 || r.finalStatus === 410) return { verdict: 'ok', detail: `${hops ? `${hops} then ` : ''}${r.finalStatus}` };
  if (r.finalStatus === 200) {
    if (!r.redirectChain.length) return { verdict: 'serves-200', detail: `200 for a URL that does not exist${r.title ? ` (title "${r.title}")` : ''}` };
    if (samePage(r.finalUrl, home)) return { verdict: 'redirects-to-home', detail: `${hops} to the homepage` };
    return { verdict: 'redirects-to-200', detail: `${hops} to ${r.finalUrl} (200)` };
  }
  return { verdict: 'other-status', detail: `${hops ? `${hops} then ` : ''}${r.finalStatus}` };
}

/** A host/scheme variant should answer ONE permanent redirect (301/308) straight to the canonical URL. */
export function judgeHostVariant(r: ProbeResult, expected: string): { verdict: HostVerdict; detail: string } {
  const unk = unknownReason(r);
  if (unk) return { verdict: 'unknown', detail: unk };
  if (r.redirectsOffProperty) return { verdict: 'wrong-target', detail: r.redirectsOffProperty };
  const hops = r.redirectChain.map(x => x.status);
  if (!hops.length) {
    if (r.finalStatus === 200) return { verdict: 'serves-200', detail: `200 without redirecting${r.canonical ? (samePage(r.canonical, expected) ? ', canonical points to the canonical URL' : `, canonical ${r.canonical}`) : ', no canonical'}` };
    return { verdict: 'error-status', detail: `${r.finalStatus}` };
  }
  const lands = samePage(r.finalUrl, expected) && r.finalStatus === 200;
  const path = `${hops.join('→')} to ${r.finalUrl} (${r.finalStatus})`;
  if (!lands) return { verdict: 'wrong-target', detail: `${path}, not ${expected}` };
  if (hops.length > 1) return { verdict: 'redirect-chain', detail: `${hops.length} hops: ${path}` };
  if (!PERMANENT.includes(hops[0])) return { verdict: 'temporary-redirect', detail: `${path}: ${hops[0]} is a temporary redirect` };
  return { verdict: 'ok', detail: path };
}

export interface SiteProbeSummary { probed: number; findings: number; skipped: string[]; results: { kind: SiteProbeKind; url: string; verdict: string; detail: string }[] }
export interface SiteProbeOptions {
  crawlId: string; userAgent?: string; chromeFallback?: boolean; delayMs?: number; budgetMs?: number;
  /** The crawl switched to Chrome (the site walls the honest UA): probe as Chrome too. */
  preferChrome?: boolean;
  signal?: AbortSignal; slug?: () => string; fetchImpl?: typeof fetch;
  /** The crawl's robots.txt gate: a probe URL it disallows is skipped (with the reason), never requested. */
  isAllowed?: (url: URL) => boolean;
}

/** Run the plan one URL at a time (the crawler's delay between requests) and replace the site-probe rows. */
export async function runSiteProbes(db: Database.Database, siteUrl: string, opts: SiteProbeOptions): Promise<SiteProbeSummary> {
  const { plan, home, skipped } = planSiteProbes(db, siteUrl, opts.slug);
  const baseHost = new URL(home).hostname;
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const done: { p: SiteProbePlan; r: ProbeResult; verdict: string; detail: string }[] = [];
  let twinHostUnresolved = false;
  for (let p of plan) {
    if (opts.signal?.aborted) break;
    if (Date.now() > deadline - 2000) { skipped.push(`${p.kind}: time budget reached`); continue; }
    // The www/apex twin doesn't resolve (no DNS record: nothing to split). Spend the deep probe on the
    // scheme twin alone rather than on a host that can't answer.
    if (p.kind === 'host-deep' && twinHostUnresolved) {
      const x = new URL(p.expected);
      if (x.port) { skipped.push('host-deep: the twin host does not resolve and the host has a port'); continue; }
      x.protocol = x.protocol === 'https:' ? 'http:' : 'https:';
      p = { ...p, url: x.toString() };
      skipped.push('host-deep: the twin host does not resolve, so the deep URL was probed on the other scheme only');
    }
    if (opts.isAllowed) {
      let u: URL | null = null;
      try { u = new URL(p.url); } catch { /* unparseable: let the probe report it */ }
      if (u && !opts.isAllowed(u)) { skipped.push(`${p.kind}: robots.txt disallows ${u.pathname}`); continue; }
    }
    if (done.length && opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
    const [r] = await probeUrls([{ url: p.url, variantType: p.kind }], baseHost, {
      userAgent: opts.userAgent, chromeFallback: opts.chromeFallback, preferChrome: opts.preferChrome, concurrency: 1,
      budgetMs: Math.min(20_000, Math.max(3000, deadline - Date.now())), fetchImpl: opts.fetchImpl,
    });
    const j = p.kind.startsWith('soft404') ? judgeSoft404(r, home) : judgeHostVariant(r, p.expected);
    done.push({ p, r, ...j });
    if (p.kind === 'host-home-host' && /ENOTFOUND|EAI_AGAIN/.test(r.error ?? '')) twinHostUnresolved = true;
  }
  if (done.length) {
    const ins = db.prepare(`INSERT INTO probes (url, variant_of, variant_type, status, redirect_chain, final_url, final_status, canonical, meta_robots, x_robots_tag, title, content_hash, cache, verdict, error, source, crawl_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      db.prepare(`DELETE FROM probes WHERE source = ?`).run(SITE_PROBE_SOURCE);
      for (const { p, r, verdict } of done) {
        ins.run(r.url, p.expected, p.kind, r.status, JSON.stringify(r.redirectChain), r.finalUrl, r.finalStatus, r.canonical, r.metaRobots, r.xRobotsTag, r.title, r.contentHash,
          JSON.stringify(r.cache), verdict, r.error ?? null, SITE_PROBE_SOURCE, opts.crawlId);
      }
    })();
  }
  const fails = done.filter(d => (SOFT404_FAIL as string[]).includes(d.verdict) || (HOST_FAIL as string[]).includes(d.verdict)).length;
  return { probed: done.length, findings: fails, skipped, results: done.map(d => ({ kind: d.p.kind, url: d.p.url, verdict: d.verdict, detail: d.detail })) };
}
