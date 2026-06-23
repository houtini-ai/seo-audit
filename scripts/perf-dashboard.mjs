// Measure getDashboardData wall-clock + DB scale per site (evidence for the performance review).
import { getDashboardData } from '../dist/core/dashboardData.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { homedir } from 'node:os';
import path from 'node:path';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const sites = ['sc-domain:simracingcockpit.gg', 'sc-domain:ehi.com.au', 'sc-domain:directdrivewheels.com'];

for (const site of sites) {
  const db = new AuditDatabase(dbPathFor(dataDir, site));
  const sa = db.db.prepare('SELECT COUNT(*) c FROM search_analytics').get().c;
  const pg = db.db.prepare('SELECT COUNT(*) c FROM pages').get().c;
  db.close?.();
  const t = [];
  for (let i = 0; i < 4; i++) { const t0 = Date.now(); getDashboardData(dataDir, site); t.push(Date.now() - t0); }
  t.sort((a, b) => a - b);
  console.log(`${site}: search_analytics=${sa} pages=${pg} | dashboard median ${t[2]}ms (runs ${t.join('/')})`);
}
