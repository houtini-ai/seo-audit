// Validate template detection: clustering by URL morphology + JSON-LD @type, N>=4 filter,
// median-healthy exemplar.  node scripts/probe-templates.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { detectTemplates, urlMorphology, jsonLdType } from '../dist/audit/templates.js';
import { urlKey } from '../dist/core/url-key.js';
const k = (u) => urlKey(u, { hostForm: 'apex' });

// unit checks on the helpers
const asserts = [];
const eq = (a, b, label) => asserts.push([JSON.stringify(a) === JSON.stringify(b), label, a, b]);
eq(urlMorphology('https://x.com/product/red-shoe-123.html?color=red&size=10'), '/product/[SLUG].html?color&size', 'morphology slug+ext+params');
eq(urlMorphology('https://x.com/blog/2024/05/my-post'), '/blog/[NUM]/[NUM]/[SLUG]', 'morphology nums');
eq(jsonLdType('[{"@context":"https://schema.org","@type":"Product"}]'), 'Product', 'jsonLdType array');
eq(jsonLdType('{"@graph":[{"@type":"Article"}]}'), 'Article', 'jsonLdType @graph');
eq(jsonLdType(null), 'None', 'jsonLdType null');

const dbPath = path.join(tmpdir(), `sac-tpl-${Date.now()}.db`);
const adb = new AuditDatabase(dbPath);
const db = adb.db;
db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status) VALUES ('c1','https://x.com','x.com','completed')`).run();
const page = (url, o = {}) => db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,is_internal,word_count,inlink_count,json_ld)
  VALUES ('c1',?,?,?,?,1,?,?,?)`).run(url, k(url), o.status ?? 200, o.indexable ?? 1, o.wc ?? 500, o.inl ?? 3, o.jsonld ?? null);

// 5 product pages (Product schema) -> one template; exemplar = median word count (green-sock, 300)
const prod = '[{"@type":"Product"}]';
page('https://x.com/product/red-shoe', { wc: 100, jsonld: prod });
page('https://x.com/product/blue-hat', { wc: 200, jsonld: prod });
page('https://x.com/product/green-sock', { wc: 300, jsonld: prod });
page('https://x.com/product/grey-belt', { wc: 400, jsonld: prod });
page('https://x.com/product/tan-boot', { wc: 500, jsonld: prod });
// 4 article pages -> one template
const art = '[{"@type":"Article"}]';
for (const s of ['hello-world', 'second-post', 'third-entry', 'fourth-note']) page(`https://x.com/blog/${s}`, { jsonld: art });
// 2 singleton pages -> filtered out (below N=4)
page('https://x.com/about');
page('https://x.com/contact');

const clusters = detectTemplates(db);
let pass = 0, fail = 0;
for (const [ok, label, a, b] of asserts) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` got ${JSON.stringify(a)} want ${JSON.stringify(b)}`}`); ok ? pass++ : fail++; }

const prodC = clusters.find(c => c.morphology === '/product/[SLUG]');
const artC = clusters.find(c => c.morphology === '/blog/[SLUG]');
const checks = [
  [clusters.length === 2, `2 templates (singletons filtered) -> got ${clusters.length}`],
  [prodC?.count === 5 && prodC?.schemaType === 'Product', `product cluster: 5 pages, Product schema`],
  [prodC?.exemplarUrl === 'https://x.com/product/green-sock', `product exemplar = median wc (got ${prodC?.exemplarUrl})`],
  [artC?.count === 4 && artC?.schemaType === 'Article', `article cluster: 4 pages, Article schema`],
];
for (const [ok, label] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; }

console.log(`\n${pass} passed, ${fail} failed`);
adb.close();
for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true });
process.exit(fail ? 1 : 0);
