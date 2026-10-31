import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { LATEST_COMPLETED_RUN_WHERE } from '../audit/history.js';

/** One page of the latest audit's findings, for the dashboard's Issues list. */
export interface FindingsPage {
  runId: string | null;
  /** Findings matching the filter (all pages). */
  total: number;
  offset: number;
  rows: {
    check_id: string; category: string; severity: string; labels: string | null; url_key: string | null; evidence: string;
    traffic_at_risk: string; effort: string; priority: number; recommendation: string; impact: number; size: string;
  }[];
}

/**
 * The latest audit's findings filtered by severity, category and/or check, highest priority first.
 * The dashboard payload carries only the top 50 findings (it would otherwise be megabytes on a big
 * run), so a filter applied to that list said "nothing at this severity" while the chip counted
 * hundreds. Filters now run here, over every finding. The run is chosen as the payload chooses it
 * (latest completed), and impact is normalised to the run's top priority, the payload's scale.
 */
export function listFindings(dataDir: string, siteUrl: string, f: { severity?: string; category?: string; checkId?: string; offset?: number; limit?: number }): FindingsPage {
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const offset = Math.max(0, Math.floor(Number(f.offset) || 0));
    const run = db.db.prepare(`SELECT run_id FROM audit_runs WHERE ${LATEST_COMPLETED_RUN_WHERE} ORDER BY started_at DESC, rowid DESC LIMIT 1`).get() as { run_id: string } | undefined;
    if (!run) return { runId: null, total: 0, offset, rows: [] };
    const where = ['run_id = ?'];
    const args: (string | number)[] = [run.run_id];
    if (f.severity) { where.push('severity = ?'); args.push(f.severity); }
    if (f.category) { where.push('category = ?'); args.push(f.category); }
    if (f.checkId) { where.push('check_id = ?'); args.push(f.checkId); }
    const w = where.join(' AND ');
    const limit = Math.min(500, Math.max(1, Math.floor(Number(f.limit) || 100)));
    const total = (db.db.prepare(`SELECT COUNT(*) c FROM findings WHERE ${w}`).get(...args) as { c: number }).c;
    const maxPrio = Math.max(1, (db.db.prepare('SELECT MAX(priority) m FROM findings WHERE run_id = ?').get(run.run_id) as { m: number | null }).m ?? 0);
    const raw = db.db.prepare(`SELECT check_id, category, severity, labels, url_key, evidence, traffic_at_risk, effort, priority, recommendation
      FROM findings WHERE ${w} ORDER BY priority DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Omit<FindingsPage['rows'][number], 'impact' | 'size'>[];
    const rows = raw.map(r => {
      const impact = Math.round(((r.priority || 0) / maxPrio) * 100);
      return { ...r, impact, size: impact >= 50 ? 'XL' : impact >= 20 ? 'L' : impact >= 5 ? 'M' : 'S' };
    });
    return { runId: run.run_id, total, offset, rows };
  } finally {
    db.close();
  }
}
