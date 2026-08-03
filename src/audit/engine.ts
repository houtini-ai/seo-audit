import { randomUUID } from 'node:crypto';
import { AuditDatabase, type Severity } from '../core/AuditDatabase.js';
import { dbPathFor } from '../core/paths.js';
import { finalizeLinkGraph } from '../core/linkGraph.js';
import { gscFreshness } from '../core/gscFreshness.js';
import { brandToken } from '../core/url-key.js';
import { snapshotCrawl } from './drift.js';
import { CHECKS, expectedCtr, type CheckContext, type CheckDef } from './checks.js';

const MAX_PER_CHECK = 500; // bound findings/check so a huge site can't balloon the table

// ── 6e priority model: Priority = (T × Y × C) / E — "expected clicks per dev-hour" ──
// Y (yield): expected % traffic uplift from the fix. Default derived from category×severity;
// a check can override via yieldCoef. Indexation/crawlability fixes recover most traffic;
// on-page tweaks are incremental; low-severity = cosmetic.
const YIELD_BY_CATEGORY: Record<string, number> = {
  indexation: 0.8, crawlability: 0.7, merged: 0.4, security: 0.5,
  schema: 0.3, content: 0.25, onpage: 0.2, performance: 0.5, 'war-stories': 0.5,
};
// Low/info are cosmetic — near-zero real traffic uplift, so they don't ride a high-traffic page up.
const SEVERITY_YIELD_ADJ: Record<Severity, number> = { crit: 1.1, high: 1, med: 0.7, low: 0.15, info: 0.05 };
function yieldOf(chk: CheckDef): number {
  if (chk.yieldCoef != null) return Math.max(0, Math.min(1, chk.yieldCoef));
  return Math.min(1, (YIELD_BY_CATEGORY[chk.category] ?? 0.25) * SEVERITY_YIELD_ADJ[chk.severity]);
}
// Site-wide (null-url) findings: stake = a severity-scaled fraction of total site clicks.
const SITEWIDE_FRACTION: Record<Severity, number> = { crit: 0.25, high: 0.12, med: 0.04, low: 0.01, info: 0.005 };
// Floor so a high-severity finding on a zero-GSC page (e.g. backlinks-to-404) never scores 0.
const SEVERITY_FLOOR: Record<Severity, number> = { crit: 5, high: 2, med: 0.5, low: 0.1, info: 0.05 };

interface Traffic { clicks: number; impressions: number; position: number }

export interface AuditResult {
  runId: string;
  siteUrl: string;
  integrityOk: boolean;
  total: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  byCheck: { checkId: string; category: string; severity: string; count: number; priority: number }[];
  top: any[];
  elapsedMs?: number; // wall-clock for the audit run (performance instrumentation)
  indexability?: Record<string, number>; // reason → count (indexable, http-404, noindex-meta, robots-disallowed, …)
}

export interface AuditOptions {
  scope?: 'core' | 'full';
  categories?: string[];
  includeJudgement?: boolean; // run N (certainty < 1) checks too
}

export function listChecks(): Omit<CheckDef, 'run'>[] {
  return CHECKS.map(({ run: _run, ...meta }) => meta);
}

function effortScale(fixType: CheckDef['fixType'], n: number): number {
  if (fixType === 'global') return 1;
  if (fixType === 'automated') return 1.2;
  return Math.log10(n + 9); // per-page: sub-linear (bulk workflows)
}

export function runAudit(dataDir: string, siteUrl: string, opts: AuditOptions = {}): AuditResult {
  const t0 = Date.now();
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    // Finalised GSC date (trailing partial days trimmed) — keeps the audit's 28d windows and the
    // per-page traffic map consistent with the dashboard, and free of unfinalised-data distortion.
    const maxDate = gscFreshness(db.db).effectiveMax;
    const pageCount = (db.db.prepare('SELECT COUNT(*) c FROM pages').get() as { c: number }).c;

    // Self-heal: if the latest crawl's link-graph was left unpopulated (e.g. the crawl process
    // was killed before finalizing), recompute inlink_count/iPR/click_depth so graph-dependent
    // checks (deep-pages, orphans, iPR-bleed, underlinked-high-demand…) aren't silently no-op.
    if (pageCount > 0) {
      const cr = db.db.prepare('SELECT crawl_id FROM pages LIMIT 1').get() as { crawl_id: string } | undefined;
      if (cr) {
        const g = db.db.prepare('SELECT MAX(ipr) mi, MAX(inlink_count) mc FROM pages WHERE crawl_id=?').get(cr.crawl_id) as { mi: number | null; mc: number | null };
        if ((g.mi ?? 0) === 0 && (g.mc ?? 0) === 0) finalizeLinkGraph(db.db, cr.crawl_id, null);
        // Drift snapshot (idempotent per crawl) so change-detection has cross-crawl history.
        const at = (db.db.prepare(`SELECT COALESCE(finished_at, datetime('now')) at FROM crawl_metadata WHERE crawl_id=?`).get(cr.crawl_id) as { at: string } | undefined)?.at ?? new Date().toISOString();
        snapshotCrawl(db.db, cr.crawl_id, at);
      }
    }
    const ctx: CheckContext = { db: db.db, gscMaxDate: maxDate, brand: brandToken(siteUrl) };
    const runId = randomUUID().slice(0, 8);

    let checks = CHECKS;
    if (opts.categories?.length) checks = checks.filter(c => opts.categories!.includes(c.category));
    if (!opts.includeJudgement) checks = checks.filter(c => c.certainty >= 1);

    // Precompute per-page traffic for the window in ONE covering scan, instead of a query per
    // finding (which was hundreds of windowed aggregations on a 1.8M-row GSC table — seconds).
    const trafficMap = new Map<string, Traffic>();
    if (maxDate) {
      for (const row of db.db.prepare(
        `SELECT page_key, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions,
                COALESCE(SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0), 0) position
         FROM search_analytics WHERE page_key IS NOT NULL AND date <= '${maxDate}' AND date > date(?, '-28 days') GROUP BY page_key`,
      ).all(maxDate) as (Traffic & { page_key: string })[]) {
        trafficMap.set(row.page_key, { clicks: row.clicks, impressions: row.impressions, position: row.position });
      }
    }
    // Total site clicks in the window — the baseline for site-wide (null-url) findings (6e).
    const siteClicks = maxDate
      ? (db.db.prepare(`SELECT COALESCE(SUM(clicks),0) c FROM search_analytics WHERE date <= '${maxDate}' AND date > date(?, '-28 days')`).get(maxDate) as { c: number }).c
      : 0;
    const insert = db.db.prepare(
      `INSERT INTO findings (run_id, check_id, category, severity, labels, certainty, url_key, evidence, traffic_at_risk, effort, priority, recommendation)
       VALUES (@run_id,@check_id,@category,@severity,@labels,@certainty,@url_key,@evidence,@traffic_at_risk,@effort,@priority,@recommendation)`,
    );

    db.db.prepare(`INSERT INTO audit_runs (run_id, scope, gsc_window_end, integrity_ok, started_at) VALUES (?,?,?,?,datetime('now'))`)
      .run(runId, opts.scope ?? 'core', maxDate, pageCount > 0 ? 1 : 0);

    let total = 0;
    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};

    const tx = db.db.transaction(() => {
      for (const chk of checks) {
        const findings = chk.run(ctx).slice(0, MAX_PER_CHECK);
        const scale = effortScale(chk.fixType, findings.length);
        const E = Math.max(chk.effortBase * scale, 0.0001); // effort in ~hours
        const Y = yieldOf(chk);
        for (const f of findings) {
          const ev = (f.evidence ?? {}) as any;
          const evImpr = Number(ev.impressions) || 0;
          const evClicks = Number(ev.clicks) || 0;
          // `positions` can be a range string ("1.1–15.3", cannibalisation). parseFloat would
          // take the BEST position and price the whole query's impressions at its CTR (wildly
          // inflating T when the leader sits at #1) — use the midpoint of the range instead.
          const posNums = String(ev.positions ?? ev.position ?? '').match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
          const evPos = posNums.length ? posNums.reduce((a, b) => a + b, 0) / posNums.length : 0;
          const hasQuery = ev.query != null && String(ev.query).length > 0;
          const pageTraf = f.urlKey ? trafficMap.get(f.urlKey) : null;
          // Choose the right stake per finding shape:
          //  • per-query findings (evidence has a `query`: striking-distance, cannibalisation) →
          //    the query's OWN impressions/clicks (so 2.7k shows 2.7k, not the page's 257k total,
          //    and multiple per-query findings on one page get DISTINCT priorities);
          //  • page-level findings on a known URL (ctr-below-expected, missing-meta, …) →
          //    the page's real GSC traffic (keeps its actual clicks, not 0);
          //  • null-url findings that still carry evidence traffic → that evidence.
          let traf: Traffic;
          if (hasQuery) {
            traf = { clicks: evClicks, impressions: evImpr, position: evPos || (pageTraf?.position ?? 0) };
          } else if (pageTraf) {
            traf = pageTraf;
          } else if (evImpr > 0 || evClicks > 0) {
            traf = { clicks: evClicks, impressions: evImpr, position: evPos };
          } else {
            traf = { clicks: 0, impressions: 0, position: 0 };
          }
          // T = expected monthly clicks at stake: max(current clicks recovered, potential from
          // impressions × CTR@position). Site-wide findings with no traffic signal fall back to a
          // severity fraction of total site clicks.
          let T: number;
          if (traf.impressions > 0 || traf.clicks > 0) {
            const potential = traf.impressions > 0 ? traf.impressions * expectedCtr(traf.position || 10) : 0;
            T = Math.max(traf.clicks, potential);
          } else if (!f.urlKey) {
            T = siteClicks * SITEWIDE_FRACTION[chk.severity];
          } else {
            T = 0; // floored below
          }
          T = Math.max(T, SEVERITY_FLOOR[chk.severity]); // floor so zero-GSC findings aren't lost
          const priority = (T * Y * chk.certainty) / E; // expected clicks per dev-hour
          insert.run({
            run_id: runId, check_id: chk.id, category: chk.category, severity: chk.severity,
            labels: JSON.stringify(chk.labels), certainty: chk.certainty, url_key: f.urlKey ?? null,
            evidence: JSON.stringify(f.evidence), traffic_at_risk: JSON.stringify(traf),
            effort: JSON.stringify({ base: chk.effortBase, scale: Math.round(scale * 100) / 100, fixType: chk.fixType, hours: Math.round(E * 10) / 10, expectedClicks: Math.round(T * 10) / 10, yield: Math.round(Y * 100) / 100 }),
            priority, recommendation: JSON.stringify({ title: chk.title, text: chk.fix }),
          });
          total++;
          bySeverity[chk.severity] = (bySeverity[chk.severity] ?? 0) + 1;
          byCategory[chk.category] = (byCategory[chk.category] ?? 0) + 1;
        }
      }
    });
    tx();

    db.db.prepare(`UPDATE audit_runs SET finished_at=datetime('now'), finding_count=? WHERE run_id=?`).run(total, runId);

    const byCheck = db.db
      .prepare(`SELECT check_id checkId, category, severity, COUNT(*) count, AVG(priority) priority FROM findings WHERE run_id=? GROUP BY check_id ORDER BY count DESC`)
      .all(runId) as AuditResult['byCheck'];
    const top = db.db
      .prepare(`SELECT check_id, category, severity, url_key, evidence, traffic_at_risk, effort, priority, recommendation FROM findings WHERE run_id=? ORDER BY priority DESC LIMIT 25`)
      .all(runId);

    const indexability = Object.fromEntries(
      (db.db.prepare(`SELECT COALESCE(indexable_reason,'indexable') reason, COUNT(*) n FROM pages WHERE is_internal IS NOT 0 GROUP BY reason ORDER BY n DESC`).all() as { reason: string; n: number }[])
        .map(r => [r.reason, r.n]),
    );
    return { runId, siteUrl, integrityOk: pageCount > 0, total, bySeverity, byCategory, byCheck, top, elapsedMs: Date.now() - t0, indexability };
  } finally {
    db.close();
  }
}

/** Run one named check and return its findings (no persistence) — for query_audit. */
export function runSingleCheck(dataDir: string, siteUrl: string, checkId: string, limit = 100, offset = 0): { check: string; findings: any[]; total: number } {
  const chk = CHECKS.find(c => c.id === checkId);
  if (!chk) throw new Error(`Unknown check: ${checkId}. See list_checks.`);
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const maxDate = gscFreshness(db.db).effectiveMax;
    const all = chk.run({ db: db.db, gscMaxDate: maxDate, brand: brandToken(siteUrl) });
    return { check: checkId, findings: all.slice(offset, offset + limit), total: all.length };
  } finally {
    db.close();
  }
}
