// Probe: query the GSC APIs and report data we DON'T yet store.
// Run outside the MCP (GOOGLE_APPLICATION_CREDENTIALS must point at the GSC key):
//   node scripts/probe-gsc.mjs sc-domain:example.com https://example.com/
import { google } from 'googleapis';

const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!creds) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to the GSC service-account JSON.');
  process.exit(1);
}
const siteUrl = process.argv[2] ?? 'sc-domain:houtini.com';
const inspectUrl = process.argv[3] ?? 'https://houtini.com/';

const auth = new google.auth.GoogleAuth({
  keyFile: creds,
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});
const sc = google.searchconsole({ version: 'v1', auth });

// 1) Search Analytics — what the response carries vs what we store.
const sa = await sc.searchanalytics.query({
  siteUrl,
  requestBody: { startDate: '2026-05-01', endDate: '2026-06-10', dimensions: ['query', 'page', 'date', 'device', 'country'], rowLimit: 1 },
});
console.log('\n# probe-gsc', siteUrl);
console.log('\n## searchAnalytics response');
console.log('  top-level keys:', Object.keys(sa.data).join(', '));
console.log('  responseAggregationType:', sa.data.responseAggregationType);
console.log('  sample row:', JSON.stringify(sa.data.rows?.[0]));
console.log('  MISSED: the "searchAppearance" dimension is never requested → AMP/rich-result appearance buckets not captured.');

// 2) URL Inspection API — rich per-URL indexing data we currently store NONE of.
console.log('\n## URL Inspection API (urlInspection.index.inspect) — WE STORE NONE OF THIS');
try {
  const ins = await sc.urlInspection.index.inspect({ requestBody: { inspectionUrl: inspectUrl, siteUrl } });
  const r = ins.data.inspectionResult ?? {};
  const idx = r.indexStatusResult ?? {};
  console.log('  indexStatusResult fields:', Object.keys(idx).join(', '));
  console.log('    coverageState     :', idx.coverageState);
  console.log('    indexingState     :', idx.indexingState);
  console.log('    robotsTxtState    :', idx.robotsTxtState);
  console.log('    pageFetchState    :', idx.pageFetchState);
  console.log('    lastCrawlTime     :', idx.lastCrawlTime);
  console.log('    googleCanonical   :', idx.googleCanonical);
  console.log('    userCanonical     :', idx.userCanonical);
  console.log('    crawledAs         :', idx.crawledAs);
  console.log('  other result blocks:', Object.keys(r).filter(k => k !== 'indexStatusResult').join(', '));
  console.log('  → MISSED: a per-URL inspection table (Google-selected canonical vs declared, coverage/indexing state,');
  console.log('            last crawl time, mobile usability, rich results) — the authoritative index-status source.');
} catch (e) {
  console.log('  URL Inspection error:', e instanceof Error ? e.message : String(e));
}
