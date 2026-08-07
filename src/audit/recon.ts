import type Database from 'better-sqlite3';
import type { OwnPageView } from '../core/reconFetch.js';
import type { SerpReconResult, ReconVerdict } from '../core/serpRecon.js';

/**
 * Content recon core: pick the pages worth a deep competitive look, and turn what we can
 * determine WITHOUT judgement (schema gaps, freshness, cannibalisation, SERP format) into
 * a trackable to-do ledger. The judgement to-dos (what competitors cover that we don't)
 * are written back by the research session via save_recon_todo.
 */

export interface ReconTarget {
  urlKey: string;
  query: string;
  impressions: number;
  clicks: number;
  position: number;         // GSC blended avg (last 28d)
  priorPosition: number | null;
  slipped: boolean;         // position got worse vs the prior 28d
  competingUrls: number;    // how many of OUR urls rank for this query (cannibalisation)
}

/** Pick declining / striking-distance pages: high impressions, currently pos 3-15, top query per page. */
export function selectReconTargets(
  db: Database.Database,
  opts: { limit?: number; minImpressions?: number; maxDate: string },
): ReconTarget[] {
  const { limit = 5, minImpressions = 300, maxDate } = opts;
  const rows = db.prepare(`
    WITH cur AS (
      SELECT page_key, query, SUM(impressions) imp, SUM(clicks) clk,
             SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
      FROM search_analytics
      WHERE page_key IS NOT NULL AND query IS NOT NULL
        AND date > date(?, '-28 days') AND date <= ?
      GROUP BY page_key, query
    ),
    ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY page_key ORDER BY imp DESC) rn FROM cur),
    prior AS (
      SELECT page_key, query, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
      FROM search_analytics
      WHERE page_key IS NOT NULL AND query IS NOT NULL
        AND date > date(?, '-56 days') AND date <= date(?, '-28 days')
      GROUP BY page_key, query
    )
    SELECT r.page_key, r.query, r.imp, r.clk, r.pos, p.pos AS prior_pos
    FROM ranked r
    LEFT JOIN prior p ON p.page_key = r.page_key AND p.query = r.query
    WHERE r.rn = 1 AND r.pos BETWEEN 3 AND 15 AND r.imp >= ?
    ORDER BY r.imp DESC
    LIMIT ?`).all(maxDate, maxDate, maxDate, maxDate, minImpressions, limit) as
    { page_key: string; query: string; imp: number; clk: number; pos: number; prior_pos: number | null }[];

  const cannStmt = db.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT page_key FROM search_analytics
      WHERE query = ? AND page_key IS NOT NULL AND date > date(?, '-28 days') AND date <= ?
      GROUP BY page_key HAVING SUM(impressions) >= 10
    )`);

  return rows.map(r => {
    const pos = Math.round(r.pos * 10) / 10;
    const priorPosition = r.prior_pos != null ? Math.round(r.prior_pos * 10) / 10 : null;
    const cann = cannStmt.get(r.query, maxDate, maxDate) as { n: number };
    return {
      urlKey: r.page_key, query: r.query, impressions: r.imp, clicks: r.clk, position: pos,
      priorPosition,
      slipped: priorPosition != null && pos > priorPosition + 0.5,
      competingUrls: cann.n,
    };
  });
}

export interface DraftTodo { action: string; type: string; rationale: string; evidence: Record<string, unknown>; priority: number }

const TYPE_WEIGHT: Record<string, number> = {
  'content-gap': 1.0, schema: 0.9, research: 0.8, cannibalisation: 0.7, format: 0.6, freshness: 0.3,
};
const looksCommercial = (q: string): boolean => /\b(best|top|vs|review|compare|comparison|cheap|budget|buy)\b/i.test(q);

/** The to-dos we can generate deterministically from our page + the SERP (no judgement). */
export function deterministicTodos(
  target: ReconTarget,
  own: OwnPageView,
  serp: SerpReconResult,
  verdict: { verdict: ReconVerdict; note: string },
  todayIso: string,
): DraftTodo[] {
  const out: DraftTodo[] = [];
  const w = (type: string) => Math.round(target.impressions * (TYPE_WEIGHT[type] ?? 0.5));

  // Verdict-driven headline action.
  if (verdict.verdict === 'accuracy-or-freshness') {
    out.push({ action: 'Update the facts to current and mark them up so they are machine-liftable', type: 'schema',
      rationale: `You rank organic #${serp.ourOrganicRank} but the AI Overview does not cite you — a data-accuracy/freshness signal.`,
      evidence: { organicRank: serp.ourOrganicRank, aioCitesUs: false }, priority: w('schema') + 1 });
  }

  // Schema: commercial/listicle page without Product/Review markup.
  if (!own.hasProductOrReview && looksCommercial(target.query)) {
    out.push({ action: 'Add Product + Review/AggregateRating schema per item, with current specs and price',
      type: 'schema', rationale: 'A comparison/review page with no item-level markup cannot be lifted into rich results or an AI Overview citation cleanly.',
      evidence: { schemaTypes: own.jsonLdTypes, hasProductOrReview: false }, priority: w('schema') });
  }

  // Freshness: stale dateModified (older than ~90 days from today).
  if (own.dateModified) {
    const ageDays = Math.round((Date.parse(todayIso) - Date.parse(own.dateModified)) / 86400000);
    if (ageDays > 90) {
      out.push({ action: `Refresh the content (dateModified is ${ageDays} days old) — genuinely update, don't just restamp`,
        type: 'freshness', rationale: 'Stale content loses ground on freshness-sensitive queries; a real update (not a date bump) is the lever.',
        evidence: { dateModified: own.dateModified, ageDays }, priority: w('freshness') });
    }
  }

  // Cannibalisation.
  if (target.competingUrls >= 2) {
    out.push({ action: `Consolidate cannibalisation — ${target.competingUrls} of your URLs rank for "${target.query}"`,
      type: 'cannibalisation', rationale: 'Multiple own URLs competing for one query split signals; pick a canonical winner.',
      evidence: { competingUrls: target.competingUrls, query: target.query }, priority: w('cannibalisation') });
  }

  // Format: AIO/SERP leans on video.
  const ytRefs = serp.aioReferences.filter(r => /youtube|youtu\.be/.test(r.domain)).length;
  if ((serp.videoPresent || ytRefs >= 2)) {
    out.push({ action: 'Produce a companion video',
      type: 'format', rationale: `The SERP favours video${ytRefs ? ` and ${ytRefs} of the AI Overview's references are YouTube` : ''}.`,
      evidence: { videoPresent: serp.videoPresent, youtubeAioRefs: ytRefs }, priority: w('format') });
  }

  // Research pointer: hand the session the competitor set to diff (coverage + originality).
  const competitors = [
    ...serp.organicAbove.map(o => ({ rank: o.rank, url: o.url, kind: 'organic-above' })),
    ...serp.aioReferences.slice(0, 6).map(r => ({ rank: r.rank, url: r.url, kind: 'aio-reference' })),
    ...serp.videoItems.slice(0, 3).map(v => ({ url: v.url, kind: 'video' })),
  ];
  out.push({ action: 'Diff our coverage against the competitors Google rewards — add table-stakes we lack, amplify what only we have',
    type: 'research', rationale: 'Scrape the ranking competitors and transcribe the ranking videos, then compare to our sections.',
    evidence: { competitors }, priority: w('research') });

  return out;
}

export function persistReconPage(db: Database.Database, p: {
  urlKey: string; query: string; verdict: string; verdictNote: string;
  organicRank: number | null; gscPosition: number; gscImpressions: number;
  aioPresent: boolean; aioCitesUs: boolean; videoPresent: boolean;
  hasProductSchema: boolean; schemaTypes: string[]; competitors: unknown;
}): void {
  db.prepare(`INSERT INTO recon_page
    (url_key, query, verdict, verdict_note, organic_rank, gsc_position, gsc_impressions,
     aio_present, aio_cites_us, video_present, has_product_schema, schema_types, competitors, researched_at)
    VALUES (@urlKey,@query,@verdict,@verdictNote,@organicRank,@gscPosition,@gscImpressions,
     @aioPresent,@aioCitesUs,@videoPresent,@hasProductSchema,@schemaTypes,@competitors, datetime('now'))
    ON CONFLICT(url_key) DO UPDATE SET query=excluded.query, verdict=excluded.verdict, verdict_note=excluded.verdict_note,
     organic_rank=excluded.organic_rank, gsc_position=excluded.gsc_position, gsc_impressions=excluded.gsc_impressions,
     aio_present=excluded.aio_present, aio_cites_us=excluded.aio_cites_us, video_present=excluded.video_present,
     has_product_schema=excluded.has_product_schema, schema_types=excluded.schema_types,
     competitors=excluded.competitors, researched_at=datetime('now')`).run({
      urlKey: p.urlKey, query: p.query, verdict: p.verdict, verdictNote: p.verdictNote,
      organicRank: p.organicRank, gscPosition: p.gscPosition, gscImpressions: p.gscImpressions,
      aioPresent: p.aioPresent ? 1 : 0, aioCitesUs: p.aioCitesUs ? 1 : 0, videoPresent: p.videoPresent ? 1 : 0,
      hasProductSchema: p.hasProductSchema ? 1 : 0, schemaTypes: JSON.stringify(p.schemaTypes),
      competitors: JSON.stringify(p.competitors),
    });
}

/** Insert to-dos for a page. `baseline` snapshots the rank/citation state so outcome is measurable.
 * De-dupes on (url_key, action) so a re-run doesn't pile up identical open items. */
export function insertTodos(db: Database.Database, urlKey: string, query: string, todos: DraftTodo[],
  baseline: Record<string, unknown>, source: 'auto' | 'research'): number {
  const exists = db.prepare(`SELECT 1 FROM recon_todo WHERE url_key=? AND action=? AND status NOT IN ('shipped','dismissed')`);
  const ins = db.prepare(`INSERT INTO recon_todo (url_key, query, action, type, rationale, evidence, priority, source, baseline)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const t of todos) {
      if (exists.get(urlKey, t.action)) continue;
      ins.run(urlKey, query, t.action, t.type, t.rationale, JSON.stringify(t.evidence), t.priority, source, JSON.stringify(baseline));
      n++;
    }
  });
  tx();
  return n;
}
