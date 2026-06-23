// One-off: re-run the audit with the freshly-built engine (the running MCP server still has
// the old build until restart), so the findings table reflects the finding-level-traffic fix.
import { runAudit } from '../dist/audit/engine.js';
import { homedir } from 'node:os';
import path from 'node:path';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const site = 'https://simracingcockpit.gg/';
const t0 = Date.now();
const res = runAudit(dataDir, site, { scope: 'full' });
console.log('elapsedMs', Date.now() - t0, 'total', res.total);
console.log('byCheck(top8):', JSON.stringify(res.byCheck.slice(0, 8), null, 0));
console.log('top5:', JSON.stringify((res.top || []).slice(0, 5).map(f => ({
  check: f.check_id, url: f.url_key, traf: f.traffic_at_risk, prio: Math.round(f.priority * 10) / 10,
})), null, 0));
