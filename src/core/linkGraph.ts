import type Database from 'better-sqlite3';

/**
 * Post-crawl link-graph metrics, computed in-process from the `links` table (no new infra):
 *  - **iPR** — internal PageRank (weighted: nav/footer links count ×0.2, body ×1), log-
 *    normalised to 0–100. Surfaces where internal authority concentrates (research/14 §1).
 *  - **click_depth** — shortest path from the homepage following BODY links only (the
 *    "honest" depth; nav/footer would make everything depth-1). null = unreachable via body.
 * Writes both back to pages.ipr / pages.click_depth for the crawl.
 */
export function computeLinkGraph(db: Database.Database, crawlId: string, seedKey: string | null): void {
  const nodes = (db.prepare('SELECT url_key FROM pages WHERE crawl_id=?').all(crawlId) as { url_key: string }[]).map(r => r.url_key);
  const N = nodes.length;
  if (N === 0) return;
  const idx = new Map(nodes.map((n, i) => [n, i]));

  const edges = db.prepare(
    'SELECT source_key s, target_key t, placement p FROM links WHERE crawl_id=? AND is_internal=1 AND source_key!=target_key',
  ).all(crawlId) as { s: string; t: string; p: string }[];

  // ── iPR: weighted power iteration ──
  const outW = new Float64Array(N);
  const adj: { t: number; w: number }[][] = Array.from({ length: N }, () => []);
  for (const e of edges) {
    const si = idx.get(e.s), ti = idx.get(e.t);
    if (si === undefined || ti === undefined) continue; // target not in this crawl
    const w = e.p === 'body' ? 1 : 0.2;
    adj[si].push({ t: ti, w });
    outW[si] += w;
  }
  const d = 0.85;
  let pr = new Float64Array(N).fill(1 / N);
  for (let iter = 0; iter < 30; iter++) {
    const next = new Float64Array(N).fill((1 - d) / N);
    let dangling = 0;
    for (let i = 0; i < N; i++) if (outW[i] === 0) dangling += pr[i];
    const danglingShare = (d * dangling) / N;
    for (let i = 0; i < N; i++) {
      if (outW[i] === 0) continue;
      const share = (d * pr[i]) / outW[i];
      for (const { t, w } of adj[i]) next[t] += share * w;
    }
    for (let i = 0; i < N; i++) next[i] += danglingShare;
    pr = next;
  }
  // log-normalise to 0–100 (pr values are all > 0 thanks to the (1-d)/N base)
  let lo = Infinity, hi = -Infinity;
  const logpr = new Float64Array(N);
  for (let i = 0; i < N; i++) { const l = Math.log(pr[i]); logpr[i] = l; if (l < lo) lo = l; if (l > hi) hi = l; }
  const span = hi - lo || 1;
  const ipr = new Float64Array(N);
  for (let i = 0; i < N; i++) ipr[i] = Math.round(((logpr[i] - lo) / span) * 100);

  // ── click_depth: BFS from homepage over BODY links only ──
  const bodyAdj: number[][] = Array.from({ length: N }, () => []);
  for (const e of edges) {
    if (e.p !== 'body') continue;
    const si = idx.get(e.s), ti = idx.get(e.t);
    if (si !== undefined && ti !== undefined) bodyAdj[si].push(ti);
  }
  const depth = new Int32Array(N).fill(-1);
  const start = seedKey != null ? idx.get(seedKey) : undefined;
  if (start !== undefined) {
    depth[start] = 0;
    const q = [start];
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      for (const v of bodyAdj[u]) if (depth[v] === -1) { depth[v] = depth[u] + 1; q.push(v); }
    }
  }

  const upd = db.prepare('UPDATE pages SET ipr=?, click_depth=? WHERE crawl_id=? AND url_key=?');
  db.transaction(() => {
    for (let i = 0; i < N; i++) upd.run(ipr[i], depth[i] < 0 ? null : depth[i], crawlId, nodes[i]);
  })();
}
