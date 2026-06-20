// Build a dashboard payload via the compiled getDashboardData (bypasses the running
// MCP server) and write it to a file for previewing. Usage:
//   node scripts/probe-dashdata.mjs <siteUrl> <outFile>
import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getDashboardData } from '../dist/core/dashboardData.js';

const siteUrl = process.argv[2];
const outFile = process.argv[3] ?? path.join('dist', 'dashdata.json');
const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'seo-audits', 'seo-audit-console');

const data = getDashboardData(dataDir, siteUrl);
fs.writeFileSync(outFile, JSON.stringify(data, null, 0));
const recs = data.findings?.recommendations ?? [];
console.log(`wrote ${outFile}`);
console.log(`findings: ${data.findings?.total ?? 0} | categories: ${recs.length} | checks: ${recs.reduce((n, c) => n + c.checks.length, 0)}`);
for (const cat of recs) console.log(`  ${cat.category}: ${cat.checks.map(c => `${c.checkId}(${c.count})`).join(', ')}`);
