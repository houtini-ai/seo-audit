// Sanity-check the 6e priority model: seed findings with different traffic/severity
// profiles and confirm the ranking is "expected clicks per dev-hour".
//   node scripts/probe-priority.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { runAudit } from '../dist/audit/engine.js';
import { dbPathFor } from '../dist/core/paths.js';
import { urlKey } from '../dist/core/url-key.js';

const dataDir = path.join(tmpdir(), `sac-prio-${Date.now()}`);
const site = 'sc-domain:example.com';
const dbPath = dbPathFor(dataDir, site);
const k = (u) => urlKey(u, { hostForm: 'apex' });

const adb = new AuditDatabase(dbPath);
const db = adb.db;
adb.upsertProperty(site, 'apex');
db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,max_pages) VALUES ('c1','https://example.com','example.com','completed',20,1000)`).run();
const page = (o) => db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,noindex,title,title_length,ipr,inlink_count)
  VALUES (@crawl_id,@url,@url_key,@status_code,@indexable,@noindex,@title,@title_length,@ipr,@inlink_count)`)
  .run({ crawl_id: 'c1', indexable: 1, noindex: 0, title: 'T', title_length: 30, ipr: 10, inlink_count: 3, ...o });
const gsc = (key, page, clicks, impr, pos, query = null) =>
  db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,clicks,impressions,position) VALUES ('2026-06-20',?,?,?,?,?,?)`).run(query, page, key, clicks, impr, pos);

// 1) noindex page still getting big traffic -> crit recovery, should dominate
page({ url: 'https://example.com/money', url_key: k('https://example.com/money'), status_code: 200, noindex: 1, title: 'Money page' });
gsc(k('https://example.com/money'), 'https://example.com/money', 5000, 60000, 4);
// 2) cosmetic: title too long on a low-traffic page -> should sink
page({ url: 'https://example.com/trivia', url_key: k('https://example.com/trivia'), status_code: 200, title_length: 85, title: 'x'.repeat(85) });
gsc(k('https://example.com/trivia'), 'https://example.com/trivia', 10, 200, 8);
// 3) striking-distance opportunity (pos ~15, decent impressions)
page({ url: 'https://example.com/opp', url_key: k('https://example.com/opp'), status_code: 200, title: 'Opp' });
gsc(k('https://example.com/opp'), 'https://example.com/opp', 20, 3000, 15, 'target query');

adb.close();

const res = runAudit(dataDir, site, { scope: 'full' });
console.log(`run ${res.runId}: ${res.total} findings\n`);
console.log('Top findings by 6e priority (expected clicks / dev-hour):');
for (const f of res.top) {
  const e = JSON.parse(f.effort ?? '{}');
  console.log(`  ${f.priority.toFixed(1).padStart(8)}  ${f.severity.padEnd(4)} ${String(f.check_id).padEnd(26)} ${f.url_key ?? '(site-wide)'}  [T=${e.expectedClicks} Y=${e.yield} hrs=${e.hours}]`);
}
rmSync(dataDir, { recursive: true, force: true });
