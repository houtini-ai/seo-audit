// Smoke test for the crawl4ai-gap extractor fields + their checks.
// Run: node scripts/probe-extract2.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { extractPage } from '../dist/core/extract.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { CHECKS } from '../dist/audit/checks.js';

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n} :: ${d}`); } };
const keyOpts = { hostForm: 'https://www.example.com' };

// ── extractPage ─────────────────────────────────────────────────────────────
const html = `<!doctype html><html lang="en"><head>
  <title>T</title>
  <link rel="next" href="/p?page=2"><link rel="prev" href="/p?page=0">
  <link rel="amphtml" href="https://www.example.com/amp/p">
  <meta name="twitter:card" content="summary"><meta name="twitter:title" content="T">
</head><body itemscope itemtype="https://schema.org/WebPage">
  <h1>A</h1><h3>skipped</h3><h2>ok</h2>
  <img src="a.jpg" width="10" height="10" alt="x">
  <img src="b.jpg" alt="y">
  <img src="http://insecure.example/c.jpg" alt="z">
  <script src="http://insecure.example/x.js"></script>
  <div typeof="Person">rdfa</div>
</body></html>`;
const ex = extractPage(html, 'https://www.example.com/p', 'example.com', keyOpts, null);
console.log('[extract]', JSON.stringify({ h2Count: ex.h2Count, headingSkips: ex.headingSkips, imagesMissingDimensions: ex.imagesMissingDimensions, mixedContentCount: ex.mixedContentCount, relNext: ex.relNext, relPrev: ex.relPrev, relAmphtml: ex.relAmphtml, hasMicrodata: ex.hasMicrodata, hasRdfa: ex.hasRdfa, twitterTags: ex.twitterTags }));
check('headingSkips=1 (h1→h3)', ex.headingSkips === 1, ex.headingSkips);
check('h2Count=1', ex.h2Count === 1, ex.h2Count);
check('imagesMissingDimensions=2', ex.imagesMissingDimensions === 2, ex.imagesMissingDimensions);
check('mixedContentCount=2 (img+script http)', ex.mixedContentCount === 2, ex.mixedContentCount);
check('relNext & relPrev true', ex.relNext === true && ex.relPrev === true, `${ex.relNext}/${ex.relPrev}`);
check('relAmphtml captured', ex.relAmphtml === 'https://www.example.com/amp/p', ex.relAmphtml);
check('twitterTags captured', !!ex.twitterTags && ex.twitterTags.includes('twitter:card'), ex.twitterTags);
check('hasMicrodata true', ex.hasMicrodata === true, ex.hasMicrodata);
check('hasRdfa true', ex.hasRdfa === true, ex.hasRdfa);

// mixed content NOT flagged on an http page
const exHttp = extractPage('<html><body><img src="http://x/y.jpg"></body></html>', 'http://www.example.com/p', 'example.com', keyOpts, null);
check('mixed content skipped on http page', exHttp.mixedContentCount === 0, exHttp.mixedContentCount);

// ── checks over a seeded DB ─────────────────────────────────────────────────
const dbPath = path.join(tmpdir(), `sac-extract2-${process.pid}.db`);
rmSync(dbPath, { force: true });
const wrap = new AuditDatabase(dbPath);
const db = wrap.db;
db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1','https://www.example.com','example.com','completed')`).run();
const ins = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,images_missing_dimensions,heading_skips,mixed_content_count,robots,og_tags,twitter_tags)
  VALUES (@crawl_id,@url,@url_key,@status_code,@indexable,@images_missing_dimensions,@heading_skips,@mixed_content_count,@robots,@og_tags,@twitter_tags)`);
const rows = [
  { url: 'https://www.example.com/a', url_key: 'https://www.example.com/a', status_code: 200, indexable: 1, images_missing_dimensions: 3, heading_skips: 0, mixed_content_count: 0, robots: null, og_tags: '{"og:image":"x"}', twitter_tags: null },
  { url: 'https://www.example.com/b', url_key: 'https://www.example.com/b', status_code: 200, indexable: 1, images_missing_dimensions: 0, heading_skips: 2, mixed_content_count: 0, robots: 'index,nofollow', og_tags: null, twitter_tags: null },
  { url: 'https://www.example.com/c', url_key: 'https://www.example.com/c', status_code: 200, indexable: 1, images_missing_dimensions: 0, heading_skips: 0, mixed_content_count: 4, robots: null, og_tags: '{"og:image":"x"}', twitter_tags: '{"twitter:card":"summary"}' },
].map(r => ({ crawl_id: 'c1', ...r }));
db.transaction(rs => rs.forEach(r => ins.run(r)))(rows);

const ctx = { db, gscMaxDate: null };
const run = id => CHECKS.find(c => c.id === id).run(ctx);
check('images-missing-dimensions → /a', run('images-missing-dimensions').map(f => f.urlKey).join() === 'https://www.example.com/a', JSON.stringify(run('images-missing-dimensions')));
check('heading-hierarchy → /b', run('heading-hierarchy').map(f => f.urlKey).join() === 'https://www.example.com/b', JSON.stringify(run('heading-hierarchy')));
check('mixed-content → /c', run('mixed-content').map(f => f.urlKey).join() === 'https://www.example.com/c', JSON.stringify(run('mixed-content')));
check('meta-nofollow → /b', run('meta-nofollow').map(f => f.urlKey).join() === 'https://www.example.com/b', JSON.stringify(run('meta-nofollow')));
check('missing-social-tags → /b only', run('missing-social-tags').map(f => f.urlKey).join() === 'https://www.example.com/b', JSON.stringify(run('missing-social-tags')));

wrap.close();
rmSync(dbPath, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
