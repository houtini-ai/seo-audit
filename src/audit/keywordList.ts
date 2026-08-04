import type Database from 'better-sqlite3';

/**
 * Demand-first keyword clustering ("list mode") - group a keyword list into topics and
 * give each cluster a verdict: OWN / WEAK / ABSENT, with the ranking URL.
 *
 * Clustering is GSC-bipartite first (free, deterministic, first-party): two keywords
 * belong together when Google already answers both with the SAME page - the strongest
 * possible clustering signal, and it costs nothing. Keywords the site has no GSC rows
 * for are grouped lexically (token Jaccard) - first into the nearest GSC cluster, else
 * among themselves.
 *
 * Verdicts are deterministic from GSC positions: OWN = best position <= 3, WEAK = 4-20,
 * ABSENT = no ranking page. Impressions stand in for demand (real, first-party); pass
 * the clusters through keyword_volume for market-level volumes when needed.
 */

export interface KeywordCluster {
  head: string;                 // representative keyword (highest impressions, else first)
  verdict: 'own' | 'weak' | 'absent';
  url: string | null;           // the page Google already associates with this cluster
  bestPosition: number | null;
  impressions: number;          // summed 90d impressions across member keywords
  clicks: number;
  keywords: { keyword: string; position: number | null; impressions: number; inGsc: boolean }[];
}

export interface KeywordListResult {
  clusters: KeywordCluster[];
  totalKeywords: number;
  inGsc: number;
  derived: boolean;             // true when the list came from GSC top queries, not the user
}

const tokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1));

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
};

export function clusterKeywordList(db: Database.Database, keywordsIn: string[] | undefined, opts?: { maxKeywords?: number; maxDate?: string | null }): KeywordListResult {
  const cap = opts?.maxKeywords ?? 2000;
  const derived = !keywordsIn?.length;
  const ub = opts?.maxDate ? `AND date <= '${opts.maxDate}'` : '';

  // No list supplied → derive the demand list from the site's own GSC queries (top by impressions).
  const keywords: string[] = derived
    ? (db.prepare(`SELECT query FROM search_analytics WHERE query IS NOT NULL AND date > date('now', '-90 days') ${ub}
                   GROUP BY query ORDER BY SUM(impressions) DESC LIMIT ?`).all(Math.min(cap, 500)) as { query: string }[]).map(r => r.query)
    : [...new Set(keywordsIn!.map(k => k.trim().toLowerCase()).filter(Boolean))].slice(0, cap);

  // Best ranking page per keyword (90d, impression-weighted position, top page by impressions).
  const stmt = db.prepare(`
    SELECT page_key url, SUM(impressions) imp, SUM(clicks) clk,
           SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
    FROM search_analytics
    WHERE query = ? AND page_key IS NOT NULL AND date > date('now', '-90 days') ${ub}
    GROUP BY page_key ORDER BY imp DESC LIMIT 1`);

  interface Row { keyword: string; url: string | null; pos: number | null; imp: number; clk: number; inGsc: boolean }
  const rows: Row[] = keywords.map(k => {
    const r = stmt.get(k) as { url: string; imp: number; clk: number; pos: number | null } | undefined;
    return r && r.imp > 0
      ? { keyword: k, url: r.url, pos: r.pos != null ? Math.round(r.pos * 10) / 10 : null, imp: r.imp, clk: r.clk, inGsc: true }
      : { keyword: k, url: null, pos: null, imp: 0, clk: 0, inGsc: false };
  });

  // 1) Bipartite: cluster by shared ranking URL.
  const byUrl = new Map<string, Row[]>();
  const orphans: Row[] = [];
  for (const r of rows) (r.url ? (byUrl.get(r.url) ?? byUrl.set(r.url, []).get(r.url)!) : orphans).push(r);

  interface Working { url: string | null; members: Row[]; tok: Set<string> }
  const working: Working[] = [...byUrl.entries()].map(([url, members]) => ({
    url, members, tok: new Set(members.flatMap(m => [...tokens(m.keyword)])),
  }));

  // 2) Lexical assignment for non-ranking keywords: nearest GSC cluster at Jaccard >= 0.4,
  //    else greedy-cluster among themselves (same threshold).
  const lexical: Working[] = [];
  for (const o of orphans) {
    const tok = tokens(o.keyword);
    let best: Working | null = null; let bestJ = 0;
    for (const w of working) { const j = jaccard(tok, w.tok); if (j > bestJ) { bestJ = j; best = w; } }
    if (best && bestJ >= 0.4) { best.members.push(o); for (const t of tok) best.tok.add(t); continue; }
    let lex: Working | null = null; let lexJ = 0;
    for (const w of lexical) { const j = jaccard(tok, w.tok); if (j > lexJ) { lexJ = j; lex = w; } }
    if (lex && lexJ >= 0.4) { lex.members.push(o); for (const t of tok) lex.tok.add(t); }
    else lexical.push({ url: null, members: [o], tok });
  }

  const clusters: KeywordCluster[] = [...working, ...lexical].map(w => {
    const withGsc = w.members.filter(m => m.inGsc);
    const bestPos = withGsc.length ? Math.min(...withGsc.map(m => m.pos ?? Infinity)) : null;
    const verdict: KeywordCluster['verdict'] = bestPos == null || !isFinite(bestPos) ? 'absent' : bestPos <= 3 ? 'own' : bestPos <= 20 ? 'weak' : 'weak';
    const sorted = [...w.members].sort((a, b) => b.imp - a.imp);
    return {
      head: sorted[0].keyword,
      verdict,
      url: w.url,
      bestPosition: bestPos != null && isFinite(bestPos) ? bestPos : null,
      impressions: w.members.reduce((s, m) => s + m.imp, 0),
      clicks: w.members.reduce((s, m) => s + m.clk, 0),
      keywords: sorted.map(m => ({ keyword: m.keyword, position: m.pos, impressions: m.imp, inGsc: m.inGsc })),
    };
  }).sort((a, b) => b.impressions - a.impressions || b.keywords.length - a.keywords.length);

  return { clusters, totalKeywords: rows.length, inGsc: rows.filter(r => r.inGsc).length, derived };
}
