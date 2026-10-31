import { randomUUID } from 'node:crypto';
import { AuditDatabase, type Severity } from '../core/AuditDatabase.js';
import { dbPathFor } from '../core/paths.js';
import { finalizeLinkGraph } from '../core/linkGraph.js';
import { gscFreshness } from '../core/gscFreshness.js';
import { brandToken } from '../core/url-key.js';
import { snapshotCrawl } from './drift.js';
import { checkIdsWithGrain, computeHealth, serverVersion } from './history.js';
import { CHECKS, expectedCtr, type CheckContext, type CheckDef } from './checks.js';
import { PAGE_EXPERIENCE_STAKE_SHARE } from './stakes.js';

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
/**
 * Clicks at stake for page-experience findings (0.16.1). An asset or accessibility finding is keyed to
 * the page that loads the asset with the most GSC clicks, so T used to be that page's FULL click count:
 * an oversized image on the site's top page outranked a high-severity CTR or decay finding on the
 * same page, because both claimed all 23k clicks. But fixing one image, one render-blocking set or one
 * cache header doesn't put a page's clicks at stake the way a snippet, indexation or content fix does:
 * page experience (Core Web Vitals) is a light ranking signal next to relevance, accessibility isn't
 * one, and the asset is one of many the page loads (LCP only if it is the LCP element, which a
 * header-only crawl can't tell). The principled stake would be the share of the page's weight or LCP
 * the asset accounts for, but bodies and the LCP element aren't recorded, so the share is a stated
 * assumption: a tenth of the page's clicks. It changes ordering only; every finding still exists, and
 * a perf issue on a genuinely big page still ranks (10% of a 20k-click page beats most of a small one).
 * Field-data CWV failures (high-yield-cwv-fail) are measured per page and keep the full stake.
 */
export { PAGE_EXPERIENCE_STAKE_SHARE };
export function stakeShareOf(chk: CheckDef): number {
  if (chk.stakeShare != null) return Math.max(0, Math.min(1, chk.stakeShare));
  return chk.category === 'accessibility' ? PAGE_EXPERIENCE_STAKE_SHARE : 1;
}
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
  /** `count` is findings STORED; when the per-check cap bit, `totalFound` is the real number. */
  byCheck: { checkId: string; category: string; severity: string; count: number; priority: number; totalFound?: number; truncated?: boolean }[];
  /** Checks whose findings exceeded MAX_PER_CHECK, with their true totals — never cap silently. */
  truncatedChecks?: { checkId: string; stored: number; totalFound: number }[];
  /** Checks whose source data was never collected (CheckDef.collected): unknown, not passed. */
  notCollected?: { checkId: string; note: string }[];
  /** The highest-priority findings (topLimit, default 10), as parsed objects with compact evidence. */
  top: TopFinding[];
  /** Each check in `top` once: its title and fix (the text is not repeated per finding). */
  checks: Record<string, { title: string; fix: string }>;
  elapsedMs?: number; // wall-clock for the audit run (performance instrumentation)
  indexability?: Record<string, number>; // reason → count (indexable, http-404, noindex-meta, robots-disallowed, …)
}

export interface AuditOptions {
  scope?: 'core' | 'full';
  categories?: string[];
  includeJudgement?: boolean; // run N (certainty < 1) checks too
  topLimit?: number; // findings returned in `top` (default 10, max 50); query_audit is the drill-down
}

/** One `top` finding as returned by run_audit: parsed, rounded, evidence trimmed (full rows stay in `findings`). */
export interface TopFinding {
  id: number; // findings.id, for fix_finding
  checkId: string;
  category: string;
  severity: string;
  url: string | null;
  priority: number;
  traffic: { clicks: number; impressions: number; position: number };
  effort: { hours: number; fixType: string; expectedClicks: number; yield: number; stakeShare?: number };
  evidence: Record<string, unknown>;
}

export const TOP_DEFAULT = 10;
export const TOP_MAX = 50;
/** Evidence trimming for `top`: arrays keep their first 3 items (the full length goes in `<key>Total`), strings are cut at 200 chars. */
export const EVIDENCE_ARRAY_MAX = 3;
export const EVIDENCE_STRING_MAX = 200;

/** Trim a finding's evidence for the run_audit reply. query_audit returns it in full. */
export function compactEvidence(ev: unknown, depth = 0): Record<string, unknown> {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return {};
  const out: Record<string, unknown> = {};
  const trim = (v: unknown, d: number): unknown => {
    if (typeof v === 'string') return v.length > EVIDENCE_STRING_MAX ? `${v.slice(0, EVIDENCE_STRING_MAX - 1)}…` : v;
    if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 100) / 100;
    if (Array.isArray(v)) return v.slice(0, EVIDENCE_ARRAY_MAX).map(x => trim(x, d + 1));
    if (v && typeof v === 'object') return d >= 2 ? '[…]' : compactEvidence(v, d + 1);
    return v;
  };
  for (const [k, v] of Object.entries(ev as Record<string, unknown>)) {
    out[k] = trim(v, depth);
    if (Array.isArray(v) && v.length > EVIDENCE_ARRAY_MAX && !(`${k}Total` in (ev as object))) out[`${k}Total`] = v.length;
  }
  return out;
}

const parseJson = (s: unknown): any => { if (typeof s !== 'string') return s ?? {}; try { return JSON.parse(s); } catch { return {}; } };
const round1 = (n: unknown): number => Math.round((Number(n) || 0) * 10) / 10;

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
  let startedRunId: string | null = null; // set once the audit_runs row exists, cleared on completion
  try {
    // Finalised GSC date (trailing partial days trimmed) — keeps the audit's 28d windows and the
    // per-page traffic map consistent with the dashboard, and free of unfinalised-data distortion.
    const maxDate = gscFreshness(db.db).effectiveMax;
    const pageCount = (db.db.prepare('SELECT COUNT(*) c FROM pages').get() as { c: number }).c;

    let crawlId: string | null = null; // the crawl this run reads (recorded on the run row)
    // Self-heal: if the latest crawl's link-graph was left unpopulated (e.g. the crawl process
    // was killed before finalizing), recompute inlink_count/iPR/click_depth so graph-dependent
    // checks (deep-pages, orphans, iPR-bleed, underlinked-high-demand…) aren't silently no-op.
    if (pageCount > 0) {
      const cr = db.db.prepare('SELECT crawl_id FROM pages LIMIT 1').get() as { crawl_id: string } | undefined;
      crawlId = cr?.crawl_id ?? null;
      if (cr) {
        const g = db.db.prepare('SELECT MAX(ipr) mi, MAX(inlink_count) mc FROM pages WHERE crawl_id=?').get(cr.crawl_id) as { mi: number | null; mc: number | null };
        if ((g.mi ?? 0) === 0 && (g.mc ?? 0) === 0) finalizeLinkGraph(db.db, cr.crawl_id, null);
        // Drift snapshot (idempotent per crawl) so change-detection has cross-crawl history.
        const at = (db.db.prepare(`SELECT COALESCE(finished_at, datetime('now')) at FROM crawl_metadata WHERE crawl_id=?`).get(cr.crawl_id) as { at: string } | undefined)?.at ?? new Date().toISOString();
        snapshotCrawl(db.db, cr.crawl_id, at);
      }
    }
    const ctx: CheckContext = { db: db.db, gscMaxDate: maxDate, brand: brandToken(siteUrl), siteUrl };
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
         FROM gsc_rows WHERE page_key IS NOT NULL AND date <= '${maxDate}' AND date > date(?, '-28 days') GROUP BY page_key`,
      ).all(maxDate) as (Traffic & { page_key: string })[]) {
        trafficMap.set(row.page_key, { clicks: row.clicks, impressions: row.impressions, position: row.position });
      }
    }
    // Total site clicks in the window — the baseline for site-wide (null-url) findings (6e).
    const siteClicks = maxDate
      ? (db.db.prepare(`SELECT COALESCE(SUM(clicks),0) c FROM gsc_rows WHERE date <= '${maxDate}' AND date > date(?, '-28 days')`).get(maxDate) as { c: number }).c
      : 0;
    const insert = db.db.prepare(
      `INSERT INTO findings (run_id, check_id, category, severity, labels, certainty, url_key, evidence, traffic_at_risk, effort, priority, recommendation)
       VALUES (@run_id,@check_id,@category,@severity,@labels,@certainty,@url_key,@evidence,@traffic_at_risk,@effort,@priority,@recommendation)`,
    );

    const insertErrorPage = db.db.prepare(`INSERT OR IGNORE INTO audit_error_pages (run_id, url_key) VALUES (?, ?)`);
    db.db.prepare(`INSERT INTO audit_runs (run_id, scope, gsc_window_end, integrity_ok, started_at, status) VALUES (?,?,?,?,datetime('now'),'running')`)
      .run(runId, opts.scope ?? 'core', maxDate, pageCount > 0 ? 1 : 0);
    startedRunId = runId;

    let total = 0;
    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};

    const truncated = new Map<string, number>(); // checkId → true finding count before the cap
    const notCollected: { checkId: string; note: string }[] = [];

    const tx = db.db.transaction(() => {
      for (const chk of checks) {
        const missing = chk.collected?.(ctx) ?? null;
        if (missing) notCollected.push({ checkId: chk.id, note: missing });
        const all = chk.run(ctx);
        // Effort scales with the REAL number of affected pages, not the stored sample. Scaling on
        // the capped length understates E (log10(509) vs log10(5009)) and therefore INFLATES
        // priority = (T×Y×C)/E on exactly the biggest checks — the cap was reordering the report.
        const scale = effortScale(chk.fixType, all.length);
        const findings = all.slice(0, MAX_PER_CHECK);
        if (all.length > MAX_PER_CHECK) {
          truncated.set(chk.id, all.length);
          // The pages past the cap still carry a crit/high issue: keep their keys for the health score.
          if (chk.severity === 'crit' || chk.severity === 'high') {
            for (const f of all.slice(MAX_PER_CHECK)) if (f.urlKey) insertErrorPage.run(runId, f.urlKey);
          }
        }
        const E = Math.max(chk.effortBase * scale, 0.0001); // effort in ~hours
        const Y = yieldOf(chk);
        const share = stakeShareOf(chk);
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
          T *= share; // page-experience findings stake a share of the page's clicks, not all of them
          T = Math.max(T, SEVERITY_FLOOR[chk.severity]); // floor so zero-GSC findings aren't lost
          const priority = (T * Y * chk.certainty) / E; // expected clicks per dev-hour
          insert.run({
            run_id: runId, check_id: chk.id, category: chk.category, severity: chk.severity,
            labels: JSON.stringify(chk.labels), certainty: chk.certainty, url_key: f.urlKey ?? null,
            evidence: JSON.stringify(f.evidence), traffic_at_risk: JSON.stringify(traf),
            effort: JSON.stringify({ base: chk.effortBase, scale: Math.round(scale * 100) / 100, fixType: chk.fixType, hours: Math.round(E * 10) / 10, expectedClicks: Math.round(T * 10) / 10, yield: Math.round(Y * 100) / 100, ...(share !== 1 ? { stakeShare: share } : {}) }),
            priority, recommendation: JSON.stringify({ title: chk.title, text: chk.fix }),
          });
          total++;
          bySeverity[chk.severity] = (bySeverity[chk.severity] ?? 0) + 1;
          byCategory[chk.category] = (byCategory[chk.category] ?? 0) + 1;
        }
      }
    });
    tx();

    // Health (the dashboard's formula, against the page set this run read) + the check set (each
    // regrouped check's finding grain as id@N, history.ts REGROUPED_CHECKS) + the
    // code version, written in the same completion UPDATE so a completed row always carries them.
    const health = computeHealth(db.db, runId);
    db.db.prepare(
      `UPDATE audit_runs SET finished_at=datetime('now'), finding_count=?, status='completed', crawl_id=?,
         health_score=?, health_error_pages=?, health_total_pages=?, health_basis=?, check_ids=?, server_version=?
       WHERE run_id=?`,
    ).run(total, crawlId, health?.score ?? null, health?.errorPages ?? null, health?.totalPages ?? null,
      health ? 'audit' : 'none:no-pages', checkIdsWithGrain(db.db, runId, checks.map(c => c.id)), serverVersion(), runId);
    startedRunId = null;

    // Stored counts, annotated with the true total wherever the per-check cap bit — a bare
    // "count: 500" reads as "that's all there was" when it may be 5,000.
    const byCheck = (db.db
      .prepare(`SELECT check_id checkId, category, severity, COUNT(*) count, AVG(priority) priority FROM findings WHERE run_id=? GROUP BY check_id ORDER BY count DESC`)
      .all(runId) as AuditResult['byCheck'])
      .map(r => {
        const t = truncated.get(r.checkId);
        const row = { ...r, priority: round1(r.priority) }; // AVG(): 1 dp is plenty, and 15 digits x 143 checks is not
        return t ? { ...row, totalFound: t, truncated: true } : row;
      });
    const truncatedChecks = [...truncated.entries()]
      .map(([checkId, totalFound]) => ({ checkId, stored: MAX_PER_CHECK, totalFound }))
      .sort((a, b) => b.totalFound - a.totalFound);
    // `top` is the headline, not the dump (0.16.1): parsed objects, capped (default 10), evidence
    // trimmed, and each check's title + fix given once in `checks` instead of on every finding.
    const topLimit = Math.max(1, Math.min(TOP_MAX, Math.floor(opts.topLimit ?? TOP_DEFAULT)));
    const checkText: AuditResult['checks'] = {};
    const top: TopFinding[] = (db.db
      .prepare(`SELECT id, check_id, category, severity, url_key, evidence, traffic_at_risk, effort, priority, recommendation FROM findings WHERE run_id=? ORDER BY priority DESC, id ASC LIMIT ?`)
      .all(runId, topLimit) as any[])
      .map(f => {
        const rec = parseJson(f.recommendation), traf = parseJson(f.traffic_at_risk), eff = parseJson(f.effort);
        checkText[f.check_id] ??= { title: rec.title ?? f.check_id, fix: rec.text ?? '' };
        return {
          id: f.id, checkId: f.check_id, category: f.category, severity: f.severity, url: f.url_key ?? null,
          priority: round1(f.priority),
          traffic: { clicks: Number(traf.clicks) || 0, impressions: Number(traf.impressions) || 0, position: round1(traf.position) },
          effort: { hours: eff.hours, fixType: eff.fixType, expectedClicks: eff.expectedClicks, yield: eff.yield, ...(eff.stakeShare != null ? { stakeShare: eff.stakeShare } : {}) },
          evidence: compactEvidence(parseJson(f.evidence)),
        };
      });

    const indexability = Object.fromEntries(
      (db.db.prepare(`SELECT COALESCE(indexable_reason,'indexable') reason, COUNT(*) n FROM pages WHERE is_internal IS NOT 0 GROUP BY reason ORDER BY n DESC`).all() as { reason: string; n: number }[])
        .map(r => [r.reason, r.n]),
    );
    return {
      runId, siteUrl, integrityOk: pageCount > 0, total, bySeverity, byCategory, byCheck, top, checks: checkText,
      ...(truncatedChecks.length ? { truncatedChecks } : {}),
      ...(notCollected.length ? { notCollected } : {}),
      elapsedMs: Date.now() - t0, indexability,
    };
  } catch (err) {
    // A run that threw must not read as 'running' forever on the dashboard: mark it failed.
    if (startedRunId) {
      try { db.db.prepare(`UPDATE audit_runs SET status='failed', error=?, finished_at=datetime('now') WHERE run_id=?`).run(err instanceof Error ? err.message : String(err), startedRunId); } catch { /* best-effort */ }
    }
    throw err;
  } finally {
    db.close();
  }
}

/** Run one named check and return its findings (no persistence) — for query_audit. */
export function runSingleCheck(dataDir: string, siteUrl: string, checkId: string, limit = 100, offset = 0): { check: string; findings: any[]; total: number; notCollected?: string } {
  const chk = CHECKS.find(c => c.id === checkId);
  if (!chk) throw new Error(`Unknown check: ${checkId}. See list_checks.`);
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const maxDate = gscFreshness(db.db).effectiveMax;
    const ctx = { db: db.db, gscMaxDate: maxDate, brand: brandToken(siteUrl), siteUrl };
    const notCollected = chk.collected?.(ctx) ?? null;
    const all = chk.run(ctx);
    return { check: checkId, findings: all.slice(offset, offset + limit), total: all.length, ...(notCollected ? { notCollected } : {}) };
  } finally {
    db.close();
  }
}
