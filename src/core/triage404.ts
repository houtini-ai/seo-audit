/**
 * 404 triage (#31). A crawl seeded from GSC reports every URL Google has seen, so the 404 list
 * mixes a few genuinely lost pages (traffic, backlinks: they need a 301) with many mangled
 * variants of real slugs from scraped or AI-rewritten links (a handful of impressions, no links:
 * noise). This classifies each 404 by discovery source, search traffic and backlinks, finds the
 * closest live URL by slug similarity, and buckets it: redirect / review / ignore.
 */
import type Database from 'better-sqlite3';
import { probeUrls, type ProbeResult } from './probeUrls.js';

export interface Triage404Row {
  urlKey: string;
  url: string;
  status: number;
  sources: string[];                 // internal-link | sitemap | gsc | backlink
  internalLinks: number;
  inSitemap: boolean;
  clicks: number;
  impressions: number;
  lastSeen: string | null;           // last GSC date with impressions
  backlinks: number;
  referringDomains: number;
  bestMatch: string | null;          // closest live, indexable URL
  score: number;                     // 0..1 slug similarity (token weights discount shared suffixes like buyers-guide)
  weakTarget?: boolean;              // bestMatch is a /tag/, /category/, /author/ or paginated archive
  bucket: 'redirect' | 'review' | 'ignore' | 'already-redirected' | 'live-now';
  reason: string;
  /** From verifyLive(): what the URL does right now. */
  live?: { status: number | null; finalUrl: string | null; chain: number[]; catchAll?: boolean; matchesSuggestion?: boolean };
}

export interface TriageOptions { minImpressions?: number; minScore?: number; limit?: number }

const WEAK_TARGET = /\/(tag|tags|category|categories|author|page)\/|\/page\/\d+\/?$/i;

const tokens = (path: string): string[] => path.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0);
const pathOf = (u: string): string => { try { return decodeURIComponent(new URL(u).pathname).toLowerCase(); } catch { return u.toLowerCase(); } };

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Token weights: how many live URLs each token appears in. Built once per site by tokenWeights(). */
export type TokenWeights = { df: Map<string, number>; n: number };
export function tokenWeights(liveUrls: string[]): TokenWeights {
  const df = new Map<string, number>();
  for (const u of liveUrls) for (const t of new Set(tokens(pathOf(u)))) df.set(t, (df.get(t) ?? 0) + 1);
  return { df, n: liveUrls.length };
}
// A token shared by many live URLs (buyers, guide, review, settings) says little about WHICH page a
// slug meant; a token on one or two pages (a brand, a model) says a lot. Smoothed IDF, floored so a
// token common to the whole site still counts a little. (#40)
const weightOf = (t: string, w?: TokenWeights): number => {
  if (!w || !w.n) return 1;
  const df = w.df.get(t) ?? 0;
  // Normalised so a token on one live page weighs 1 and a token on every page weighs the floor.
  const denom = Math.log((1 + w.n) / 2) || 1;
  return Math.min(1, Math.max(0.15, Math.log((1 + w.n) / (1 + df)) / denom));
};

/** Slug similarity: the better of weighted token overlap (reordered/extra words, rare tokens count
 *  more) and edit similarity (typos). Dice form: a renamed post that gained or lost a word keeps a fair score. */
export function slugSimilarity(a: string, b: string, w?: TokenWeights): number {
  const pa = pathOf(a).replace(/\/+$/, ''), pb = pathOf(b).replace(/\/+$/, '');
  const ta = new Set(tokens(pa)), tb = new Set(tokens(pb));
  let inter = 0, sa = 0, sb = 0;
  for (const t of ta) { const x = weightOf(t, w); sa += x; if (tb.has(t)) inter += x; }
  for (const t of tb) sb += weightOf(t, w);
  const dice = sa + sb ? (2 * inter) / (sa + sb) : 0;
  const lev = 1 - levenshtein(pa, pb) / Math.max(pa.length, pb.length, 1);
  return Math.max(dice, lev);
}

export function triage404s(db: Database.Database, opts: TriageOptions = {}): Triage404Row[] {
  const minImpressions = opts.minImpressions ?? 50;
  const minScore = opts.minScore ?? 0.6;
  const limit = opts.limit ?? 500;

  // No LIMIT here: value signals are cheap, so every 404 is scored and the limit applies AFTER sorting
  // by value. Truncating first dropped high-value 404s on GSC-seeded crawls with thousands of them.
  const dead = db.prepare(`SELECT url_key, url, status_code FROM pages WHERE is_internal=1 AND status_code IN (404, 410)`).all() as { url_key: string; url: string; status_code: number }[];
  if (!dead.length) return [];
  const live = db.prepare(`SELECT url FROM pages WHERE status_code=200 AND indexable=1`).all() as { url: string }[];
  const weights = tokenWeights(live.map(p => p.url));

  // Inverted index on meaningful tokens (≥3 chars) so only plausible candidates get edit distance.
  const byToken = new Map<string, number[]>();
  live.forEach((p, i) => { for (const t of new Set(tokens(pathOf(p.url)))) if (t.length >= 3) (byToken.get(t) ?? byToken.set(t, []).get(t)!).push(i); });

  const q = {
    links: db.prepare(`SELECT COUNT(DISTINCT source_key) n FROM links WHERE target_key=? AND is_internal=1`),
    sitemap: db.prepare(`SELECT 1 FROM sitemap_urls WHERE url_key=? LIMIT 1`),
    gsc: db.prepare(`SELECT COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i, MAX(CASE WHEN impressions>0 THEN date END) last FROM search_analytics WHERE page_key=?`),
    bl: db.prepare(`SELECT backlinks, referring_domains FROM page_backlinks WHERE url_key=?`),
  };
  const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } }; // tables absent on a crawl-only DB

  const scored = dead.map(d => {
    const internalLinks = (q.links.get(d.url_key) as { n: number }).n;
    const inSitemap = safe(() => !!q.sitemap.get(d.url_key), false);
    const g = safe(() => q.gsc.get(d.url_key) as { c: number; i: number; last: string | null }, { c: 0, i: 0, last: null });
    const b = safe(() => q.bl.get(d.url_key) as { backlinks: number; referring_domains: number } | undefined, undefined);
    return { d, internalLinks, inSitemap, g, backlinks: b?.backlinks ?? 0, referringDomains: b?.referring_domains ?? 0 };
  }).sort((a, b) => (b.g.c - a.g.c) || (b.referringDomains - a.referringDomains) || (b.g.i - a.g.i) || (b.internalLinks - a.internalLinks)).slice(0, limit);

  return scored.map(({ d, internalLinks, inSitemap, g, backlinks, referringDomains }) => {

    // Candidates: share a meaningful token; ranked by shared-token count, top 300 get edit distance.
    const counts = new Map<number, number>();
    for (const t of new Set(tokens(pathOf(d.url)))) if (t.length >= 3) for (const i of byToken.get(t) ?? []) counts.set(i, (counts.get(i) ?? 0) + 1);
    let bestMatch: string | null = null, score = 0;
    for (const [i] of [...counts].sort((x, y) => y[1] - x[1]).slice(0, 300)) {
      // Archives (/tag/, /category/, /author/, paginated) are weak 301 targets: thin, often noindexed.
      const s = slugSimilarity(d.url, live[i].url, weights) * (WEAK_TARGET.test(pathOf(live[i].url)) ? 0.75 : 1);
      if (s > score) { score = s; bestMatch = live[i].url; }
    }
    score = Math.round(score * 100) / 100;
    const weakTarget = !!bestMatch && WEAK_TARGET.test(pathOf(bestMatch));

    const sources = [internalLinks ? 'internal-link' : '', inSitemap ? 'sitemap' : '', g.i > 0 ? 'gsc' : '', backlinks > 0 ? 'backlink' : ''].filter(Boolean);
    const valuable = g.c > 0 || g.i >= minImpressions || referringDomains > 0;
    const linked = internalLinks > 0 || inSitemap;
    let bucket: Triage404Row['bucket'], reason: string;
    if (valuable && bestMatch && score >= minScore) {
      bucket = 'redirect';
      reason = `${[g.c ? `${g.c} clicks` : '', g.i ? `${g.i} impressions` : '', referringDomains ? `${referringDomains} referring domains` : ''].filter(Boolean).join(', ')}; confident match (${score})${weakTarget ? '; target is an archive page, prefer a content page if one fits' : ''}`;
    } else if (!valuable && !linked && backlinks === 0 && g.i < 10) {
      bucket = 'ignore';
      reason = `${g.i} impressions, no clicks, no internal links, not in sitemap, no backlinks${score >= minScore ? `: likely a mangled variant of ${bestMatch}` : ''}`;
    } else {
      bucket = 'review';
      reason = valuable ? `has value but no confident match (best ${score})` : linked ? `${internalLinks ? `${internalLinks} internal link(s) point here: fix them at source` : 'listed in the sitemap: remove it'}` : 'some signal; check by hand';
    }
    return { urlKey: d.url_key, url: d.url, status: d.status_code, sources, internalLinks, inSitemap, clicks: g.c, impressions: g.i, lastSeen: g.last, backlinks, referringDomains, bestMatch, score, ...(weakTarget ? { weakTarget } : {}), bucket, reason };
  }).sort((a, b) => (b.clicks - a.clicks) || (b.referringDomains - a.referringDomains) || (b.impressions - a.impressions));
}

/**
 * Live check (#40): the crawl's 404 list is as old as the crawl, and redirects get added between
 * crawls. Probe the redirect and review candidates now; a URL that already 3xx's to a live page
 * moves to `already-redirected` (with its live destination, so a wrong suggestion never replaces a
 * right redirect), and one that now answers 200 moves to `live-now`. Capped and time-boxed; URLs
 * not reached keep their stored bucket.
 */
export async function verifyLive(rows: Triage404Row[], baseHost: string, opts: { max?: number; budgetMs?: number; probe?: typeof probeUrls } = {}): Promise<{ rows: Triage404Row[]; probed: number; candidates: number }> {
  const candidates = rows.filter(r => r.bucket === 'redirect' || r.bucket === 'review').slice(0, opts.max ?? 50);
  if (!candidates.length) return { rows, probed: 0, candidates: 0 };
  const results = await (opts.probe ?? probeUrls)(candidates.map(c => ({ url: c.url })), baseHost, { followRedirects: true, concurrency: 4, budgetMs: opts.budgetMs ?? 30000 });
  const byUrl = new Map<string, ProbeResult>(results.map(r => [r.url, r]));
  let probed = 0;
  const out = rows.map(r => {
    const p = byUrl.get(r.url);
    if (!p || p.error || p.finalStatus == null) return r;
    probed++;
    const live = { status: p.status, finalUrl: p.finalUrl, chain: p.redirectChain.map(h => h.status) };
    if (p.redirectChain.length && p.finalStatus < 400) {
      // Where did it land? A redirect to the site root is almost always a blanket 404→homepage
      // rule, not a considered redirect: the specific target is still worth setting, so the row
      // keeps its bucket and the live fact is attached. A redirect to the suggested target (or
      // any other real page) is a redirect somebody already made.
      const landedPath = pathOf(p.finalUrl ?? '').replace(/\/+$/, '');
      const sourcePath = pathOf(r.url).replace(/\/+$/, '');
      const catchAll = landedPath === '' && sourcePath !== '';
      const matchesSuggestion = !!r.bestMatch && pathOf(p.finalUrl ?? '').replace(/\/+$/, '') === pathOf(r.bestMatch).replace(/\/+$/, '');
      if (catchAll) {
        return { ...r, live: { ...live, catchAll: true }, reason: `${r.reason}. Live it ${live.chain.join('→')}s to the homepage (a catch-all rule, not a specific redirect): a specific 301${r.bestMatch ? ` to ${r.bestMatch}` : ''} still helps.` };
      }
      // An off-property destination was recorded, not fetched (probe_urls' own-host guard), so don't
      // call it live - say where it goes and that it went unchecked.
      const offSite = p.redirectsOffProperty ? ` - off the property, so the destination was not checked` : '';
      return { ...r, live: { ...live, matchesSuggestion }, bucket: 'already-redirected' as const,
        reason: matchesSuggestion
          ? `already redirects live (${live.chain.join('→')}) to the suggested target; the crawl predates it. Nothing to do.`
          : `already redirects ${offSite ? '' : 'live '}(${live.chain.join('→')}) to ${p.finalUrl}${offSite}; the crawl predates it. Nothing to do unless that destination is wrong${r.bestMatch && r.bucket === 'redirect' ? ` (slug match suggested ${r.bestMatch} instead)` : ''}.` };
    }
    if (!p.redirectChain.length && p.finalStatus < 400) {
      return { ...r, live, bucket: 'live-now' as const, reason: `answers ${p.finalStatus} live now; the crawl is stale. Re-crawl to clear it.` };
    }
    return { ...r, live };
  });
  return { rows: out, probed, candidates: candidates.length };
}
