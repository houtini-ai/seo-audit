// Replicate export_report locally against the fresh build. node scripts/run-export.mjs <siteUrl>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDashboardData } from '../dist/core/dashboardData.js';
const site = process.argv[2] || 'sc-domain:simracingcockpit.gg';
const data = getDashboardData('C:/Users/Richard Baxter/Documents/seo-audit-console', site);
const tpl = readFileSync('dist/src/ui/dashboard.html', 'utf8');
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const html = tpl.replace(/<head([^>]*)>/i, `<head$1><script>window.__DASH_FIXTURE__=${json};window.__DASH_THEME__="light";</script>`);
const out = path.join('C:/Users/Richard Baxter/Documents/seo-audit-console/reports', `${site.replace(/[^a-z0-9]+/gi, '_')}-dashboard.html`);
writeFileSync(out, html);
const has = (s) => html.includes(s);
console.log('wrote', out, '(' + Math.round(html.length / 1024) + ' KB)');
console.log('chart code present:  mismatchChart=' + has('mismatchChart'), 'scatterChart=' + has('scatterChart'));
console.log('data present:  templateMismatch=' + has('"templateMismatch"'), 'equityScatter=' + has('"equityScatter"'));
const sink = (data.templateMismatch || []).find(m => m.iprPct >= 10 && m.trafficPct < m.iprPct * 0.3);
console.log('equity-sink detected:', sink ? `/${sink.template}/ ${sink.iprPct}% equity / ${sink.trafficPct}% traffic` : 'none');
