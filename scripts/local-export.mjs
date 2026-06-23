// Generate a self-contained dashboard export from the FRESH local build (mirrors the export_report
// tool), so previews reflect current code without restarting Claude Desktop.
// Usage: node scripts/local-export.mjs <siteUrl> <theme:light|dark> <outName>
import { getDashboardData } from '../dist/core/dashboardData.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const site = process.argv[2] ?? 'sc-domain:simracingcockpit.gg';
const theme = process.argv[3] ?? 'dark';
const outName = process.argv[4] ?? 'dark';

const data = getDashboardData(dataDir, site);
const tpl = readFileSync(path.join(here, '..', 'dist', 'src', 'ui', 'dashboard.html'), 'utf8');
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const inject = `<script>window.__DASH_FIXTURE__=${json};window.__DASH_THEME__=${JSON.stringify(theme)};</script>`;
const html = tpl.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
const out = path.join(here, '..', '.preview', `${outName}.html`);
writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes) for ${site} [${theme}]  findings=${data.findings?.total ?? 0}`);
