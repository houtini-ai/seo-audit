import type Database from 'better-sqlite3';

/**
 * Post-crawl link-graph metrics, computed in-process from the `links` table (no new infra):
 *  - **iPR** — internal PageRank (weighted: nav/footer links count ×0.2, body ×1), log-
 *    normalised to 0–100. Surfaces where internal authority concentrates (research/14 §1).
 *  - **click_depth** — shortest path from the homepage following BODY links only (the
 *    "honest" depth; nav/footer would make everything depth-1). null = unreachable via body.
 * Writes both back to pages.ipr / pages.click_depth for the crawl.
 */
/**
 * Full post-crawl link-graph finalization for a crawl: in-degree (inlink_count) from the
 * `links` table, then iPR + click_depth. Idempotent — safe to re-run. Used by the crawler at
 * the end of a crawl AND by the audit as a self-heal when a crawl's link-graph was left
 * unpopulated (e.g. the crawl process was killed before it could finalize). When seedKey is
 * null the homepage is inferred as the highest-in-degree page (computed first, above).
 */
export function finalizeLinkGraph(db: Database.Database, crawlId: string, seedKey: string | null): void {
  db.prepare(
    `UPDATE pages SET inlink_count = (
      SELECT COUNT(*) FROM links
      WHERE links.target_key = pages.url_key AND links.is_internal = 1
        AND links.source_key != pages.url_key AND links.crawl_id = pages.crawl_id
    ) WHERE crawl_id = ?`,
  ).run(crawlId);
  let seed = seedKey;
  if (!seed) {
    const r = db.prepare(`SELECT url_key FROM pages WHERE crawl_id=? ORDER BY inlink_count DESC LIMIT 1`).get(crawlId) as { url_key: string } | undefined;
    seed = r?.url_key ?? null;
  }
  computeLinkGraph(db, crawlId, seed);
}

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
    // L1-delta early exit — PageRank usually converges well before 30 iterations; stop once the
    // vector barely moves so we don't spend the back half of the iterations for no change.
    let delta = 0; for (let i = 0; i < N; i++) delta += Math.abs(next[i] - pr[i]);
    pr = next;
    if (delta < 1e-6) break;
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
  // BFS root: the seed's key, but if the bare homepage redirected (final URL keyed
  // differently), fall back to the shallowest crawl-discovered page (depth 0 = seed).
  let start = seedKey != null ? idx.get(seedKey) : undefined;
  if (start === undefined) {
    const root = db.prepare('SELECT url_key FROM pages WHERE crawl_id=? ORDER BY depth ASC, inlink_count DESC LIMIT 1').get(crawlId) as { url_key: string } | undefined;
    if (root) start = idx.get(root.url_key);
  }
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
