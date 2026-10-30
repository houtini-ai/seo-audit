import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { checkAgentReadiness, type AgentReadiness } from './agentReadiness.js';

/**
 * Probe a site for agent readiness and persist the result, so the dashboard and export can show it
 * (a live probe, not crawl-derived). Shared by the check_agent_readiness tool and the dashboard's
 * action button. Persistence is best-effort: the probe result is returned either way.
 */
export async function checkAndSaveAgentReadiness(dataDir: string, siteUrl: string): Promise<AgentReadiness> {
  const r = await checkAgentReadiness(siteUrl);
  try {
    const adb = new AuditDatabase(dbPathFor(dataDir, siteUrl));
    try {
      adb.db.prepare(`INSERT INTO agent_readiness (origin,score,level,checks,by_category,bots,checked_at) VALUES (?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(origin) DO UPDATE SET score=excluded.score, level=excluded.level, checks=excluded.checks, by_category=excluded.by_category, bots=excluded.bots, checked_at=excluded.checked_at`)
        .run(r.origin, r.score, r.level, JSON.stringify(r.checks), JSON.stringify(r.byCategory), r.bots ? JSON.stringify(r.bots) : null);
    } finally { adb.close(); }
  } catch { /* persistence is best-effort */ }
  return r;
}
