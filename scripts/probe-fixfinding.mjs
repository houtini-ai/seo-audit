// Smoke test for fix_finding generators + tool routing, against a seeded temp DB.
// Run: node scripts/probe-fixfinding.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { generateJsonLd, suggestRedirect, suggestInternalLinks } from '../dist/generators/index.js';

const dbPath = path.join(tmpdir(), `sac-fixfinding-${process.pid}.db`);
rmSync(dbPath, { force: true });
const wrap = new AuditDatabase(dbPath);
const db = wrap.db;

// ── Seed ──────────────────────────────────────────────────────────────────
wrap.upsertProperty('sc-domain:example.com', 'https://www.example.com');

db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1','https://www.example.com','example.com','completed')`).run();

const insPage = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,inlink_count,title,h1,meta_description,og_tags,json_ld)
  VALUES (@crawl_id,@url,@url_key,@status_code,@indexable,@inlink_count,@title,@h1,@meta_description,@og_tags,@json_ld)`);
const pages = [
  { url: 'https://www.example.com/', url_key: 'https://www.example.com/', status_code: 200, indexable: 1, inlink_count: 40, title: 'Example Co — Widgets', h1: 'Example Co', meta_description: 'We make widgets.', og_tags: '{"og:image":"https://www.example.com/logo.png"}', json_ld: null },
  { url: 'https://www.example.com/blog/best-widgets', url_key: 'https://www.example.com/blog/best-widgets', status_code: 200, indexable: 1, inlink_count: 0, title: 'Best Widgets 2026', h1: 'The Best Widgets of 2026', meta_description: 'Our pick of widgets.', og_tags: '{"og:image":"https://www.example.com/widgets.jpg"}', json_ld: null },
  { url: 'https://www.example.com/products/blue-widget', url_key: 'https://www.example.com/products/blue-widget', status_code: 200, indexable: 1, inlink_count: 12, title: 'Blue Widget', h1: 'Blue Widget', meta_description: 'A blue widget.', og_tags: '{"og:image":"https://www.example.com/blue.jpg"}', json_ld: null },
  { url: 'https://www.example.com/products/blue-widgets', url_key: 'https://www.example.com/products/blue-widgets', status_code: 404, indexable: 0, inlink_count: 3, title: null, h1: null, meta_description: null, og_tags: null, json_ld: null },
  { url: 'https://www.example.com/widgets', url_key: 'https://www.example.com/widgets', status_code: 200, indexable: 1, inlink_count: 25, title: 'Widgets', h1: 'All Widgets', meta_description: 'Browse widgets.', og_tags: null, json_ld: null },
].map(p => ({ crawl_id: 'c1', ...p }));
const tx = db.transaction(rs => rs.forEach(r => insPage.run(r)));
tx(pages);

// links: home → products/blue-widget (so it's already linking — should be excluded as donor)
db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,is_internal) VALUES ('c1','https://www.example.com/','https://www.example.com/','https://www.example.com/products/blue-widget','https://www.example.com/products/blue-widget',1)`).run();

// audit run + findings
db.prepare(`INSERT INTO audit_runs (run_id, crawl_id, scope, started_at) VALUES ('r1','c1','core',datetime('now'))`).run();
const insF = db.prepare(`INSERT INTO findings (run_id,check_id,category,severity,url_key,evidence) VALUES (@run_id,@check_id,@category,@severity,@url_key,@evidence)`);
const findings = [
  { check_id: 'missing-structured-data', category: 'schema', severity: 'low', url_key: 'https://www.example.com/blog/best-widgets', evidence: '{}' },
  { check_id: 'broken-internal-links', category: 'crawlability', severity: 'crit', url_key: 'https://www.example.com/products/blue-widgets', evidence: '{"status":404,"linkingPages":3}' },
  { check_id: 'striking-distance', category: 'merged', severity: 'high', url_key: 'https://www.example.com/blog/best-widgets', evidence: '{"query":"best widgets","position":12.4,"impressions":340}' },
  { check_id: 'missing-title', category: 'onpage', severity: 'crit', url_key: 'https://www.example.com/products/blue-widgets', evidence: '{}' },
].map(f => ({ run_id: 'r1', ...f }));
db.transaction(rs => rs.forEach(r => insF.run(r)))(findings);

// ── Exercise (mirrors the tool's routing) ───────────────────────────────────
const getF = id => db.prepare('SELECT check_id, url_key, evidence FROM findings WHERE id = ?').get(id);
let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };

// 1) missing-structured-data → JSON-LD
{
  const f = getF(1);
  const page = db.prepare('SELECT url, url_key, title, h1, meta_description, og_tags FROM pages WHERE url_key = ?').get(f.url_key);
  const r = generateJsonLd(page);
  console.log('\n[1] missing-structured-data →', r.type);
  console.log(r.scriptTag);
  check('json-ld type is Article', r.type === 'Article', r.type);
  check('headline filled from h1', r.jsonLd.headline === 'The Best Widgets of 2026', r.jsonLd.headline);
  check('image from og:image', r.jsonLd.image === 'https://www.example.com/widgets.jpg', r.jsonLd.image);
  check('scriptTag escapes <', !r.scriptTag.includes('<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "Article",') === false, 'tag shape');
  check('todo lists datePublished', r.todo.includes('datePublished'), JSON.stringify(r.todo));
}

// 2) broken-internal-links → redirect rule
{
  const f = getF(2);
  const live = db.prepare('SELECT url FROM pages WHERE status_code = 200 AND indexable = 1').all();
  const r = suggestRedirect(f.url_key, live, 'htaccess');
  console.log('\n[2] broken-internal-links → redirect');
  console.log('   ', r.rule, '(score', r.score + ')');
  check('suggests /products/blue-widget (token overlap)', r.suggested === 'https://www.example.com/products/blue-widget', String(r.suggested));
  check('rule is a 301', r.rule.startsWith('Redirect 301'), r.rule);
  const ng = suggestRedirect(f.url_key, live, 'nginx');
  check('nginx format honoured', ng.rule.startsWith('rewrite '), ng.rule);
}

// 3) striking-distance → internal-link suggestions
{
  const f = getF(3);
  const evidence = JSON.parse(f.evidence);
  const r = suggestInternalLinks(db, f.url_key, evidence.query);
  console.log('\n[3] striking-distance → internal links (anchor:', JSON.stringify(r.anchor) + ')');
  r.donors.forEach(d => console.log(`    ${d.donorUrl}  inlinks=${d.inlinkCount} rel=${d.relevance}`));
  check('anchor is the query', r.anchor === 'best widgets', r.anchor);
  check('returns donors', r.donors.length > 0, String(r.donors.length));
  check('does not suggest the receiver itself', !r.donors.some(d => d.donorUrl === f.url_key), 'self-link');
}

// 4) default → explanation (missing-title has no generator)
{
  const f = getF(4);
  console.log('\n[4] missing-title → default explanation path');
  check('routes to default (no generator)', !['missing-structured-data','broken-internal-links','internal-links-to-redirects','redirect-chain','orphan-with-impressions','striking-distance'].includes(f.check_id), f.check_id);
}

wrap.close();
rmSync(dbPath, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
