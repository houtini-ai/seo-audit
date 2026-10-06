import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { gscFreshness } from './gscFreshness.js';
import { expectedCtr } from './ctrModel.js';
import { brandToken } from './url-key.js';
import { HTML_CT } from './sql.js';
import { latestSerpFootprint, ensureFootprintTable, type SerpFootprint } from './serpFootprint.js';
import { latestMarketSizing, ensureMarketTable, type MarketSizing } from './marketSizing.js';
import { contentArchitecture, type TopicCluster } from '../audit/contentArchitecture.js';

export interface DashboardData {
  siteUrl: string;
  empty?: boolean;
  dateRange?: { current: string; prior: string; maxDate: string; rawMaxDate: string; trimmedDays: number };
  summary?: {
    current: { clicks: number; impressions: number; ctr: number; position: number };
    prior: { clicks: number; impressions: number; ctr: number; position: number };
  };
  rankTrend?: { date: string; clicks: number; impressions: number; position: number }[];
  rankHistory?: { period: string; pos_1_3: number; pos_4_10: number; pos_11_20: number; pos_21_100: number; etv: number; keyword_count: number }[];
  dateAlignment?: {
    gsc: { start: string; end: string } | null;
    dataforseo: { start: string; end: string } | null;
    overlap: { start: string; end: string } | null;
    note: string;
  };
  rankingDistribution?: { date: string; b1: number; b2: number; b3: number; b4: number }[];
  strikingDistance?: { query: string; position: number; impressions: number; clicks: number }[];
  quickWins?: { query: string; position: number; impressions: number; clicks: number; ctr: number; expectedCtr: number; type: 'striking' | 'snippet' | 'serp' | 'ok'; potential: number }[];
  contentDecay?: { urlKey: string; prevClicks: number; clicks: number; lost: number; dropPct: number; impressions: number; position: number }[];
  cannibalisationTable?: { query: string; urlCount: number; totalImpressions: number; totalClicks: number; verdict: 'split' | 'dominant'; crossType: boolean; urls: { url: string; impressions: number; clicks: number; position: number; template: string }[] }[];
  brandedSplit?: { brand: string; branded: { clicks: number; impressions: number }; nonBranded: { clicks: number; impressions: number }; priorBrandedClicks: number; priorNonBrandedClicks: number };
  topKeywords?: {
    query: string;
    clicks: number;
    prevClicks: number;
    clicksChange: number;
    position: number;
    prevPosition: number;
  }[];
  deviceBreakdown?: { device: string; clicks: number; prevClicks: number; impressions: number; ctr: number; position: number }[];
  countryBreakdown?: { country: string; clicks: number; prevClicks: number; impressions: number }[];
  pagePerformance?: { urlKey: string; clicks: number; prevClicks: number; clicksChangePct: number; impressions: number; position: number; category: string }[];
  keywordMovement?: { query: string; firstPos: number; lastPos: number; delta: number; firstDate: string; lastDate: string; category: string }[];
  // Equity vs reality: per-page internal PageRank (x) vs GSC impressions (y), bucketed by template.
  equityScatter?: { x: number; y: number; t: string; u: string }[];
  // Template-level mismatch: where internal equity flows vs where traffic actually comes from.
  templateMismatch?: { template: string; pages: number; iprPct: number; trafficPct: number }[];
  // Cannibalisation braids: per contested query, each competing URL's weekly average position.
  cannibalisation?: { query: string; urls: { url: string; points: { week: string; position: number }[] }[] }[];
  // Top internally-linked pages + their live status — a non-200 high up here is a big equity leak.
  topLinkedPages?: { url: string; inlinks: number; status: number | null; indexable: boolean; reason: string | null }[];
  // Site health — Screaming-Frog-style crawl diagnostics, rendered as plain stat bars (no chart lib).
  crawlHealth?: {
    responseCodes: { label: string; count: number; tone?: string }[];
    indexability: { label: string; count: number; tone?: string }[];
    speed: { label: string; count: number; tone?: string }[];    // response-time buckets (HTML pages)
    htmlSize: { label: string; count: number; tone?: string }[]; // estimated transfer-size buckets
    depth: { label: string; count: number; tone?: string }[];    // crawl depth distribution
    titles: { label: string; count: number; tone?: string }[];
    metas: { label: string; count: number; tone?: string }[];
    onPage: { label: string; count: number; tone?: string }[];   // H1s, alt text, CLS dimensions, mixed content
    serverErrors: { url: string; status: number }[];  // 5xx URLs
    slowPages: { url: string; ms: number }[];         // slowest HTML pages
    largeImages: { url: string; kb: number; usedOn: number }[]; // heaviest sampled images
    imageStats: { sampled: number; over100kb: number; over300kb: number } | null;
    totalPages: number;
  };
  // Agent readiness (from check_agent_readiness) — how ready the site is for AI agents.
  agentReadiness?: { score: number; level: string; checkedAt: string; byCategory: { category: string; passed: number; total: number }[]; checks: { id: string; category: string; label: string; present: boolean; detail: string; fix: string }[] };
  serpFootprint?: SerpFootprint | null;
  marketSizing?: MarketSizing | null;
  // Internal link explorer: folder-to-folder iPR flow (bipartite Sankey - left sources, right targets).
  linkFlows?: { sources: string[]; targets: string[]; flows: { source: string; target: string; value: number }[] };
  // Crawl-structure map: the internal link skeleton of the highest-equity pages. Nodes are the
  // top pages by iPR (size = iPR), edges are in-content internal links among them; status/indexable
  // drive colour (non-200 / non-indexable surfaced in the problem hue).
  structureGraph?: {
    nodes: { id: string; ipr: number; depth: number | null; status: number | null; indexable: boolean }[];
    edges: { source: string; target: string }[];
    totalPages: number;
  };
  findings?: {
    runId: string;
    total: number;
    finishedAt: string | null;
    byCheck: { check_id: string; category: string; severity: string; count: number; priority: number; urls?: number; coveragePct?: number | null }[];
    top: { check_id: string; category: string; severity: string; url_key: string | null; evidence: string; traffic_at_risk: string; effort: string; priority: number; recommendation: string; impact?: number; size?: string }[];
    // Audit-deliverable view: issues grouped by category, each a sub-heading with a real example + fix.
    recommendations: {
      category: string;
      checks: {
        checkId: string;
        title: string;
        fix: string;
        severity: string;
        count: number;
        coveragePct?: number | null;
        example: { urlKey: string | null; evidence: Record<string, unknown>; clicks: number; impressions: number } | null;
        examples: { urlKey: string | null; evidence: Record<string, unknown>; clicks: number; impressions: number }[];
      }[];
    }[];
  } | null;
  // Link intersect (from link_intersect) — domains linking to competitors but not us.
  linkProspects?: {
    domain: string; intersections: number; linkedTargets: string[];
    domainTrust: number | null; spamScore: number | null; dofollow: boolean;
    trustFlow: number | null; citationFlow: number | null; topTopic: string | null;
    competitors: string[]; fetchedAt: string | null;
  }[];
  // Which optional integrations have a key set (drives the key-gated tabs + upsell CTAs).
  // Injected by the server layer (the data layer has no env access).
  apiKeys?: { dataforseo: boolean; majestic: boolean; firecrawl: boolean; supadata: boolean };
  // Trapped authority — pages with real external authority (referring domains) buried deep
  // internally (high click depth / low iPR), so their link equity isn't reaching money pages.
  trappedAuthority?: { url: string; referringDomains: number; backlinks: number; clickDepth: number | null; ipr: number; trustFlow: number | null; topTopic: string | null }[];
  // Site Health Score (the headline every paid tool has): % of crawled internal pages with no
  // error-class (critical/high) finding. Honest + defensible; banded Weak/Fair/Good/Excellent.
  healthScore?: { score: number; band: string; errorPages: number; totalPages: number; definition: string } | null;
  // Security / HTTPS coverage (V2): share of 200 internal pages carrying each security header.
  securityCoverage?: { total: number; headers: { key: string; label: string; present: number }[]; mixedContent: number } | null;
  // Structured-data coverage (V2): JSON-LD @types across the crawl, most common first.
  schemaCoverage?: { pagesWithSchema: number; totalPages: number; types: { type: string; pages: number }[] } | null;
  // GSC index coverage (V2): per-URL index status from URL Inspection.
  indexCoverage?: { total: number; states: { state: string; count: number }[]; canonicalMismatch: number; indexed: number } | null;
  // Redirect chains (V2): multi-hop redirects captured during the crawl.
  redirectChains?: { total: number; chains: { from: string; to: string; status: number; hops: number }[] } | null;
  // Content architecture (topic clusters): pillar + supporting demand with coverage/gap/funnel.
  topicClusters?: { clusters: TopicCluster[]; totalClusters: number } | null;
  // Core Web Vitals (V2): lab CWV from page_lighthouse, pass rates + worst offenders.
  cwvCoverage?: { pages: number; passLcp: number; passCls: number; passTbt: number; worst: { url: string; perf: number; lcpMs: number; cls: number; tbtMs: number }[] } | null;
  // Hreflang / international (V2): declared languages across crawled pages.
  hreflangCoverage?: { pagesWithHreflang: number; totalPages: number; langs: { lang: string; pages: number }[] } | null;
  // Entity graph (V2): pages resolved to Wikidata entities + subclass/part-of edges.
  entityGraph?: { total: number; nodes: { qid: string; label: string; pages: number }[]; edges: { source: string; target: string; relation: string }[] } | null;
  // AI answerability (V2): cross-encoder max-passage scores for ranking pages.
  answerability?: { scored: number; weak: number; pages: { url: string; score: number; query: string | null; impr: number }[] } | null;
}

interface Totals { clicks: number; impressions: number; position: number }

// Bump when the dashboard payload SHAPE/content changes, so cached entries from older code are
// invalidated even if the underlying GSC/crawl data hasn't changed. Part of the cache version key.
const PAYLOAD_VERSION = '20';

/** Build the dashboard payload for a property from its synced GSC history. */
export function getDashboardData(dataDir: string, siteUrl: string): DashboardData {
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    // Cache: the payload is ~20 GROUP-BY scans over search_analytics (~6s at 1.8M rows) but only
    // changes on sync/audit. Probe a cheap data-version; serve the cached JSON on a hit.
    // Probe every table the payload reads from — search_analytics + pages + the latest audit run,
    // PLUS agent_readiness and rank_history (written by check_agent_readiness / track_ranks via their
    // own paths). Omitting the latter two would serve a stale dashboard after those tools run.
    ensureFootprintTable(db.db); // probe below reads it; create before first serp_features run
    ensureMarketTable(db.db);
    const ver = db.db.prepare(
      `SELECT (SELECT MAX(date)||':'||COALESCE(MAX(rowid),0) FROM search_analytics) sa,
              (SELECT run_id FROM audit_runs ORDER BY started_at DESC LIMIT 1) run,
              (SELECT COALESCE(MAX(rowid),0) FROM pages) pg,
              (SELECT COALESCE(MAX(checked_at),'') FROM agent_readiness) ar,
              (SELECT COUNT(*)||':'||COALESCE(MAX(period),'') FROM rank_history) rh,
              (SELECT COALESCE(MAX(id),0) FROM serp_footprint) sf,
              (SELECT COALESCE(MAX(id),0) FROM market_sizing) ms,
              (SELECT COUNT(*)||':'||COALESCE(MAX(fetched_at),'')||':'||COALESCE(MAX(majestic_at),'') FROM page_backlinks) pb,
              (SELECT COUNT(*)||':'||COALESCE(MAX(fetched_at),'') FROM link_prospects) lp`).get() as { sa: string | null; run: string | null; pg: number; ar: string | null; rh: string | null; sf: number; ms: number; pb: string | null; lp: string | null };
    const version = `${PAYLOAD_VERSION}|${ver.sa ?? 'none'}|${ver.run ?? 'none'}|${ver.pg}|${ver.ar ?? ''}|${ver.rh ?? ''}|${ver.sf}|${ver.ms}|${ver.pb ?? ''}|${ver.lp ?? ''}`;
    const hit = db.db.prepare('SELECT payload FROM dashboard_cache WHERE id=1 AND version=?').get(version) as { payload: string } | undefined;
    // A corrupt/truncated cache row must fall through to a rebuild, not throw forever.
    if (hit) { try { return JSON.parse(hit.payload) as DashboardData; } catch { /* rebuild below */ } }

    // Use the finalised date (trailing partial GSC days trimmed) for ALL windows + charts, so the
    // dashboard never shows the "traffic tanking" cliff of unfinalised data.
    const fresh = gscFreshness(db.db);
    const maxDate = fresh.effectiveMax;
    if (!maxDate) return { siteUrl, empty: true };
    // Upper bound: never include unfinalised days past effectiveMax. Windows anchored on maxDate
    // only set a lower bound (date > date(maxDate,'-Nd')), so without this the partial trailing
    // days would still slip into current-period sums and the daily charts. (Prior windows already
    // cap below maxDate, so they don't need it.) maxDate is our own ISO date — safe to interpolate.
    const UB = `date <= '${maxDate}'`;

    const totals = (start: string, end?: string): Totals => {
      const where = end
        ? `date > date(?, '${start}') AND date <= date(?, '${end}')`
        : `date > date(?, '${start}') AND ${UB}`;
      const args = end ? [maxDate, maxDate] : [maxDate];
      const r = db.db
        .prepare(`SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, COALESCE(AVG(position),0) position FROM search_analytics WHERE ${where}`)
        .get(...args) as Totals;
      return r;
    };
    const cur = totals('-28 days');
    const prior = totals('-56 days', '-28 days');
    const ctr = (t: Totals): number => (t.impressions ? t.clicks / t.impressions : 0);

    // Branded vs non-branded — brand derived from the property's registrable label, matched against
    // the space-stripped query (so "my brand name" matches brand "mybrandname"). Done in
    // one SQL pass. The detected brand is surfaced in the UI so the split is verifiable, not a
    // black box — for descriptive domains where the brand equals a generic term, the user can see it.
    const brandKey = brandToken(siteUrl); // shared helper — same derivation the audit's brandExcl uses
    let brandedSplit: DashboardData['brandedSplit'];
    if (brandKey) {
      // Whole-token match (brand surrounded by word boundaries), NOT substring — so a 3-letter brand
      // like "ehi" matches the query "ehi inspections" but NOT "vehicle". Strict: this under-detects
      // for descriptive concatenated domains (where the brand is typed spaced = the category) rather
      // than over-detecting — a wrong split is worse than a conservative one.
      const tok = `% ${brandKey} %`;
      const splitRow = db.db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN (' '||LOWER(query)||' ') LIKE ? THEN clicks ELSE 0 END),0) bClk,
                COALESCE(SUM(CASE WHEN (' '||LOWER(query)||' ') LIKE ? THEN impressions ELSE 0 END),0) bImp,
                COALESCE(SUM(clicks),0) tClk, COALESCE(SUM(impressions),0) tImp
         FROM search_analytics WHERE query IS NOT NULL AND ${UB} AND date > date(?, '-28 days')`)
        .get(tok, tok, maxDate) as { bClk: number; bImp: number; tClk: number; tImp: number };
      const priorRow = db.db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN (' '||LOWER(query)||' ') LIKE ? THEN clicks ELSE 0 END),0) bClk, COALESCE(SUM(clicks),0) tClk
         FROM search_analytics WHERE query IS NOT NULL AND date > date(?, '-56 days') AND date <= date(?, '-28 days')`)
        .get(tok, maxDate, maxDate) as { bClk: number; tClk: number };
      brandedSplit = {
        brand: brandKey,
        branded: { clicks: splitRow.bClk, impressions: splitRow.bImp },
        nonBranded: { clicks: splitRow.tClk - splitRow.bClk, impressions: splitRow.tImp - splitRow.bImp },
        priorBrandedClicks: priorRow.bClk,
        priorNonBrandedClicks: priorRow.tClk - priorRow.bClk,
      };
    }

    const rankTrend = db.db
      .prepare(
        `SELECT date, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, COALESCE(AVG(position),0) position
         FROM search_analytics WHERE ${UB} AND date > date(?, '-90 days') GROUP BY date ORDER BY date`,
      )
      .all(maxDate) as { date: string; clicks: number; impressions: number; position: number }[];

    const curKw = db.db
      .prepare(
        `SELECT query, SUM(clicks) clicks, AVG(position) position
         FROM search_analytics WHERE query IS NOT NULL AND ${UB} AND date > date(?, '-28 days')
         GROUP BY query ORDER BY clicks DESC LIMIT 15`,
      )
      .all(maxDate) as { query: string; clicks: number; position: number }[];
    const priorKw = db.db
      .prepare(
        `SELECT query, SUM(clicks) clicks, AVG(position) position
         FROM search_analytics WHERE query IS NOT NULL AND date > date(?, '-56 days') AND date <= date(?, '-28 days')
         GROUP BY query`,
      )
      .all(maxDate, maxDate) as { query: string; clicks: number; position: number }[];
    const priorMap = new Map(priorKw.map(k => [k.query, k]));

    const topKeywords = curKw.map(k => {
      const p = priorMap.get(k.query);
      return {
        query: k.query,
        clicks: k.clicks,
        prevClicks: p?.clicks ?? 0,
        clicksChange: k.clicks - (p?.clicks ?? 0),
        position: Math.round(k.position * 10) / 10,
        prevPosition: p ? Math.round(p.position * 10) / 10 : 0,
      };
    });

    // Ranking distribution over time (impressions by position bucket) — flagship #1
    const rankingDistribution = db.db
      .prepare(
        `SELECT date,
           COALESCE(SUM(CASE WHEN position<=3 THEN impressions ELSE 0 END),0) b1,
           COALESCE(SUM(CASE WHEN position>3 AND position<=10 THEN impressions ELSE 0 END),0) b2,
           COALESCE(SUM(CASE WHEN position>10 AND position<=20 THEN impressions ELSE 0 END),0) b3,
           COALESCE(SUM(CASE WHEN position>20 THEN impressions ELSE 0 END),0) b4
         FROM search_analytics WHERE ${UB} AND date > date(?, '-90 days') GROUP BY date ORDER BY date`,
      )
      .all(maxDate) as { date: string; b1: number; b2: number; b3: number; b4: number }[];

    // Striking-distance queries (avg position 11–20, current period) — flagship #2
    const strikingDistance = (db.db
      .prepare(
        `SELECT query, AVG(position) position, SUM(impressions) impressions, SUM(clicks) clicks
         FROM search_analytics WHERE query IS NOT NULL AND ${UB} AND date > date(?, '-28 days')
         GROUP BY query HAVING AVG(position) > 10 AND AVG(position) <= 20 AND SUM(impressions) > 0
         ORDER BY SUM(impressions) DESC LIMIT 40`,
      )
      .all(maxDate) as { query: string; position: number; impressions: number; clicks: number }[])
      .map(r => ({ ...r, position: Math.round(r.position * 10) / 10 }));

    // Quick-wins matrix — every query with real impressions (≤ pos 20), plotted CTR vs position
    // against the expected-CTR curve. Two opportunity types: 'striking' (page 2 → push to page 1)
    // and 'snippet' (ranks page-1 but under-clicked vs expected). potential = recoverable clicks,
    // grounded in the same CTR model the audit uses. 'ok' queries are context dots.
    const quickWins = (db.db.prepare(
      `SELECT query, SUM(impressions) impr, SUM(clicks) clicks, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
       FROM search_analytics WHERE query IS NOT NULL AND ${UB} AND date > date(?, '-28 days')
       GROUP BY query HAVING SUM(impressions) >= 50 AND pos <= 20
       ORDER BY SUM(impressions) DESC LIMIT 300`).all(maxDate) as { query: string; impr: number; clicks: number; pos: number }[])
      .map(r => {
        const ctr = r.impr ? r.clicks / r.impr : 0;
        const exp = expectedCtr(r.pos);
        // STRICT: near-zero CTR at a page-1 position is NOT a snippet-rewrite win — a SERP feature
        // (AI overview / video / pack), cannibalisation, or tracking gap is eating the clicks. Bucket
        // it as 'serp' (verify, no recoverable promise) so we never over-state the opportunity.
        const type: 'striking' | 'snippet' | 'serp' | 'ok' =
          r.pos > 10 ? 'striking'
            : (r.pos <= 10 && ctr < exp * 0.1) ? 'serp'
              : (ctr < exp * 0.6 ? 'snippet' : 'ok');
        const potential = type === 'striking' ? Math.max(0, r.impr * expectedCtr(8) - r.clicks)
          : type === 'snippet' ? Math.max(0, r.impr * exp - r.clicks) : 0; // serp/ok carry no recoverable estimate
        return { query: r.query, position: Math.round(r.pos * 10) / 10, impressions: r.impr, clicks: r.clicks, ctr: Math.round(ctr * 1000) / 10, expectedCtr: Math.round(exp * 1000) / 10, type, potential: Math.round(potential) };
      })
      .sort((a, b) => b.potential - a.potential);

    // DataForSEO over-time sequence + GSC↔DataForSEO date-range reconciliation
    const rankHistory = db.db
      .prepare('SELECT period, pos_1_3, pos_4_10, pos_11_20, pos_21_100, etv, keyword_count FROM rank_history ORDER BY period')
      .all() as DashboardData['rankHistory'];
    const gscMin = (db.db.prepare('SELECT MIN(date) d FROM search_analytics').get() as { d: string | null }).d;
    const dateAlignment = reconcileRanges(gscMin, maxDate, rankHistory ?? []);

    // Device breakdown (current vs prior 28d)
    const devCur = db.db.prepare(`SELECT device, SUM(clicks) clicks, SUM(impressions) impressions, AVG(position) position FROM search_analytics WHERE device <> '' AND ${UB} AND date > date(?, '-28 days') GROUP BY device`).all(maxDate) as any[];
    const devPrior = new Map((db.db.prepare(`SELECT device, SUM(clicks) clicks FROM search_analytics WHERE device <> '' AND date > date(?, '-56 days') AND date <= date(?, '-28 days') GROUP BY device`).all(maxDate, maxDate) as any[]).map(d => [d.device, d.clicks]));
    const deviceBreakdown = devCur.map(d => ({ device: d.device, clicks: d.clicks, prevClicks: (devPrior.get(d.device) as number) ?? 0, impressions: d.impressions, ctr: d.impressions ? d.clicks / d.impressions : 0, position: Math.round(d.position * 10) / 10 }));

    // Country breakdown (top 10 current, with prior clicks)
    const ctyPrior = new Map((db.db.prepare(`SELECT country, SUM(clicks) clicks FROM search_analytics WHERE country <> '' AND date > date(?, '-56 days') AND date <= date(?, '-28 days') GROUP BY country`).all(maxDate, maxDate) as any[]).map(c => [c.country, c.clicks]));
    const countryBreakdown = (db.db.prepare(`SELECT country, SUM(clicks) clicks, SUM(impressions) impressions FROM search_analytics WHERE country <> '' AND ${UB} AND date > date(?, '-28 days') GROUP BY country ORDER BY clicks DESC LIMIT 10`).all(maxDate) as any[]).map(c => ({ country: c.country, clicks: c.clicks, prevClicks: (ctyPrior.get(c.country) as number) ?? 0, impressions: c.impressions }));

    // Page performance + categorisation (current vs prior 28d)
    const pagePrior = new Map((db.db.prepare(`SELECT page_key, SUM(clicks) clicks, SUM(impressions) impressions FROM search_analytics WHERE page_key IS NOT NULL AND date > date(?, '-56 days') AND date <= date(?, '-28 days') GROUP BY page_key`).all(maxDate, maxDate) as any[]).map(p => [p.page_key, p]));
    const pagePerformance = (db.db.prepare(`SELECT page_key, SUM(clicks) clicks, SUM(impressions) impressions, AVG(position) position FROM search_analytics WHERE page_key IS NOT NULL AND ${UB} AND date > date(?, '-28 days') GROUP BY page_key ORDER BY clicks DESC LIMIT 40`).all(maxDate) as any[]).map(p => {
      const prev = (pagePrior.get(p.page_key) as any) ?? { clicks: 0, impressions: 0 };
      const pct = prev.clicks ? ((p.clicks - prev.clicks) / prev.clicks) * 100 : (p.clicks > 0 ? 100 : 0);
      return { urlKey: p.page_key, clicks: p.clicks, prevClicks: prev.clicks, clicksChangePct: Math.round(pct), impressions: p.impressions, position: Math.round(p.position * 10) / 10, category: pageCategory(p, prev) };
    });

    // Content decay & refresh ROI — pages that earned ≥10 clicks last period and have since fallen
    // ≥20%, ranked by clicks lost (the recoverable upside from a content refresh). Fact-based: every
    // row is a real page with a measured before/after over matched 28-day windows.
    const contentDecay = (db.db.prepare(
      `WITH cur AS (SELECT page_key, SUM(clicks) c, SUM(impressions) i, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
                    FROM search_analytics WHERE page_key IS NOT NULL AND ${UB} AND date > date(?, '-28 days') GROUP BY page_key),
            prev AS (SELECT page_key, SUM(clicks) c FROM search_analytics WHERE page_key IS NOT NULL AND date > date(?, '-56 days') AND date <= date(?, '-28 days') GROUP BY page_key)
       SELECT prev.page_key url, prev.c prevC, COALESCE(cur.c,0) curC, COALESCE(cur.i,0) curI, COALESCE(cur.pos,0) pos
       FROM prev LEFT JOIN cur ON cur.page_key=prev.page_key
       WHERE prev.c >= 10 AND COALESCE(cur.c,0) < prev.c * 0.8
       ORDER BY (prev.c - COALESCE(cur.c,0)) DESC LIMIT 30`).all(maxDate, maxDate, maxDate) as { url: string; prevC: number; curC: number; curI: number; pos: number }[])
      .map(r => ({ urlKey: r.url, prevClicks: r.prevC, clicks: r.curC, lost: r.prevC - r.curC, dropPct: Math.round((1 - r.curC / r.prevC) * 100), impressions: r.curI, position: Math.round(r.pos * 10) / 10 }));

    // Keyword ranking movement (first-seen vs last-seen position over 90d)
    const keywordMovement = (db.db.prepare(
      `WITH q AS (SELECT query, MIN(date) fd, MAX(date) ld FROM search_analytics WHERE query IS NOT NULL AND ${UB} AND date > date(?, '-90 days') GROUP BY query HAVING SUM(impressions) >= 50 AND MIN(date) < MAX(date))
       SELECT q.query,
         (SELECT AVG(position) FROM search_analytics s WHERE s.query=q.query AND s.date=q.fd AND s.impressions>0) firstPos,
         (SELECT AVG(position) FROM search_analytics s WHERE s.query=q.query AND s.date=q.ld AND s.impressions>0) lastPos,
         q.fd firstDate, q.ld lastDate
       FROM q`,
    ).all(maxDate) as any[])
      .filter(r => r.firstPos != null && r.lastPos != null)
      .map(r => ({ query: r.query, firstPos: Math.round(r.firstPos * 10) / 10, lastPos: Math.round(r.lastPos * 10) / 10, delta: Math.round((r.firstPos - r.lastPos) * 10) / 10, firstDate: r.firstDate, lastDate: r.lastDate, category: movementCategory(r.firstPos, r.lastPos) }))
      .filter(r => r.category !== 'stable')
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 40);

    // Latest audit findings (if run_audit has run for this property)
    const lastRun = db.db.prepare('SELECT run_id, finding_count, finished_at FROM audit_runs ORDER BY started_at DESC LIMIT 1').get() as
      | { run_id: string; finding_count: number; finished_at: string | null }
      | undefined;
    const totalInternalPages = (db.db.prepare(`SELECT COUNT(*) n FROM pages WHERE is_internal=1`).get() as { n: number }).n;
    let findings: DashboardData['findings'] = null;
    if (lastRun) {
      const byCheckRaw = db.db.prepare('SELECT check_id, category, severity, COUNT(*) count, COUNT(DISTINCT url_key) urls, AVG(priority) priority FROM findings WHERE run_id=? GROUP BY check_id ORDER BY count DESC').all(lastRun.run_id) as NonNullable<DashboardData['findings']>['byCheck'];
      const byCheck = byCheckRaw.map(c => ({ ...c, coveragePct: totalInternalPages > 0 && c.urls ? Math.min(100, Math.round((c.urls / totalInternalPages) * 1000) / 10) : null }));
      const topRaw = db.db.prepare('SELECT check_id, category, severity, url_key, evidence, traffic_at_risk, effort, priority, recommendation FROM findings WHERE run_id=? ORDER BY priority DESC LIMIT 50').all(lastRun.run_id) as NonNullable<DashboardData['findings']>['top'];
      // Impact = priority normalised to the run's top finding (preserves magnitude), shown as a
      // 0–100 index + S/M/L/XL size instead of a clicks "forecast".
      const maxPrio = Math.max(1, ...topRaw.map(f => f.priority || 0));
      const top = topRaw.map(f => { const impact = Math.round((f.priority || 0) / maxPrio * 100); return { ...f, impact, size: impact >= 50 ? 'XL' : impact >= 20 ? 'L' : impact >= 5 ? 'M' : 'S' }; });

      // One representative (highest-priority) example per check → the audit-report view.
      const exRows = db.db.prepare('SELECT check_id, url_key, evidence, traffic_at_risk, recommendation, priority FROM findings WHERE run_id=? ORDER BY priority DESC').all(lastRun.run_id) as
        { check_id: string; url_key: string | null; evidence: string; traffic_at_risk: string; recommendation: string; priority: number }[];
      const parse = (s: string): any => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
      // Up to 3 representative examples per check (highest-priority first) → richer recs view.
      const exByCheck = new Map<string, typeof exRows>();
      for (const r of exRows) { const arr = exByCheck.get(r.check_id) ?? []; if (arr.length < 3) { arr.push(r); exByCheck.set(r.check_id, arr); } }

      const SEV: Record<string, number> = { crit: 0, high: 1, med: 2, low: 3, info: 4 };
      const sevRank = (s: string): number => SEV[s] ?? 5; // unknown severity sorts last, not NaN
      const catMap = new Map<string, NonNullable<DashboardData['findings']>['recommendations'][number]['checks']>();
      const mkEx = (r: typeof exRows[number]): { urlKey: string | null; evidence: Record<string, unknown>; clicks: number; impressions: number } => {
        const t = parse(r.traffic_at_risk);
        return { urlKey: r.url_key, evidence: parse(r.evidence), clicks: t.clicks || 0, impressions: t.impressions || 0 };
      };
      for (const c of byCheck) {
        const exs = exByCheck.get(c.check_id) ?? [];
        const rec = exs[0] ? parse(exs[0].recommendation) : {};
        const list = catMap.get(c.category) ?? [];
        const examples = exs.map(mkEx);
        list.push({
          checkId: c.check_id,
          title: rec.title || c.check_id,
          fix: rec.text || '',
          severity: c.severity,
          count: c.count,
          coveragePct: c.coveragePct,
          example: examples[0] ?? null,
          examples,
        });
        catMap.set(c.category, list);
      }
      const recommendations = [...catMap.entries()]
        .map(([category, checks]) => ({ category, checks: checks.sort((a, b) => (sevRank(a.severity) - sevRank(b.severity)) || (b.count - a.count)) }))
        .sort((a, b) => Math.min(...a.checks.map(c => sevRank(c.severity))) - Math.min(...b.checks.map(c => sevRank(c.severity))));

      findings = { runId: lastRun.run_id, total: lastRun.finding_count, finishedAt: lastRun.finished_at, byCheck, top, recommendations };
    }

    // Site Health Score - the headline metric every paid tool has. Ahrefs-style and honest:
    // the share of crawled internal pages carrying no error-class (critical/high) finding.
    let healthScore: DashboardData['healthScore'] = null;
    if (lastRun && totalInternalPages > 0) {
      // Count only crawled internal pages that carry a crit/high finding, so a check whose url_key
      // is not a crawled page (ghost-pages, backlinks-to-404) can't push errPages past the total.
      const errPages = (db.db.prepare(`SELECT COUNT(DISTINCT f.url_key) n FROM findings f JOIN pages p ON p.url_key = f.url_key AND p.is_internal = 1 WHERE f.run_id=? AND f.severity IN ('crit','high') AND f.url_key IS NOT NULL`).get(lastRun.run_id) as { n: number }).n;
      const score = Math.max(0, Math.min(100, Math.round((1 - errPages / totalInternalPages) * 100)));
      const band = score >= 91 ? 'Excellent' : score >= 71 ? 'Good' : score >= 31 ? 'Fair' : 'Weak';
      healthScore = { score, band, errorPages: errPages, totalPages: totalInternalPages, definition: 'Share of crawled internal pages with no critical or high finding.' };
    }

    // Security / HTTPS coverage (V2 view): share of 200 internal pages carrying each header.
    let securityCoverage: DashboardData['securityCoverage'] = null;
    {
      const secRows = db.db.prepare(`SELECT security_headers FROM pages WHERE is_internal=1 AND status_code=200 AND security_headers IS NOT NULL AND security_headers NOT IN ('','{}')`).all() as { security_headers: string }[];
      if (secRows.length) {
        const keys = [
          { key: 'hsts', label: 'HSTS (Strict-Transport-Security)' },
          { key: 'csp', label: 'Content-Security-Policy' },
          { key: 'xFrame', label: 'X-Frame-Options' },
          { key: 'xContentType', label: 'X-Content-Type-Options' },
          { key: 'referrerPolicy', label: 'Referrer-Policy' },
        ];
        const present: Record<string, number> = {};
        for (const r of secRows) {
          let h: Record<string, unknown> = {};
          try { h = JSON.parse(r.security_headers); } catch { /* skip */ }
          for (const k of keys) if (h[k.key]) present[k.key] = (present[k.key] ?? 0) + 1;
        }
        const mixed = (db.db.prepare(`SELECT COUNT(*) n FROM pages WHERE is_internal=1 AND COALESCE(mixed_content_count,0)>0`).get() as { n: number }).n;
        securityCoverage = { total: secRows.length, headers: keys.map(k => ({ key: k.key, label: k.label, present: present[k.key] ?? 0 })), mixedContent: mixed };
      }
    }

    // Structured-data coverage (V2 view): JSON-LD @types across the crawl. json_ld is an array of
    // JSON strings; each parses to an object with an @graph of nodes, and @type can be a string or array.
    let schemaCoverage: DashboardData['schemaCoverage'] = null;
    {
      const schemaRows = db.db.prepare(`SELECT json_ld FROM pages WHERE is_internal=1 AND status_code=200 AND json_ld IS NOT NULL AND json_ld NOT IN ('','[]')`).all() as { json_ld: string }[];
      if (schemaRows.length) {
        const typeCount = new Map<string, number>();
        for (const r of schemaRows) {
          const types = new Set<string>();
          try {
            const blocks = JSON.parse(r.json_ld) as unknown[];
            for (const b of blocks) {
              const obj = (typeof b === 'string' ? JSON.parse(b) : b) as any;
              const nodes = Array.isArray(obj) ? obj : (Array.isArray(obj['@graph']) ? obj['@graph'] : [obj]);
              for (const n of nodes) { const t = n?.['@type']; if (Array.isArray(t)) t.forEach((x: unknown) => typeof x === 'string' && types.add(x)); else if (typeof t === 'string') types.add(t); }
            }
          } catch { /* skip unparseable */ }
          for (const t of types) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
        }
        const types = [...typeCount.entries()].map(([type, pages]) => ({ type, pages })).sort((a, b) => b.pages - a.pages).slice(0, 12);
        if (types.length) schemaCoverage = { pagesWithSchema: schemaRows.length, totalPages: totalInternalPages, types };
      }
    }

    // GSC index coverage (V2 view): per-URL index status from URL Inspection.
    let indexCoverage: DashboardData['indexCoverage'] = null;
    try {
      const total = (db.db.prepare(`SELECT COUNT(*) n FROM url_inspection`).get() as { n: number }).n;
      if (total > 0) {
        const states = (db.db.prepare(`SELECT COALESCE(coverage_state,'Unknown') state, COUNT(*) count FROM url_inspection GROUP BY coverage_state ORDER BY count DESC`).all() as { state: string; count: number }[]);
        const canonicalMismatch = (db.db.prepare(`SELECT COUNT(*) n FROM url_inspection WHERE google_canonical IS NOT NULL AND user_canonical IS NOT NULL AND google_canonical <> user_canonical`).get() as { n: number }).n;
        const indexed = (db.db.prepare(`SELECT COUNT(*) n FROM url_inspection WHERE coverage_state LIKE '%indexed%' AND coverage_state NOT LIKE '%not indexed%'`).get() as { n: number }).n;
        indexCoverage = { total, states, canonicalMismatch, indexed };
      }
    } catch { /* no url_inspection */ }

    // Redirect chains (V2 view): multi-hop redirects captured during the crawl.
    let redirectChains: DashboardData['redirectChains'] = null;
    {
      const rcRows = db.db.prepare(`SELECT url, redirects FROM pages WHERE is_internal=1 AND redirects IS NOT NULL AND redirects NOT IN ('','[]')`).all() as { url: string; redirects: string }[];
      if (rcRows.length) {
        const chains: NonNullable<DashboardData['redirectChains']>['chains'] = [];
        for (const r of rcRows) {
          try {
            const hopsArr = JSON.parse(r.redirects) as { from: string; to: string; status: number }[];
            if (Array.isArray(hopsArr) && hopsArr.length) chains.push({ from: hopsArr[0].from ?? r.url, to: hopsArr[hopsArr.length - 1].to, status: hopsArr[0].status, hops: hopsArr.length });
          } catch { /* skip */ }
        }
        chains.sort((a, b) => b.hops - a.hops);
        if (chains.length) redirectChains = { total: chains.length, chains: chains.slice(0, 50) };
      }
    }

    // Content architecture (topic clusters) - the full topical picture from GSC demand + crawl.
    let topicClusters: DashboardData['topicClusters'] = null;
    try { const ca = contentArchitecture(db.db, {}); if (ca.clusters.length) topicClusters = ca; } catch { /* no GSC / no crawl */ }

    // Core Web Vitals (V2 view): lab CWV from page_lighthouse.
    let cwvCoverage: DashboardData['cwvCoverage'] = null;
    try {
      const cwvRows = db.db.prepare(`SELECT url, performance, lcp_ms, cls, tbt_ms FROM page_cwv WHERE performance IS NOT NULL`).all() as { url: string; performance: number; lcp_ms: number; cls: number; tbt_ms: number }[];
      if (cwvRows.length) {
        const passLcp = cwvRows.filter(r => r.lcp_ms != null && r.lcp_ms < 2500).length;
        const passCls = cwvRows.filter(r => r.cls != null && r.cls < 0.1).length;
        const passTbt = cwvRows.filter(r => r.tbt_ms != null && r.tbt_ms < 200).length;
        const worst = cwvRows.slice().sort((a, b) => (a.performance ?? 1) - (b.performance ?? 1)).slice(0, 15)
          .map(r => ({ url: r.url, perf: Math.round((r.performance ?? 0) * 100), lcpMs: Math.round(r.lcp_ms ?? 0), cls: Math.round((r.cls ?? 0) * 1000) / 1000, tbtMs: Math.round(r.tbt_ms ?? 0) }));
        cwvCoverage = { pages: cwvRows.length, passLcp, passCls, passTbt, worst };
      }
    } catch { /* no page_cwv */ }

    // Hreflang / international (V2 view): languages declared across crawled pages.
    let hreflangCoverage: DashboardData['hreflangCoverage'] = null;
    {
      const hlRows = db.db.prepare(`SELECT hreflang FROM pages WHERE is_internal=1 AND hreflang IS NOT NULL AND hreflang NOT IN ('','[]','{}')`).all() as { hreflang: string }[];
      if (hlRows.length) {
        const langCount = new Map<string, number>();
        for (const r of hlRows) {
          const langs = new Set<string>();
          try {
            const parsed = JSON.parse(r.hreflang) as any;
            const entries: any[] = Array.isArray(parsed) ? parsed : Object.keys(parsed).map(k => ({ lang: k }));
            for (const e of entries) { const l = e?.lang ?? e?.hreflang ?? e?.lang_code; if (typeof l === 'string' && l) langs.add(l.toLowerCase()); }
          } catch { /* non-JSON: skip */ }
          for (const l of langs) langCount.set(l, (langCount.get(l) ?? 0) + 1);
        }
        const langs = [...langCount.entries()].map(([lang, pages]) => ({ lang, pages })).sort((a, b) => b.pages - a.pages).slice(0, 15);
        if (langs.length) hreflangCoverage = { pagesWithHreflang: hlRows.length, totalPages: totalInternalPages, langs };
      }
    }

    // Entity graph (V2 view): pages resolved to Wikidata entities + their edges.
    let entityGraph: DashboardData['entityGraph'] = null;
    try {
      const entRows = db.db.prepare(`SELECT qid, label, COUNT(*) pages FROM page_entity GROUP BY qid, label ORDER BY pages DESC LIMIT 80`).all() as { qid: string; label: string; pages: number }[];
      if (entRows.length >= 2) {
        const ids = new Set(entRows.map(e => e.qid));
        const edgeRows = db.db.prepare(`SELECT qid source, related_qid target, relation FROM entity_edge`).all() as { source: string; target: string; relation: string }[];
        const edges = edgeRows.filter(e => ids.has(e.source) && ids.has(e.target));
        entityGraph = { total: entRows.length, nodes: entRows.map(e => ({ qid: e.qid, label: e.label || e.qid, pages: e.pages })), edges };
      }
    } catch { /* no page_entity */ }

    // AI answerability (V2 view): cross-encoder max-passage scores for ranking pages.
    let answerability: DashboardData['answerability'] = null;
    try {
      const ansRows = db.db.prepare(`SELECT url, max_passage_score score, max_passage_query q, COALESCE(max_passage_impr,0) impr FROM pages WHERE is_internal=1 AND max_passage_score IS NOT NULL`).all() as { url: string; score: number; q: string | null; impr: number }[];
      if (ansRows.length) {
        const weak = ansRows.filter(r => r.score < 3).length;
        const pages = ansRows.slice().sort((a, b) => a.score - b.score).slice(0, 15).map(r => ({ url: r.url, score: Math.round(r.score * 100) / 100, query: r.q, impr: r.impr }));
        answerability = { scored: ansRows.length, weak, pages };
      }
    } catch { /* no scores */ }

    // Equity vs reality: join per-page internal PageRank with 28d GSC traffic, bucketed by template.
    // (Needs a crawl — pages.ipr is populated post-crawl. Empty if crawl-free.)
    let equityScatter: DashboardData['equityScatter'];
    let templateMismatch: DashboardData['templateMismatch'];
    const pageRows = db.db.prepare(`SELECT url_key, COALESCE(ipr,0) ipr FROM pages WHERE status_code=200 AND indexable=1`).all() as { url_key: string; ipr: number }[];
    if (pageRows.length) {
      const g28 = new Map<string, { clicks: number; impr: number }>();
      for (const r of db.db.prepare(`SELECT page_key, SUM(clicks) c, SUM(impressions) i FROM search_analytics WHERE page_key IS NOT NULL AND ${UB} AND date > date(?, '-28 days') GROUP BY page_key`).all(maxDate) as any[]) g28.set(r.page_key, { clicks: r.c, impr: r.i });
      const scatter: NonNullable<DashboardData['equityScatter']> = [];
      const agg = new Map<string, { ipr: number; clicks: number; n: number }>();
      for (const p of pageRows) {
        const t = templateBucket(p.url_key);
        const gg = g28.get(p.url_key) ?? { clicks: 0, impr: 0 };
        const a = agg.get(t) ?? { ipr: 0, clicks: 0, n: 0 };
        a.ipr += p.ipr; a.clicks += gg.clicks; a.n += 1; agg.set(t, a);
        if (p.ipr >= 15 || gg.impr >= 5) scatter.push({ x: Math.round(p.ipr), y: gg.impr, t: ['content', 'category', 'homepage'].includes(t) ? t : 'other', u: p.url_key });
      }
      equityScatter = scatter.sort((a, b) => b.y - a.y).slice(0, 500);
      const tIpr = [...agg.values()].reduce((s, a) => s + a.ipr, 0) || 1;
      const tClk = [...agg.values()].reduce((s, a) => s + a.clicks, 0) || 1;
      templateMismatch = [...agg.entries()].map(([template, a]) => ({ template, pages: a.n, iprPct: Math.round(a.ipr / tIpr * 1000) / 10, trafficPct: Math.round(a.clicks / tClk * 1000) / 10 }))
        .sort((x, y) => y.iprPct - x.iprPct).slice(0, 8);
    }

    // Internal link explorer: iPR flow between folders as a bipartite Sankey. Each body link
    // carries ipr(source)/outdegree(source); flows are summed folder→folder, intra-folder
    // flows dropped (they're the noise, cross-folder equity movement is the architecture story).
    let linkFlows: DashboardData['linkFlows'];
    {
      const iprMap = new Map<string, number>();
      for (const p of db.db.prepare(`SELECT url_key, COALESCE(ipr,0) ipr FROM pages WHERE is_internal=1`).all() as { url_key: string; ipr: number }[]) iprMap.set(p.url_key, p.ipr);
      const edges = db.db.prepare(
        `SELECT source_key s, target_key t, COUNT(*) n FROM links WHERE is_internal=1 AND placement='body' AND source_key <> target_key GROUP BY source_key, target_key`,
      ).all() as { s: string; t: string; n: number }[];
      if (edges.length && iprMap.size) {
        const outdeg = new Map<string, number>();
        for (const e of edges) outdeg.set(e.s, (outdeg.get(e.s) ?? 0) + e.n);
        const flow = new Map<string, number>(); // "src|dst" folder pair → summed equity
        for (const e of edges) {
          const sf = templateBucket(e.s), tf = templateBucket(e.t);
          if (sf === tf) continue;
          const ipr = iprMap.get(e.s) ?? 0;
          const od = outdeg.get(e.s) ?? 1;
          if (ipr <= 0) continue;
          const k = `${sf}|${tf}`;
          flow.set(k, (flow.get(k) ?? 0) + (ipr * e.n) / od);
        }
        const pairs = [...flow.entries()].map(([k, v]) => { const [source, target] = k.split('|'); return { source, target, value: Math.round(v * 10) / 10 }; })
          .filter(p => p.value > 0).sort((a, b) => b.value - a.value).slice(0, 24);
        if (pairs.length) {
          const sources = [...new Set(pairs.map(p => p.source))];
          const targets = [...new Set(pairs.map(p => p.target))];
          linkFlows = { sources, targets, flows: pairs };
        }
      }
    }

    // Top internally-linked pages with their current status code (most-linked first). A 404/redirect
    // high in this list is a major leak — lots of internal links pointing at a dead/redirected URL.
    const topLinkedPages = (db.db.prepare(`SELECT url_key, COALESCE(inlink_count,0) inl, status_code, indexable, indexable_reason FROM pages WHERE is_internal=1 ORDER BY inlink_count DESC, status_code LIMIT 30`).all() as any[])
      .map(p => ({ url: p.url_key, inlinks: p.inl, status: p.status_code, indexable: !!p.indexable, reason: p.indexable_reason }));

    // Crawl-structure map: the internal link skeleton of the highest-equity pages. Bounded to the
    // top-N by iPR so the force graph stays legible and fast; edges are in-content internal links
    // whose BOTH ends are in that set (threshold-joined in SQL, not filtered in JS over every link).
    let structureGraph: DashboardData['structureGraph'];
    {
      const MAX_NODES = 140, MAX_EDGES = 1100;
      const nodeRows = db.db.prepare(
        `SELECT url_key, COALESCE(ipr,0) ipr, click_depth, status_code, indexable
         FROM pages WHERE is_internal=1 ORDER BY ipr DESC, inlink_count DESC LIMIT ?`,
      ).all(MAX_NODES) as { url_key: string; ipr: number; click_depth: number | null; status_code: number | null; indexable: number }[];
      const totalPages = totalInternalPages;
      if (nodeRows.length >= 3) {
        const thr = nodeRows[nodeRows.length - 1].ipr;
        // ORDER BY the combined endpoint iPR so that when thr is 0 (unfinalised graph / large site)
        // the LIMIT keeps the highest-equity edges - which are the ones among the top-N nodes - rather
        // than an arbitrary slice that the JS id-filter would mostly discard.
        const edges = db.db.prepare(
          `SELECT DISTINCT l.source_key s, l.target_key t, (ps.ipr + pt.ipr) w
           FROM links l
           JOIN pages ps ON ps.url_key = l.source_key AND ps.is_internal = 1
           JOIN pages pt ON pt.url_key = l.target_key AND pt.is_internal = 1
           WHERE l.is_internal = 1 AND l.placement = 'body' AND l.source_key <> l.target_key
             AND ps.ipr >= ? AND pt.ipr >= ?
           ORDER BY w DESC
           LIMIT ?`,
        ).all(thr, thr, MAX_EDGES) as { s: string; t: string; w: number }[];
        const ids = new Set(nodeRows.map(n => n.url_key));
        const keptEdges = edges.filter(e => ids.has(e.s) && ids.has(e.t)).map(e => ({ source: e.s, target: e.t }));
        structureGraph = {
          nodes: nodeRows.map(n => ({ id: n.url_key, ipr: Math.round(n.ipr), depth: n.click_depth, status: n.status_code, indexable: !!n.indexable })),
          edges: keptEdges,
          totalPages,
        };
      }
    }

    // Site health — Screaming-Frog-style crawl diagnostics. One conditional-aggregation
    // pass per table region (not a COUNT(*) scan per bucket); tones are assigned HERE, where
    // the meaning of each bucket is known, so the UI never has to infer colour from label text.
    let crawlHealth: DashboardData['crawlHealth'];
    {
      const one = (sql: string): number => (db.db.prepare(sql).get() as { n: number }).n;
      const totalPages = one(`SELECT COUNT(*) n FROM pages WHERE is_internal=1`);
      if (totalPages > 0) {
        type Stat = { label: string; count: number; tone?: string };
        const stats = (rows: Stat[]): Stat[] => rows.filter(r => r.count > 0);
        const num = (v: unknown): number => Number(v) || 0;
        // Estimated transfer size: pages.bytes is the DECODED HTML size (see Crawler), so
        // compressed responses ship roughly 22% of it over the wire.
        const EST = `CAST(CASE WHEN content_encoding IS NOT NULL AND content_encoding <> '' THEN bytes*0.22 ELSE bytes END AS INTEGER)`;
        const IDX = `status_code=200 AND indexable=1 AND ${HTML_CT}`;
        const g1 = db.db.prepare(`SELECT
            SUM(CASE WHEN status_code=200 THEN 1 ELSE 0 END) ok,
            SUM(CASE WHEN status_code BETWEEN 300 AND 399 THEN 1 ELSE 0 END) r3,
            SUM(CASE WHEN status_code BETWEEN 400 AND 499 THEN 1 ELSE 0 END) r4,
            SUM(CASE WHEN status_code BETWEEN 500 AND 599 THEN 1 ELSE 0 END) r5,
            SUM(CASE WHEN indexable_reason='robots-disallowed' THEN 1 ELSE 0 END) rb,
            SUM(CASE WHEN ${HTML_CT} AND response_time_ms < 200 THEN 1 ELSE 0 END) s1,
            SUM(CASE WHEN ${HTML_CT} AND response_time_ms BETWEEN 200 AND 499 THEN 1 ELSE 0 END) s2,
            SUM(CASE WHEN ${HTML_CT} AND response_time_ms BETWEEN 500 AND 999 THEN 1 ELSE 0 END) s3,
            SUM(CASE WHEN ${HTML_CT} AND response_time_ms >= 1000 THEN 1 ELSE 0 END) s4,
            SUM(CASE WHEN ${HTML_CT} AND status_code=200 AND ${EST} < 30000 THEN 1 ELSE 0 END) z1,
            SUM(CASE WHEN ${HTML_CT} AND status_code=200 AND ${EST} BETWEEN 30000 AND 59999 THEN 1 ELSE 0 END) z2,
            SUM(CASE WHEN ${HTML_CT} AND status_code=200 AND ${EST} BETWEEN 60000 AND 99999 THEN 1 ELSE 0 END) z3,
            SUM(CASE WHEN ${HTML_CT} AND status_code=200 AND ${EST} >= 100000 THEN 1 ELSE 0 END) z4
          FROM pages`).get() as Record<string, unknown>;
        const g2 = db.db.prepare(`SELECT
            SUM(CASE WHEN title IS NULL OR TRIM(title)='' THEN 1 ELSE 0 END) tMissing,
            SUM(CASE WHEN title_length > 60 THEN 1 ELSE 0 END) tLong,
            SUM(CASE WHEN title_length BETWEEN 1 AND 29 THEN 1 ELSE 0 END) tShort,
            SUM(CASE WHEN meta_description IS NULL OR TRIM(meta_description)='' THEN 1 ELSE 0 END) mMissing,
            SUM(CASE WHEN meta_description_length > 155 THEN 1 ELSE 0 END) mLong,
            SUM(CASE WHEN meta_description_length BETWEEN 1 AND 69 THEN 1 ELSE 0 END) mShort,
            SUM(CASE WHEN h1 IS NULL OR TRIM(h1)='' THEN 1 ELSE 0 END) h1Missing,
            SUM(CASE WHEN h1_count > 1 THEN 1 ELSE 0 END) h1Multi,
            SUM(CASE WHEN images_without_alt > 0 THEN 1 ELSE 0 END) noAlt,
            SUM(CASE WHEN images_missing_dimensions > 0 THEN 1 ELSE 0 END) noDims,
            SUM(CASE WHEN mixed_content_count > 0 THEN 1 ELSE 0 END) mixed,
            SUM(CASE WHEN heading_skips > 0 THEN 1 ELSE 0 END) hSkips
          FROM pages WHERE ${IDX}`).get() as Record<string, unknown>;
        // Duplicate title/meta: one GROUP BY pass each (sum of members of every duplicated group).
        const dupCount = (col: string): number => (db.db.prepare(
          `SELECT COALESCE(SUM(c),0) n FROM (SELECT COUNT(*) c FROM pages WHERE ${IDX} AND ${col} IS NOT NULL AND TRIM(${col})<>'' GROUP BY LOWER(TRIM(${col})) HAVING COUNT(*)>1)`,
        ).get() as { n: number }).n;
        const responseCodes = stats([
          { label: '200 OK', count: num(g1.ok), tone: 'ok' },
          { label: '3xx redirect', count: num(g1.r3), tone: 'muted' },
          { label: '4xx client error', count: num(g1.r4), tone: 'warn' },
          { label: '5xx server error', count: num(g1.r5), tone: 'bad' },
          { label: 'Blocked by robots', count: num(g1.rb), tone: 'warn' },
          { label: 'Fetch failed', count: one(`SELECT COUNT(*) n FROM errors WHERE error_type='fetch'`), tone: 'bad' },
        ]);
        const indexability = stats((db.db.prepare(
          `SELECT COALESCE(CASE WHEN indexable=1 THEN 'Indexable' ELSE indexable_reason END,'unknown') label, COUNT(*) count
           FROM pages WHERE status_code IS NOT NULL GROUP BY label ORDER BY count DESC`).all() as Stat[])
          .map(r => ({ ...r, tone: r.label === 'Indexable' ? 'ok' : /canonicalised|redirect/.test(r.label) ? 'muted' : 'warn' })));
        const speed = stats([
          { label: 'Under 200 ms', count: num(g1.s1), tone: 'ok' },
          { label: '200–500 ms', count: num(g1.s2), tone: 'ok' },
          { label: '500 ms–1 s', count: num(g1.s3), tone: 'warn' },
          { label: 'Over 1 s', count: num(g1.s4), tone: 'bad' },
        ]);
        const htmlSize = stats([
          { label: 'Under 30 KB', count: num(g1.z1), tone: 'ok' },
          { label: '30–60 KB', count: num(g1.z2), tone: 'muted' },
          { label: '60–100 KB', count: num(g1.z3) },
          { label: 'Over 100 KB', count: num(g1.z4), tone: 'bad' },
        ]);
        const depth = stats((db.db.prepare(
          `SELECT CASE WHEN depth >= 6 THEN '6+' ELSE CAST(depth AS TEXT) END label, COUNT(*) count
           FROM pages WHERE depth IS NOT NULL GROUP BY label ORDER BY MIN(depth)`).all() as Stat[])
          .map(r => ({ label: `Depth ${r.label}`, count: r.count })));
        const titles = stats([
          { label: 'Missing', count: num(g2.tMissing), tone: 'warn' },
          { label: 'Duplicate', count: dupCount('title'), tone: 'warn' },
          { label: 'Over 60 characters', count: num(g2.tLong), tone: 'warn' },
          { label: 'Under 30 characters', count: num(g2.tShort), tone: 'warn' },
        ]);
        const metas = stats([
          { label: 'Missing', count: num(g2.mMissing), tone: 'warn' },
          { label: 'Duplicate', count: dupCount('meta_description'), tone: 'warn' },
          { label: 'Over 155 characters', count: num(g2.mLong), tone: 'warn' },
          { label: 'Under 70 characters', count: num(g2.mShort), tone: 'warn' },
        ]);
        const onPage = stats([
          { label: 'Missing H1', count: num(g2.h1Missing), tone: 'warn' },
          { label: 'Multiple H1s', count: num(g2.h1Multi), tone: 'warn' },
          { label: 'Images missing alt text', count: num(g2.noAlt), tone: 'warn' },
          { label: 'Images without dimensions (CLS)', count: num(g2.noDims), tone: 'warn' },
          { label: 'Mixed content (http on https)', count: num(g2.mixed), tone: 'warn' },
          { label: 'Heading order skips', count: num(g2.hSkips), tone: 'warn' },
        ]);
        const serverErrors = (db.db.prepare(`SELECT url_key url, status_code status FROM pages WHERE status_code BETWEEN 500 AND 599 ORDER BY inlink_count DESC LIMIT 15`).all() as { url: string; status: number }[]);
        const slowPages = (db.db.prepare(`SELECT url_key url, response_time_ms ms FROM pages WHERE ${HTML_CT} AND status_code=200 AND response_time_ms >= 1000 ORDER BY response_time_ms DESC LIMIT 15`).all() as { url: string; ms: number }[]);
        const imgSampled = one(`SELECT COUNT(*) n FROM image_assets WHERE bytes IS NOT NULL`);
        const largeImages = (db.db.prepare(`SELECT url, bytes, used_on FROM image_assets WHERE bytes >= 100000 ORDER BY bytes DESC LIMIT 15`).all() as { url: string; bytes: number; used_on: number }[])
          .map(r => ({ url: r.url, kb: Math.round(r.bytes / 1024), usedOn: r.used_on }));
        crawlHealth = {
          responseCodes, indexability, speed, htmlSize, depth, titles, metas, onPage, serverErrors, slowPages, largeImages,
          imageStats: imgSampled > 0 ? {
            sampled: imgSampled,
            over100kb: one(`SELECT COUNT(*) n FROM image_assets WHERE bytes >= 100000`),
            over300kb: one(`SELECT COUNT(*) n FROM image_assets WHERE bytes >= 300000`),
          } : null,
          totalPages,
        };
      }
    }

    // Agent readiness — latest result persisted by check_agent_readiness (one property per DB).
    const arRow = db.db.prepare(`SELECT score, level, checks, by_category, checked_at FROM agent_readiness ORDER BY checked_at DESC LIMIT 1`).get() as { score: number; level: string; checks: string; by_category: string; checked_at: string } | undefined;
    const parseJ = (s: string): any => { try { return JSON.parse(s || '[]'); } catch { return []; } };
    const agentReadiness = arRow ? { score: arRow.score, level: arRow.level, checkedAt: arRow.checked_at, byCategory: parseJ(arRow.by_category), checks: parseJ(arRow.checks) } : undefined;

    // Cannibalisation braids — queries where multiple URLs compete, each URL's weekly avg position.
    // The "braid" of crossing lines over time is Google thrashing between URLs (severity = tangle).
    const cannQueries = db.db.prepare(
      `WITH pp AS (SELECT query, page_key, SUM(impressions) imp, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
                   FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${UB} AND date > date(?, '-90 days')
                   GROUP BY query, page_key HAVING pos < 20 AND imp >= 30)
       SELECT query, COUNT(*) urls, SUM(imp) imp FROM pp GROUP BY query HAVING COUNT(*) >= 2 ORDER BY imp DESC LIMIT 6`,
    ).all(maxDate) as { query: string; urls: number; imp: number }[];
    const cannibalisation = cannQueries.map(q => {
      const urls = db.db.prepare(`SELECT page_key, SUM(impressions) imp FROM search_analytics WHERE query=? AND page_key IS NOT NULL AND ${UB} AND date > date(?, '-90 days') GROUP BY page_key ORDER BY imp DESC LIMIT 4`).all(q.query, maxDate) as { page_key: string }[];
      return {
        query: q.query,
        urls: urls.map(u => ({
          url: u.page_key,
          points: (db.db.prepare(`SELECT strftime('%Y-%W', date) week, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos FROM search_analytics WHERE query=? AND page_key=? AND ${UB} AND date > date(?, '-90 days') AND impressions > 0 GROUP BY week ORDER BY week`).all(q.query, u.page_key, maxDate) as { week: string; pos: number }[])
            .map(w => ({ week: w.week, position: Math.round(w.pos * 10) / 10 })),
        })),
      };
    });

    // Cannibalisation table — the full list (not just the 6 braided). One query for every
    // (query,page_key) pair that competes, grouped client-side. Verdict by IMPRESSION share (robust:
    // impressions are always present, so a single noise click can't flip it): 'dominant' = Google
    // overwhelmingly shows one URL (≥70%, low urgency); 'split' = it rotates between URLs
    // (consolidate). crossType = the competing URLs are DIFFERENT page types (e.g. a category page
    // and an article) — the clearest intent confusion and the most actionable to resolve.
    const cannRows = db.db.prepare(
      `WITH pp AS (SELECT query, page_key, SUM(impressions) imp, SUM(clicks) clk, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
                   FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${UB} AND date > date(?, '-90 days')
                   GROUP BY query, page_key HAVING pos < 20 AND imp >= 30),
            multi AS (SELECT query FROM pp GROUP BY query HAVING COUNT(*) >= 2)
       SELECT pp.query, pp.page_key, pp.imp, pp.clk, pp.pos FROM pp JOIN multi ON multi.query = pp.query
       ORDER BY pp.query, pp.imp DESC`).all(maxDate) as { query: string; page_key: string; imp: number; clk: number; pos: number }[];
    const cannMap = new Map<string, { url: string; impressions: number; clicks: number; position: number; template: string }[]>();
    for (const r of cannRows) {
      const arr = cannMap.get(r.query) ?? [];
      arr.push({ url: r.page_key, impressions: r.imp, clicks: r.clk, position: Math.round(r.pos * 10) / 10, template: templateBucket(r.page_key) });
      cannMap.set(r.query, arr);
    }
    const cannibalisationTable = [...cannMap.entries()].map(([query, urls]) => {
      const totalImpressions = urls.reduce((s, u) => s + u.impressions, 0);
      const totalClicks = urls.reduce((s, u) => s + u.clicks, 0);
      // Impression share of the most-shown URL — robust to click noise (the old click-share verdict
      // could flip 'dominant' on a single click in the 5–10 total-clicks band).
      const imprShare = totalImpressions > 0 ? Math.max(...urls.map(u => u.impressions)) / totalImpressions : 0;
      const verdict: 'split' | 'dominant' = imprShare >= 0.7 ? 'dominant' : 'split';
      // Cross-type = the competing URLs span 2+ page templates (e.g. a /category page vs an article).
      const crossType = new Set(urls.map(u => u.template)).size >= 2;
      return { query, urlCount: urls.length, totalImpressions, totalClicks, verdict, crossType, urls: urls.slice(0, 6) };
    }).sort((a, b) =>
      (Number(b.crossType) - Number(a.crossType)) ||                                   // cross-type first (most actionable)
      ((a.verdict === 'split' ? 0 : 1) - (b.verdict === 'split' ? 0 : 1)) ||           // then split before dominant
      (b.totalImpressions - a.totalImpressions),                                       // then by reach
    ).slice(0, 40);

    // Link intersect (link_intersect) — followed-first, then Trust Flow / domain trust. Absent
    // table (pre-link_intersect DB) is fine; the tab shows a run/upsell state instead.
    let linkProspects: DashboardData['linkProspects'] = [];
    try {
      const lpRows = db.db.prepare(
        `SELECT domain, intersections, linked_targets, domain_trust, spam_score, dofollow,
                trust_flow, citation_flow, topical_trust_flow, competitors_set, fetched_at
         FROM link_prospects
         ORDER BY dofollow DESC, COALESCE(trust_flow, domain_trust, 0) DESC LIMIT 100`,
      ).all() as any[];
      const pj = (s: string): any => { try { return JSON.parse(s || '[]'); } catch { return []; } };
      linkProspects = lpRows.map(r => ({
        domain: r.domain,
        intersections: r.intersections || 0,
        linkedTargets: pj(r.linked_targets),
        domainTrust: r.domain_trust ?? null,
        spamScore: r.spam_score ?? null,
        dofollow: !!r.dofollow,
        trustFlow: r.trust_flow ?? null,
        citationFlow: r.citation_flow ?? null,
        topTopic: pj(r.topical_trust_flow)[0]?.topic ?? null,
        competitors: pj(r.competitors_set),
        fetchedAt: r.fetched_at ?? null,
      }));
    } catch { /* no link_prospects table yet */ }

    // Trapped authority: pages with real external authority (referring domains) buried deep
    // internally (click depth 3+ from home via body links, or unreachable) — equity not reaching
    // money pages. Needs pull_backlinks (page_backlinks); empty otherwise.
    let trappedAuthority: DashboardData['trappedAuthority'] = [];
    try {
      const taRows = db.db.prepare(
        `SELECT p.url_key url, COALESCE(p.ipr,0) ipr, p.click_depth cd,
                COALESCE(b.referring_domains,0) rd, COALESCE(b.backlinks,0) bl,
                b.trust_flow tf, b.topical_trust_flow ttf
         FROM page_backlinks b JOIN pages p ON p.url_key = b.url_key
         WHERE p.status_code = 200 AND COALESCE(b.referring_domains,0) >= 2
           AND (p.click_depth IS NULL OR p.click_depth >= 3)`,
      ).all() as { url: string; ipr: number; cd: number | null; rd: number; bl: number; tf: number | null; ttf: string | null }[];
      trappedAuthority = taRows
        .map(r => {
          let topTopic: string | null = null;
          try { topTopic = (JSON.parse(r.ttf || '[]')[0]?.topic) ?? null; } catch { /* not enriched */ }
          // Rank by real authority buried deep: Majestic Trust Flow (0-100) when enriched, else the
          // referring-domains count (capped) as a proxy, weighted by how deep the page sits.
          const authority = r.tf != null ? r.tf : Math.min(r.rd, 100);
          return { url: r.url, referringDomains: r.rd, backlinks: r.bl, clickDepth: r.cd, ipr: Math.round(r.ipr), trustFlow: r.tf ?? null, topTopic, _s: authority * (r.cd ?? 6) };
        })
        .sort((a, b) => b._s - a._s)
        .slice(0, 20)
        .map(({ _s, ...rest }) => rest);
    } catch { /* no page_backlinks / no crawl */ }

    const payload: DashboardData = {
      siteUrl,
      linkProspects,
      trappedAuthority,
      dateRange: { current: `last 28d to ${maxDate}`, prior: 'prior 28d', maxDate, rawMaxDate: fresh.rawMax ?? maxDate, trimmedDays: fresh.trimmedDays },
      equityScatter,
      templateMismatch,
      crawlHealth,
      cannibalisation,
      cannibalisationTable,
      brandedSplit,
      topLinkedPages,
      linkFlows,
      structureGraph,
      healthScore,
      securityCoverage,
      schemaCoverage,
      indexCoverage,
      redirectChains,
      cwvCoverage,
      hreflangCoverage,
      entityGraph,
      answerability,
      topicClusters,
      agentReadiness,
      rankHistory,
      dateAlignment,
      rankingDistribution,
      strikingDistance,
      quickWins,
      contentDecay,
      summary: {
        current: { ...cur, ctr: ctr(cur) },
        prior: { ...prior, ctr: ctr(prior) },
      },
      rankTrend,
      topKeywords,
      deviceBreakdown,
      countryBreakdown,
      pagePerformance,
      keywordMovement,
      findings,
      serpFootprint: latestSerpFootprint(db.db),
      marketSizing: latestMarketSizing(db.db),
    };
    // Best-effort cache write (skip silently if the DB is read-only).
    try {
      db.db.prepare(`INSERT INTO dashboard_cache (id, version, payload, created_at) VALUES (1, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET version=excluded.version, payload=excluded.payload, created_at=excluded.created_at`)
        .run(version, JSON.stringify(payload));
    } catch { /* cache is an optimisation, never block the dashboard on it */ }
    return payload;
  } finally {
    db.close();
  }
}

/** Template proxy: first URL path segment (homepage / content-root collapse to named buckets). */
function templateBucket(urlKey: string): string {
  try {
    const p = new URL(urlKey).pathname.replace(/^\/+|\/+$/g, '');
    if (!p) return 'homepage';
    return p.includes('/') ? p.split('/')[0] : 'content';
  } catch { return 'other'; }
}

/** Categorise a page by period-over-period performance (per the agency-report idiom). */
function pageCategory(cur: { clicks: number; impressions: number }, prev: { clicks: number; impressions: number }): string {
  const pct = prev.clicks ? ((cur.clicks - prev.clicks) / prev.clicks) * 100 : (cur.clicks > 0 ? 100 : 0);
  if (pct >= 15) return 'top performer';
  if (pct <= -30) return 'low performer';
  if (prev.impressions && ((cur.impressions - prev.impressions) / prev.impressions) * 100 <= -20) return 'declining visibility';
  const curCtr = cur.impressions ? cur.clicks / cur.impressions : 0;
  const prevCtr = prev.impressions ? prev.clicks / prev.impressions : 0;
  if (prevCtr && curCtr < prevCtr * 0.85) return 'improve CTR';
  return 'stable';
}

/** Categorise a query's rank movement (first-seen vs last-seen position). */
function movementCategory(first: number, last: number): string {
  if (first > 3 && last <= 3) return 'entered top 3';
  if (first <= 3 && last > 3) return 'dropped from top 3';
  const delta = first - last; // positive = improved (lower position number)
  if (delta >= 3) return 'gained';
  if (delta <= -3) return 'lost';
  return 'stable';
}

/** Reconcile GSC (daily) and DataForSEO (monthly) date ranges before charting. */
function reconcileRanges(
  gscMin: string | null,
  gscMax: string,
  rankHistory: NonNullable<DashboardData['rankHistory']>,
): NonNullable<DashboardData['dateAlignment']> {
  const gsc = gscMin && gscMax ? { start: gscMin, end: gscMax } : null;
  const dfs = rankHistory.length
    ? { start: rankHistory[0].period, end: rankHistory[rankHistory.length - 1].period }
    : null;
  if (!dfs) return { gsc, dataforseo: null, overlap: null, note: 'No DataForSEO rank history yet — run track_ranks to add the over-time sequence.' };
  if (!gsc) return { gsc: null, dataforseo: dfs, overlap: null, note: 'No GSC data — run sync_gsc.' };
  const gsM = gsc.start.slice(0, 7);
  const geM = gsc.end.slice(0, 7);
  const oStart = gsM > dfs.start ? gsM : dfs.start;
  const oEnd = geM < dfs.end ? geM : dfs.end;
  const aligned = oStart <= oEnd;
  return {
    gsc,
    dataforseo: dfs,
    overlap: aligned ? { start: oStart, end: oEnd } : null,
    note: aligned
      ? `GSC ${gsc.start}–${gsc.end} (daily) overlaps DataForSEO ${dfs.start}–${dfs.end} (monthly) at ${oStart}–${oEnd}; time charts share that window.`
      : `No overlap: GSC ends ${geM}, DataForSEO covers ${dfs.start}–${dfs.end}. Render on separate axes.`,
  };
}
