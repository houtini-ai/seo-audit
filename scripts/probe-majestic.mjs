#!/usr/bin/env node
/**
 * probe-majestic.mjs — dev-sandbox probe for the Majestic API (GetIndexItemInfo).
 *
 * Purpose: nail down the REAL response shape before wiring MajesticClient into the
 * MCP. Majestic is an old API (XML-native, JSON bolted on); we do not trust the docs
 * blindly — we hit the dev sandbox (free, no unit cost, Historic subset) and read the
 * bytes. GetIndexItemInfo is our target command: batch up to 100 domains/URLs → TrustFlow,
 * CitationFlow, Topical Trust Flow, RefDomains, ExtBackLinks each, one call.
 *
 * Usage:
 *   MAJESTIC_API_KEY=xxxx node scripts/probe-majestic.mjs
 *   node scripts/probe-majestic.mjs <KEY> [datasource] [item ...]
 *     datasource: fresh | historic   (dev sandbox may only hold a Historic subset)
 *
 * Auth: direct API key as the app_api_key query param (developer-support.majestic.com/api).
 * Host: developer.majestic.com is the DEV sandbox (no allowance cost). Live is api.majestic.com.
 * Format: /api/json returns JSON; /api/xml returns pipe-delimited DataTables.
 */

const KEY = process.env.MAJESTIC_API_KEY || process.argv[2];
if (!KEY) {
  console.error('No key. Set MAJESTIC_API_KEY or pass it as argv[2].');
  process.exit(2);
}
const DATASOURCE = process.argv[3] || 'fresh';
const ITEMS = process.argv.slice(4);
if (!ITEMS.length) ITEMS.push('majestic.com', 'bbc.co.uk'); // doc example domain + a well-known one

const DEV_HOST = 'https://developer.majestic.com';

/** Build a GetIndexItemInfo URL. format = 'json' | 'xml'. */
function buildUrl(host, format, items, datasource) {
  const p = new URLSearchParams();
  p.set('app_api_key', KEY);
  p.set('cmd', 'GetIndexItemInfo');
  p.set('items', String(items.length));
  items.forEach((it, i) => p.set(`item${i}`, it));
  p.set('datasource', datasource);
  p.set('DesiredTopics', '5'); // Topical Trust Flow topics — the directory-killer signal
  return `${host}/api/${format}?${p.toString()}`;
}

/** Redact the key when printing a URL. */
const redact = (u) => u.replace(/app_api_key=[^&]+/, 'app_api_key=***');

async function main() {
  const url = buildUrl(DEV_HOST, 'json', ITEMS, DATASOURCE);
  console.log('GET', redact(url));
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  console.log('HTTP', res.status, res.headers.get('content-type'));
  const raw = await res.text();

  let json;
  try { json = JSON.parse(raw); }
  catch {
    console.log('\n[not JSON — raw body, first 2000 chars]');
    console.log(raw.slice(0, 2000));
    return;
  }

  // CONFIRMED shape (dev sandbox, 2026-08-09): message-level fields are FLAT at the top
  // (no GlobalVars wrapper); DataTables.Results.Data is an array of KEYED OBJECTS (one per
  // item, fields named). Results.Headers is NOT column names — it's topic-cap metadata
  // ({ MaxTopicsRootDomain, MaxTopicsSubDomain, MaxTopicsURL, TopicsCount }).
  console.log('\n=== message level ===');
  console.log('Code:', json.Code, '| ErrorMessage:', json.ErrorMessage || '(none)', '| FullError:', json.FullError || '');
  console.log('IndexType:', json.IndexType, '| IndexBuildDate:', json.IndexBuildDate, '| UniqueIndexID:', json.UniqueIndexID);
  console.log('MostRecentBackLinkDate:', json.MostRecentBackLinkDate,
    '| RootDomainsNotFound:', json.QueriedRootDomainsNotFound, '| URLsNotFound:', json.QueriedURLsNotFound);

  const tables = json.DataTables ?? {};
  console.log('\n=== DataTables keys ===', Object.keys(tables));
  const results = tables.Results ?? {};
  console.log('Results.Headers (topic caps):', JSON.stringify(results.Headers));
  const rows = Array.isArray(results.Data) ? results.Data : [];
  console.log('Results row count:', rows.length);

  // Print the fields we persist for each item. ItemType: 1=root domain, 2=subdomain, 3=URL.
  // Status: Found | MayExist | NotFound.
  const WANT = ['Item', 'ItemType', 'ResultCode', 'Status', 'TrustFlow', 'CitationFlow', 'TrustMetric',
    'RefDomains', 'ExtBackLinks', 'IndexedURLs', 'ACRank', 'RefIPs', 'RefSubNets', 'Title', 'LanguageDesc',
    'TopicalTrustFlow_Topic_0', 'TopicalTrustFlow_Value_0',
    'TopicalTrustFlow_Topic_1', 'TopicalTrustFlow_Value_1'];
  rows.forEach((row, i) => {
    console.log(`\n--- item ${i} ---`);
    for (const k of WANT) {
      if (row[k] !== undefined && row[k] !== '') console.log(`  ${k}: ${row[k]}`);
    }
  });

  // Dump one full row so we see EVERY field name/value as delivered.
  if (rows.length) {
    console.log('\n=== full first row (verbatim) ===');
    console.log(JSON.stringify(rows[0], null, 2).slice(0, 3000));
  }
}

main().catch(e => { console.error('probe failed:', e.message); process.exit(1); });
