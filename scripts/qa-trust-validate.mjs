#!/usr/bin/env node
/**
 * qa-trust-validate — external (non-MCP) trust-building validation of the crawl data.
 *
 * The point: prove, from OUTSIDE the audit pipeline, three things before trusting any finding —
 *   1. We're not being blocked   (live fetch returns real 200 HTML, not a bot-challenge/403/429 wall)
 *   2. We're getting results      (stored pages have real, non-trivial content)
 *   3. It parses & validates       (an INDEPENDENT parser agrees with what the crawler stored)
 *
 * It re-fetches a random sample of stored pages with its own wait-and-retry (so a slow/erroring
 * server is reported as such, never silently passed), parses the key fields with its own cheerio
 * queries (NOT the crawler's extractor — so extractor bugs surface), and diffs against the DB.
 *
 * Usage:  node scripts/qa-trust-validate.mjs "<db-path>" [sampleSize]
 *   e.g.  node scripts/qa-trust-validate.mjs "C:/Users/.../seo-audit-console/ehi.com.au.db" 12
 * Exit code 0 = all sampled pages trusted; 1 = at least one block or field mismatch.
 */
import Database from 'better-sqlite3';
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const dbPath = process.argv[2];
const sampleSize = Number(process.argv[3] || 10);
if (!dbPath) { console.error('usage: node scripts/qa-trust-validate.mjs <db-path> [sampleSize]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Markers that a 200 response is actually a bot wall, not the real page.
const BLOCK_MARKERS = [
  /just a moment/i, /checking your browser/i, /cf-browser-verification/i, /cf-challenge/i,
  /enable javascript and cookies/i, /attention required/i, /captcha/i, /access denied/i,
  /are you a robot/i, /ddos protection by/i, /__cf_chl/i,
];

// Fetch with its own wait-and-retry — a slow/unresponsive server becomes latency, never a silent pass.
async function fetchLive(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      const body = await res.text();
      return { status: res.status, finalUrl: res.url, body };
    } catch (err) {
      if (i < tries - 1) { process.stdout.write(`    (slow/err on ${url} — waiting 10s, retry ${i + 1})\n`); await sleep(10000); continue; }
      return { status: 0, finalUrl: url, body: '', error: String(err?.message || err) };
    }
  }
}

const db = new Database(dbPath, { readonly: true });
const site = dbPath.replace(/^.*[\\/]/, '').replace(/\.db$/, '');
const rows = db.prepare(
  `SELECT url, url_key, status_code, title, h1_count, meta_description, canonical_url, noindex, json_ld, image_count, word_count
   FROM pages WHERE status_code=200 AND content_type LIKE '%html%' ORDER BY RANDOM() LIMIT ?`,
).all(sampleSize);
db.close();

console.log(`\n=== qa-trust-validate: ${site} — ${rows.length} pages, independent live re-parse ===`);
let blocked = 0, mismatched = 0, ok = 0;

for (const r of rows) {
  const live = await fetchLive(r.url);
  const tag = r.url_key.replace(/^https?:\/\/[^/]+/, '') || '/';

  // (1) not blocked / (2) real results
  if (live.status === 0) { console.log(`  ⚠ NO-RESPONSE  ${tag}  (${live.error})`); blocked++; continue; }
  if (live.status === 403 || live.status === 429 || live.status === 503) { console.log(`  ✗ BLOCKED ${live.status}  ${tag}`); blocked++; continue; }
  const marker = BLOCK_MARKERS.find((re) => re.test(live.body));
  if (marker && live.body.length < 30000) { console.log(`  ✗ CHALLENGE-PAGE  ${tag}  (matched ${marker})`); blocked++; continue; }
  if (live.body.length < 500) { console.log(`  ⚠ THIN-BODY ${live.body.length}b  ${tag}`); blocked++; continue; }

  // (3) independent parse vs stored
  const $ = cheerio.load(live.body);
  const liveJsonld = $('script[type="application/ld+json"]').length;
  const storedJsonld = (() => { try { return JSON.parse(r.json_ld || '[]').length; } catch { return 0; } })();
  const d = [];
  if (norm(r.title) !== norm($('title').first().text())) d.push(`TITLE`);
  if (r.h1_count !== $('h1').length) d.push(`H1(${r.h1_count}/${$('h1').length})`);
  if (norm(r.meta_description) !== norm($('meta[name=description]').attr('content'))) d.push(`META`);
  if (norm(r.canonical_url) !== norm($('link[rel=canonical]').attr('href'))) d.push(`CANON`);
  if ((r.noindex ? 1 : 0) !== (/noindex/i.test(norm($('meta[name=robots]').attr('content'))) ? 1 : 0)) d.push(`NOINDEX`);
  if (storedJsonld !== liveJsonld) d.push(`JSONLD(${storedJsonld}/${liveJsonld})`);
  if (Math.abs(r.image_count - $('img').length) > 4) d.push(`IMG(${r.image_count}/${$('img').length})`);

  if (d.length) { console.log(`  ✗ MISMATCH  ${tag}  → ${d.join(' ')}`); mismatched++; }
  else { console.log(`  ✓ ${tag}`); ok++; }
}

console.log(`\n  trusted ${ok}/${rows.length}  ·  blocked/no-response ${blocked}  ·  field-mismatch ${mismatched}`);
process.exit(blocked + mismatched === 0 ? 0 : 1);
