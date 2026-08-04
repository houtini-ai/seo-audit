import type Database from 'better-sqlite3';

/**
 * Market Sizing and Prioritisation - the organic market read that opens an engagement.
 *
 * Top-down Labs only, never bottom-up SERPs: ONE cached ranked_keywords pull per domain
 * (client + up to 4 competitors) unions into a keyword universe. Total demand = summed
 * search volume (deduplicated by keyword). Share of voice = each domain's ETV share of
 * the universe, overall and per topic cluster (lexical greedy clustering).
 *
 * Honesty: the competitor set and each domain's ranked keywords are deterministic (D -
 * the Labs index). ETV is DataForSEO's CTR-curve estimate - a modelled judgement (N);
 * the share-of-voice percentages inherit that. Volumes are Google Ads averages.
 */

export interface MarketDomainInput {
  domain: string;
  /** keyword → { volume, position, etv } for that domain */
  keywords: { keyword: string; volume: number | null; position: number | null; etv: number | null }[];
}

export interface MarketCluster {
  head: string;                     // highest-volume keyword in the cluster
  volume: number;                   // total unique-keyword search volume
  keywords: number;
  leader: string | null;            // domain with the highest ETV share in this cluster
  sov: Record<string, number>;      // domain → % of cluster ETV (0-100, rounded 0.1)
}

export interface MarketSizing {
  domains: string[];                // [client, ...competitors] - order preserved
  location: string | null;
  universeKeywords: number;         // unique keywords across all footprints
  universeVolume: number;           // total monthly demand (deduped)
  etvByDomain: Record<string, number>;
  sovByDomain: Record<string, number>; // overall ETV share %
  clusters: MarketCluster[];
  fetchedAt?: string;
}

const tokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1));

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
};

export function computeMarketSizing(inputs: MarketDomainInput[], location: string | null): MarketSizing {
  // Union the universe: keyword → volume + per-domain etv.
  interface U { volume: number; etv: Map<string, number> }
  const universe = new Map<string, U>();
  for (const d of inputs) {
    for (const k of d.keywords) {
      if (!k.keyword) continue;
      const key = k.keyword.toLowerCase();
      const u = universe.get(key) ?? { volume: 0, etv: new Map() };
      u.volume = Math.max(u.volume, k.volume ?? 0); // same keyword, same volume - max guards nulls
      if (k.etv != null && k.etv > 0) u.etv.set(d.domain, (u.etv.get(d.domain) ?? 0) + k.etv);
      universe.set(key, u);
    }
  }

  const domains = inputs.map(d => d.domain);
  const etvByDomain: Record<string, number> = Object.fromEntries(domains.map(d => [d, 0]));
  let universeVolume = 0;
  for (const u of universe.values()) {
    universeVolume += u.volume;
    for (const [d, e] of u.etv) etvByDomain[d] = (etvByDomain[d] ?? 0) + e;
  }
  const totalEtv = Object.values(etvByDomain).reduce((s, v) => s + v, 0) || 1;
  const sovByDomain: Record<string, number> = Object.fromEntries(
    domains.map(d => [d, Math.round((etvByDomain[d] / totalEtv) * 1000) / 10]));

  // Greedy lexical clustering of the universe (compare against cluster token pools, not O(n²)).
  interface W { tok: Set<string>; members: { key: string; u: U }[]; volume: number }
  const entries = [...universe.entries()].sort((a, b) => b[1].volume - a[1].volume);
  const clustersW: W[] = [];
  for (const [key, u] of entries) {
    const tok = tokens(key);
    let best: W | null = null; let bestJ = 0;
    for (const w of clustersW) { const j = jaccard(tok, w.tok); if (j > bestJ) { bestJ = j; best = w; } }
    if (best && bestJ >= 0.35) { best.members.push({ key, u }); best.volume += u.volume; for (const t of tok) best.tok.add(t); }
    else clustersW.push({ tok, members: [{ key, u }], volume: u.volume });
  }

  const clusters: MarketCluster[] = clustersW
    .filter(w => w.members.length >= 2 || w.volume >= 500)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 15)
    .map(w => {
      const clusterEtv: Record<string, number> = Object.fromEntries(domains.map(d => [d, 0]));
      for (const m of w.members) for (const [d, e] of m.u.etv) clusterEtv[d] = (clusterEtv[d] ?? 0) + e;
      const tot = Object.values(clusterEtv).reduce((s, v) => s + v, 0);
      const sov: Record<string, number> = Object.fromEntries(
        domains.map(d => [d, tot ? Math.round((clusterEtv[d] / tot) * 1000) / 10 : 0]));
      const leader = tot ? domains.reduce((a, b) => (clusterEtv[a] >= clusterEtv[b] ? a : b)) : null;
      return { head: w.members[0].key, volume: Math.round(w.volume), keywords: w.members.length, leader, sov };
    });

  return {
    domains, location,
    universeKeywords: universe.size,
    universeVolume: Math.round(universeVolume),
    etvByDomain: Object.fromEntries(domains.map(d => [d, Math.round(etvByDomain[d])])),
    sovByDomain, clusters,
  };
}

export function ensureMarketTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_sizing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,           -- JSON MarketSizing
      fetched_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function persistMarketSizing(db: Database.Database, m: MarketSizing): void {
  ensureMarketTable(db);
  db.prepare(`INSERT INTO market_sizing (payload) VALUES (?)`).run(JSON.stringify(m));
}

export function latestMarketSizing(db: Database.Database): MarketSizing | null {
  ensureMarketTable(db);
  const row = db.prepare(`SELECT payload, fetched_at FROM market_sizing ORDER BY id DESC LIMIT 1`).get() as { payload: string; fetched_at: string } | undefined;
  if (!row) return null;
  try { return { ...(JSON.parse(row.payload) as MarketSizing), fetchedAt: row.fetched_at }; } catch { return null; }
}
