// Full audit incl. heuristic (N) checks — confirm the content-cluster checks integrate + get priority.
import { runAudit } from '../dist/audit/engine.js';
import { homedir } from 'node:os';
import path from 'node:path';
const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const site = process.argv[2] ?? 'sc-domain:simracingcockpit.gg';
const res = runAudit(dataDir, site, { scope: 'full', includeJudgement: true });
console.log('total', res.total, 'elapsedMs', res.elapsedMs);
const ids = ['body-missing-top-query', 'poor-chunkability', 'rag-answer-gap', 'low-extractability'];
for (const b of res.byCheck.filter(c => ids.includes(c.checkId))) console.log(`  ${b.checkId}: count=${b.count} priority=${Math.round(b.priority * 10) / 10} sev=${b.severity}`);
