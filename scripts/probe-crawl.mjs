// Probe: fetch a real page and report which response data we DON'T yet store.
// Run outside the MCP: `node scripts/probe-crawl.mjs https://example.com/`
import { extractPage } from '../dist/core/extract.js';

const url = process.argv[2] ?? 'https://houtini.com/';
const res = await fetch(url, { headers: { 'user-agent': 'seo-audit-console-probe/0.1' } });
const body = await res.text();
const headers = Object.fromEntries(res.headers.entries());

// What the `pages` table currently persists from the HTTP response.
const STORED_HEADERS = new Set(['content-type', 'content-length', 'x-robots-tag']);
// Headers that matter for the checks in our research but aren't stored yet.
const SEO_RELEVANT = [
  'cache-control', 'last-modified', 'etag', 'vary', 'content-encoding',
  'strict-transport-security', 'content-security-policy', 'x-frame-options',
  'x-content-type-options', 'referrer-policy', 'permissions-policy', 'server', 'link',
];

console.log(`\n# probe-crawl ${url}  (status ${res.status})`);
console.log('\n## response headers returned');
console.log(Object.keys(headers).join(', '));

console.log('\n## SEO-relevant headers RETURNED but NOT stored (missed → should persist)');
let missed = 0;
for (const h of SEO_RELEVANT) {
  if (headers[h] !== undefined && !STORED_HEADERS.has(h)) {
    console.log(`  MISSED  ${h}: ${String(headers[h]).slice(0, 80)}`);
    missed++;
  }
}
if (!missed) console.log('  (none present on this page)');

const ex = extractPage(body, res.url, new URL(url).hostname, { hostForm: 'apex' }, headers['x-robots-tag']);
console.log('\n## extracted fields (stored)');
for (const [k, v] of Object.entries(ex)) {
  if (k === 'links') { console.log(`  links: ${ex.links.length}`); continue; }
  console.log(`  ${k}: ${JSON.stringify(v)?.slice(0, 60)}`);
}
console.log('\n## known ingestion gaps');
console.log('  - pages.security_headers column EXISTS but extractor does not populate CSP/HSTS/X-Frame/Referrer yet.');
console.log('  - no TTFB / last-modified / etag / vary / content-encoding columns (needed for 304, Vary, compression, CWV-proxy checks).');
