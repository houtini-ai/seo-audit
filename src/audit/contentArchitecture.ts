import type Database from 'better-sqlite3';
import { gscFreshness } from '../core/gscFreshness.js';
import { tokenize, jaccard } from './lexical.js';

/**
 * Content architecture (topic clusters) - the whole topical picture, not just the gaps.
 *
 * suggestPages() clusters only the surviving GAP queries (demand with no winning page).
 * This clusters the FULL significant demand so we can show each topic cluster as a pillar
 * with supporting members, each classified covered / thin / gap, with a funnel read, a
 * coverage %, the concrete gaps, and simple pillar<->member link suggestions.
 *
 * GSC-first by design (our entity layer is thin): clusters come from query demand + the
 * pages that serve it. Computable from stored GSC + crawl - no paid calls. Entity labels
 * are layered on by the caller where page_entity resolved.
 */

export interface TopicCluster {
  id: string;
  pillar: { label: string; page: string | null; impressions: number };
  funnel: 'informational' | 'commercial' | 'transactional' | 'navigational' | 'mixed' | 'unknown';
  members: { topic: string; page: string | null; impressions: number; position: number; status: 'covered' | 'thin' | 'gap' }[];
  gaps: { topic: string; impressions: number; nearestPage: string | null }[];
  linkSuggestions: { from: string; to: string }[];
  coverage: number;          // % of cluster impressions served by a page ranking <= 10
  totalImpressions: number;
}

interface Opts { minImpressions?: number; maxQueries?: number; maxClusters?: number; clusterThreshold?: number; maxDate?: string }

const FUNNELS = new Set(['informational', 'commercial', 'transactional', 'navigational']);

export function contentArchitecture(db: Database.Database, opts: Opts = {}): { clusters: TopicCluster[]; totalClusters: number } {
  const minImpr = opts.minImpressions ?? 50;
  const maxQueries = opts.maxQueries ?? 500;
  const clusterT = opts.clusterThreshold ?? 0.5;
  // Reuse the caller's finalised max date when given (dashboardData already computed it) - avoids a
  // second full GROUP BY date scan of search_analytics on every dashboard rebuild.
  const maxDate = opts.maxDate ?? gscFreshness(db).effectiveMax;
  if (!maxDate) return { clusters: [], totalClusters: 0 };
  const win = `date > date('${maxDate}', '-28 days') AND date <= '${maxDate}'`;

  // Demand per query x page (impression-weighted position).
  const qp = db.prepare(
    `SELECT query, page_key, SUM(impressions) impr, SUM(clicks) clicks,
            SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
     FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win}
     GROUP BY query, page_key`,
  ).all() as { query: string; page_key: string; impr: number; clicks: number; pos: number }[];
  if (!qp.length) return { clusters: [], totalClusters: 0 };

  // Collapse to per-query: total impressions, the best-ranking page + its position.
  interface Q { query: string; toks: Set<string>; impr: number; topPage: string | null; bestPos: number }
  const byQuery = new Map<string, { impr: number; pages: { key: string; impr: number; pos: number }[] }>();
  for (const r of qp) {
    let q = byQuery.get(r.query);
    if (!q) { q = { impr: 0, pages: [] }; byQuery.set(r.query, q); }
    q.impr += r.impr;
    q.pages.push({ key: r.page_key, impr: r.impr, pos: r.pos });
  }
  const queries: Q[] = [];
  for (const [query, q] of byQuery) {
    if (q.impr < minImpr) continue;
    const toks = new Set(tokenize(query));
    if (!toks.size) continue;
    const topPage = q.pages.reduce((a, b) => (b.impr > a.impr ? b : a));           // page that earns the most for this query
    const bestPos = Math.min(...q.pages.map(p => p.pos ?? 999));                     // our best position (a null impression-weighted pos can't count as rank 0)
    queries.push({ query, toks, impr: q.impr, topPage: topPage.key, bestPos });
  }
  if (!queries.length) return { clusters: [], totalClusters: 0 };
  queries.sort((a, b) => b.impr - a.impr);
  const head = queries.slice(0, maxQueries);

  // Persisted intent (optional) for the funnel read.
  const intentOf = new Map<string, string>();
  try { for (const r of db.prepare('SELECT keyword, intent FROM keyword_intent').all() as { keyword: string; intent: string }[]) intentOf.set(r.keyword, r.intent); } catch { /* no table */ }

  // Greedy lexical clustering over the whole head-demand (head term = highest-impression query).
  interface C { head: Q; toks: Set<string>; members: Q[]; impr: number }
  const clusters: C[] = [];
  for (const q of head) {
    const c = clusters.find(c => jaccard(q.toks, c.toks) >= clusterT);
    if (c) { c.members.push(q); for (const t of q.toks) c.toks.add(t); c.impr += q.impr; }
    else clusters.push({ head: q, toks: new Set(q.toks), members: [q], impr: q.impr });
  }

  const status = (pos: number): 'covered' | 'thin' | 'gap' => pos <= 10 ? 'covered' : pos <= 20 ? 'thin' : 'gap';
  const out: TopicCluster[] = clusters
    .filter(c => c.members.length >= 2)                     // a single query is not a cluster
    .sort((a, b) => b.impr - a.impr)
    .slice(0, opts.maxClusters ?? 40)
    .map((c, idx) => {
      const members = c.members.slice().sort((a, b) => b.impr - a.impr);
      // funnel: impression-weighted dominant intent across the cluster's queries.
      const intentW = new Map<string, number>();
      for (const m of members) { const it = intentOf.get(m.query.toLowerCase()); if (it) intentW.set(it, (intentW.get(it) ?? 0) + m.impr); }
      let funnel: TopicCluster['funnel'] = 'unknown';
      if (intentW.size) {
        const total = [...intentW.values()].reduce((s, v) => s + v, 0);
        const top = [...intentW.entries()].sort((a, b) => b[1] - a[1])[0];
        funnel = (top[1] / total >= 0.6 && FUNNELS.has(top[0])) ? (top[0] as TopicCluster['funnel']) : 'mixed';
      }
      const covered = members.filter(m => status(m.bestPos) === 'covered').reduce((s, m) => s + m.impr, 0);
      // nearestPage = the page already associated with the gap query in GSC (where to improve / link from).
      const gaps = members.filter(m => status(m.bestPos) === 'gap')
        .slice(0, 6)
        .map(m => ({ topic: m.query, impressions: m.impr, nearestPage: m.topPage }));
      // Simple link suggestions: interlink the pillar page with the distinct member pages (V1).
      const pillarPage = c.head.topPage;
      const seen = new Set<string>();
      const linkSuggestions: { from: string; to: string }[] = [];
      if (pillarPage) for (const m of members) {
        if (m.topPage && m.topPage !== pillarPage && !seen.has(m.topPage)) { seen.add(m.topPage); linkSuggestions.push({ from: pillarPage, to: m.topPage }); }
        if (linkSuggestions.length >= 8) break;
      }
      return {
        id: `tc${idx + 1}`,
        pillar: { label: c.head.query, page: c.head.topPage, impressions: c.head.impr },
        funnel,
        members: members.slice(0, 12).map(m => ({ topic: m.query, page: m.topPage, impressions: m.impr, position: Math.round(m.bestPos * 10) / 10, status: status(m.bestPos) })),
        gaps,
        linkSuggestions,
        coverage: Math.round((covered / c.impr) * 100),
        totalImpressions: c.impr,
      };
    });

  return { clusters: out, totalClusters: clusters.filter(c => c.members.length >= 2).length };
}
