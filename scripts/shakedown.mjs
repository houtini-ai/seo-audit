// End-to-end shakedown: GSC sync -> crawl -> audit -> markdown, with per-phase timings
// (performance instrumentation). Uses the compiled dist so it tests the latest code without a
// Desktop restart. Reads creds/data-dir from env, else the Claude Desktop config.
//   node scripts/shakedown.mjs <siteUrl> [syncDays] [maxPages]
import { homedir } from 'node:os';
import path from 'node:path';
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { GscClient } from '../dist/core/GscClient.js';
import { GscSync } from '../dist/core/GscSync.js';
import { Crawler } from '../dist/core/Crawler.js';
import { runAudit } from '../dist/audit/engine.js';
import { buildAuditMarkdown } from '../dist/audit/report.js';
import { dbPathFor } from '../dist/core/paths.js';

const site = process.argv[2] ?? 'sc-domain:ehi.com.au';
const syncDays = Number(process.argv[3]) || 14;
const maxPages = Number(process.argv[4]) || 2000;

function fromConfig() {
  try {
    const cfg = path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json');
    return JSON.parse(readFileSync(cfg, 'utf-8'))?.mcpServers?.['seo-audit-console']?.env ?? {};
  } catch { return {}; }
}
const cfg = fromConfig();
const dataDir = process.env.SAC_DATA_DIR || cfg.SAC_DATA_DIR || path.join(homedir(), 'Documents', 'seo-audit-console');
const cred = process.env.GOOGLE_APPLICATION_CREDENTIALS || cfg.GOOGLE_APPLICATION_CREDENTIALS;
if (!cred || !existsSync(cred)) { console.error('No GSC credentials found.'); process.exit(1); }

const phases = [];
const time = async (name, fn) => { const t = Date.now(); const r = await fn(); const ms = Date.now() - t; phases.push([name, ms]); console.log(`\n  ✓ ${name}: ${(ms / 1000).toFixed(1)}s`); return r; };
const ac = new AbortController();
console.log(`SHAKEDOWN ${site}\n  dataDir=${dataDir}\n  syncDays=${syncDays} maxPages=${maxPages}`);

// 1) GSC sync
const sync = new GscSync(new GscClient(cred), dataDir);
const startDate = new Date(Date.now() - syncDays * 86400000).toISOString().slice(0, 10);
const endDate = new Date().toISOString().slice(0, 10);
const syncRes = await time('GSC sync', () =>
  sync.run(site, { startDate, endDate }, p => process.stdout.write(`\r    ${p.rowsFetched ?? 0} rows fetched   `), ac.signal));
console.log('   ', JSON.stringify(syncRes));

// 2) Crawl
const crawler = new Crawler(dataDir);
const crawlRes = await time('Crawl', () =>
  crawler.run(site, { maxPages, maxConcurrency: 3, delayMs: 450 },
    p => process.stdout.write(`\r    crawled ${p.crawled ?? 0}/${p.discovered ?? 0} (skipped ${p.skipped ?? 0})   `), ac.signal));
console.log('   ', JSON.stringify(crawlRes));

// 3) Audit -> markdown
const audit = await time('Audit', async () => runAudit(dataDir, site, { scope: 'full', includeJudgement: true }));
const md = buildAuditMarkdown(audit, site);
const outPath = path.join(dataDir, 'reports', `${site.replace(/[^a-z0-9.]+/gi, '_')}-audit.md`);
import('node:fs').then(fs => fs.mkdirSync(path.dirname(outPath), { recursive: true }));
writeFileSync(outPath, md);

// Perf summary
const dbBytes = (() => { try { return statSync(dbPathFor(dataDir, site)).size; } catch { return 0; } })();
console.log('\n\n=== PERF ===');
for (const [n, ms] of phases) console.log(`  ${n.padEnd(10)} ${(ms / 1000).toFixed(1)}s`);
console.log(`  total      ${(phases.reduce((a, [, ms]) => a + ms, 0) / 1000).toFixed(1)}s`);
console.log(`  crawl rate ${(crawlRes.crawled / (phases[1][1] / 1000)).toFixed(1)} pages/s`);
console.log(`  db size    ${(dbBytes / 1048576).toFixed(1)} MB`);
console.log(`  findings   ${audit.total} (${audit.bySeverity.crit ?? 0} crit, ${audit.bySeverity.high ?? 0} high)`);
console.log(`  audit      ${audit.elapsedMs}ms`);
console.log(`\nmarkdown -> ${outPath}`);
console.log('\n--- AUDIT MARKDOWN ---\n');
console.log(md);
