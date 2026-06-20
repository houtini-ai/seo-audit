// Smoke test for extractor fields + extractor-dependent checks.
// Run: node scripts/probe-extract.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { extractPage } from '../dist/core/extract.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { CHECKS } from '../dist/audit/checks.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };

const keyOpts = { hostForm: 'https://www.example.com' };

// ── extractPage field extraction ────────────────────────────────────────────
{
  const html = `<!doctype html><html lang="en"><head>
    <title>T</title>
    <link rel="canonical" href="/page">
    <link rel="canonical" href="https://www.example.com/page2">
    <meta charset="utf-8">
  </head><body>
    <img src="a.jpg" alt="described">
    <img src="b.jpg">
    <img src="c.jpg" alt="">
    <a href="/x">x</a>
  </body></html>`;
  const ex = extractPage(html, 'https://www.example.com/page', 'example.com', keyOpts, null);
  console.log('[extract]', JSON.stringify({ imageCount: ex.imageCount, imagesWithoutAlt: ex.imagesWithoutAlt, canonicalCount: ex.canonicalCount, canonicalRelative: ex.canonicalRelative }));
  check('imageCount = 3', ex.imageCount === 3, ex.imageCount);
  check('imagesWithoutAlt = 1 (alt="" not flagged)', ex.imagesWithoutAlt === 1, ex.imagesWithoutAlt);
  check('canonicalCount = 2', ex.canonicalCount === 2, ex.canonicalCount);
  check('canonicalRelative = true (first canonical is relative)', ex.canonicalRelative === true, ex.canonicalRelative);
  check('canonicalUrl resolved absolute', ex.canonicalUrl === 'https://www.example.com/page', ex.canonicalUrl);
}

// absolute single canonical → not relative
{
  const ex = extractPage('<html><head><link rel="canonical" href="https://www.example.com/"></head><body></body></html>', 'https://www.example.com/', 'example.com', keyOpts, null);
  check('absolute canonical → canonicalRelative false', ex.canonicalRelative === false, ex.canonicalRelative);
  check('single canonical → count 1', ex.canonicalCount === 1, ex.canonicalCount);
}

// ── checks over a seeded DB ─────────────────────────────────────────────────
const dbPath = path.join(tmpdir(), `sac-extract-${process.pid}.db`);
rmSync(dbPath, { force: true });
const wrap = new AuditDatabase(dbPath);
const db = wrap.db;
db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1','https://www.example.com','example.com','completed')`).run();
const ins = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,image_count,images_without_alt,canonical_count,canonical_relative,canonical_url)
  VALUES (@crawl_id,@url,@url_key,@status_code,@indexable,@image_count,@images_without_alt,@canonical_count,@canonical_relative,@canonical_url)`);
const rows = [
  { url: 'https://www.example.com/a', url_key: 'https://www.example.com/a', status_code: 200, indexable: 1, image_count: 4, images_without_alt: 2, canonical_count: 1, canonical_relative: 0, canonical_url: 'https://www.example.com/a' },
  { url: 'https://www.example.com/b', url_key: 'https://www.example.com/b', status_code: 200, indexable: 1, image_count: 1, images_without_alt: 0, canonical_count: 1, canonical_relative: 1, canonical_url: '/b' },
  { url: 'https://www.example.com/c', url_key: 'https://www.example.com/c', status_code: 200, indexable: 1, image_count: 0, images_without_alt: 0, canonical_count: 2, canonical_relative: 0, canonical_url: 'https://www.example.com/c' },
].map(r => ({ crawl_id: 'c1', ...r }));
db.transaction(rs => rs.forEach(r => ins.run(r)))(rows);

const ctx = { db, gscMaxDate: null };
const run = id => CHECKS.find(c => c.id === id).run(ctx);

const alt = run('image-alt');
check('image-alt finds /a only', alt.length === 1 && alt[0].urlKey.endsWith('/a'), JSON.stringify(alt));
check('image-alt evidence has missing+total', alt[0]?.evidence.missing === 2 && alt[0]?.evidence.total === 4, JSON.stringify(alt[0]?.evidence));

const rel = run('canonical-relative');
check('canonical-relative finds /b only', rel.length === 1 && rel[0].urlKey.endsWith('/b'), JSON.stringify(rel));

const multi = run('multiple-canonical');
check('multiple-canonical finds /c only', multi.length === 1 && multi[0].urlKey.endsWith('/c'), JSON.stringify(multi));
check('multiple-canonical evidence count = 2', multi[0]?.evidence.canonicalCount === 2, JSON.stringify(multi[0]?.evidence));

wrap.close();
rmSync(dbPath, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
