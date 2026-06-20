import { randomUUID } from 'node:crypto';
import { AuditDatabase, type Severity } from '../core/AuditDatabase.js';
import { dbPathFor } from '../core/paths.js';
import { CHECKS, type CheckContext, type CheckDef } from './checks.js';

const SEVERITY_WEIGHT: Record<Severity, number> = { crit: 1, high: 0.8, med: 0.5, low: 0.2, info: 0.05 };
const MAX_PER_CHECK = 500; // bound findings/check so a huge site can't balloon the table

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
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const maxDate = (db.db.prepare('SELECT MAX(date) d FROM search_analytics').get() as { d: string | null }).d;
    const pageCount = (db.db.prepare('SELECT COUNT(*) c FROM pages').get() as { c: number }).c;
    const ctx: CheckContext = { db: db.db, gscMaxDate: maxDate };
    const runId = randomUUID().slice(0, 8);

    let checks = CHECKS;
    if (opts.categories?.length) checks = checks.filter(c => opts.categories!.includes(c.category));
    if (!opts.includeJudgement) checks = checks.filter(c => c.certainty >= 1);

    const trafStmt = maxDate
      ? db.db.prepare(`SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, COALESCE(AVG(position),0) position FROM search_analytics WHERE page_key = ? AND date > date(?, '-28 days')`)
      : null;
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
        const E = Math.max(chk.effortBase * scale, 0.0001);
        for (const f of findings) {
          const traf: Traffic = (trafStmt && f.urlKey ? trafStmt.get(f.urlKey, maxDate) : null) as Traffic ?? { clicks: 0, impressions: 0, position: 0 };
          const V = Math.log10(traf.clicks * 10 + traf.impressions + 10);
          const priority = (SEVERITY_WEIGHT[chk.severity] * chk.certainty * V) / E;
          insert.run({
            run_id: runId, check_id: chk.id, category: chk.category, severity: chk.severity,
            labels: JSON.stringify(chk.labels), certainty: chk.certainty, url_key: f.urlKey ?? null,
            evidence: JSON.stringify(f.evidence), traffic_at_risk: JSON.stringify(traf),
            effort: JSON.stringify({ base: chk.effortBase, scale: Math.round(scale * 100) / 100, fixType: chk.fixType }),
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
      .prepare(`SELECT check_id, category, severity, url_key, evidence, traffic_at_risk, priority, recommendation FROM findings WHERE run_id=? ORDER BY priority DESC LIMIT 25`)
      .all(runId);

    return { runId, siteUrl, integrityOk: pageCount > 0, total, bySeverity, byCategory, byCheck, top };
  } finally {
    db.close();
  }
}

/** Run one named check and return its findings (no persistence) — for query_audit. */
export function runSingleCheck(dataDir: string, siteUrl: string, checkId: string, limit = 100): { check: string; findings: any[] } {
  const chk = CHECKS.find(c => c.id === checkId);
  if (!chk) throw new Error(`Unknown check: ${checkId}. See list_checks.`);
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const maxDate = (db.db.prepare('SELECT MAX(date) d FROM search_analytics').get() as { d: string | null }).d;
    const findings = chk.run({ db: db.db, gscMaxDate: maxDate }).slice(0, limit);
    return { check: checkId, findings };
  } finally {
    db.close();
  }
}
