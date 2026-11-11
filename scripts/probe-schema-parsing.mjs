// Schema parsing: nested typed nodes, Organization subtypes, case-insensitive matching.
// Guards the rowlinsons.co.uk false positive (reported 2026-11-03): a homepage whose Organization
// (as Corporation under mainEntity) and WebSite (as "Website" under isPartOf) are nested and used
// subtypes, which the old top-level/exact-case check missed.
//   node scripts/probe-schema-parsing.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { collectTypedNodes, typesOf, hasOrganizationSchema, hasWebSiteSchema, schemaTypePresence, ORGANIZATION_TYPES } from '../dist/audit/schemaTypes.js';
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
function runHomeCheck(jsonLdCol, checkId = 'homepage-missing-org-schema') {
  const check = CHECKS.find(c => c.id === checkId);
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

// Review fixes for 1.0.2 -------------------------------------------------------------------
// Third-party entities nested under non-identity edges must NOT count as the site's own Organization.
const CAROUSEL = col({ '@type': 'ItemList', itemListElement: [{ '@type': 'Product', name: 'Echo',
  offers: { '@type': 'Offer', seller: { '@type': 'Organization', name: 'Amazon' } },
  manufacturer: { '@type': 'Corporation', name: 'Amazon' }, brand: { '@type': 'Brand', name: 'Amazon' },
  review: { '@type': 'Review', author: { '@type': 'Organization', name: 'Which?' } } }] });
t("third-party seller/manufacturer/review Organization is NOT the site's own", !hasOrganizationSchema(CAROUSEL));
t('check: product-carousel homepage with only third-party orgs still fires', runHomeCheck(CAROUSEL).length === 1);
t('publisher Organization under WebSite IS owned', hasOrganizationSchema(col({ '@type': 'WebSite', publisher: { '@type': 'Organization', name: 'X' } })));

// IRI-form and prefixed types
t('typesOf strips https://schema.org/', typesOf({ '@type': 'https://schema.org/Organization' })[0] === 'organization');
t('typesOf strips http://schema.org/ (WebSite)', hasWebSiteSchema(col({ '@type': 'http://schema.org/WebSite' })));
t('typesOf strips schema: prefix', hasOrganizationSchema(col({ '@type': 'schema:Corporation' })));
t('check: IRI-typed Organization homepage -> no finding', runHomeCheck(col({ '@type': 'https://schema.org/Organization', name: 'X' })).length === 0);

// Type list corrections
t('FundingAgency counts as Organization', ORGANIZATION_TYPES.has('fundingagency') && hasOrganizationSchema(col({ '@type': 'FundingAgency' })));
t('Physiotherapy counts as Organization', hasOrganizationSchema(col({ '@type': 'Physiotherapy' })));
t('projectorganization (not a schema.org type) removed', !ORGANIZATION_TYPES.has('projectorganization'));

// Caps are reported, never silent
let deep = { '@type': 'WebPage', name: 'leaf' };
for (let i = 0; i < 30; i++) deep = { '@type': 'WebPage', hasPart: deep };
t('over-deep document: presence is unknown, not absent', schemaTypePresence(col(deep), new Set(['organization'])) === 'unknown');
const deepFinding = runHomeCheck(col(deep));
t('check: truncated scan fires with truncated:true in the evidence', deepFinding.length === 1 && deepFinding[0].evidence.truncated === true);
t('early exit: a found type is present even in a huge document', schemaTypePresence(col({ '@graph': [{ '@type': 'Organization' }, deep] }), new Set(['organization'])) === 'present');

// org-entity-incomplete
const fullOrg = col({ '@type': 'Organization', name: 'X', logo: 'https://x.test/l.png', sameAs: ['https://x.com/x'], contactPoint: { '@type': 'ContactPoint', telephone: '1' } });
t('org-entity-incomplete: complete Organization -> no finding', runHomeCheck(fullOrg, 'org-entity-incomplete').length === 0);
const bare = runHomeCheck(col({ '@type': 'Organization', name: 'X' }), 'org-entity-incomplete');
t('org-entity-incomplete: bare Organization -> names all three gaps', bare.length === 1 && bare[0].evidence.missing.length === 3);
const split = col({ '@graph': [
  { '@type': 'WebSite', publisher: { '@type': 'Organization', '@id': '#org' } },
  { '@type': 'Organization', '@id': '#org', logo: { '@type': 'ImageObject', url: 'l.png' }, sameAs: 'https://x.com/x', email: 'a@x.test' }] });
t('org-entity-incomplete: Yoast-style split @id reference -> no finding', runHomeCheck(split, 'org-entity-incomplete').length === 0);
t('org-entity-incomplete: no Organization at all -> silent (other check covers it)', runHomeCheck(col({ '@type': 'Product' }), 'org-entity-incomplete').length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
