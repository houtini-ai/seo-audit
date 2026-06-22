// Precision check for the extended schema-validate rules. Each case asserts the EXPECTED
// issue kinds — proving the new rules fire and don't false-flag.  node scripts/probe-schema-rules.mjs
import { validateJsonLdColumn } from '../dist/audit/schema-validate.js';

// json_ld column = JSON.stringify(arrayOfRawBlockStrings)
const col = (...objs) => JSON.stringify(objs.map(o => JSON.stringify(o)));
const kinds = (c) => validateJsonLdColumn(c).map(i => `${i.kind}:${i.detail}`);

let pass = 0, fail = 0;
const t = (name, c, expect) => {
  const got = kinds(c);
  const ok = expect(got);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log('      got:', JSON.stringify(got, null, 0));
  ok ? pass++ : fail++;
};

t('Review missing author → required flag',
  col({ '@context': 'https://schema.org', '@type': 'Review', reviewRating: { '@type': 'Rating', ratingValue: '5' } }),
  g => g.some(x => x.startsWith('required') && /author/.test(x)));

t('Nested Product.review (no itemReviewed) → NOT flagged (review not extracted)',
  col({ '@context': 'https://schema.org', '@type': 'Product', name: 'Widget', offers: { '@type': 'Offer', price: '10.00', priceCurrency: 'USD' }, review: { '@type': 'Review', reviewRating: { ratingValue: '5' } } }),
  g => g.length === 0);

t('offers.price "$10" → value flag',
  col({ '@context': 'https://schema.org', '@type': 'Product', name: 'X', offers: { '@type': 'Offer', price: '$10', priceCurrency: 'USD' } }),
  g => g.some(x => x.startsWith('value') && /price/.test(x)));

t('priceCurrency "usd" → value flag (not ISO-4217)',
  col({ '@context': 'https://schema.org', '@type': 'Product', name: 'X', offers: { '@type': 'Offer', price: '10', priceCurrency: 'usd' } }),
  g => g.some(x => x.startsWith('value') && /priceCurrency/.test(x)));

t('AggregateRating missing ratingValue → required flag',
  col({ '@context': 'https://schema.org', '@type': 'AggregateRating', reviewCount: '10' }),
  g => g.some(x => x.startsWith('required') && /ratingValue/.test(x)));

t('SoftwareApplication with aggregateRating, no offers → NOT flagged for offers',
  col({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'App', aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5', ratingCount: '20' } }),
  g => g.length === 0);

t('valid Product → no flags',
  col({ '@context': 'https://schema.org', '@type': 'Product', name: 'X', offers: { '@type': 'Offer', price: '19.99', priceCurrency: 'GBP' } }),
  g => g.length === 0);

// ── jobs / products one-of (the FP fixes) ──
t('Remote JobPosting (jobLocationType, no jobLocation) → NOT flagged',
  col({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Dev', description: 'd', datePosted: '2026-06-01', hiringOrganization: { '@type': 'Organization', name: 'Acme' }, jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { '@type': 'Country', name: 'AU' } }),
  g => g.length === 0);

t('JobPosting with NO location of any kind → one-of flag',
  col({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Dev', description: 'd', datePosted: '2026-06-01', hiringOrganization: { '@type': 'Organization', name: 'Acme' } }),
  g => g.some(x => x.startsWith('required') && /at least one of/.test(x) && /jobLocation/.test(x)));

t('JobPosting physical, jobLocation missing address → nested required flag',
  col({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Dev', description: 'd', datePosted: '2026-06-01', hiringOrganization: { '@type': 'Organization', name: 'Acme' }, jobLocation: { '@type': 'Place' } }),
  g => g.some(x => x.startsWith('required') && /jobLocation missing: address/.test(x)));

t('Product with aggregateRating, no offers → NOT flagged (one-of satisfied)',
  col({ '@context': 'https://schema.org', '@type': 'Product', name: 'X', aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.5', reviewCount: '12' } }),
  g => g.length === 0);

t('Product with only a name → one-of flag (offers/review/aggregateRating)',
  col({ '@context': 'https://schema.org', '@type': 'Product', name: 'X' }),
  g => g.some(x => x.startsWith('required') && /at least one of/.test(x) && /offers/.test(x)));

// ── datasets + travel ──
t('Dataset missing description → required flag',
  col({ '@context': 'https://schema.org', '@type': 'Dataset', name: 'Census 2026' }),
  g => g.some(x => x.startsWith('required') && /description/.test(x)));

t('Hotel missing address → required flag',
  col({ '@context': 'https://schema.org', '@type': 'Hotel', name: 'Grand' }),
  g => g.some(x => x.startsWith('required') && /address/.test(x)));

t('TouristAttraction with name → clean',
  col({ '@context': 'https://schema.org', '@type': 'TouristAttraction', name: 'Sydney Opera House' }),
  g => g.length === 0);

t('valid physical JobPosting → clean',
  col({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Dev', description: 'd', datePosted: '2026-06-01', hiringOrganization: { '@type': 'Organization', name: 'Acme' }, jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Sydney' } } }),
  g => g.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
