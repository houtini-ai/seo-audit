import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { gscFreshness } from './gscFreshness.js';
import { maxPassageScore } from './reranker.js';

/** The flag threshold, and the only band boundaries we assert. Raw cross-encoder logits have no
 * intrinsic scale, so a bare "8.18" is unreadable — every consumer gets the threshold, the band
 * convention and the run's own distribution alongside the number. */
export const WEAK_PASSAGE_THRESHOLD = 3;
export const PASSAGE_SCALE_NOTE =
  'Raw ms-marco-MiniLM cross-encoder logit for the single best passage vs the page\'s top query. Unbounded (roughly -11..+11), higher = more relevant; it is a relative measure, not a percentage. Our bands: <0 no relevant passage, 0-3 weak (flagged as weak-passage-answer), 3-6 adequate, 6+ a dense, directly-extractable answer. The bands are this tool\'s convention, not the model\'s — compare a score against the run distribution as well.';

/** sigmoid(logit) — the model is trained with a binary relevance objective, so this reads as an
 * approximate P(passage is relevant). Useful for "is 8.18 comfortable?" (it is: ~0.9997). */
const relevanceProbability = (score: number): number => Math.round((1 / (1 + Math.exp(-score))) * 1000) / 1000;
const band = (s: number): string => (s < 0 ? 'none' : s < WEAK_PASSAGE_THRESHOLD ? 'weak' : s < 6 ? 'adequate' : 'strong');
const quantile = (sorted: number[], q: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : 0;

export interface PassageScoreRow { url: string; query: string; impressions: number; score: number; band: string; relevanceProbability: number }
export interface PassageScoreResult {
  scored: number;
  flagged: number;
  threshold: number;
  scale: string;
  distribution: { min: number; p25: number; median: number; p75: number; max: number } | null;
  pages: PassageScoreRow[];       // every scored page (capped), highest impressions first
  pagesReturned: number;
  pagesTotal: number;
  weakest: { url: string; query: string; score: number }[];
}

/**
 * For each ranking page (top GSC query, has body chunks), score every chunk against that query with
 * the local cross-encoder and persist the single best-passage score — the proxy for how neural /
 * AI search judges whether the page has a dense, extractable answer. On-demand (ML inference cost);
 * bounded to pages that actually rank. Powers the `weak-passage-answer` check.
 *
 * Returns the score for EVERY page it scored, not just the failures: "does any passage confidently
 * answer the query" is a question about the passing pages too, and having to go to query_data for
 * pages.max_passage_score to answer it was an undocumented extra hop.
 */
export async function scoreSitePassages(
  dataDir: string,
  siteUrl: string,
  opts: { limit?: number; minImpressions?: number; maxPagesReturned?: number } = {},
): Promise<PassageScoreResult> {
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const empty: PassageScoreResult = { scored: 0, flagged: 0, threshold: WEAK_PASSAGE_THRESHOLD, scale: PASSAGE_SCALE_NOTE, distribution: null, pages: [], pagesReturned: 0, pagesTotal: 0, weakest: [] };
    const maxDate = gscFreshness(db.db).effectiveMax;
    if (!maxDate) return empty;
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
    const all: PassageScoreRow[] = [];
    for (const pg of pages) {
      let chunks: { heading?: string; text?: string }[];
      try { chunks = JSON.parse(pg.bc); } catch { continue; }
      const passages = chunks
        .map(c => `${c.heading ? `${c.heading}. ` : ''}${c.text || ''}`.trim())
        .filter(t => t.length > 20);
      if (!passages.length) continue;
      const { max } = await maxPassageScore(pg.query, passages);
      if (!Number.isFinite(max)) continue; // empty/whitespace query → no scores; don't persist -Infinity
      const score = Math.round(max * 100) / 100;
      upd.run({ s: score, q: pg.query, i: pg.impressions, u: pg.urlKey });
      scored++;
      all.push({ url: pg.urlKey, query: pg.query, impressions: pg.impressions, score, band: band(score), relevanceProbability: relevanceProbability(score) });
      if (score < WEAK_PASSAGE_THRESHOLD) { flagged++; weakest.push({ url: pg.urlKey, query: pg.query, score }); }
    }
    weakest.sort((a, b) => a.score - b.score);
    const sorted = all.map(p => p.score).sort((a, b) => a - b);
    const cap = opts.maxPagesReturned ?? 200;
    return {
      scored, flagged, threshold: WEAK_PASSAGE_THRESHOLD, scale: PASSAGE_SCALE_NOTE,
      distribution: sorted.length
        ? { min: sorted[0], p25: quantile(sorted, 0.25), median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75), max: sorted[sorted.length - 1] }
        : null,
      pages: all.slice(0, cap), pagesReturned: Math.min(cap, all.length), pagesTotal: all.length,
      weakest: weakest.slice(0, 20),
    };
  } finally {
    db.close();
  }
}
