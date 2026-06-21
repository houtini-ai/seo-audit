// Validate the new-page opportunity engine: demand -> subtraction (A/B/C) -> cluster -> score.
//   node scripts/probe-6c.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { suggestPages } from '../dist/audit/opportunities.js';
import { urlKey } from '../dist/core/url-key.js';
const k = (u) => urlKey(u, { hostForm: 'apex' });

const dbPath = path.join(tmpdir(), `sac-6c-${Date.now()}.db`);
const adb = new AuditDatabase(dbPath);
const db = adb.db;
db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status) VALUES ('c1','https://x.com','x.com','completed')`).run();
const page = (url, title) => db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,title,h1) VALUES ('c1',?,?,200,1,?,?)`).run(url, k(url), title, title);
const gsc = (q, u, clicks, impr, pos) => db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,clicks,impressions,position) VALUES ('2026-06-20',?,?,?,?,?,?)`).run(q, u, k(u), clicks, impr, pos);

// Existing pages
page('https://x.com/wheels', 'Racing Wheels');           // covers "racing wheels" queries
page('https://x.com/blog/pedal-guide', 'Pedal Setup Guide');

// 1) OPPORTUNITY: "hydraulic handbrake" — impressions, rank 18, no dedicated/covering page -> KEEP
gsc('hydraulic handbrake', 'https://x.com/blog/pedal-guide', 2, 800, 18);
gsc('hydraulic handbrake mount', 'https://x.com/blog/pedal-guide', 1, 400, 22); // clusters with above
// 2) Rule A: "racing wheels" we already rank #3 -> DROP
gsc('racing wheels', 'https://x.com/wheels', 50, 1000, 3);
// 3) Rule B: "racing wheels review" — page /wheels covers >=70% tokens (racing, wheels) -> DROP
gsc('racing wheels review', 'https://x.com/wheels', 1, 300, 19);
// 4) Rule B: "pedal setup guide" fully covered by the /blog/pedal-guide page -> DROP
gsc('pedal setup guide', 'https://x.com/blog/pedal-guide', 5, 900, 14);
// 5) Rule C: "track day tips" — 90% impressions on a contender page ranking #12 (not lexically
//    covered) -> optimise that page, DROP as a new-page idea
gsc('track day tips', 'https://x.com/blog/pedal-guide', 4, 550, 12);
gsc('track day tips', 'https://x.com/wheels', 0, 50, 40);
// 6) below threshold: "obscure thing" 20 impr -> DROP
gsc('obscure thing', 'https://x.com/wheels', 0, 20, 30);

const r = suggestPages(db, { minImpressions: 50 });
console.log(`considered ${r.consideredQueries} queries, ${r.afterDedup} survived dedup`);
for (const p of r.proposals) console.log(`  PROPOSAL "${p.headTerm}" impr=${p.totalImpressions} pos=${p.bestPosition} score=${p.score} queries=${JSON.stringify(p.queries)} nearest=${p.nearestExistingPage}`);

const headTerms = r.proposals.map(p => p.headTerm);
const checks = [
  [r.proposals.length === 2, `2 proposals (handbrake + wheels review) (got ${r.proposals.length})`],
  [headTerms[0] === 'hydraulic handbrake', `top head term = hydraulic handbrake (got ${headTerms[0]})`],
  [r.proposals.find(p => p.headTerm === 'hydraulic handbrake')?.queries.length === 2, `clustered 2 handbrake queries`],
  [headTerms.includes('racing wheels review'), '"racing wheels review" kept (distinct review intent, <70% covered)'],
  [!headTerms.includes('racing wheels'), 'rule A dropped "racing wheels" (rank #3)'],
  [!headTerms.includes('pedal setup guide'), 'rule B dropped "pedal setup guide" (page fully covers it)'],
  [!headTerms.includes('track day tips'), 'rule C dropped "track day tips" (contender page #12 owns it)'],
];
let pass = 0, fail = 0;
for (const [ok, label] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; }
console.log(`\n${pass} passed, ${fail} failed`);
adb.close();
for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true });
process.exit(fail ? 1 : 0);
