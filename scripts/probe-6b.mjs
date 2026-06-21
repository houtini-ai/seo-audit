// Assert the 6b per-template checks fire correctly.  node scripts/probe-6b.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { CHECKS } from '../dist/audit/checks.js';
import { urlKey } from '../dist/core/url-key.js';
const k = (u) => urlKey(u, { hostForm: 'apex' });

const dbPath = path.join(tmpdir(), `sac-6b-${Date.now()}.db`);
const adb = new AuditDatabase(dbPath);
const db = adb.db;
db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status) VALUES ('c1','https://x.com','x.com','completed')`).run();
const page = (o) => db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,canonical_url,canonical_key,canonical_count,rel_prev,json_ld)
  VALUES ('c1',@url,@url_key,200,1,@canonical_url,@canonical_key,@canonical_count,@rel_prev,@json_ld)`)
  .run({ canonical_url: null, canonical_key: null, canonical_count: 0, rel_prev: 0, json_ld: null, ...o });

// pagination: /blog/page/2 canonicalises to /blog  -> flagged
const P2 = 'https://x.com/blog/page/2';
page({ url: P2, url_key: k(P2), canonical_url: 'https://x.com/blog', canonical_key: k('https://x.com/blog'), canonical_count: 1, rel_prev: 1 });
// control: page 1 self-canonical -> NOT flagged
const P1 = 'https://x.com/blog';
page({ url: P1, url_key: k(P1), canonical_url: 'https://x.com/blog', canonical_key: k(P1), canonical_count: 1 });
// control: paginated page that IS self-canonical -> NOT flagged
const P3 = 'https://x.com/shop/page/3';
page({ url: P3, url_key: k(P3), canonical_url: P3, canonical_key: k(P3), canonical_count: 1, rel_prev: 1 });

// article dates: dateModified < datePublished -> flagged
const BAD = 'https://x.com/news/bad-dates';
page({ url: BAD, url_key: k(BAD), json_ld: JSON.stringify([{ '@type': 'Article', datePublished: '2024-05-01', dateModified: '2024-04-01' }]) });
// control: valid order -> NOT flagged
const OK = 'https://x.com/news/good-dates';
page({ url: OK, url_key: k(OK), json_ld: JSON.stringify([{ '@type': 'Article', datePublished: '2024-04-01', dateModified: '2024-05-01' }]) });

const ctx = { db, gscMaxDate: '2026-06-20' };
const expect = {
  'pagination-canonical-to-page-1': [k(P2)],
  'article-date-illogical': [k(BAD)],
};
let pass = 0, fail = 0;
for (const [id, want] of Object.entries(expect)) {
  const chk = CHECKS.find(c => c.id === id);
  const got = chk ? chk.run(ctx).map(f => f.urlKey).sort() : ['<missing check>'];
  const ok = JSON.stringify(got) === JSON.stringify([...want].sort());
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} -> ${JSON.stringify(got)}${ok ? '' : ` (wanted ${JSON.stringify(want)})`}`);
  if (ok && chk.run(ctx)[0]) console.log(`      evidence: ${JSON.stringify(chk.run(ctx)[0].evidence)}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
adb.close();
for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true });
process.exit(fail ? 1 : 0);
