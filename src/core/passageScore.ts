import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { gscFreshness } from './gscFreshness.js';
import { maxPassageScore } from './reranker.js';

/**
 * For each ranking page (top GSC query, has body chunks), score every chunk against that query with
 * the local cross-encoder and persist the single best-passage score — the proxy for how neural /
 * AI search judges whether the page has a dense, extractable answer. On-demand (ML inference cost);
 * bounded to pages that actually rank. Powers the `weak-passage-answer` check.
 */
export async function scoreSitePassages(
  dataDir: string,
  siteUrl: string,
  opts: { limit?: number; minImpressions?: number } = {},
): Promise<{ scored: number; flagged: number; weakest: { url: string; query: string; score: number }[] }> {
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const maxDate = gscFreshness(db.db).effectiveMax;
    if (!maxDate) return { scored: 0, flagged: 0, weakest: [] };
    const minImpr = opts.minImpressions ?? 50;
    const win = `date > date('${maxDate}', '-28 days') AND date <= '${maxDate}'`;
    const pages = db.db.prepare(
      `SELECT s.page_key urlKey, s.query query, s.impr impressions, p.body_chunks bc FROM
        (SELECT page_key, query, SUM(impressions) impr, ROW_NUMBER() OVER (PARTITION BY page_key ORDER BY SUM(impressions) DESC) rn
         FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win} GROUP BY page_key, query) s
       JOIN pages p ON p.url_key = s.page_key
       WHERE s.rn = 1 AND p.indexable = 1 AND p.body_chunks IS NOT NULL AND s.impr >= ${minImpr}
       ORDER BY s.impr DESC LIMIT ${opts.limit ? Math.floor(opts.limit) : 500}`,
    ).all() as { urlKey: string; query: string; impressions: number; bc: string }[];

    const upd = db.db.prepare(
      `UPDATE pages SET max_passage_score=@s, max_passage_query=@q, max_passage_impr=@i, max_passage_at=datetime('now') WHERE url_key=@u`,
    );
    let scored = 0, flagged = 0;
    const weakest: { url: string; query: string; score: number }[] = [];
    for (const pg of pages) {
      let chunks: { heading?: string; text?: string }[];
      try { chunks = JSON.parse(pg.bc); } catch { continue; }
      const passages = chunks
        .map(c => `${c.heading ? `${c.heading}. ` : ''}${c.text || ''}`.trim())
        .filter(t => t.length > 20);
      if (!passages.length) continue;
      const { max } = await maxPassageScore(pg.query, passages);
      const score = Math.round(max * 100) / 100;
      upd.run({ s: score, q: pg.query, i: pg.impressions, u: pg.urlKey });
      scored++;
      if (score < 3) { flagged++; weakest.push({ url: pg.urlKey, query: pg.query, score }); }
    }
    weakest.sort((a, b) => a.score - b.score);
    return { scored, flagged, weakest: weakest.slice(0, 20) };
  } finally {
    db.close();
  }
}
