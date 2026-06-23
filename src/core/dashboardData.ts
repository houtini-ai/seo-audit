import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { gscFreshness } from './gscFreshness.js';
import { expectedCtr } from './ctrModel.js';

export interface DashboardData {
  siteUrl: string;
  empty?: boolean;
  dateRange?: { current: string; prior: string; maxDate: string; rawMaxDate: string; trimmedDays: number };
  summary?: {
    current: { clicks: number; impressions: number; ctr: number; position: number };
    prior: { clicks: number; impressions: number; ctr: number; position: number };
  };
  rankTrend?: { date: string; clicks: number; position: number }[];
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
  equityScatter?: { x: number; y: number; t: string }[];
  // Template-level mismatch: where internal equity flows vs where traffic actually comes from.
  templateMismatch?: { template: string; pages: number; iprPct: number; trafficPct: number }[];
  // Cannibalisation braids: per contested query, each competing URL's weekly average position.
  cannibalisation?: { query: string; urls: { url: string; points: { week: string; position: number }[] }[] }[];
  // Top internally-linked pages + their live status — a non-200 high up here is a big equity leak.
  topLinkedPages?: { url: string; inlinks: number; status: number | null; indexable: boolean; reason: string | null }[];
  // Agent readiness (from check_agent_readiness) — how ready the site is for AI agents.
  agentReadiness?: { score: number; level: string; checkedAt: string; byCategory: { category: string; passed: number; total: number }[]; checks: { id: string; category: string; label: string; present: boolean; detail: string; fix: string }[] };
  findings?: {
    runId: string;
    total: number;
    finishedAt: string | null;
    byCheck: { check_id: string; category: string; severity: string; count: number; priority: number }[];
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
        example: { urlKey: string | null; evidence: Record<string, unknown>; clicks: number; impressions: number } | null;
        examples: { urlKey: string | null; evidence: Record<string, unknown>; clicks: number; impressions: number }[];
      }[];
    }[];
  } | null;
}

interface Totals { clicks: number; impressions: number; position: number }

/** Build the dashboard payload for a property from its synced GSC history. */
export function getDashboardData(dataDir: string, siteUrl: string): DashboardData {
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
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

    const rankTrend = db.db
      .prepare(
        `SELECT date, COALESCE(SUM(clicks),0) clicks, COALESCE(AVG(position),0) position
         FROM search_analytics WHERE ${UB} AND date > date(?, '-90 days') GROUP BY date ORDER BY date`,
      )
      .all(maxDate) as { date: string; clicks: number; position: number }[];

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
    let findings: DashboardData['findings'] = null;
    if (lastRun) {
      const byCheck = db.db.prepare('SELECT check_id, category, severity, COUNT(*) count, AVG(priority) priority FROM findings WHERE run_id=? GROUP BY check_id ORDER BY count DESC').all(lastRun.run_id) as NonNullable<DashboardData['findings']>['byCheck'];
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

      const SEV_RANK: Record<string, number> = { crit: 0, high: 1, med: 2, low: 3, info: 4 };
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
          example: examples[0] ?? null,
          examples,
        });
        catMap.set(c.category, list);
      }
      const recommendations = [...catMap.entries()]
        .map(([category, checks]) => ({ category, checks: checks.sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (b.count - a.count)) }))
        .sort((a, b) => Math.min(...a.checks.map(c => SEV_RANK[c.severity])) - Math.min(...b.checks.map(c => SEV_RANK[c.severity])));

      findings = { runId: lastRun.run_id, total: lastRun.finding_count, finishedAt: lastRun.finished_at, byCheck, top, recommendations };
    }

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
        if (p.ipr >= 15 || gg.impr >= 5) scatter.push({ x: Math.round(p.ipr), y: gg.impr, t: ['content', 'category', 'homepage'].includes(t) ? t : 'other' });
      }
      equityScatter = scatter.sort((a, b) => b.y - a.y).slice(0, 500);
      const tIpr = [...agg.values()].reduce((s, a) => s + a.ipr, 0) || 1;
      const tClk = [...agg.values()].reduce((s, a) => s + a.clicks, 0) || 1;
      templateMismatch = [...agg.entries()].map(([template, a]) => ({ template, pages: a.n, iprPct: Math.round(a.ipr / tIpr * 1000) / 10, trafficPct: Math.round(a.clicks / tClk * 1000) / 10 }))
        .sort((x, y) => y.iprPct - x.iprPct).slice(0, 8);
    }

    // Top internally-linked pages with their current status code (most-linked first). A 404/redirect
    // high in this list is a major leak — lots of internal links pointing at a dead/redirected URL.
    const topLinkedPages = (db.db.prepare(`SELECT url_key, COALESCE(inlink_count,0) inl, status_code, indexable, indexable_reason FROM pages WHERE is_internal=1 ORDER BY inlink_count DESC, status_code LIMIT 30`).all() as any[])
      .map(p => ({ url: p.url_key, inlinks: p.inl, status: p.status_code, indexable: !!p.indexable, reason: p.indexable_reason }));

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

    return {
      siteUrl,
      dateRange: { current: `last 28d to ${maxDate}`, prior: 'prior 28d', maxDate, rawMaxDate: fresh.rawMax ?? maxDate, trimmedDays: fresh.trimmedDays },
      equityScatter,
      templateMismatch,
      cannibalisation,
      topLinkedPages,
      agentReadiness,
      rankHistory,
      dateAlignment,
      rankingDistribution,
      strikingDistance,
      quickWins,
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
    };
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
