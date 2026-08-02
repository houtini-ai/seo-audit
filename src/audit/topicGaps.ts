import type Database from 'better-sqlite3';

/**
 * Topic-gap engine — "what related topics should this site cover to be expert in its
 * space?" Competitor keyword footprints (DataForSEO Labs ranked_keywords, fetched by
 * the caller — this module makes NO paid calls) minus OUR footprint:
 *   A. every distinct query we already earn impressions for in search_analytics, and
 *   B. lexical near-matches against our page titles / H1s / slugs (≥70% token cover),
 * then the survivors are clustered lexically (same tokenise + greedy-Jaccard approach
 * as opportunities.ts) and scored by summed search volume × competitor coverage.
 * If the entity layer is populated (page_entity + entity_edge), clusters whose terms
 * sit beside entities we already cover are annotated — stored edges only, no live
 * Wikidata calls.
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

/** One competitor keyword row (normalised from a Labs ranked_keywords item by the caller). */
export interface GapKeywordRow {
  keyword: string;
  searchVolume: number | null;
  etv: number | null;
  position: number | null;
  url: string | null;       // the competitor URL ranking for this keyword
  competitor: string;       // competitor domain the row came from
}

export interface TopicCluster {
  headTerm: string;                 // highest-volume keyword in the cluster
  totalVolume: number;              // summed monthly search volume
  competitorCoverage: number;       // distinct competitors ranking in this cluster
  score: number;                    // totalVolume × competitorCoverage
  ownedBy: string;                  // competitor with the most volume in the cluster
  exampleUrl: string | null;        // that competitor's ranking URL for the head term (or best keyword)
  keywords: { keyword: string; searchVolume: number | null; competitor: string }[];
  nearestExistingPage: { url: string; title: string | null } | null; // best title/H1/slug token overlap
  entityNote: string | null;        // stored-entity adjacency annotation (no live calls)
  why: string;                      // one-line rationale
}

export interface TopicGapsResult {
  clusters: TopicCluster[];
  competitorKeywords: number;       // rows in, before subtraction
  ourQueryCount: number;            // distinct GSC queries used for subtraction
  afterSubtraction: number;         // surviving gap keywords
}

interface Opts { limit?: number; clusterThreshold?: number }

export function computeTopicGaps(db: Database.Database, rows: GapKeywordRow[], opts: Opts = {}): TopicGapsResult {
  const limit = opts.limit ?? 15;
  const clusterT = opts.clusterThreshold ?? 0.5;

  // ── OUR footprint, part A: every distinct query we already get impressions for.
  const ourQueries = new Set<string>();
  for (const r of db.prepare(
    `SELECT DISTINCT lower(query) q FROM search_analytics WHERE query IS NOT NULL AND impressions > 0`,
  ).iterate() as IterableIterator<{ q: string }>) ourQueries.add(r.q);

  // ── OUR footprint, part B: page vocabulary (title + H1 + slug) → inverted index,
  //    same 70%-coverage subtraction as opportunities.ts.
  const pages = db.prepare(`SELECT url_key, url, title, h1 FROM pages WHERE status_code = 200`).all() as
    { url_key: string; url: string; title: string | null; h1: string | null }[];
  const pageTokens = pages.map(p => {
    const slug = (() => { try { return decodeURIComponent(new URL(p.url).pathname).replace(/[-_/]+/g, ' '); } catch { return ''; } })();
    return { url: p.url, title: p.title, toks: new Set(tokenize(`${p.title ?? ''} ${p.h1 ?? ''} ${slug}`)) };
  });
  const invIndex = new Map<string, number[]>();
  pageTokens.forEach((pt, i) => { for (const t of pt.toks) (invIndex.get(t) ?? invIndex.set(t, []).get(t)!).push(i); });
  const bestPageCover = (toks: string[]): { cover: number; idx: number } => {
    const hits = new Map<number, number>();
    for (const t of toks) for (const i of invIndex.get(t) ?? []) hits.set(i, (hits.get(i) ?? 0) + 1);
    let cover = 0, idx = -1;
    for (const [i, n] of hits) { const c = n / Math.max(toks.length, 1); if (c > cover) { cover = c; idx = i; } }
    return { cover, idx };
  };

  // ── Merge duplicate keywords across competitors (keep every competitor's evidence).
  interface Merged { keyword: string; toks: string[]; volume: number; byCompetitor: Map<string, { volume: number; url: string | null }> }
  const byKeyword = new Map<string, Merged>();
  for (const r of rows) {
    const kw = r.keyword.trim().toLowerCase();
    if (!kw) continue;
    let m = byKeyword.get(kw);
    if (!m) { m = { keyword: kw, toks: tokenize(kw), volume: 0, byCompetitor: new Map() }; byKeyword.set(kw, m); }
    m.volume = Math.max(m.volume, r.searchVolume ?? 0);
    const prev = m.byCompetitor.get(r.competitor);
    if (!prev || (r.searchVolume ?? 0) >= prev.volume) m.byCompetitor.set(r.competitor, { volume: r.searchVolume ?? 0, url: r.url ?? prev?.url ?? null });
  }

  // ── Subtraction: drop what we already have (GSC query, or a page that near-covers it).
  const survivors: Merged[] = [];
  for (const m of byKeyword.values()) {
    if (!m.toks.length) continue;
    if (ourQueries.has(m.keyword)) continue;                       // A: we already surface for it
    if (bestPageCover(m.toks).cover >= 0.7) continue;              // B: an existing page near-covers it
    survivors.push(m);
  }

  // ── Cluster survivors lexically (greedy Jaccard, volume-first so heads are the big terms).
  survivors.sort((a, b) => b.volume - a.volume);
  interface Cluster { head: Merged; toks: Set<string>; members: Merged[] }
  const clusters: Cluster[] = [];
  for (const s of survivors) {
    const st = new Set(s.toks);
    const c = clusters.find(c => jaccard(st, c.toks) >= clusterT);
    if (c) { c.members.push(s); for (const t of s.toks) c.toks.add(t); }
    else clusters.push({ head: s, toks: new Set(s.toks), members: [s] });
  }

  // ── Entity adjacency (stored data only): our covered entities that share a parent —
  //    a cluster matching one of those labels slots into a topic family we already cover.
  const entityLabels: { label: string; toks: Set<string>; qid: string }[] = [];
  try {
    const covered = db.prepare(`SELECT url_key, qid, label FROM page_entity WHERE label IS NOT NULL`).all() as
      { url_key: string; qid: string; label: string }[];
    if (covered.length) {
      const coveredQids = new Set(covered.map(c => c.qid));
      const edges = db.prepare(`SELECT qid, related_qid FROM entity_edge`).all() as { qid: string; related_qid: string }[];
      const parentsCovered = new Set(edges.filter(e => coveredQids.has(e.qid)).map(e => e.related_qid));
      const siblingQids = new Set(edges.filter(e => parentsCovered.has(e.related_qid)).map(e => e.qid));
      for (const c of covered) {
        if (!siblingQids.has(c.qid)) continue;
        const toks = new Set(tokenize(c.label));
        if (toks.size) entityLabels.push({ label: c.label, toks, qid: c.qid });
      }
    }
  } catch { /* entity tables absent on old DBs — annotation simply skipped */ }
  const entityNoteFor = (clusterToks: Set<string>): string | null => {
    let best: { label: string; overlap: number } | null = null;
    for (const e of entityLabels) {
      let inter = 0;
      for (const t of e.toks) if (clusterToks.has(t)) inter++;
      const overlap = inter / e.toks.size;
      if (overlap >= 0.5 && (!best || overlap > best.overlap)) best = { label: e.label, overlap };
    }
    return best ? `sits beside "${best.label}" in your entity graph (shared parent topic already covered)` : null;
  };

  // ── Score + shape the output clusters.
  const out: TopicCluster[] = clusters.map(c => {
    const volByCompetitor = new Map<string, number>();
    let totalVolume = 0;
    for (const m of c.members) {
      totalVolume += m.volume;
      for (const [comp, v] of m.byCompetitor) volByCompetitor.set(comp, (volByCompetitor.get(comp) ?? 0) + v.volume);
    }
    const coverage = volByCompetitor.size;
    const ownedBy = [...volByCompetitor.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    // Example URL: the owner's URL for the head term, else the owner's highest-volume member.
    const exampleUrl =
      c.head.byCompetitor.get(ownedBy)?.url ??
      c.members.map(m => m.byCompetitor.get(ownedBy)?.url).find(u => u != null) ?? null;
    const near = bestPageCover([...c.toks]);
    const nearest = near.idx >= 0 && near.cover > 0
      ? { url: pageTokens[near.idx].url, title: pageTokens[near.idx].title }
      : null;
    const keywords = c.members
      .map(m => ({
        keyword: m.keyword,
        searchVolume: m.volume || null,
        competitor: [...m.byCompetitor.entries()].sort((a, b) => b[1].volume - a[1].volume)[0]?.[0] ?? ownedBy,
      }));
    const why = `${ownedBy} ranks for ${c.members.length} keyword${c.members.length === 1 ? '' : 's'} here (~${totalVolume.toLocaleString('en-US')}/mo searches${coverage > 1 ? `, ${coverage} competitors present` : ''}) and you currently surface for none of them.`;
    return {
      headTerm: c.head.keyword,
      totalVolume,
      competitorCoverage: coverage,
      score: totalVolume * Math.max(coverage, 1),
      ownedBy,
      exampleUrl,
      keywords,
      nearestExistingPage: nearest,
      entityNote: entityNoteFor(c.toks),
      why,
    };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    clusters: out,
    competitorKeywords: byKeyword.size,
    ourQueryCount: ourQueries.size,
    afterSubtraction: survivors.length,
  };
}
