// Re-audit one or more sites with the fresh build. Usage: node scripts/reaudit-site.mjs <site> [site...]
import { runAudit } from '../dist/audit/engine.js';
import { homedir } from 'node:os';
import path from 'node:path';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const sites = process.argv.slice(2);
for (const site of sites) {
  try {
    const t0 = Date.now();
    const res = runAudit(dataDir, site, { scope: 'full' });
    console.log(`\n${site}: ${res.total} findings in ${Date.now() - t0}ms`);
    console.log('  top5:', JSON.stringify((res.top || []).slice(0, 5).map(f => ({
      check: f.check_id, url: f.url_key, traf: JSON.parse(f.traffic_at_risk || '{}'), sz: f.size,
    }))));
  } catch (e) { console.log(`\n${site}: ERROR ${e.message}`); }
}
