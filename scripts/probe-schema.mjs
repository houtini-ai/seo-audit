// Smoke test for the schema-validate module. Run: node scripts/probe-schema.mjs
import { validateJsonLdColumn } from '../dist/audit/schema-validate.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
// Build the column the crawler stores: JSON.stringify([ rawBlockString, ... ]).
const col = (...blocks) => JSON.stringify(blocks.map(b => typeof b === 'string' ? b : JSON.stringify(b)));
const kinds = issues => issues.map(i => i.kind);

// 1) Valid Article — no issues
{
  const issues = validateJsonLdColumn(col({
    '@context': 'https://schema.org', '@type': 'Article', headline: 'Hi',
    author: { '@type': 'Person', name: 'A' }, datePublished: '2026-01-02', image: 'https://x.com/a.jpg',
  }));
  check('valid Article → no issues', issues.length === 0, JSON.stringify(issues));
}

// 2) Article missing required fields
{
  const issues = validateJsonLdColumn(col({ '@context': 'https://schema.org', '@type': 'Article', headline: 'Hi' }));
  const req = issues.find(i => i.kind === 'required');
  check('Article missing fields → required issue', !!req, JSON.stringify(issues));
  check('lists author/datePublished/image', req && ['author','datePublished','image'].every(f => req.fields.includes(f)), JSON.stringify(req?.fields));
}

// 3) Product offers missing price/priceCurrency (nested)
{
  const issues = validateJsonLdColumn(col({ '@context': 'https://schema.org', '@type': 'Product', name: 'W', offers: { '@type': 'Offer', availability: 'InStock' } }));
  const nested = issues.find(i => i.kind === 'required' && i.detail.includes('offers'));
  check('Product offers nested-required fires', !!nested, JSON.stringify(issues));
  check('nested cites offers.price', nested && nested.fields.includes('offers.price'), JSON.stringify(nested?.fields));
}

// 4) Bad JSON block → parse
{
  const issues = validateJsonLdColumn(col('{ "@type": "Article", }')); // trailing comma
  check('trailing comma → parse issue', kinds(issues).includes('parse'), JSON.stringify(issues));
}

// 5) Wrong @context
{
  const issues = validateJsonLdColumn(col({ '@context': 'http://example.com', '@type': 'WebSite', url: 'https://x.com' }));
  check('bad @context → context issue', kinds(issues).includes('context'), JSON.stringify(issues));
}

// 6) No @type
{
  const issues = validateJsonLdColumn(col({ '@context': 'https://schema.org', name: 'x' }));
  check('no @type → type issue', kinds(issues).includes('type'), JSON.stringify(issues));
}

// 7) Value errors: relative image + bad date
{
  const issues = validateJsonLdColumn(col({ '@context': 'https://schema.org', '@type': 'Article', headline: 'H', author: { name: 'A' }, datePublished: 'March 5 2026', image: '/rel.jpg' }));
  const vals = issues.filter(i => i.kind === 'value');
  check('relative image → value issue', vals.some(v => v.fields.includes('image')), JSON.stringify(vals));
  check('non-ISO date → value issue', vals.some(v => v.fields.includes('datePublished')), JSON.stringify(vals));
}

// 8) Forbidden schema (FAQPage)
{
  const issues = validateJsonLdColumn(col({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [] }));
  check('FAQPage → forbidden issue', kinds(issues).includes('forbidden'), JSON.stringify(issues));
}

// 9) @graph handling: Organization inside @graph, missing logo
{
  const issues = validateJsonLdColumn(col({ '@context': 'https://schema.org', '@graph': [ { '@type': 'Organization', name: 'Co', url: 'https://co.com' } ] }));
  const req = issues.find(i => i.kind === 'required' && i.type === 'Organization');
  check('@graph node validated', !!req, JSON.stringify(issues));
  check('Organization missing logo cited', req && req.fields.includes('logo'), JSON.stringify(req?.fields));
  check('@graph block not flagged for missing @context', !kinds(issues).includes('context'), JSON.stringify(issues));
}

// 10) Unknown @type → no required-field false positive
{
  const issues = validateJsonLdColumn(col({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'App' }));
  check('unknown type → no required issue', !kinds(issues).includes('required'), JSON.stringify(issues));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
