// Independent QA of stored crawl data: sample crawled pages, re-fetch them live with a
// SEPARATE extraction path, and diff key fields to catch crawler bugs / staleness.
//   node scripts/qa-crawl.mjs <siteUrl> [sampleSize]
import { homedir } from 'node:os';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';

const site = process.argv[2] ?? 'sc-domain:simracingcockpit.gg';
const N = Number(process.argv[3] ?? 15);

function dataDir() {
  if (process.env.SAC_DATA_DIR) return process.env.SAC_DATA_DIR;
  const cfg = path.join(homedir(), '.seo-audit-console.json');
  if (existsSync(cfg)) { try { const d = JSON.parse(readFileSync(cfg, 'utf-8')).dataDir; if (d) return d; } catch {} }
  return path.join(homedir(), 'Documents', 'seo-audit-console');
}

const adb = new AuditDatabase(dbPathFor(dataDir(), site));
const db = adb.db;
const total = db.prepare('SELECT COUNT(*) n FROM pages').get().n;
// random sample of 200s + a few non-200s
const sample = [
  ...db.prepare(`SELECT * FROM pages WHERE status_code=200 ORDER BY RANDOM() LIMIT ?`).all(Math.max(1, N - 3)),
  ...db.prepare(`SELECT * FROM pages WHERE status_code!=200 OR status_code IS NULL ORDER BY RANDOM() LIMIT 3`).all(),
];
console.log(`DB: ${total} pages. Sampling ${sample.length}.\n`);

const UA = 'seo-audit-console-qa/0.1';
const wordCount = ($) => { const b = $('body').clone(); b.find('script,style,noscript').remove(); return (b.text().match(/\S+/g) || []).length; };

let checked = 0, clean = 0;
const issues = [];
for (const p of sample) {
  checked++;
  let live;
  try {
    const res = await fetch(p.url, { redirect: 'manual', headers: { 'user-agent': UA, 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
    let status = res.status, finalUrl = p.url, redirected = false;
    if (status >= 300 && status < 400) { redirected = true; finalUrl = res.headers.get('location') || ''; }
    let title = null, h1 = 0, canonical = null, noindex = false, hasLd = false, wc = 0;
    if (status === 200) {
      const html = await res.text();
      const $ = cheerio.load(html);
      title = ($('title').first().text() || '').trim();
      h1 = $('h1').length;
      canonical = $('link[rel="canonical"]').first().attr('href') || null;
      noindex = /noindex/i.test($('meta[name="robots"]').attr('content') || '');
      hasLd = $('script[type="application/ld+json"]').length > 0;
      wc = wordCount($);
    }
    live = { status, redirected, finalUrl, title, h1, canonical, noindex, hasLd, wc };
  } catch (e) { live = { error: e.message }; }

  const probs = [];
  if (live.error) probs.push(`fetch failed: ${live.error}`);
  else {
    if (live.status !== p.status_code) probs.push(`status stored=${p.status_code} live=${live.status}`);
    if (live.status === 200) {
      const st = (p.title || '').trim();
      if (st && live.title && st !== live.title) probs.push(`title differs\n      stored: ${st}\n      live:   ${live.title}`);
      if (!st && live.title) probs.push(`stored title empty but live has one: "${live.title}"`);
      const storedH1 = p.h1_count ?? 0;
      if (Math.abs(storedH1 - live.h1) > 0) probs.push(`h1_count stored=${storedH1} live=${live.h1}`);
      const sc = (p.canonical_url || '').replace(/\/$/, ''), lc = (live.canonical || '').replace(/\/$/, '');
      if (sc !== lc) probs.push(`canonical stored=${p.canonical_url || 'null'} live=${live.canonical || 'null'}`);
      if (!!p.noindex !== live.noindex) probs.push(`noindex stored=${!!p.noindex} live=${live.noindex}`);
      if ((!!p.json_ld) !== live.hasLd) probs.push(`json_ld stored=${!!p.json_ld} live(has script)=${live.hasLd}`);
      if (p.word_count && live.wc && Math.abs(p.word_count - live.wc) / Math.max(p.word_count, live.wc) > 0.5) probs.push(`word_count stored=${p.word_count} live~=${live.wc} (>50% diff)`);
    }
  }
  if (probs.length) { issues.push({ url: p.url, probs }); console.log(`⚠ ${p.url}\n   - ${probs.join('\n   - ')}`); }
  else { clean++; console.log(`✓ ${p.url} (status ${p.status_code}, h1 ${p.h1_count}, ${p.word_count}w${p.json_ld ? ', ld' : ''})`); }
}

console.log(`\n${clean}/${checked} clean, ${issues.length} with discrepancies`);
adb.close();
