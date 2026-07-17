import type Database from 'better-sqlite3';
import { gscFreshness } from '../core/gscFreshness.js';

/**
 * New-page opportunity engine (Phase 6c). Grounded in REAL demand (GSC), with ruthless
 * subtraction so we never propose a page that already exists. Computable from stored
 * GSC + crawl data — no paid calls. (SERP-overlap clustering and search-volume/intent
 * scoring are refinements layered on via DataForSEO when available.)
 *
 * Pipeline: demand universe (queries we get impressions for but rank 11+ → no winning page)
 * → subtract (A: we already rank ≤10; B: a page already covers ≥70% of the query's words;
 * C: one URL owns >80% of the query's impressions → that's an optimisation, not a new page)
 * → cluster surviving queries lexically → score by impressions × intent → attach evidence.
 */
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'your', 'you', 'is', 'are', 'best', 'how', 'what', 'vs', 'why', 'can', 'my', 'i', 'it']);
const tokenize = (s: string): string[] =>
  (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t.length >= 2 && !STOP.has(t));
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};
const INTENT_MULT: Record<string, number> = { transactional: 1, commercial: 0.8, informational: 0.3, navigational: 0.1 };

export interface PageProposal {
  headTerm: string;
  queries: string[];
  totalImpressions: number;
  totalClicks: number;
  bestPosition: number;       // best (lowest) impression-weighted position we currently hold
  intent: string | null;
  score: number;
  nearestExistingPage: string | null; // closest existing page (to link the new page from), if any
}

interface Opts { minImpressions?: number; maxProposals?: number; clusterThreshold?: number }

export function suggestPages(db: Database.Database, opts: Opts = {}): { proposals: PageProposal[]; consideredQueries: number; afterDedup: number } {
  const minImpr = opts.minImpressions ?? 50;
  const clusterT = opts.clusterThreshold ?? 0.5;
  // Window off the FINALISED max date (raw MAX(date) includes 1–3 unfinalised, systematically
  // low days that deflate impressions and can shift a query across the rank/dominance thresholds).
  const maxDate = gscFreshness(db).effectiveMax;
  if (!maxDate) return { proposals: [], consideredQueries: 0, afterDedup: 0 };
  const win = `date > date('${maxDate}', '-28 days') AND date <= '${maxDate}'`;

  // Demand: per query × page (impression-weighted position).
  const qp = db.prepare(
    `SELECT query, page_key, SUM(impressions) impr, SUM(clicks) clicks,
            SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
     FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win}
     GROUP BY query, page_key`,
  ).all() as { query: string; page_key: string; impr: number; clicks: number; pos: number }[];

  const byQuery = new Map<string, { totalImpr: number; totalClicks: number; best: number; topPageShare: number; pages: { key: string; impr: number; pos: number }[] }>();
  for (const r of qp) {
    let q = byQuery.get(r.query);
    if (!q) { q = { totalImpr: 0, totalClicks: 0, best: 999, topPageShare: 0, pages: [] }; byQuery.set(r.query, q); }
    q.totalImpr += r.impr; q.totalClicks += r.clicks;
    q.best = Math.min(q.best, r.pos);
    q.pages.push({ key: r.page_key, impr: r.impr, pos: r.pos });
  }

  // Existing-page vocabulary (title + h1 + url slug) → inverted index for the 70% dedup.
  const pages = db.prepare(`SELECT url_key, title, h1, url FROM pages WHERE status_code=200`).all() as { url_key: string; title: string | null; h1: string | null; url: string }[];
  const pageTokens: { key: string; toks: Set<string> }[] = pages.map(p => {
    const slug = (() => { try { return decodeURIComponent(new URL(p.url).pathname).replace(/[-_/]+/g, ' '); } catch { return ''; } })();
    return { key: p.url_key, toks: new Set(tokenize(`${p.title ?? ''} ${p.h1 ?? ''} ${slug}`)) };
  });
  const invIndex = new Map<string, number[]>();
  pageTokens.forEach((pt, i) => { for (const t of pt.toks) (invIndex.get(t) ?? invIndex.set(t, []).get(t)!).push(i); });

  // Persisted intent (optional) for scoring.
  const intentOf = new Map<string, string>();
  try {
    for (const r of db.prepare('SELECT keyword, intent FROM keyword_intent').all() as { keyword: string; intent: string }[]) intentOf.set(r.keyword, r.intent);
  } catch { /* table may not exist on very old DBs */ }

  // Subtraction.
  const survivors: { query: string; toks: Set<string>; impr: number; clicks: number; best: number }[] = [];
  for (const [query, q] of byQuery) {
    if (q.totalImpr < minImpr) continue;
    if (q.best <= 10) continue;                                   // A: we already rank on page 1
    // C: one URL owns >80% of impressions AND is a genuine contender (ranks ≤15) → optimise
    // that page, don't spawn a new one. (Gated on rank so an incidental single-page mention at
    // position 30 doesn't suppress a real gap — long-tail queries usually surface one page.)
    const dominant = q.pages.reduce((a, b) => (b.impr > a.impr ? b : a));
    if (dominant.impr / q.totalImpr > 0.8 && dominant.pos <= 15) continue;
    const qt = tokenize(query);
    if (!qt.length) continue;
    // B: does any existing page already cover ≥70% of the query's words?
    const hits = new Map<number, number>();
    for (const t of qt) for (const i of invIndex.get(t) ?? []) hits.set(i, (hits.get(i) ?? 0) + 1);
    let maxCover = 0;
    for (const [, n] of hits) { const cover = n / qt.length; if (cover > maxCover) maxCover = cover; }
    if (maxCover >= 0.7) continue;                                // page exists → optimisation, not a new page
    survivors.push({ query, toks: new Set(qt), impr: q.totalImpr, clicks: q.totalClicks, best: q.best });
  }

  // Cluster survivors lexically (greedy Jaccard); head term = highest-impression query.
  survivors.sort((a, b) => b.impr - a.impr);
  interface Cluster { headTerm: string; toks: Set<string>; queries: string[]; impr: number; clicks: number; best: number }
  const clusters: Cluster[] = [];
  for (const s of survivors) {
    const c = clusters.find(c => jaccard(s.toks, c.toks) >= clusterT);
    if (c) { c.queries.push(s.query); for (const t of s.toks) c.toks.add(t); c.impr += s.impr; c.clicks += s.clicks; c.best = Math.min(c.best, s.best); }
    else clusters.push({ headTerm: s.query, toks: new Set(s.toks), queries: [s.query], impr: s.impr, clicks: s.clicks, best: s.best });
  }

  const proposals: PageProposal[] = clusters.map(c => {
    const intent = intentOf.get(c.headTerm.toLowerCase()) ?? null;
    const mult = intent ? (INTENT_MULT[intent] ?? 0.5) : 0.5;
    // nearest existing page: best partial token coverage of the head term (where to add a link).
    const ht = tokenize(c.headTerm); let cover = 0, nearestKey: string | null = null;
    const hits = new Map<number, number>();
    for (const t of ht) for (const i of invIndex.get(t) ?? []) hits.set(i, (hits.get(i) ?? 0) + 1);
    for (const [i, n] of hits) { const cv = n / Math.max(ht.length, 1); if (cv > cover) { cover = cv; nearestKey = pageTokens[i].key; } }
    return {
      headTerm: c.headTerm,
      queries: c.queries.slice(0, 20),
      totalImpressions: c.impr,
      totalClicks: c.clicks,
      bestPosition: Math.round(c.best * 10) / 10,
      intent,
      score: Math.round(c.impr * mult),
      nearestExistingPage: nearestKey,
    };
  }).sort((a, b) => b.score - a.score).slice(0, opts.maxProposals ?? 50);

  return { proposals, consideredQueries: byQuery.size, afterDedup: survivors.length };
}
