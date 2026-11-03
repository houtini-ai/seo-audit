// Schema parsing: nested typed nodes, Organization subtypes, case-insensitive matching.
// Guards the rowlinsons.co.uk false positive (reported 2026-11-03): a homepage whose Organization
// (as Corporation under mainEntity) and WebSite (as "Website" under isPartOf) are nested and used
// subtypes, which the old top-level/exact-case check missed.
//   node scripts/probe-schema-parsing.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { collectTypedNodes, typesOf, hasOrganizationSchema, hasWebSiteSchema } from '../dist/audit/schemaTypes.js';
import { CHECKS } from '../dist/audit/checks.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';

// json_ld column = JSON.stringify(arrayOfRawBlockStrings) — the shape extract.ts stores.
const col = (...objs) => JSON.stringify(objs.map(o => JSON.stringify(o)));
let pass = 0, fail = 0;
const t = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? pass++ : fail++; };

// The real rowlinsons.co.uk structure, confirmed live in the browser:
//   WebPage > isPartOf > "Website"   (note the lowercase 's')
//   WebPage > mainEntity > Corporation > department > LegalService x3
const ROWLINSONS = col(
  { '@context': 'https://schema.org', '@type': 'WebPage',
    isPartOf: { '@type': 'Website', name: 'Rowlinsons' },
    mainEntity: { '@type': 'Corporation', name: 'Rowlinsons Solicitors',
      department: [{ '@type': 'LegalService' }, { '@type': 'LegalService' }] },
    speakable: { '@type': 'SpeakableSpecification' } },
  { '@context': 'https://schema.org', '@type': 'Product', aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.9' } },
);

t('rowlinsons: Corporation found despite nesting under mainEntity', hasOrganizationSchema(ROWLINSONS));
t('rowlinsons: Website found despite nesting under isPartOf + lowercase casing', hasWebSiteSchema(ROWLINSONS));
t('rowlinsons: the collector also reaches the nested LegalService nodes', collectTypedNodes(ROWLINSONS).some(n => typesOf(n).includes('legalservice')));

// Subtypes, nested
t('LegalService only (nested) counts as Organization', hasOrganizationSchema(col({ '@type': 'WebPage', mainEntity: { '@type': 'LegalService' } })));
t('ClothingStore counts as Organization', hasOrganizationSchema(col({ '@type': 'ClothingStore', name: 'X' })));
t('Restaurant counts as Organization', hasOrganizationSchema(col({ '@type': 'Restaurant', name: 'X' })));
t('@type array ["Organization","LegalService"] counts', hasOrganizationSchema(col({ '@type': ['Organization', 'LegalService'] })));

// No regressions on the cases that already worked
t('canonical WebSite (capital S) still matches', hasWebSiteSchema(col({ '@type': 'WebSite', name: 'X' })));
t('top-level Organization still matches', hasOrganizationSchema(col({ '@type': 'Organization', name: 'X' })));
t('@graph Organization still matches', hasOrganizationSchema(col({ '@graph': [{ '@type': 'Organization' }] })));

// Negatives — must NOT be treated as org/website
t('Product only: no Organization', !hasOrganizationSchema(col({ '@type': 'Product', name: 'X' })));
t('Product only: no WebSite', !hasWebSiteSchema(col({ '@type': 'Product', name: 'X' })));
t('empty / no schema: both false', !hasOrganizationSchema(null) && !hasWebSiteSchema('[]'));

// End to end: the actual homepage-missing-org-schema check against a seeded homepage.
const check = CHECKS.find(c => c.id === 'homepage-missing-org-schema');
function runHomeCheck(jsonLdCol) {
  const dir = path.join(tmpdir(), `sac-schemaparse-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const adb = new AuditDatabase(path.join(dir, 'x.db'));
  const db = adb.db;
  db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,max_pages) VALUES ('c1','https://x.test','x.test','completed',1,100)`).run();
  db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,click_depth,inlink_count,indexable,json_ld) VALUES ('c1','https://x.test/','https://x.test/',200,0,5,1,?)`).run(jsonLdCol);
  const findings = check.run({ db, gscMaxDate: null, brand: null, siteUrl: 'sc-domain:x.test' });
  adb.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ }
  return findings;
}
t('check: rowlinsons homepage → NO finding (the reported false positive is fixed)', runHomeCheck(ROWLINSONS).length === 0);
t('check: Product-only homepage → still fires', runHomeCheck(col({ '@type': 'Product', name: 'X' })).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
