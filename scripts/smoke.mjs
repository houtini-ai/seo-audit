// Extended end-to-end smoke test. Seeds ONE realistic property covering crawl + GSC +
// URL-inspection + backlinks + intent + CWV + entities, then exercises the whole pipeline:
//   - every check runs without throwing
//   - runAudit (full + judgement) fires a broad, sane set of findings with finite, sorted priority
//   - template detection, new-page opportunities, and dashboard data all build
// Run:  npm run smoke
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { CHECKS } from '../dist/audit/checks.js';
import { runAudit } from '../dist/audit/engine.js';
import { detectTemplates } from '../dist/audit/templates.js';
import { suggestPages } from '../dist/audit/opportunities.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { dbPathFor } from '../dist/core/paths.js';
import { crawlRate, fmtDuration } from '../dist/core/crawlProgress.js';
import { brandTokens, classifyAnchor, monthlyFromHistory } from '../dist/core/backlinkProfile.js';
import { buildBacklinkProfile } from '../dist/core/dashboardData.js';
import { urlKey } from '../dist/core/url-key.js';
import { optionalSecret, placeholderReason, dataForSeoCredentials, cruxApiKey } from '../dist/core/secrets.js';

const k = (u) => urlKey(u, { hostForm: 'apex' });
const dataDir = path.join(tmpdir(), `sac-smoke-${Date.now()}`);
const site = 'sc-domain:smoke.test';
const dbPath = dbPathFor(dataDir, site);
const adb = new AuditDatabase(dbPath);
const db = adb.db;
adb.upsertProperty(site, 'apex');
const TODAY = '2026-06-20';

db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,max_pages) VALUES ('c1','https://smoke.test','smoke.test','completed',60,1000)`).run();

const PAGE_DEFAULTS = {
  crawl_id: 'c1', url: '', url_key: '', status_code: 200, content_type: 'text/html', content_encoding: 'gzip', bytes: 20000, response_time_ms: 200,
  depth: 1, is_internal: 1, indexable: 1, noindex: 0, title: 'Default Title', title_length: 13, meta_description: 'A description here', meta_description_length: 18,
  h1: 'Default H1', h1_count: 1, word_count: 600, lang: 'en', canonical_url: null, canonical_key: null, robots: null, x_robots_tag: null, viewport: 'width=device-width, initial-scale=1',
  json_ld: null, og_tags: '{"og:title":"x"}', hreflang: null, redirects: null, internal_links: 5, external_links: 1,
  canonical_count: 0, canonical_relative: 0, h2_count: 2, heading_skips: 0, rel_next: 0, rel_prev: 0, mixed_content_count: 0, twitter_tags: '{"twitter:card":"summary"}',
  inlink_count: 3, ipr: 10, click_depth: 2, security_headers: '{"hsts":"max-age=63072000"}',
};
const COLS = Object.keys(PAGE_DEFAULTS);
const pStmt = db.prepare(`INSERT INTO pages (${COLS.join(',')}) VALUES (${COLS.map(c => '@' + c).join(',')})`);
const page = (url, o = {}) => pStmt.run({ ...PAGE_DEFAULTS, ...o, url, url_key: o.url_key ?? k(url) });
// Real json_ld column format = JSON array of RAW BLOCK STRINGS (one per <script>), per extract.ts.
const ld = (...objs) => JSON.stringify(objs.map(o => (typeof o === 'string' ? o : JSON.stringify(o))));
const link = (from, to, internal = 1) => db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,is_internal) VALUES ('c1',?,?,?,?,?)`).run(from, k(from), to, k(to), internal);
const gsc = (q, u, clicks, impr, pos) => db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,clicks,impressions,position) VALUES (?,?,?,?,?,?,?)`).run(TODAY, q, u, u ? k(u) : null, clicks, impr, pos);

// ── Home + a healthy hub
page('https://smoke.test/', { url_key: k('https://smoke.test/'), ipr: 100, inlink_count: 20, h1: 'Home', title: 'Smoke Test — Home' });

// ── Product template (4) — Product schema; one missing offers (missing-required-fields),
//    one is the intent-mismatch target
const PROD = ['red-racing-wheel', 'blue-pedal-set', 'green-shifter', 'grey-handbrake'];
PROD.forEach((s, i) => page(`https://smoke.test/product/${s}`, {
  title: `${s} for sale`, title_length: 20, h1: s,
  json_ld: i === 0
    ? ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'x' }) /* missing offers */
    : ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'x', offers: { '@type': 'Offer', price: '9', priceCurrency: 'USD' } }),
}));
// Product page whose top query is informational -> intent-vs-pagetype-mismatch
gsc('how to install a handbrake', 'https://smoke.test/product/grey-handbrake', 2, 500, 12);
db.prepare(`INSERT INTO keyword_intent (keyword,intent,probability) VALUES ('how to install a handbrake','informational',0.97)`).run();

// ── Blog template (4) — Article schema; one has illogical dates
const BLOG = ['getting-started', 'advanced-tips', 'common-mistakes', 'date-bug'];
BLOG.forEach((s) => page(`https://smoke.test/blog/${s}`, {
  title: `${s} guide`, h1: s,
  json_ld: s === 'date-bug'
    ? ld({ '@context': 'https://schema.org', '@type': 'Article', headline: 'x', image: 'https://smoke.test/i.jpg', author: { '@type': 'Person', name: 'A' }, datePublished: '2024-05-01', dateModified: '2024-04-01' })
    : ld({ '@context': 'https://schema.org', '@type': 'Article', headline: 'x', image: 'https://smoke.test/i.jpg', author: { '@type': 'Person', name: 'A' }, datePublished: '2024-01-01', dateModified: '2024-02-01' }),
}));

// ── On-page issue pages
page('https://smoke.test/no-title', { title: '', title_length: 0 });            // missing-title
page('https://smoke.test/dupe-a', { title: 'Same Title Twice' });               // duplicate-title
page('https://smoke.test/dupe-b', { title: 'Same Title Twice' });               // duplicate-title
page('https://smoke.test/no-meta', { meta_description: '', meta_description_length: 0 }); // missing-meta-description
page('https://smoke.test/no-h1', { h1: null, h1_count: 0 });                    // missing-h1
page('https://smoke.test/many-h1', { h1_count: 3 });                            // multiple-h1
page('https://smoke.test/long-title', { title_length: 80 });                    // title-too-long
page('https://smoke.test/long-meta', { meta_description_length: 200 });         // meta-description-length
page('https://smoke.test/no-viewport', { viewport: '' });                       // missing-viewport
page('https://smoke.test/no-social', { og_tags: null, twitter_tags: null });    // missing-social-tags
page('https://smoke.test/nofollow', { robots: 'nofollow' });                    // meta-nofollow
page('http://smoke.test/insecure', { url_key: k('http://smoke.test/insecure') });// non-https
page('https://smoke.test/mixed', { mixed_content_count: 3 });                   // mixed-content
page('https://smoke.test/no-hsts', { security_headers: '{}' });                 // missing-hsts
page('https://smoke.test/no-schema', { json_ld: null });                        // missing-structured-data
page('https://smoke.test/bad-schema', { json_ld: ld({ name: 'no type or context' }) }); // invalid-schema (no @type/@context)
page('https://smoke.test/deep', { click_depth: 6 });                            // deep-pages

// ── Crawlability / indexation
page('https://smoke.test/dead', { status_code: 404, indexable: 0 });            // 404 target
link('https://smoke.test/', 'https://smoke.test/dead');                         // ipr-bleed (home ipr 100 -> dead)
page('https://smoke.test/bad-canon', { canonical_url: 'https://smoke.test/dead', canonical_key: k('https://smoke.test/dead'), canonical_count: 1 }); // broken-canonical-target
page('https://smoke.test/redir', { redirects: JSON.stringify([{ from: 'https://smoke.test/a', to: 'https://smoke.test/b', status: 301 }, { from: 'https://smoke.test/b', to: 'https://smoke.test/redir', status: 301 }]) }); // redirect-chain (the crawler's {from,to,status} hop shape)
link('https://smoke.test/', 'https://smoke.test/redir');                        // internal-links-to-redirects
page('https://smoke.test/list?cat=1&sort=asc', { url_key: k('https://smoke.test/list?cat=1&sort=asc') }); // faceted-spider-trap (no GSC)
page('https://smoke.test/shop/page/2', { canonical_url: 'https://smoke.test/shop', canonical_key: k('https://smoke.test/shop'), canonical_count: 1, rel_prev: 1 }); // pagination-canonical
page('https://smoke.test/noindex-traffic', { noindex: 1 });                     // noindex-with-traffic
gsc('noindex query', 'https://smoke.test/noindex-traffic', 40, 800, 6);
page('https://smoke.test/orphan-impr', { inlink_count: 0 });                    // orphan-with-impressions
gsc('orphan query', 'https://smoke.test/orphan-impr', 1, 300, 14);

// hreflang cluster: /en -> /fr (ok-but-no-return) + /gone (404, broken)
page('https://smoke.test/en', { hreflang: JSON.stringify([{ lang: 'en', href: 'https://smoke.test/en' }, { lang: 'fr', href: 'https://smoke.test/fr' }, { lang: 'de', href: 'https://smoke.test/gone' }]) });
page('https://smoke.test/fr', { hreflang: JSON.stringify([{ lang: 'fr', href: 'https://smoke.test/fr' }]) });
page('https://smoke.test/gone', { status_code: 404, indexable: 0 });

// ── URL inspection
db.prepare(`INSERT INTO url_inspection (url_key,url,coverage_state,page_fetch_state,google_canonical,user_canonical) VALUES (?,?,?,?,?,?)`)
  .run(k('https://smoke.test/no-schema'), 'https://smoke.test/no-schema', 'Crawled - currently not indexed', 'SUCCESSFUL', null, null); // coverage-not-indexed
db.prepare(`INSERT INTO url_inspection (url_key,url,coverage_state,page_fetch_state) VALUES (?,?,?,?)`)
  .run(k('https://smoke.test/long-title'), 'https://smoke.test/long-title', 'Submitted and indexed', 'SOFT_404'); // soft-404-shell
db.prepare(`INSERT INTO url_inspection (url_key,url,google_canonical,user_canonical) VALUES (?,?,?,?)`)
  .run(k('https://smoke.test/dupe-a'), 'https://smoke.test/dupe-a', 'https://smoke.test/dupe-b', 'https://smoke.test/dupe-a'); // canonical-conflict

// ── Backlinks (gate for orphan-no-links + backlinks-to-404)
db.prepare(`INSERT INTO page_backlinks (url_key,url,backlinks,referring_domains,status_code) VALUES (?,?,?,?,?)`)
  .run(k('https://smoke.test/dead'), 'https://smoke.test/dead', 42, 9, 404);     // backlinks-to-404
page('https://smoke.test/true-orphan', { inlink_count: 0 });                     // orphan-no-links
db.prepare(`INSERT INTO page_backlinks (url_key,url,backlinks,referring_domains,status_code) VALUES (?,?,?,?,?)`)
  .run(k('https://smoke.test/true-orphan'), 'https://smoke.test/true-orphan', 0, 0, 200);

// ── CWV (high-yield-cwv-fail) — failing + has clicks
page('https://smoke.test/slow', {});
gsc('slow page query', 'https://smoke.test/slow', 250, 4000, 5);
db.prepare(`INSERT INTO page_cwv (url_key,url,performance,lcp_ms,cls,tbt_ms) VALUES (?,?,?,?,?,?)`)
  .run(k('https://smoke.test/slow'), 'https://smoke.test/slow', 0.3, 5200, 0.04, 700);

// ── Entities (entity-internal-link-gap) — SEO -> Technical SEO related, no link
page('https://smoke.test/seo', { h1: 'SEO' });
page('https://smoke.test/technical-seo', { h1: 'Technical SEO' });
db.prepare(`INSERT INTO page_entity (url_key,qid,label,source) VALUES (?,?,?,'h1')`).run(k('https://smoke.test/seo'), 'Q1', 'SEO');
db.prepare(`INSERT INTO page_entity (url_key,qid,label,source) VALUES (?,?,?,'h1')`).run(k('https://smoke.test/technical-seo'), 'Q2', 'Technical SEO');
db.prepare(`INSERT INTO entity_edge (qid,related_qid,relation) VALUES ('Q2','Q1','subclass_of')`).run();

// ── GSC merged checks
gsc('striking term', 'https://smoke.test/blog/advanced-tips', 3, 900, 15);       // striking-distance
gsc('cannibal term', 'https://smoke.test/blog/getting-started', 5, 600, 8);      // keyword-cannibalisation
gsc('cannibal term', 'https://smoke.test/blog/common-mistakes', 4, 500, 9);
gsc('low ctr term', 'https://smoke.test/product/blue-pedal-set', 2, 5000, 3);    // ctr-below-expected (pos 3, tiny CTR)
gsc('ghost term', 'https://smoke.test/ghost-page', 10, 600, 7);                  // ghost-pages (not crawled)
gsc('underlinked demand', 'https://smoke.test/orphan-impr', 1, 500, 9);          // underlinked-high-demand (ipr<30, low inlinks)
gsc('coffee machine reviews', 'https://smoke.test/blog/getting-started', 1, 1200, 22); // suggest_pages gap (incidental, rank 22)

// Performance proxies (from captured columns)
page('https://smoke.test/slow-server', { response_time_ms: 3200 });   // slow-response
page('https://smoke.test/heavy-page', { bytes: 320000 });             // large-html
page('https://smoke.test/no-compression', { content_encoding: null }); // uncompressed-html

// Sitemap reconciliation: list /dead (404 → sitemap-non-indexable) + /true-orphan (in sitemap,
// no inlinks → sitemap-orphan). Indexable pages NOT listed → indexable-not-in-sitemap.
const sm = (u) => db.prepare(`INSERT INTO sitemap_urls (url_key,url) VALUES (?,?)`).run(k(u), u);
sm('https://smoke.test/dead'); sm('https://smoke.test/true-orphan'); sm('https://smoke.test/');

adb.close();

// ── Run the pipeline ───────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); cond ? pass++ : fail++; };

// 1) Every check runs without throwing
{
  const adb2 = new AuditDatabase(dbPath);
  const ctx = { db: adb2.db, gscMaxDate: TODAY };
  const threw = [];
  for (const chk of CHECKS) { try { chk.run(ctx); } catch (e) { threw.push(`${chk.id}: ${e.message}`); } }
  ok(threw.length === 0, `all ${CHECKS.length} checks run without throwing${threw.length ? ` — ${JSON.stringify(threw)}` : ''}`);
  adb2.close();
}

// 2) Full audit
const res = runAudit(dataDir, site, { scope: 'full', includeJudgement: true });
const fired = new Set(res.byCheck.map(c => c.checkId));
console.log(`\naudit: ${res.total} findings across ${fired.size} checks`);
ok(res.total >= 30, `>=30 findings (got ${res.total})`);
ok(fired.size >= 25, `>=25 distinct checks fired (got ${fired.size})`);

const must = [
  'missing-title', 'duplicate-title', 'missing-h1', 'title-too-long', 'missing-viewport', 'non-https', 'mixed-content',
  'redirect-chain', 'ipr-bleed-by-status', 'broken-canonical-target', 'faceted-spider-trap', 'pagination-canonical-to-page-1',
  'backlinks-to-404', 'orphan-no-links', 'noindex-with-traffic', 'canonical-conflict', 'coverage-not-indexed', 'soft-404-shell',
  'broken-hreflang-target', 'hreflang-no-return-tag', 'striking-distance', 'keyword-cannibalisation', 'ctr-below-expected',
  'ghost-pages', 'underlinked-high-demand', 'missing-required-fields', 'invalid-schema', 'article-date-illogical',
  'intent-vs-pagetype-mismatch', 'high-yield-cwv-fail', 'entity-internal-link-gap',
  'sitemap-non-indexable', 'indexable-not-in-sitemap', 'sitemap-orphan',
  'slow-response', 'large-html', 'uncompressed-html',
];
const missing = must.filter(m => !fired.has(m));
ok(missing.length === 0, `all ${must.length} must-fire checks present${missing.length ? ` — MISSING: ${JSON.stringify(missing)}` : ''}`);

// 3) Priority sane: finite, sorted desc, top finding has real expected-clicks basis
const pr = res.top.map(f => f.priority);
ok(pr.every(p => Number.isFinite(p)) && pr.every((p, i) => i === 0 || p <= pr[i - 1]), 'priorities finite & sorted desc');
const top = res.top[0];
ok(top && top.effort.expectedClicks != null, `top finding has expectedClicks basis (${top?.checkId})`);
console.log(`  top 3: ${res.top.slice(0, 3).map(f => `${f.checkId}(${f.priority.toFixed(0)})`).join(', ')}`);

// 4) Templates, opportunities, dashboard
const adb3 = new AuditDatabase(dbPath);
const templates = detectTemplates(adb3.db);
ok(templates.length >= 2, `>=2 templates detected (got ${templates.length}: ${templates.map(t => t.morphology).join(', ')})`);
const sp = suggestPages(adb3.db, { minImpressions: 50 });
ok(sp.proposals.length >= 1, `>=1 new-page proposal (got ${sp.proposals.length}${sp.proposals[0] ? `: "${sp.proposals[0].headTerm}"` : ''})`);
adb3.close();

let dash;
try { dash = getDashboardData(dataDir, site); } catch (e) { dash = { __error: e.message }; }
ok(dash && !dash.__error && typeof dash === 'object', `dashboard data builds${dash?.__error ? ` — ${dash.__error}` : ''}`);

// 5) Data freshness (job/status panel, read from the DB) + the canonical/redirect/404 breakdown
const fr = dash?.freshness;
const kinds = new Set((fr?.sources ?? []).map(s => s.kind));
ok(['sync', 'crawl', 'audit', 'inspect'].every(x => kinds.has(x)), `freshness lists sync/crawl/audit/inspect (got ${[...kinds].join(',')})`);
const crawlSrc = fr?.sources?.find(s => s.kind === 'crawl');
ok(crawlSrc?.state === 'completed' && /URLs crawled/.test(crawlSrc.detail), `freshness crawl source reads crawl_metadata (${crawlSrc?.state}: ${crawlSrc?.detail})`);
ok(fr?.sources?.find(s => s.kind === 'audit')?.state === 'completed', 'freshness audit source reads the audit run');
ok(Array.isArray(fr?.crawlRuns) && fr.crawlRuns.length === 1, `freshness lists crawl runs (got ${fr?.crawlRuns?.length})`);
const flow = dash?.crawlHealth?.urlFlow ?? [];
const nf = flow.find(r => r.label === 'Not found (404)');
ok(nf && nf.count >= 1 && typeof nf.example === 'string', `urlFlow has a 404 bucket with an example (${JSON.stringify(nf)})`);
// A cache hit must still carry live freshness (it is read outside the payload cache).
const dash2 = getDashboardData(dataDir, site);
ok(Array.isArray(dash2?.freshness?.sources) && dash2.freshness.sources.length === (fr?.sources?.length ?? -1), 'cached payload still carries live freshness');

// ── Dashboard review fixes (post-0.14.0) ───────────────────────────────────────────────────
{
  const { getDataFreshness } = await import('../dist/core/dataFreshness.js');
  // The fixture connection is closed above (the audit/dashboard open their own); reopen for these checks.
  const adb4 = new AuditDatabase(dbPathFor(dataDir, site));
  const db = adb4.db;
  const page = (url, o = {}) => db.prepare(`INSERT INTO pages (${COLS.join(',')}) VALUES (${COLS.map(c => '@' + c).join(',')})`).run({ ...PAGE_DEFAULTS, ...o, url, url_key: o.url_key ?? k(url) });
  // A failed run that wrote nothing leaves c1's pages on screen: shownCrawl must say so.
  db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,started_at,finished_at,error) VALUES ('c2','https://smoke.test','smoke.test','failed',0,datetime('now'),datetime('now'),'boom')`).run();
  let fz = getDataFreshness(db);
  const crawl = fz.sources.find(s => s.kind === 'crawl');
  ok(crawl?.state === 'failed' && /last completed crawl/.test(crawl.detail) && fz.shownCrawl?.crawlId === 'c1' && fz.shownCrawl.partial === false,
    `failed crawl that wrote nothing: shownCrawl is the last completed run (${fz.shownCrawl?.crawlId}, "${crawl?.detail}")`);
  // A failed run that DID write pages is what's on screen (the crawler wiped the previous snapshot).
  db.prepare(`UPDATE crawl_metadata SET urls_crawled=7 WHERE crawl_id='c2'`).run();
  fz = getDataFreshness(db);
  ok(fz.shownCrawl?.crawlId === 'c2' && fz.shownCrawl.partial === true && /partial snapshot/.test(fz.sources.find(s => s.kind === 'crawl').detail), 'failed crawl that wrote pages: shownCrawl is that run, flagged partial');
  db.prepare(`DELETE FROM crawl_metadata WHERE crawl_id='c2'`).run();
  // Audit state: the engine writes status; a crashed run reads failed, a dead pre-status row reads interrupted.
  const latestAudit = db.prepare(`SELECT status FROM audit_runs ORDER BY started_at DESC LIMIT 1`).get();
  ok(latestAudit?.status === 'completed', `engine records audit status (${latestAudit?.status})`);
  db.prepare(`INSERT INTO audit_runs (run_id, scope, started_at, status, error) VALUES ('r-fail','core',datetime('now','+1 second'),'failed','check exploded')`).run();
  ok(getDataFreshness(db).sources.find(s => s.kind === 'audit')?.state === 'failed', 'a failed audit run reads failed, not running');
  // The newest row must be the dead one for this check, so age every other run past it, then restore.
  const origStarts = db.prepare(`SELECT run_id, started_at FROM audit_runs`).all();
  db.prepare(`UPDATE audit_runs SET started_at=datetime('now','-5 hours')`).run();
  db.prepare(`INSERT INTO audit_runs (run_id, scope, started_at) VALUES ('r-dead','core',datetime('now','-2 hours'))`).run();
  ok(getDataFreshness(db).sources.find(s => s.kind === 'audit')?.state === 'interrupted', 'an old run with no status and no finish reads interrupted');
  db.prepare(`DELETE FROM audit_runs WHERE run_id IN ('r-fail','r-dead')`).run();
  for (const r of origStarts) db.prepare(`UPDATE audit_runs SET started_at=? WHERE run_id=?`).run(r.started_at, r.run_id);
  // Missing canonical excludes non-indexable pages.
  const before = (getDashboardData(dataDir, site).crawlHealth?.urlFlow ?? []).find(r => r.label === 'Missing canonical')?.count ?? 0;
  page('https://smoke.test/noindex-tag', { status_code: 200, indexable: 0, indexable_reason: 'noindex', noindex: 1, canonical_url: null });
  const after = (getDashboardData(dataDir, site).crawlHealth?.urlFlow ?? []).find(r => r.label === 'Missing canonical')?.count ?? 0;
  ok(after === before, `Missing canonical ignores noindex pages (${before} → ${after})`);
  // A crawled-but-unsynced property still reports freshness in the empty payload.
  const site2 = 'sc-domain:nosync.test';
  const adb5 = new AuditDatabase(dbPathFor(dataDir, site2));
  const db2 = adb5.db;
  db2.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled) VALUES ('x1','https://nosync.test','nosync.test','completed',3)`).run();
  const emptyDash = getDashboardData(dataDir, site2);
  ok(emptyDash.empty === true && Array.isArray(emptyDash.freshness?.sources) && emptyDash.freshness.sources.some(s => s.kind === 'crawl' && s.state === 'completed'), 'empty (no GSC) payload still carries freshness');
  adb5.close();
  adb4.close();
}

// ── Audit history (summary page, slice 2): migration, per-run health, backfill, deltas ──────────
{
  const Database = (await import('better-sqlite3')).default;
  const { auditHistory, backfillAuditHealth, computeHealth } = await import('../dist/audit/history.js');

  // a) Migration on an OLD-shape DB: audit_runs without status/health/check_ids upgrades in place.
  const oldPath = dbPathFor(dataDir, 'sc-domain:oldshape.test');
  const raw = new Database(oldPath);
  raw.exec(`CREATE TABLE audit_runs (run_id TEXT PRIMARY KEY, crawl_id TEXT, scope TEXT, gsc_window_start TEXT, gsc_window_end TEXT,
            integrity_ok INTEGER, started_at TEXT, finished_at TEXT, finding_count INTEGER DEFAULT 0);
            INSERT INTO audit_runs (run_id, scope, started_at, finished_at, finding_count) VALUES ('legacy','core','2026-01-01 00:00:00','2026-01-01 00:00:05',3);`);
  raw.close();
  const NEW_COLS = ['health_score', 'health_error_pages', 'health_total_pages', 'health_basis', 'check_ids', 'server_version'];
  let a1 = new AuditDatabase(oldPath);
  const colsNow = new Set(a1.db.prepare(`PRAGMA table_info(audit_runs)`).all().map(c => c.name));
  a1.close();
  let threwAgain = null;
  try { a1 = new AuditDatabase(oldPath); a1.close(); } catch (e) { threwAgain = e.message; }
  const legacyRaw = new Database(oldPath, { readonly: true });
  const legacy = legacyRaw.prepare(`SELECT finding_count, health_score FROM audit_runs WHERE run_id='legacy'`).get();
  legacyRaw.close();
  ok(NEW_COLS.every(c => colsNow.has(c)) && !threwAgain && legacy?.finding_count === 3 && legacy.health_score === null,
    `old-shape audit_runs upgrades in place, idempotently, keeping its rows (missing: ${NEW_COLS.filter(c => !colsNow.has(c)).join(',') || 'none'}${threwAgain ? `; reopen threw ${threwAgain}` : ''})`);

  // b) Health written on a new audit: the dashboard's formula, plus crawl + check set + version.
  //    (Section 5 added a page since the first audit, so re-audit and compare on the fresh run.)
  const r1 = runAudit(dataDir, site, { scope: 'full', includeJudgement: true });
  const h1 = new AuditDatabase(dbPath);
  const row = h1.db.prepare(`SELECT * FROM audit_runs WHERE run_id=?`).get(r1.runId);
  const live = computeHealth(h1.db, r1.runId);
  h1.close();
  const ids = row?.check_ids ? JSON.parse(row.check_ids) : [];
  ok(row?.health_basis === 'audit' && row.health_score === live?.score && row.health_total_pages === live?.totalPages && row.crawl_id === 'c1'
    && Array.isArray(ids) && ids.includes('missing-title') && typeof row.server_version === 'string',
    `runAudit stores health ${row?.health_score} (${row?.health_error_pages}/${row?.health_total_pages}), crawl ${row?.crawl_id}, ${ids.length} check ids, v${row?.server_version}`);
  const dashNow = getDashboardData(dataDir, site);
  ok(dashNow.healthScore?.score === row?.health_score, `dashboard tile and stored run share one formula (${dashNow.healthScore?.score} = ${row?.health_score})`);

  // c) Deltas between real runs: an identical re-run is comparable (nothing opened or resolved);
  //    a run with a different check set, and one with a different scope, are skipped with reasons.
  const r2 = runAudit(dataDir, site, { scope: 'full', includeJudgement: true });
  const r3 = runAudit(dataDir, site, { scope: 'full', includeJudgement: false });
  const r4 = runAudit(dataDir, site, { scope: 'core', includeJudgement: false });
  const d = getDashboardData(dataDir, site).auditDeltas ?? [];
  const at = (id) => d.find(x => x.runId === id);
  ok(at(r2.runId) && !at(r2.runId).skipped && at(r2.runId).opened === 0 && at(r2.runId).resolved === 0 && at(r2.runId).carried > 0 && at(r2.runId).prevRunId === r1.runId,
    `identical re-run is a comparable pair (${JSON.stringify(at(r2.runId))})`);
  ok(at(r3.runId)?.skipped === 'check-set-changed' && at(r3.runId).opened === null, `changed check set is skipped (${at(r3.runId)?.skipped})`);
  ok(at(r4.runId)?.skipped === 'different-scope', `different scope is skipped (${at(r4.runId)?.skipped})`);

  // d) Arithmetic over synthetic runs + the backfill rules, on a crawl-only property (no GSC).
  const hs = 'sc-domain:history.test';
  const ha = new AuditDatabase(dbPathFor(dataDir, hs));
  const hd = ha.db;
  const crawl = (id, s, f) => hd.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,started_at,finished_at) VALUES (?,?,?,'completed',?,?)`).run(id, 'https://history.test', 'history.test', s, f);
  const snap = (cid, urls) => urls.forEach(u => hd.prepare(`INSERT INTO page_snapshots (crawl_id,url_key,captured_at,status_code) VALUES (?,?,?,200)`).run(cid, u, '2026-05-01 00:00:00'));
  const CK = JSON.stringify(['a', 'b']);
  const run = (id, started, o = {}) => hd.prepare(`INSERT INTO audit_runs (run_id,scope,started_at,finished_at,status,check_ids) VALUES (?,?,?,?,?,?)`)
    .run(id, 'core', started, started, o.status === undefined ? 'completed' : o.status, o.checks === undefined ? CK : o.checks);
  const fnd = (rid, check, url, sev = 'high') => hd.prepare(`INSERT INTO findings (run_id,check_id,severity,url_key) VALUES (?,?,?,?)`).run(rid, check, sev, url);
  // Crawl k1 (snapshotted, 4 pages), then k2 (never snapshotted). Legacy runs: no status, no check set.
  crawl('k1', '2026-05-01T09:00:00.000Z', '2026-05-01T09:05:00.000Z'); snap('k1', ['u1', 'u2', 'u3', 'u4']);
  crawl('k2', '2026-05-03T09:00:00.000Z', '2026-05-03T09:05:00.000Z');
  run('L1', '2026-05-02 10:00:00', { status: null, checks: null }); fnd('L1', 'a', 'u1'); fnd('L1', 'b', 'u2', 'low');
  run('L2', '2026-05-04 10:00:00', { status: null, checks: null });
  // Comparable runs (same scope + check set), with a failed run between two of them.
  run('S1', '2026-05-05 10:00:00'); fnd('S1', 'a', 'u1'); fnd('S1', 'a', 'u2'); fnd('S1', 'b', null);
  run('S2', '2026-05-06 10:00:00'); fnd('S2', 'a', 'u2'); fnd('S2', 'a', 'u3'); fnd('S2', 'b', null); fnd('S2', 'b', null);
  run('F1', '2026-05-07 10:00:00', { status: 'failed' });
  run('S3', '2026-05-08 10:00:00'); fnd('S3', 'a', 'u3');
  run('S4', '2026-05-09 10:00:00', { checks: JSON.stringify(['a', 'b', 'c']) });
  ha.close();

  const emptyH = getDashboardData(dataDir, hs); // no GSC → the empty payload, but the history still ships
  const hh = new Map((emptyH.healthHistory ?? []).map(p => [p.runId, p]));
  ok(hh.get('L1')?.score === 75 && hh.get('L1').errorPages === 1 && hh.get('L1').totalPages === 4 && hh.get('L1').basis === 'snapshot:k1',
    `backfill rebuilds a past run from its crawl's snapshots (${JSON.stringify(hh.get('L1'))})`);
  ok(hh.get('L2')?.score === null && hh.get('L2').basis === 'none:no-snapshot', `backfill leaves NULL when the crawl has no snapshots (${JSON.stringify(hh.get('L2'))})`);
  ok(!hh.has('F1'), 'failed runs are not in the health history');
  const hdl = emptyH.auditDeltas ?? [];
  const dx = (id) => hdl.find(x => x.runId === id);
  ok(dx('L2')?.skipped === 'check-set-unknown' && dx('S1')?.skipped === 'check-set-unknown', `runs without a recorded check set are skipped (${dx('L2')?.skipped}, ${dx('S1')?.skipped})`);
  // S1 {a|u1, a|u2, b|site} → S2 {a|u2, a|u3, b|site}: opened 1 (a|u3), resolved 1 (a|u1), carried 2.
  ok(dx('S2')?.opened === 1 && dx('S2').resolved === 1 && dx('S2').carried === 2, `S1→S2 opened/resolved/carried 1/1/2 (${JSON.stringify(dx('S2'))})`);
  ok(dx('F1')?.skipped === 'run-failed', `failed run carries a skipped reason (${dx('F1')?.skipped})`);
  ok(dx('S3')?.prevRunId === 'S2' && dx('S3').opened === 0 && dx('S3').resolved === 2 && dx('S3').carried === 1, `S2→S3 steps over the failed run: 0/2/1 (${JSON.stringify(dx('S3'))})`);
  ok(dx('S4')?.skipped === 'check-set-changed', `S3→S4 check set changed (${dx('S4')?.skipped})`);
  const ha2 = new AuditDatabase(dbPathFor(dataDir, hs));
  const again = backfillAuditHealth(ha2.db);
  const hist2 = auditHistory(ha2.db);
  ha2.close();
  ok(again.visited === 0 && hist2.healthHistory.length === 6, `backfill runs once (second pass visited ${again.visited}, ${hist2.healthHistory.length} points)`);

  // e) Two crawls overlapping before a run: the page set is ambiguous → NULL, never a guess.
  const aa = new AuditDatabase(dbPathFor(dataDir, 'sc-domain:ambig.test'));
  aa.db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,started_at,finished_at) VALUES ('x1','https://a.test','a.test','completed','2026-05-01T09:00:00.000Z','2026-05-01T09:05:00.000Z'),('x2','https://a.test','a.test','completed','2026-05-01T09:00:00.005Z','2026-05-01T09:04:59.000Z')`).run();
  aa.db.prepare(`INSERT INTO page_snapshots (crawl_id,url_key,captured_at) VALUES ('x1','u1','2026-05-01'),('x2','u1','2026-05-01')`).run();
  aa.db.prepare(`INSERT INTO audit_runs (run_id,scope,started_at,finished_at) VALUES ('A1','core','2026-05-01 09:06:00','2026-05-01 09:06:01')`).run();
  backfillAuditHealth(aa.db);
  const amb = aa.db.prepare(`SELECT health_score, health_basis FROM audit_runs WHERE run_id='A1'`).get();
  aa.close();
  ok(amb.health_score === null && amb.health_basis === 'none:ambiguous-crawl', `overlapping crawls leave the run NULL (${amb.health_basis})`);
}

// #47: backlink profile — anchor classification, monthly trend, and the payload builder.
{
  const tk = brandTokens('simracingcockpit.gg');
  ok(tk.join() === 'simracingcockpit' && brandTokens('sc-domain:ehi.com.au').join() === 'ehi', `brandTokens strips TLD and public suffix (${tk}, ${brandTokens('sc-domain:ehi.com.au')})`);
  const kinds = ['Sim Racing Cockpit', 'https://simracingcockpit.gg/guide', 'click here', '', 'best sim racing wheel', 'simracingcockpit.gg'].map(a => classifyAnchor(a, tk, 'simracingcockpit.gg'));
  ok(kinds.join() === 'branded,url,generic,empty,keyword,url', `classifyAnchor: ${kinds.join()}`);
  const months = monthlyFromHistory([
    { date: '2026-08-30', backlinks: 100, referring_domains: 50, new_referring_domains: 2, lost_referring_domains: 1 },
    { date: '2026-08-31', backlinks: 101, referring_domains: 51, new_referring_domains: 1, lost_referring_domains: 0 },
    { date: '2026-09-01', backlinks: 99, referring_domains: 49, new_referring_domains: 0, lost_referring_domains: 2 },
  ]);
  ok(months.length === 2 && months[0].month === '2026-08' && months[0].newDomains === 3 && months[0].lostDomains === 1 && months[0].referringDomains === 51 && months[1].lostDomains === 2, `monthlyFromHistory sums new/lost and keeps the month-end stock (${JSON.stringify(months)})`);

  const adb6 = new AuditDatabase(dbPathFor(dataDir, site));
  const d6 = adb6.db;
  const before = buildBacklinkProfile(d6, site);
  ok(before && before.summary === null && before.pagesTotal === 2 && before.referringDomains === null, 'page rows without a summary: summary null, pages counted (fixture has 2)');
  {
    const freshSite = 'sc-domain:nopull.test';
    const adbF = new AuditDatabase(dbPathFor(dataDir, freshSite));
    adbF.upsertProperty(freshSite, 'asis');
    ok(buildBacklinkProfile(adbF.db, freshSite) === null, 'backlinkProfile is null before any pull');
    adbF.close();
  }
  d6.prepare(`UPDATE property_meta SET total_backlinks=1200, referring_domains=80, backlinks_rank=312, broken_backlinks=7, broken_pages=2, backlinks_nofollow_pct=0.25, backlinks_fetched_at=datetime('now') WHERE site_url=?`).run(site);
  d6.prepare(`INSERT OR REPLACE INTO page_backlinks (url_key,url,backlinks,referring_domains,dofollow,status_code) VALUES ('smoke.test/','https://smoke.test/',900,60,800,200),('smoke.test/gone','https://smoke.test/gone',40,9,40,404),('smoke.test/unknown','https://smoke.test/unknown',3,1,3,NULL)`).run();
  const p1 = buildBacklinkProfile(d6, site);
  ok(p1 && p1.summary.domainRank === 312 && p1.pagesTotal === 5 && p1.pagesUnchecked === 1 && p1.brokenPages.length === 2 && p1.brokenPages.some(b => b.url.endsWith('/gone')) && p1.topPages[0].url === 'https://smoke.test/', `profile summary + pages from stored rows (${JSON.stringify({ s: p1?.summary, n: p1?.pagesTotal, broken: p1?.brokenPages.length })})`);
  ok(p1.referringDomains === null && p1.anchors === null && p1.history === null, 'sections never collected are null, not zero');
  d6.prepare(`INSERT INTO referring_domains (snapshot_at,domain,rank,backlinks,referring_pages,nofollow_pages,spam_score,first_seen,lost_date) VALUES ('2026-10-01T00:00:00Z','old.example',100,5,5,0,0,'2024-01-01',NULL),('2026-10-17T00:00:00Z','big.example',500,30,20,20,5,'2025-02-02',NULL),('2026-10-17T00:00:00Z','gone.example',200,1,1,0,0,'2023-01-01','2026-09-30')`).run();
  d6.prepare(`INSERT INTO backlink_anchors (snapshot_at,anchor,kind,backlinks,referring_domains,nofollow_pages) VALUES ('2026-10-17T00:00:00Z','Smoke Test','branded',70,30,0),('2026-10-17T00:00:00Z','click here','generic',30,10,0),('2026-10-17T00:00:00Z','','empty',10,5,0)`).run();
  d6.prepare(`INSERT INTO backlink_history (date,backlinks,referring_domains,new_referring_domains,lost_referring_domains,fetched_at) VALUES ('2026-09-15',100,50,3,1,'2026-10-17'),('2026-10-01',103,52,2,0,'2026-10-17')`).run();
  const p2 = buildBacklinkProfile(d6, site);
  ok(p2.referringDomains.snapshotAt === '2026-10-17T00:00:00Z' && p2.referringDomains.live === 1 && p2.referringDomains.lost === 1 && p2.referringDomains.top.length === 1 && p2.referringDomains.top[0].domain === 'big.example', `latest snapshot only; lost domains counted, not listed (${JSON.stringify(p2.referringDomains)})`);
  ok(p2.anchors.mix.length === 3 && p2.anchors.mix[0].kind === 'branded' && p2.anchors.mix[0].backlinks === 70, `anchor mix grouped by kind (${JSON.stringify(p2.anchors.mix)})`);
  ok(p2.history.months.length === 2 && p2.history.months[0].newDomains === 3 && p2.history.fetchedAt === '2026-10-17', 'history is monthly from the stored days');
  const dashBp = getDashboardData(dataDir, site).backlinkProfile;
  ok(dashBp && dashBp.summary?.backlinks === 1200, 'dashboard payload carries backlinkProfile (cache key sees the new tables)');
  adb6.close();
}

// #52: crawl progress arithmetic.
{
  const r0 = crawlRate(0, 0, 5, 10000, 0);
  ok(r0.pagesPerSec === null && r0.etaSeconds === null && r0.pagesRemaining === 5, 'crawlRate: no rate or ETA before the first page');
  const r1 = crawlRate(600, 0, 9400, 10000, 300_000);
  ok(r1.pagesPerSec === 2 && r1.etaSeconds === 4700 && r1.pagesRemaining === 9400, `crawlRate: 600 pages in 5 min = 2 pages/s, ETA 4700 s (${JSON.stringify(r1)})`);
  const r2 = crawlRate(3900, 100, 5000, 4000, 60_000);
  ok(r2.pagesRemaining === 100 && r2.pagesPerSec === 66.7, `crawlRate: the queue is capped by maxPages and failures count toward the rate (${JSON.stringify(r2)})`);
  ok(fmtDuration(4700) === '1h 18m' && fmtDuration(252) === '4m 12s' && fmtDuration(9) === '9s' && fmtDuration(null) === 'unknown', 'fmtDuration formats s / m s / h m');
}

// #58: optional API keys are read placeholder-safe.
{
  const placeholders = ['your-majestic-key-here', 'YOUR_API_KEY', 'your key', '<your key>', '${user_config.majestic_api_key}', 'key-here', 'keyhere', 'changeme', 'xxx', 'XXXXXXXX', 'placeholder', 'you@example.com', 'Example'];
  const bad = placeholders.filter(v => placeholderReason(v) == null);
  ok(bad.length === 0, `optionalSecret: placeholders are rejected${bad.length ? ` — ACCEPTED ${JSON.stringify(bad)}` : ''}`);
  const real = ['d41d8cd98f00b204e9800998ecf8427e', 'richard@houtini.com', 'Tr0ub4dor&3', 'xx', 'axxxb'];
  const wrong = real.filter(v => placeholderReason(v) != null);
  ok(wrong.length === 0, `optionalSecret: real-looking values pass${wrong.length ? ` — REJECTED ${JSON.stringify(wrong)}` : ''}`);
  // A DataForSEO login is an email address: the placeholder words inside a real one must not switch the tier off.
  const emails = ['seo@example-agency.co.uk', 'bob@your-seo.com', 'info@keyhere.io', 'team@placeholder-media.com', 'your-name@agency.io'];
  const emailWrong = emails.filter(v => placeholderReason(v) != null);
  ok(emailWrong.length === 0, `optionalSecret: real email-style logins pass${emailWrong.length ? ` — REJECTED ${JSON.stringify(emailWrong)}` : ''}`);
  const fakeEmails = ['you@example.com', 'me@example.org', 'user@mail.example', '${user_config.dataforseo_username}@x.com', '<you@agency.com>'];
  const emailBad = fakeEmails.filter(v => placeholderReason(v) == null);
  ok(emailBad.length === 0, `optionalSecret: reserved-domain and template emails are still rejected${emailBad.length ? ` — ACCEPTED ${JSON.stringify(emailBad)}` : ''}`);
  ok(dataForSeoCredentials({ DATAFORSEO_USERNAME: 'seo@example-agency.co.uk', DATAFORSEO_PASSWORD: 'd41d8cd98f00b204' })?.user === 'seo@example-agency.co.uk', 'optionalSecret: an email login containing "example" switches DataForSEO on');
  ok(placeholderReason('') === 'empty' && placeholderReason('   ') === 'empty' && placeholderReason(undefined) === 'unset', 'optionalSecret: blank / whitespace / missing are unset');
  ok(optionalSecret('MAJESTIC_API_KEY', { MAJESTIC_API_KEY: '  abc123  ' }) === 'abc123', 'optionalSecret: values are trimmed');
  // Exactly one stderr line per rejected name, naming the tier; blank stays silent.
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  let a, c, d, good;
  try {
    a = optionalSecret('MAJESTIC_API_KEY', { MAJESTIC_API_KEY: 'your-majestic-key-here' });
    optionalSecret('MAJESTIC_API_KEY', { MAJESTIC_API_KEY: '<your key>' });
    optionalSecret('CRUX_API_KEY', { CRUX_API_KEY: '' });
    c = cruxApiKey({ CRUX_API_KEY: '${user_config.crux_api_key}' });
    d = dataForSeoCredentials({ DATAFORSEO_USERNAME: 'me@houtini.com', DATAFORSEO_PASSWORD: 'your-dataforseo-password' });
    good = dataForSeoCredentials({ DATAFORSEO_USERNAME: ' me@houtini.com ', DATAFORSEO_PASSWORD: 's3cret' });
  } finally { console.error = orig; }
  ok(a === undefined && c === undefined && d === null && good?.user === 'me@houtini.com' && good.pass === 's3cret', 'optionalSecret: placeholders read as unset (Majestic, CrUX, the DataForSEO pair)');
  ok(lines.length === 3
    && lines[0] === 'MAJESTIC_API_KEY looks like a placeholder; Majestic tier disabled.'
    && lines.includes('CRUX_API_KEY looks like a placeholder; CrUX tier disabled.')
    && lines.includes('DATAFORSEO_PASSWORD looks like a placeholder; DataForSEO tier disabled.'), `optionalSecret: one stderr line per rejected key (${JSON.stringify(lines)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dataDir, { recursive: true, force: true });
if (fail) process.exitCode = 1;
