// Optimise-without-losing-breadth test: crawl + audit several sites, reporting BOTH
// performance (time, 429s, pages/s) and analysis breadth (categories + distinct checks firing).
//   node scripts/multi-test.mjs
import { homedir } from 'node:os';
import path from 'node:path';
import { Crawler } from '../dist/core/Crawler.js';
import { runAudit } from '../dist/audit/engine.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';

const dataDir = process.env.SAC_DATA_DIR || path.join(homedir(), 'Documents', 'seo-audit-console');
const sites = [
  { site: 'sc-domain:simracingcockpit.gg', max: 600 },
  { site: 'sc-domain:directdrivewheels.com', max: 600 },
  { site: 'sc-domain:ehi.com.au', max: 600 },
];

for (const { site, max } of sites) {
  console.log(`\n========== ${site} (max ${max}) ==========`);
  const crawler = new Crawler(dataDir);
  const t = Date.now();
  let lastThrottleNote = 0;
  const r = await crawler.run(site, { maxPages: max, maxConcurrency: 4, delayMs: 200 },
    p => { if ((p.crawled ?? 0) - lastThrottleNote >= 150) { lastThrottleNote = p.crawled; process.stdout.write(`\r  crawled ${p.crawled}/${p.discovered}  `); } },
    new AbortController().signal);
  const secs = (Date.now() - t) / 1000;
  const adb = new AuditDatabase(dbPathFor(dataDir, site)); const db = adb.db;
  const n = (s) => db.prepare(s).get().n;
  const r429 = n("SELECT COUNT(*) n FROM pages WHERE status_code=429");
  const r200 = n("SELECT COUNT(*) n FROM pages WHERE status_code=200");
  adb.close();
  console.log(`\n  CRAWL: ${r.crawled} pages, ${r.failed} failed, ${r.skipped} skipped · ${secs.toFixed(0)}s · ${(r.crawled / secs).toFixed(1)} pp/s · 200=${r200} 429=${r429}`);
  const a = runAudit(dataDir, site, { scope: 'full', includeJudgement: true });
  const cats = new Set(a.byCheck.map(c => c.category));
  console.log(`  AUDIT: ${a.total} findings · ${a.byCheck.length} distinct checks · ${cats.size} categories [${[...cats].join(', ')}] · ${a.elapsedMs}ms`);
  console.log(`  indexability: ${JSON.stringify(a.indexability)}`);
}
console.log('\ndone');
