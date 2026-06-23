// Verify the freshness fix flows through getDashboardData: trend tail should not cliff, and
// dateRange should report the trimmed days.
import { getDashboardData } from '../dist/core/dashboardData.js';
import { gscFreshness } from '../dist/core/gscFreshness.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { homedir } from 'node:os';
import path from 'node:path';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
for (const site of ['sc-domain:simracingcockpit.gg', 'sc-domain:ehi.com.au', 'sc-domain:directdrivewheels.com']) {
  const db = new AuditDatabase(dbPathFor(dataDir, site));
  const f = gscFreshness(db.db);
  db.close?.();
  const d = getDashboardData(dataDir, site);
  const trend = d.rankTrend ?? [];
  const tail = trend.slice(-3).map(t => `${t.date}:${t.clicks}c`).join('  ');
  console.log(`${site}\n  fresh: raw=${f.rawMax} eff=${f.effectiveMax} trimmed=${f.trimmedDays}\n  range: ${d.dateRange?.current} (trimmed ${d.dateRange?.trimmedDays})\n  trend tail: ${tail}`);
}
