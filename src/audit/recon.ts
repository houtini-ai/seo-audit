import type Database from 'better-sqlite3';
import type { OwnPageView } from '../core/reconFetch.js';
import type { SerpReconResult, ReconVerdict } from '../core/serpRecon.js';
import { expectedCtr } from '../core/ctrModel.js';

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

/** What the CRAWL says about this URL — the reality check the SERP + GSC read has to survive.
 * GSC history is legacy: it keeps reporting impressions for a URL that has since been
 * canonicalised away or set noindex, and classifying off that alone produced a
 * "defend-and-deepen, produce a companion video" verdict for a non-indexable duplicate. */
export interface PageState {
  urlKey: string;
  crawled: boolean;
  indexable: boolean | null;
  indexableReason: string | null;
  canonicalKey: string | null;
  canonicalisedAway: boolean;   // declares a canonical pointing at a DIFFERENT url_key
  statusCode: number | null;
  inlinkCount: number | null;
  ipr: number | null;
  cannotRank: boolean;          // not indexable, or canonicalised elsewhere → content work is wasted here
}

export function pageState(db: Database.Database, urlKey: string): PageState {
  const row = db.prepare(
    `SELECT status_code, indexable, indexable_reason, canonical_key, inlink_count, ipr FROM pages WHERE url_key = ?`,
  ).get(urlKey) as
    { status_code: number | null; indexable: number | null; indexable_reason: string | null; canonical_key: string | null; inlink_count: number | null; ipr: number | null } | undefined;
  if (!row) {
    return { urlKey, crawled: false, indexable: null, indexableReason: null, canonicalKey: null, canonicalisedAway: false, statusCode: null, inlinkCount: null, ipr: null, cannotRank: false };
  }
  const canonicalisedAway = !!row.canonical_key && row.canonical_key !== urlKey;
  const indexable = row.indexable == null ? null : !!row.indexable;
  return {
    urlKey, crawled: true, indexable, indexableReason: row.indexable_reason,
    canonicalKey: row.canonical_key, canonicalisedAway,
    statusCode: row.status_code, inlinkCount: row.inlink_count, ipr: row.ipr,
    cannotRank: indexable === false || canonicalisedAway,
  };
}

/** A crawl row that contradicts the SERP/GSC read WINS. Returns null when there's no conflict. */
export function crawlRealityOverride(
  v: { verdict: ReconVerdict; note: string }, state: PageState,
): { verdict: ReconVerdict; note: string } | null {
  if (!state.cannotRank) return null;
  const why = state.indexable === false
    ? `the crawl marks it not indexable (${state.indexableReason ?? 'reason not recorded'})`
    : `it declares a canonical pointing at ${state.canonicalKey}`;
  const equity = `${state.inlinkCount ?? 0} internal link(s), iPR ${state.ipr ?? 0}`;
  return {
    verdict: 'page-cannot-rank',
    note: `This URL cannot rank as it stands: ${why} (${equity}). Its Search Console history is legacy — the SERP read ("${v.verdict}") describes whoever Google actually ranks, not this URL. Resolve the duplicate first; content work here is wasted.`,
  };
}

export interface DraftTodo { action: string; type: string; rationale: string; evidence: Record<string, unknown>; priority: number }

const TYPE_WEIGHT: Record<string, number> = {
  'content-gap': 1.0, schema: 0.9, research: 0.8, cannibalisation: 0.7, format: 0.6, freshness: 0.3,
};
/** How much headroom the verdict implies. A page already sitting at #4 with nobody editorial
 * above it has far less to gain than one losing a competitive gap, even at higher impressions. */
const VERDICT_FACTOR: Record<string, number> = {
  'competitive-gap': 1.0, 'accuracy-or-freshness': 1.0, 'consolidate-weak-page': 0.9,
  'page-cannot-rank': 0.8, 'defend-and-deepen': 0.4,
};
const looksCommercial = (q: string): boolean => /\b(best|top|vs|review|compare|comparison|cheap|budget|buy)\b/i.test(q);

/**
 * Priority = OPPORTUNITY, not impressions. Raw impressions ranked a #4 defend-and-deepen page
 * above the genuinely broken one, i.e. roughly the wrong working order. This prices the clicks
 * actually available: impressions x (CTR at a realistic target position - CTR where we are now),
 * damped by the verdict's headroom, then weighted by to-do type.
 */
export interface PriorityBasis {
  model: string;
  impressions: number;
  position: number;
  positionSource: 'live-serp' | 'gsc-average';
  targetPosition: number;
  opportunityClicks: number;   // per the measured window
  verdictFactor: number;
}

export function opportunityBasis(
  impressions: number, organicRank: number | null, gscPosition: number, verdict: string,
): PriorityBasis {
  const position = Math.max(1, organicRank ?? gscPosition);
  const targetPosition = position <= 3 ? 1 : position <= 10 ? 3 : 8;
  const opportunityClicks = Math.max(0, impressions * (expectedCtr(targetPosition) - expectedCtr(position)));
  return {
    model: 'impressions x (expectedCtr(target) - expectedCtr(current)) x verdictFactor x typeWeight',
    impressions, position: Math.round(position * 10) / 10,
    positionSource: organicRank != null ? 'live-serp' : 'gsc-average',
    targetPosition,
    opportunityClicks: Math.round(opportunityClicks),
    verdictFactor: VERDICT_FACTOR[verdict] ?? 1,
  };
}

/** Cannibalisation at CLUSTER level, not one query at a time. Keying off a single query missed a
 * four-URL overlap that only showed up across the whole "<entity>" query family. */
const CLUSTER_STOP = new Set(['the', 'and', 'for', 'with', 'best', 'top', 'vs', 'versus', 'review', 'reviews', 'guide', 'how', 'what', 'which', 'why', 'you', 'your', 'cheap', 'budget', 'buy', 'compare', 'comparison', '2024', '2025', '2026', '2027']);

/** The entity-ish terms of a query: the tokens a sibling page would have to share to be competing.
 * Minimum length 2 so short but load-bearing terms ("vr", "ai") survive. */
export function queryCore(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !CLUSTER_STOP.has(t)))].slice(0, 4);
}

export interface ClusterCannibalisation {
  core: string[];
  clusterQueries: number;       // queries in the cluster
  collidingQueries: number;     // cluster queries where 2+ of our URLs genuinely compete
  urls: { urlKey: string; impressions: number; position: number; queries: number }[];
  cannibalising: boolean;       // 2+ URLs AND at least one query they actually collide on
}

/**
 * Competition is judged PER QUERY and then unioned across the cluster. Judging it on cluster
 * TOTALS is what hid the overlap: the leader accumulates across every query in the topic, so a
 * genuine rival page falls under the 10%-of-leader guard and disappears. Here a URL qualifies if
 * it competes on any single cluster query (>=10 impressions, >=10% of that query's leader, avg
 * position inside 20) — and we separately count the queries where two or more of them collide,
 * which is what distinguishes cannibalisation from ordinary topical coverage.
 */
export function clusterCannibalisation(
  db: Database.Database, query: string, maxDate: string, minImpressions = 10,
): ClusterCannibalisation {
  const core = queryCore(query);
  const none = { core, clusterQueries: 0, collidingQueries: 0, urls: [], cannibalising: false };
  if (!core.length) return none;
  const like = core.map(() => 'query LIKE ?').join(' AND ');
  const terms = core.map(t => `%${t}%`);
  const win = `date > date(?, '-28 days') AND date <= ?`;
  const cte =
    `WITH q AS (
       SELECT query, page_key, SUM(impressions) impr,
              SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
       FROM search_analytics
       WHERE page_key IS NOT NULL AND query IS NOT NULL AND ${win} AND ${like}
       GROUP BY query, page_key
     ),
     lead AS (SELECT query, MAX(impr) top FROM q GROUP BY query),
     comp AS (
       SELECT q.* FROM q JOIN lead l ON l.query = q.query
       WHERE q.impr >= ? AND q.impr >= l.top * 0.1 AND q.pos < 20
     )`;
  const args = [maxDate, maxDate, ...terms, minImpressions];
  const urls = db.prepare(
    `${cte}
     SELECT page_key urlKey, SUM(impr) impressions,
            SUM(pos*impr)*1.0/NULLIF(SUM(impr),0) position,
            COUNT(DISTINCT query) queries
     FROM comp GROUP BY page_key ORDER BY impressions DESC`,
  ).all(...args) as { urlKey: string; impressions: number; position: number; queries: number }[];

  const { colliding } = db.prepare(
    `${cte} SELECT COUNT(*) colliding FROM (SELECT query FROM comp GROUP BY query HAVING COUNT(DISTINCT page_key) >= 2)`,
  ).get(...args) as { colliding: number };
  const { n } = db.prepare(
    `SELECT COUNT(DISTINCT query) n FROM search_analytics WHERE query IS NOT NULL AND ${win} AND ${like}`,
  ).get(maxDate, maxDate, ...terms) as { n: number };

  return {
    core, clusterQueries: n, collidingQueries: colliding,
    urls: urls.map(r => ({ ...r, position: Math.round(r.position * 10) / 10 })),
    cannibalising: urls.length >= 2 && colliding >= 1,
  };
}

/** The to-dos we can generate deterministically from our page + the SERP (no judgement). */
export function deterministicTodos(
  target: ReconTarget,
  own: OwnPageView,
  serp: SerpReconResult,
  verdict: { verdict: ReconVerdict; note: string },
  todayIso: string,
  ctx: { state?: PageState; cluster?: ClusterCannibalisation } = {},
): DraftTodo[] {
  const out: DraftTodo[] = [];
  const basis = opportunityBasis(target.impressions, serp.ourOrganicRank, target.position, verdict.verdict);
  const w = (type: string) => Math.max(1, Math.round(basis.opportunityClicks * basis.verdictFactor * (TYPE_WEIGHT[type] ?? 0.5)));

  // A URL that cannot rank gets ONE to-do: resolve it. Everything downstream (schema, freshness,
  // a companion video) is work against a page Google will not serve.
  const state = ctx.state;
  if (state?.cannotRank) {
    return [{
      action: state.canonicalisedAway
        ? `Resolve the duplicate — this URL canonicalises to ${state.canonicalKey}; merge or de-duplicate before any content work`
        : `Restore indexability — the crawl marks this URL not indexable (${state.indexableReason ?? 'reason not recorded'})`,
      type: 'cannibalisation',
      rationale: `${verdict.note} Its GSC impressions are historical, so they are not evidence the page can win today.`,
      evidence: {
        indexable: state.indexable, indexableReason: state.indexableReason, canonicalKey: state.canonicalKey,
        statusCode: state.statusCode, inlinkCount: state.inlinkCount, ipr: state.ipr, source: 'crawl (pages table)',
      },
      priority: w('cannibalisation'),
    }];
  }

  // Verdict-driven headline action.
  if (verdict.verdict === 'accuracy-or-freshness') {
    out.push({ action: 'Update the facts to current and mark them up so they are machine-liftable', type: 'schema',
      rationale: `You rank organic #${serp.ourOrganicRank} but the AI Overview does not cite you — a data-accuracy/freshness signal.`,
      evidence: { organicRank: serp.ourOrganicRank, aioCitesUs: false, aioReferencesChecked: serp.aioReferences.length }, priority: w('schema') + 1 });
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

  // Cannibalisation — cluster first (the real overlap), falling back to the single query.
  const cluster = ctx.cluster;
  if (cluster?.cannibalising) {
    out.push({ action: `Consolidate cannibalisation — ${cluster.urls.length} of your URLs compete across the "${cluster.core.join(' ')}" cluster, colliding on ${cluster.collidingQueries} quer${cluster.collidingQueries === 1 ? 'y' : 'ies'}`,
      type: 'cannibalisation',
      rationale: 'Multiple own URLs competing across one topic cluster split signals; pick a canonical winner and point the others at it. Judged across the cluster, not one query at a time — a single-query count misses siblings that share the topic under different phrasings.',
      evidence: { core: cluster.core, clusterQueries: cluster.clusterQueries, collidingQueries: cluster.collidingQueries, urls: cluster.urls, seedQuery: target.query },
      priority: w('cannibalisation') });
  } else if (target.competingUrls >= 2) {
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
  aioPresent: boolean; aioCitesUs: boolean | null; videoPresent: boolean;   // null = unknown, stored as NULL
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
      aioPresent: p.aioPresent ? 1 : 0, aioCitesUs: p.aioCitesUs == null ? null : (p.aioCitesUs ? 1 : 0), videoPresent: p.videoPresent ? 1 : 0,
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
