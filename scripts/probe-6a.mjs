// Seed a controlled fixture and assert each Phase-6a check fires exactly where it should.
//   node scripts/probe-6a.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { CHECKS } from '../dist/audit/checks.js';
import { urlKey } from '../dist/core/url-key.js';
const k = (u) => urlKey(u, { hostForm: 'apex' }); // match production key format

const dbPath = path.join(tmpdir(), `sac-6a-${Date.now()}.db`);
const adb = new AuditDatabase(dbPath);
const db = adb.db;

adb.upsertProperty('sc-domain:example.com', 'apex');

const page = (o) => db.prepare(`INSERT INTO pages
  (crawl_id,url,url_key,status_code,indexable,noindex,ipr,inlink_count,canonical_url,canonical_key,word_count,bytes,hreflang)
  VALUES (@crawl_id,@url,@url_key,@status_code,@indexable,@noindex,@ipr,@inlink_count,@canonical_url,@canonical_key,@word_count,@bytes,@hreflang)`)
  .run({ crawl_id: 'c1', indexable: 1, noindex: 0, ipr: 0, inlink_count: 0, canonical_url: null, canonical_key: null, word_count: 500, bytes: 20000, hreflang: null, ...o });
db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,max_pages) VALUES ('c1','https://example.com','example.com','completed',20,1000)`).run();

// pages (url_key computed via urlKey, exactly as the crawler would write it)
const U = {
  home: 'https://example.com/', dead: 'https://example.com/dead', a: 'https://example.com/a',
  facet: 'https://example.com/list?a=1&b=2', soft: 'https://example.com/soft',
  en: 'https://example.com/en', fr: 'https://example.com/fr', gone: 'https://example.com/gone',
};
page({ url: U.home, url_key: k(U.home), status_code: 200, ipr: 100, inlink_count: 5 });
page({ url: U.dead, url_key: k(U.dead), status_code: 404, indexable: 0 });
page({ url: U.a, url_key: k(U.a), status_code: 200, canonical_url: U.dead, canonical_key: k(U.dead) }); // broken canonical
page({ url: U.facet, url_key: k(U.facet), status_code: 200, indexable: 1 }); // facet trap
page({ url: U.soft, url_key: k(U.soft), status_code: 200, word_count: 5, bytes: 800 }); // soft 404
// hreflang cluster: /en -> fr(/fr ok), de(/gone 404); /fr only self -> /en gets no-return-tag for /fr
page({ url: U.en, url_key: k(U.en), status_code: 200, hreflang: JSON.stringify([{ lang: 'en', href: U.en }, { lang: 'fr', href: U.fr }, { lang: 'de', href: U.gone }]) });
page({ url: U.fr, url_key: k(U.fr), status_code: 200, hreflang: JSON.stringify([{ lang: 'fr', href: U.fr }]) });
page({ url: U.gone, url_key: k(U.gone), status_code: 404, indexable: 0 });

// links: home (ipr 100) -> dead  => ipr-bleed wastedIpr 100
db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,is_internal) VALUES ('c1',?,?,?,?,1)`).run(U.home, k(U.home), U.dead, k(U.dead));

// url_inspection: soft 404 for /soft
db.prepare(`INSERT INTO url_inspection (url_key,url,page_fetch_state) VALUES (?,?,'SOFT_404')`).run(k(U.soft), U.soft);

// GSC: facet URL gets nothing (zero-impression); /a gets impressions so the join exists
const today = '2026-06-20';
db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,clicks,impressions,position) VALUES (?,?,?,?,?,?,?)`)
  .run(today, 'thing', U.a, k(U.a), 1, 100, 5);

const ctx = { db, gscMaxDate: today };
const expect = {
  'ipr-bleed-by-status': [k(U.dead)],
  'broken-canonical-target': [k(U.a)],
  'faceted-spider-trap': [k(U.facet)],
  'soft-404-shell': [k(U.soft)],
  'broken-hreflang-target': [k(U.en)],
  'hreflang-no-return-tag': [k(U.en)],
};

let pass = 0, fail = 0;
for (const [id, want] of Object.entries(expect)) {
  const chk = CHECKS.find(c => c.id === id);
  if (!chk) { console.log(`MISSING CHECK ${id}`); fail++; continue; }
  const got = chk.run(ctx).map(f => f.urlKey).sort();
  const ok = JSON.stringify(got) === JSON.stringify([...want].sort());
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} -> ${JSON.stringify(got)}${ok ? '' : ` (wanted ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
  if (ok) { const ev = chk.run(ctx)[0]?.evidence; if (ev) console.log(`      evidence: ${JSON.stringify(ev)}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
adb.close();
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });
process.exit(fail ? 1 : 0);
