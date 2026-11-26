/**
 * #55 summary slice 4, group B, item 3: redirect hygiene.
 *   - redirect-to-non-indexable     an internal redirect that lands on a 4xx/5xx, noindex or canonicalised page
 *   - redirect-to-homepage          a deep URL redirected to the homepage (Google reads it as a soft 404)
 *   - redirect-loop                 a chain that revisits a URL, or never resolves within the crawler's hop cap
 *   - temporary-redirect-with-equity  302/303/307 on a URL with search traffic, backlinks or internal links
 *   - redirect-retired              a URL that answered 200 in an earlier crawl and now answers 404/410
 *   (and the extension of the existing `redirect-chain`, see redirectChainFindings)
 *
 * Data: `redirect_sources` (every crawled URL that redirected in the latest crawl, keyed by the SOURCE,
 * with its hop chain), `pages` (the latest crawl, keyed by the FINAL url), `page_snapshots` (one row per
 * crawl per URL), `links`, `page_backlinks` and `search_analytics`. Same contract as checks.ts: a pure
 * read, deterministic, thresholds stated here, and missing data means no finding. A rate-limited URL
 * (fetch_state='rate_limited', or a legacy stored 429/503) is unknown, never an error.
 */
import { lifetimePageRows } from '../core/gscPageTotals.js';
import type { CheckContext, CheckDef, RawFinding } from './checks.js';
import type Database from 'better-sqlite3';
import { isInternalHost } from '../core/extract.js';
import { hasGscRows } from '../core/gscRows.js';

const rows = (c: CheckContext, sql: string, ...args: unknown[]): any[] => c.db.prepare(sql).all(...args);
const one = (c: CheckContext, sql: string, ...args: unknown[]): any => c.db.prepare(sql).get(...args);

// ── Thresholds, stated ──────────────────────────────────────────────────────────────────────
/** The crawler follows at most this many hops (Crawler.fetchWithRedirects maxHops); a chain still redirecting after it never resolved. */
export const REDIRECT_HOP_CAP = 5;
/** "Equity" = any of: GSC clicks >= this, GSC impressions >= EQUITY_MIN_IMPRESSIONS, a backlink, or an internal link from another page. */
export const EQUITY_MIN_CLICKS = 1;
/** Same floor as traffic-to-dead-url: fewer impressions than this over the GSC history held is noise. */
export const EQUITY_MIN_IMPRESSIONS = 10;
/** First-hop statuses that say "temporary" (RFC 9110): 302 Found, 303 See Other, 307 Temporary Redirect. */
export const TEMPORARY_STATUSES = [302, 303, 307];
/** Gone statuses for the snapshot checks: 404 Not Found and 410 Gone. Other 4xx (401/403) are access, not removal. */
export const GONE_STATUSES = [404, 410];

/**
 * Login, account, cart and checkout flows (and the platform auth hops they bounce through) redirect
 * by design and are not search landing pages: Shopify sends /account to accounts.<domain> with a 302,
 * WordPress sends wp-admin to wp-login.php. A chain that touches one of these is never a finding.
 * Mirrors the crawler's skip-list (auth/oauth/login_with_shop/cart/checkout), plus account/login paths.
 */
export const NON_SEO_FLOW = /\/(account|accounts|customer_authentication|authentication|oauth|login_with_shop|login|logout|signin|sign-in|signup|sign-up|register|cart|checkout|checkouts|basket|my-account|wp-login\.php|wp-admin)(\/|$|\?|#)|[?&](client_id|redirect_uri|response_type|return_url|return_to)=/i;

/** Paths that ARE the homepage under another name, or a locale root: redirecting them to "/" is canonicalisation, not a soft 404. */
const HOME_ALIAS = /^\/(index|default|home)(\.(html?|php|aspx?|jsp|cfm))?\/?$|^\/[a-z]{2}([-_][a-z]{2})?\/?$/i;

interface Hop { from: string; to: string; status: number }
/** One redirecting URL from the latest crawl, from whichever table recorded it. */
export interface RedirectRecord {
  sourceKey: string;
  sourceUrl: string;
  firstStatus: number | null;
  finalKey: string | null;
  finalUrl: string | null;
  chain: Hop[];
  recordedIn: 'redirect_sources' | 'pages.redirects';
}

const hostOf = (u: string | null | undefined): string | null => { try { return u ? new URL(u).hostname : null; } catch { return null; } };
const pathOf = (u: string | null | undefined): { path: string; search: string } | null => { try { if (!u) return null; const x = new URL(u); return { path: x.pathname, search: x.search }; } catch { return null; } };
const parseChain = (s: string | null): Hop[] => {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter(h => h && typeof h.from === 'string' && typeof h.to === 'string') : []; } catch { return []; }
};

/**
 * Every redirect the latest crawl recorded. `redirect_sources` holds each source URL; `pages.redirects`
 * adds the chains whose source normalises to the same key as its target (http->https, a trailing-slash
 * hop), which redirect_sources skips. One record per source URL.
 */
export function redirectRecords(c: CheckContext): RedirectRecord[] {
  const out: RedirectRecord[] = [];
  const seen = new Set<string>();
  const hasRs = !!one(c, `SELECT 1 FROM sqlite_master WHERE type='table' AND name='redirect_sources'`);
  if (hasRs) {
    for (const r of rows(c, `SELECT url_key, url, status, final_url, final_key, chain FROM redirect_sources`)) {
      const chain = parseChain(r.chain);
      out.push({ sourceKey: r.url_key, sourceUrl: r.url, firstStatus: r.status ?? chain[0]?.status ?? null, finalKey: r.final_key ?? null, finalUrl: r.final_url ?? null, chain, recordedIn: 'redirect_sources' });
      seen.add(r.url); if (chain[0]) seen.add(chain[0].from);
    }
  }
  for (const p of rows(c, `SELECT url_key, url, redirects FROM pages WHERE redirects IS NOT NULL AND redirects <> '' AND redirects <> '[]'`)) {
    const chain = parseChain(p.redirects);
    if (!chain.length || seen.has(chain[0].from)) continue;
    seen.add(chain[0].from);
    out.push({ sourceKey: p.url_key, sourceUrl: chain[0].from, firstStatus: chain[0].status ?? null, finalKey: p.url_key, finalUrl: chain[chain.length - 1].to, chain, recordedIn: 'pages.redirects' });
  }
  return out;
}

/** Every hop stays on the property (the source's host or its www/apex twin): not an outbound or third-party flow. */
export function isInternalChain(r: RedirectRecord): boolean {
  const base = hostOf(r.sourceUrl);
  if (!base) return false;
  const urls = r.chain.length ? r.chain.flatMap(h => [h.from, h.to]) : [r.sourceUrl, r.finalUrl ?? ''];
  return urls.every(u => { const h = hostOf(u); return !!h && isInternalHost(h, base); });
}
/** The chain touches a login/account/cart/checkout flow. */
export const isNonSeoFlow = (r: RedirectRecord): boolean => [r.sourceUrl, ...r.chain.flatMap(h => [h.from, h.to])].some(u => NON_SEO_FLOW.test(u));
/** The redirects worth judging: internal, and not an auth/cart flow. */
const inScope = (r: RedirectRecord): boolean => isInternalChain(r) && !isNonSeoFlow(r);

interface FinalPage { status: number | null; indexable: number | null; reason: string | null; canonicalKey: string | null; fetchState: string | null; url: string }
function finalPageLookup(c: CheckContext): (key: string | null) => FinalPage | null {
  const st = c.db.prepare(`SELECT url, status_code status, indexable, indexable_reason reason, canonical_key canonicalKey, fetch_state fetchState FROM pages WHERE url_key=?`);
  return (key) => (key ? (st.get(key) as FinalPage | undefined) ?? null : null);
}
/** Unknown, not broken: never fetched because the host rate-limited the crawl (#54/#60), or a legacy stored 429/503. */
const rateLimited = (p: FinalPage): boolean => p.fetchState === 'rate_limited' || p.status === 429 || p.status === 503;
const unresolvedFinal = (p: FinalPage | null): boolean => !!p && p.status != null && p.status >= 300 && p.status < 400;

/** Where the chain revisits a URL (exact match), or null. */
export function loopPoint(chain: Hop[]): string | null {
  const seen = new Set<string>();
  for (const u of [...chain.map(h => h.from), chain[chain.length - 1]?.to].filter((x): x is string => !!x)) {
    if (seen.has(u)) return u;
    seen.add(u);
  }
  return null;
}

// ── Equity: search traffic, backlinks, internal links ────────────────────────────────────────
export interface Equity {
  gsc: { clicks: number; impressions: number; from: string | null; to: string } | null; // null = no GSC data held
  backlinks: { backlinks: number; referringDomains: number } | null;                     // null = backlinks never pulled
  internalInlinks: number;                                                               // other pages linking here (latest crawl)
  hasEquity: boolean;
}

/**
 * Equity per url_key over the GSC history held (up to the finalised max date). A day that holds BOTH
 * GSC row shapes (all-country rows and segmented rows) counts its all-country rows only, so it is not
 * summed twice (the same rule as checks-signals brandedClicks). The mixed-day scan runs only when a
 * check has a candidate to price.
 */
export function equityLookup(c: CheckContext): (key: string) => Equity {
  let gscStmt: Database.Statement | null = null;
  let mixed = '[]';
  const lite = `(COALESCE(device,'') = '' AND COALESCE(country,'') = '')`;
  const blPulled = !!one(c, `SELECT 1 FROM page_backlinks LIMIT 1`);
  const blStmt = c.db.prepare(`SELECT backlinks, referring_domains rd FROM page_backlinks WHERE url_key=?`);
  const inStmt = c.db.prepare(`SELECT COUNT(DISTINCT source_key) n FROM links WHERE target_key=? AND is_internal=1 AND source_key <> target_key`);
  return (key) => {
    let gsc: Equity['gsc'] = null;
    if (c.gscMaxDate) {
      if (!gscStmt && hasGscRows(c.db)) {
        // Integration (#67 x #64): the gsc_rows view already counts each day once (#61). Page totals
        // (#118) when they cover the whole stored history, so long-tail clicks count too.
        const src = lifetimePageRows(c.db);
        gscStmt = c.db.prepare(`SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, MIN(date) "from"
          FROM ${src} WHERE page_key=? AND date <= ? AND ? IS NOT NULL`);
      }
      if (!gscStmt) {
        mixed = JSON.stringify(rows(c, `SELECT date FROM search_analytics GROUP BY date HAVING SUM(${lite}) > 0 AND SUM(NOT ${lite}) > 0`).map(r => r.date));
        gscStmt = c.db.prepare(`SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, MIN(date) "from"
          FROM search_analytics WHERE page_key=? AND date <= ? AND (date NOT IN (SELECT value FROM json_each(?)) OR ${lite})`);
      }
      const g = gscStmt.get(key, c.gscMaxDate, mixed) as { clicks: number; impressions: number; from: string | null };
      gsc = { clicks: g.clicks, impressions: g.impressions, from: g.from, to: c.gscMaxDate };
    }
    const b = blPulled ? (blStmt.get(key) as { backlinks: number; rd: number } | undefined) : undefined;
    const backlinks = blPulled ? { backlinks: b?.backlinks ?? 0, referringDomains: b?.rd ?? 0 } : null;
    const internalInlinks = (inStmt.get(key) as { n: number }).n;
    const hasEquity = (gsc != null && (gsc.clicks >= EQUITY_MIN_CLICKS || gsc.impressions >= EQUITY_MIN_IMPRESSIONS))
      || (backlinks != null && backlinks.backlinks > 0) || internalInlinks > 0;
    return { gsc, backlinks, internalInlinks, hasEquity };
  };
}
export const EQUITY_RULE = `equity = GSC clicks >= ${EQUITY_MIN_CLICKS} or impressions >= ${EQUITY_MIN_IMPRESSIONS} over the GSC history held, or >= 1 backlink, or >= 1 internal link from another page`;
const hopsOut = (chain: Hop[]): Hop[] => chain.map(h => ({ from: h.from, to: h.to, status: h.status }));
/** Sort weight for "most to lose first": clicks, then backlinks, impressions, internal links. */
export const equityWeight = (e: Equity): number => (e.gsc?.clicks ?? 0) * 1e6 + (e.backlinks?.backlinks ?? 0) * 1e3 + (e.gsc?.impressions ?? 0) + e.internalInlinks / 1e3;

// ── redirect-chain (existing check, extended) ────────────────────────────────────────────────
/**
 * The extended `redirect-chain`, limited to chains that stay on the property and resolve. Before, it
 * also counted chains that left the site or never resolved: on a Shopify store ~1,300 login/OAuth
 * bounces (accounts.<domain>, shop.app), stored as off-site 302 rows, read as "chains to collapse".
 * Loops and hop-cap chains are redirect-loop's; login/cart flows are excluded like every other
 * redirect check. Two stores, one finding per source URL:
 *   - pages.redirects: the 2+ hop chain a final page was FIRST reached through, keyed by that FINAL
 *     page (which is what fix_finding's collapse-the-chain generator reads);
 *   - redirect_sources: every other URL that redirected through 2+ hops, keyed by the SOURCE. The
 *     crawler writes a final page once, so a chain that ends on a page already crawled (directly, or
 *     through another redirect) exists only here; reading pages.redirects alone missed all of those.
 */
export function redirectChainFindings(c: CheckContext): RawFinding[] {
  const out: RawFinding[] = [];
  const seen = new Set<string>(); // source URLs already reported from pages.redirects
  for (const p of rows(c, `SELECT url_key urlKey, url, status_code status, redirects FROM pages
      WHERE redirects IS NOT NULL AND json_valid(redirects) AND json_array_length(redirects) >= 2`)) {
    if (p.status != null && p.status >= 300 && p.status < 400) continue; // never resolved (loop, hop cap, off-site): not a chain to collapse
    const chain = parseChain(p.redirects);
    if (chain.length < 2) continue;
    const r: RedirectRecord = { sourceKey: p.urlKey, sourceUrl: chain[0].from, firstStatus: chain[0].status ?? null, finalKey: p.urlKey, finalUrl: p.url, chain, recordedIn: 'pages.redirects' };
    if (!inScope(r) || loopPoint(chain)) continue;
    seen.add(chain[0].from);
    out.push({ urlKey: p.urlKey, evidence: { hops: chain.length, source: chain[0].from, finalUrl: p.url, chain: hopsOut(chain) } });
  }
  const final = finalPageLookup(c);
  for (const r of redirectRecords(c)) {
    if (r.recordedIn !== 'redirect_sources' || r.chain.length < 2) continue;
    if (seen.has(r.sourceUrl) || seen.has(r.chain[0].from)) continue; // the chain its final page was first reached through: reported above
    if (!inScope(r) || loopPoint(r.chain)) continue;
    const fp = final(r.finalKey);
    if (!fp || fp.status == null || (fp.status >= 300 && fp.status < 400)) continue; // unknown or never resolved (as above): not a chain to collapse
    out.push({ urlKey: r.sourceKey, evidence: { hops: r.chain.length, source: r.sourceUrl, finalUrl: fp.url, chain: hopsOut(r.chain), recordedIn: r.recordedIn } });
  }
  return out;
}

// ── redirect-to-non-indexable ────────────────────────────────────────────────────────────────
/** Why the final page can't be indexed, from its pages row; null = indexable, unknown or out of scope. */
function nonIndexableWhy(p: FinalPage): string | null {
  if (rateLimited(p) || p.status == null) return null;
  if (p.status >= 400) return `http-${p.status}`;
  if (p.status >= 300) return null; // unresolved chain: redirect-loop's
  if (p.reason === 'noindex-meta' || p.reason === 'noindex-header' || p.reason === 'canonicalised') return p.reason;
  return null; // non-html (a PDF, a feed) is a deliberate target, not an equity sink
}

function redirectToNonIndexable(c: CheckContext): RawFinding[] {
  const final = finalPageLookup(c);
  const equity = equityLookup(c);
  const out: RawFinding[] = [];
  for (const r of redirectRecords(c)) {
    if (!inScope(r)) continue;
    // http->https or a trailing-slash hop onto the same URL: the URL itself is dead or noindex, which
    // broken-internal-links / traffic-to-dead-url / backlinks-to-404 report. Not a redirect pointing elsewhere.
    if (r.sourceKey === r.finalKey) continue;
    const fp = final(r.finalKey);
    if (!fp) continue; // final not crawled: no evidence either way
    const why = nonIndexableWhy(fp);
    if (!why) continue;
    const eq = equity(r.sourceKey);
    // A backlinked source that lands on a dead page is backlinks-to-404's (crit) finding; don't report it twice.
    if ((fp.status ?? 0) >= 400 && (eq.backlinks?.backlinks ?? 0) > 0) continue;
    out.push({ urlKey: r.sourceKey, evidence: {
      source: r.sourceUrl, finalUrl: fp.url, finalStatus: fp.status, finalReason: why,
      ...(why === 'canonicalised' ? { finalCanonicalisesTo: fp.canonicalKey } : {}),
      hops: r.chain.length || null, chain: hopsOut(r.chain), equity: eq, recordedIn: r.recordedIn,
    } });
  }
  return out.sort((a, b) => equityWeight(b.evidence.equity as Equity) - equityWeight(a.evidence.equity as Equity));
}

// ── redirect-to-homepage ─────────────────────────────────────────────────────────────────────
function redirectToHomepage(c: CheckContext): RawFinding[] {
  const final = finalPageLookup(c);
  const equity = equityLookup(c);
  const out: RawFinding[] = [];
  for (const r of redirectRecords(c)) {
    if (!inScope(r)) continue;
    const src = pathOf(r.sourceUrl), dst = pathOf(r.finalUrl);
    if (!src || !dst) continue;
    if (dst.path !== '/' || dst.search !== '') continue;       // lands on the bare homepage
    if (src.path === '/' || HOME_ALIAS.test(src.path)) continue; // the homepage under another name, or a locale root
    const fp = final(r.finalKey);
    if (fp && (rateLimited(fp) || fp.status == null)) continue;
    const eq = equity(r.sourceKey);
    out.push({ urlKey: r.sourceKey, evidence: {
      source: r.sourceUrl, finalUrl: r.finalUrl, firstStatus: r.firstStatus, hops: r.chain.length || null,
      equity: eq, hadEquity: eq.hasEquity,
      note: 'Google treats a deep URL redirected to the homepage as a soft 404: the old page\'s signals are not passed on' + (eq.hasEquity ? '; this URL had search traffic or links' : ''),
    } });
  }
  return out.sort((a, b) => equityWeight(b.evidence.equity as Equity) - equityWeight(a.evidence.equity as Equity));
}

// ── redirect-loop ────────────────────────────────────────────────────────────────────────────
function redirectLoop(c: CheckContext): RawFinding[] {
  const final = finalPageLookup(c);
  const out: RawFinding[] = [];
  for (const r of redirectRecords(c)) {
    if (!inScope(r) || !r.chain.length) continue;
    const revisits = loopPoint(r.chain);
    const fp = final(r.finalKey);
    const capped = unresolvedFinal(fp) && r.chain.length >= REDIRECT_HOP_CAP;
    if (!revisits && !capped) continue;
    out.push({ urlKey: r.sourceKey, evidence: {
      source: r.sourceUrl, kind: revisits ? 'loop' : 'hop-cap', ...(revisits ? { revisits } : {}),
      hops: r.chain.length, hopCap: REDIRECT_HOP_CAP, lastStatus: fp?.status ?? r.chain[r.chain.length - 1].status, chain: hopsOut(r.chain),
      note: revisits ? 'the chain comes back to a URL it already visited: browsers and Googlebot give up' : `still redirecting after ${REDIRECT_HOP_CAP} hops (the crawler's cap; Googlebot follows up to 10 before giving up)`,
    } });
  }
  return out;
}

// ── temporary-redirect-with-equity ───────────────────────────────────────────────────────────
function temporaryRedirectWithEquity(c: CheckContext): RawFinding[] {
  const equity = equityLookup(c);
  const out: RawFinding[] = [];
  for (const r of redirectRecords(c)) {
    if (!inScope(r) || r.firstStatus == null || !TEMPORARY_STATUSES.includes(r.firstStatus)) continue;
    const src = pathOf(r.sourceUrl);
    if (!src || src.path === '/') continue; // a homepage 302 to a locale/geo version is a deliberate, documented pattern
    if (loopPoint(r.chain)) continue;       // redirect-loop's
    const eq = equity(r.sourceKey);
    if (!eq.hasEquity) continue;
    out.push({ urlKey: r.sourceKey, evidence: {
      source: r.sourceUrl, status: r.firstStatus, finalUrl: r.finalUrl, hops: r.chain.length || null, chain: hopsOut(r.chain),
      equity: eq, rule: EQUITY_RULE,
    } });
  }
  return out.sort((a, b) => equityWeight(b.evidence.equity as Equity) - equityWeight(a.evidence.equity as Equity));
}

// ── redirect-retired + product-gone-404 (shared: 200 in an earlier crawl, 404/410 now) ───────
/** A store product URL: Shopify /products/<handle> (also under /collections/x/products/) or WooCommerce /product/<slug>. */
export const PRODUCT_PATH = /\/products?\/[^/?#]+/i;

export interface GoneUrl {
  urlKey: string; url: string; status: number; crawlId: string;
  lastLive: { crawlId: string; capturedAt: string; schemaTypes: string | null };
  isProduct: boolean; productBy: ('url' | 'schema')[];
}

/**
 * URLs the latest crawl fetched and got 404/410 for, which an EARLIER crawl's snapshot recorded as 200.
 * A URL absent from the latest crawl is not "gone": a partial or capped crawl just didn't reach it.
 */
export function goneSinceEarlierCrawl(c: CheckContext): GoneUrl[] {
  const statuses = GONE_STATUSES.join(',');
  return rows(c, `SELECT p.url_key urlKey, p.url, p.status_code status, p.crawl_id crawlId, s.crawl_id liveCrawl, s.captured_at liveAt, s.schema_types schemaTypes
      FROM pages p
      JOIN page_snapshots s ON s.url_key = p.url_key AND s.crawl_id <> p.crawl_id AND s.status_code = 200
      WHERE p.status_code IN (${statuses}) AND COALESCE(p.fetch_state,'') <> 'rate_limited'
        AND s.captured_at = (SELECT MAX(x.captured_at) FROM page_snapshots x WHERE x.url_key = p.url_key AND x.crawl_id <> p.crawl_id AND x.status_code = 200)`)
    .map(r => {
      const byUrl = PRODUCT_PATH.test(pathOf(r.url)?.path ?? r.urlKey);
      const bySchema = String(r.schemaTypes ?? '').split(',').some((t: string) => t.trim() === 'Product' || t.trim() === 'ProductGroup');
      return {
        urlKey: r.urlKey, url: r.url, status: r.status, crawlId: r.crawlId,
        lastLive: { crawlId: r.liveCrawl, capturedAt: r.liveAt, schemaTypes: r.schemaTypes || null },
        isProduct: byUrl || bySchema, productBy: [...(byUrl ? ['url' as const] : []), ...(bySchema ? ['schema' as const] : [])],
      };
    });
}

function redirectRetired(c: CheckContext): RawFinding[] {
  const equity = equityLookup(c);
  const out: RawFinding[] = [];
  for (const g of goneSinceEarlierCrawl(c)) {
    if (g.isProduct) continue; // product-gone-404 reports store products (ranked by lost clicks)
    const eq = equity(g.urlKey);
    if (!eq.hasEquity) continue;
    out.push({ urlKey: g.urlKey, evidence: {
      url: g.url, status: g.status, lastSeen200: g.lastLive, equity: eq, rule: EQUITY_RULE,
      note: `answered 200 in an earlier crawl and now answers ${g.status} with no redirect: its traffic and links now hit a dead end`,
    } });
  }
  return out.sort((a, b) => equityWeight(b.evidence.equity as Equity) - equityWeight(a.evidence.equity as Equity));
}

export const REDIRECT_CHECKS: CheckDef[] = [
  {
    id: 'redirect-to-non-indexable', category: 'crawlability', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'automated',
    title: 'Redirect lands on a non-indexable page',
    fix: 'This internal redirect ends on a page Google will not index: a 4xx/5xx, a noindex page, or a page canonicalised to another URL. Whatever the old URL earned is thrown away at the last hop. Point the redirect straight at the live, indexable, self-canonical page that replaces it (or fix the target).',
    run: redirectToNonIndexable,
  },
  {
    id: 'redirect-to-homepage', category: 'indexation', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Deep URL redirected to the homepage',
    fix: 'Google treats a removed page redirected to the homepage as a soft 404, so the old URL\'s rankings and links are not passed on. Redirect it to the closest equivalent page (the replacement product, the parent category, the updated article). If nothing is equivalent, let it return 404/410. Findings with search traffic or links are listed first.',
    run: redirectToHomepage,
  },
  {
    id: 'redirect-loop', category: 'crawlability', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Redirect loop or chain that never resolves',
    fix: 'This URL redirects in a circle, or is still redirecting after the crawler\'s hop cap: browsers show an error and Googlebot gives up, so the URL is a dead end for users and crawlers. Usually two rules disagree (trailing slash, http/https or www, an app redirect against a server redirect). Fix the rules so the URL resolves to a 200 in one hop.',
    run: redirectLoop,
  },
  {
    id: 'temporary-redirect-with-equity', category: 'crawlability', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Temporary redirect on a URL with traffic or links',
    fix: 'A 302/303/307 tells Google the move is temporary, so it may keep the old URL indexed and be slow to consolidate signals on the new one. This URL has search traffic, backlinks or internal links. If the move is permanent, make it a 301 (or 308), and repoint the internal links at the new URL.',
    run: temporaryRedirectWithEquity,
  },
  {
    id: 'redirect-retired', category: 'crawlability', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Live page removed without a redirect',
    fix: 'This URL answered 200 in an earlier crawl and now answers 404/410 with no redirect, yet it had search traffic or links. Usually a migration, a URL change or a cleanup that skipped the redirect map. 301 it to the closest live equivalent, or restore the page. Needs two crawls on different dates (page_snapshots). Store products are reported by product-gone-404 instead.',
    run: redirectRetired,
  },
];
