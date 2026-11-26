// Probe: audit-engine regressions found by the engine review. Each block builds the smallest fixture
// that used to give the wrong answer:
//   - a category-filtered run_audit replaced the property's audit (dashboard, list_findings, history);
//   - the 500-per-check cap kept an arbitrary 500, dropping the site's top page;
//   - run_audit during a crawl froze a partial snapshot, so detect_changes reported pages as removed;
//   - redirect-chain / internal-links-to-redirects read only pages.redirects (first arrival), missing
//     every redirect recorded in redirect_sources;
//   - ghost-pages flagged URLs that redirected or failed to fetch, and fired on an unfinished crawl;
//   - traffic-decay priced a page on the clicks it kept, not the clicks it lost;
//   - history deltas keyed every site-level finding of a check as one 'site' key;
//   - checks reading an optional, empty table passed silently instead of reading "not collected";
//   - broken-canonical-target missed the https -> http downgrade on a self-canonical;
//   - article-date-illogical skipped BlogPosting pages and flagged same-day date-only values;
//   - sitemap-non-indexable flagged PDFs; pagination-canonical-to-page-1 flagged ?p=<post id>;
//   - striking-distance carried no clicks, so its rank-gap stake ignored what the query already earns.
// Run: node scripts/probe-audit-engine.mjs   (after npm run build:server). No network.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { runAudit, runSingleCheck } from '../dist/audit/engine.js';
import { snapshotCrawl, diffLatest } from '../dist/audit/drift.js';
import { auditHistory } from '../dist/audit/history.js';
import { listFindings } from '../dist/core/findingsQuery.js';
import { getDashboardData } from '../dist/core/dashboardData.js';
import { ensurePageTotalsSchema } from '../dist/core/gscPageTotals.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };
const dataDir = path.join(tmpdir(), `sac-audit-engine-${Date.now()}`);
const H = 'https://example.com';
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/** A property with one crawl row. Returns helpers bound to its database. */
function property(site, crawl = { status: 'completed', maxPages: 4000, crawled: 700 }) {
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  const db = adb.db;
  db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, max_pages, urls_crawled, started_at, finished_at)
    VALUES ('c1', ?, 'example.com', ?, ?, ?, datetime('now','-20 minutes'), ?)`)
    .run(`${H}/`, crawl.status, crawl.maxPages, crawl.crawled, crawl.status === 'completed' ? new Date(Date.now() - 600000).toISOString() : null);
  const pg = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,is_internal,indexable,indexable_reason,noindex,content_type,title,title_length,meta_description,h1,h1_count,word_count,
      canonical_url,canonical_key,canonical_count,json_ld,inlink_count,ipr,click_depth,redirects,rel_prev)
    VALUES ('c1',@url,@key,@st,1,@ix,@rs,0,@ct,@title,10,@md,'h one',1,500,@cu,@ck,1,@jl,3,10,@cd,@rd,0)`);
  const add = (p, o = {}) => pg.run({ url: H + p, key: H + p, st: 200, ix: 1, rs: null, ct: 'text/html', title: `Title ${p}`, md: `desc ${p}`, cu: H + p, ck: H + p, jl: null, cd: p === '/' ? 0 : 1, rd: null, ...o });
  ensurePageTotalsSchema(db);
  const sa = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0,?)`);
  const pt = db.prepare(`INSERT OR REPLACE INTO gsc_page_totals (date,page,page_key,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,0,?)`);
  /** One query row and the matching page-total row for a day. */
  const gsc = (d, q, p, c, i, pos) => { sa.run(d, q, H + p, H + p, c, i, pos); pt.run(d, H + p, H + p, c, i, pos); };
  return { adb, db, add, gsc, sa };
}
const check = (site, id) => runSingleCheck(dataDir, site, id, 1000);
const keys = (r) => r.findings.map(f => f.urlKey);
const jsonLd = (node) => JSON.stringify([JSON.stringify({ '@context': 'https://schema.org', ...node })]);

try {
  // ── 1. Checks over one completed crawl ───────────────────────────────────────────────────────
  console.log('checks');
  const site = 'sc-domain:engine.test';
  {
    const { adb, db, add, gsc } = property(site);
    add('/');
    // /new was crawled directly; /old -> /mid -> /new was found later, so it is in redirect_sources only.
    add('/new');
    const chain = [{ from: `${H}/old`, to: `${H}/mid`, status: 301 }, { from: `${H}/mid`, to: `${H}/new`, status: 301 }];
    db.prepare(`INSERT INTO redirect_sources (url_key,url,status,final_url,final_key,hops,chain,crawl_id) VALUES (?,?,?,?,?,?,?,'c1')`)
      .run(`${H}/old`, `${H}/old`, 301, `${H}/new`, `${H}/new`, 2, JSON.stringify(chain));
    // /first was FIRST reached through a 2-hop chain: pages.redirects holds it (the pre-existing case).
    const firstChain = [{ from: `${H}/f0`, to: `${H}/f1`, status: 301 }, { from: `${H}/f1`, to: `${H}/first`, status: 301 }];
    add('/first', { rd: JSON.stringify(firstChain) });
    db.prepare(`INSERT INTO redirect_sources (url_key,url,status,final_url,final_key,hops,chain,crawl_id) VALUES (?,?,?,?,?,?,?,'c1')`)
      .run(`${H}/f0`, `${H}/f0`, 301, `${H}/first`, `${H}/first`, 2, JSON.stringify(firstChain));
    const ln = db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,anchor_text,is_internal,placement) VALUES ('c1',?,?,?,?,?,1,'body')`);
    for (const s of ['/', '/new']) ln.run(H + s, H + s, `${H}/old`, `${H}/old`, 'old link');
    ln.run(`${H}/`, `${H}/`, `${H}/new`, `${H}/new`, 'new link');
    // A URL the crawl requested and got no answer for.
    db.prepare(`INSERT INTO errors (crawl_id,url,error_type,error_message) VALUES ('c1',?,'fetch','timeout')`).run(`${H}/timeout/`);
    // https page canonicalising to its own http:// URL; a healthy self-canonical beside it.
    add('/down', { cu: 'http://example.com/down' });
    // Article dates.
    add('/post-blog', { jl: jsonLd({ '@type': 'BlogPosting', headline: 'x', datePublished: '2025-06-10T09:00:00+00:00', dateModified: '2024-01-01T09:00:00+00:00' }) });
    add('/post-sameday', { jl: jsonLd({ '@type': 'Article', headline: 'x', datePublished: '2025-06-10T09:00:00+00:00', dateModified: '2025-06-10' }) });
    add('/post-daybefore', { jl: jsonLd({ '@type': 'Article', headline: 'x', datePublished: '2025-06-10T09:00:00+00:00', dateModified: '2025-06-09' }) });
    // Sitemap: a PDF and a noindex page.
    add('/guide.pdf', { ix: 0, rs: 'non-html', ct: 'application/pdf', title: null, cu: null, ck: null });
    add('/hidden', { ix: 0, rs: 'noindex-meta' });
    for (const p of ['/guide.pdf', '/hidden', '/new']) db.prepare(`INSERT INTO sitemap_urls (url_key,url,fetched_at) VALUES (?,?,datetime('now'))`).run(H + p, H + p);
    // Pagination: a WordPress post id, a /page/<slug> section, and a real page 2 canonicalised to page 1.
    add('/?p=123', { cu: `${H}/hello-world`, ck: `${H}/hello-world`, ix: 0, rs: 'canonicalised' });
    add('/page/about', { cu: `${H}/about`, ck: `${H}/about`, ix: 0, rs: 'canonicalised' });
    add('/blog/page/2', { cu: `${H}/blog`, ck: `${H}/blog`, ix: 0, rs: 'canonicalised' });
    // max-image-preview restricted in the header only.
    db.prepare(`UPDATE pages SET x_robots_tag = 'max-image-preview:none' WHERE url_key = ?`).run(`${H}/new`);
    // The cap: 600 pages without a meta description; the one with the traffic sorts last by url.
    for (let i = 0; i < 600; i++) add(`/p${String(i).padStart(3, '0')}`, { md: null });
    add('/zz-money', { md: null });
    add('/decay-total'); add('/decay-most');
    for (let n = 4; n < 64; n++) {
      const d = day(n);
      gsc(d, 'home', '/', 5, 100, 3);
      gsc(d, 'money kw', '/zz-money', 200, 4000, 2);
      gsc(d, 'old thing', '/old', 3, 60, 6);         // redirected: not a ghost
      gsc(d, 'slow thing', '/timeout', 3, 60, 6);    // failed to fetch: not a ghost
      gsc(d, 'cart thing', '/cart', 3, 60, 6);       // never requested (a skip rule): the finding
      gsc(d, 'page two kw', '/new', 2, 50, 14);      // striking distance, already earning clicks
      if (n >= 32) { gsc(d, 'dt', '/decay-total', 40, 800, 4); gsc(d, 'dm', '/decay-most', 40, 800, 4); }
      else if (n % 7 === 0) gsc(d, 'dm', '/decay-most', 1, 5, 30); // a trickle is left; /decay-total has no rows at all
    }
    adb.close();

    const rc = check(site, 'redirect-chain');
    ok(keys(rc).includes(`${H}/old`), `redirect-chain: a 2-hop chain recorded only in redirect_sources is reported, keyed by its source (${JSON.stringify(keys(rc))})`);
    ok(keys(rc).includes(`${H}/first`) && rc.total === 2, `redirect-chain: the first-arrival chain keeps its final-page key and is not reported twice (total ${rc.total})`);
    const il = check(site, 'internal-links-to-redirects');
    ok(il.total === 1 && il.findings[0].urlKey === `${H}/old` && il.findings[0].evidence.linkingPages === 2, `internal-links-to-redirects: links to /old (in redirect_sources) are reported, 2 linking pages (${JSON.stringify(il.findings)})`);
    const gp = check(site, 'ghost-pages');
    ok(gp.total === 1 && gp.findings[0].urlKey === `${H}/cart`, `ghost-pages: the redirected and the failed URL are left out; the never-requested one stays (${JSON.stringify(keys(gp))})`);
    const bc = check(site, 'broken-canonical-target');
    ok(bc.total === 1 && bc.findings[0].urlKey === `${H}/down` && /HTTP URL/.test(bc.findings[0].evidence.reason), `broken-canonical-target: https page canonicalising to its own http:// URL (${JSON.stringify(bc.findings)})`);
    const ad = keys(check(site, 'article-date-illogical')).sort();
    ok(JSON.stringify(ad) === JSON.stringify([`${H}/post-blog`, `${H}/post-daybefore`]), `article-date-illogical: BlogPosting caught, same-day date-only not flagged, an earlier day still flagged (${JSON.stringify(ad)})`);
    const sn = keys(check(site, 'sitemap-non-indexable'));
    ok(JSON.stringify(sn) === JSON.stringify([`${H}/hidden`]), `sitemap-non-indexable: the PDF is not reported, the noindex page is (${JSON.stringify(sn)})`);
    const pc = keys(check(site, 'pagination-canonical-to-page-1'));
    ok(JSON.stringify(pc) === JSON.stringify([`${H}/blog/page/2`]), `pagination-canonical-to-page-1: ?p=<id> and /page/<slug> are not pagination (${JSON.stringify(pc)})`);
    const ip = keys(check(site, 'image-preview-restricted'));
    ok(ip.includes(`${H}/new`), 'image-preview-restricted: a restriction set in X-Robots-Tag is seen');
    const sd = check(site, 'striking-distance').findings.find(f => f.evidence.query === 'page two kw');
    ok(sd && sd.evidence.clicks === 56, `striking-distance: evidence carries the query's clicks (${sd?.evidence.clicks})`);

    const full = runAudit(dataDir, site, { topLimit: 50 });
    const a2 = new AuditDatabase(dbPathFor(dataDir, site));
    const q = (sql, ...args) => a2.db.prepare(sql).all(...args);
    const trunc = full.truncatedChecks?.find(t => t.checkId === 'missing-meta-description');
    ok(trunc && trunc.totalFound === 601, `cap: missing-meta-description found 601, stored 500 (${JSON.stringify(trunc)})`);
    ok(q(`SELECT 1 FROM findings WHERE run_id=? AND check_id='missing-meta-description' AND url_key=?`, full.runId, `${H}/zz-money`).length === 1, 'cap: the page with the most clicks is among the 500 kept');
    const decay = Object.fromEntries(q(`SELECT url_key k, priority p, json_extract(effort,'$.expectedClicks') t FROM findings WHERE run_id=? AND check_id='traffic-decay'`, full.runId).map(r => [r.k.replace(H, ''), r]));
    ok(decay['/decay-total']?.t === 1120 && decay['/decay-most']?.t === 1116, `traffic-decay: both pages stake the clicks they lost (${decay['/decay-total']?.t}, ${decay['/decay-most']?.t})`);
    ok(decay['/decay-most'] && decay['/decay-total'] && decay['/decay-most'].p > decay['/decay-total'].p * 0.9, 'traffic-decay: a page that kept 4 clicks is not ranked far below one that kept none');
    const sdRun = q(`SELECT json_extract(effort,'$.expectedClicks') t, json_extract(traffic_at_risk,'$.clicks') c, json_extract(traffic_at_risk,'$.impressions') i FROM findings WHERE run_id=? AND check_id='striking-distance' AND json_extract(evidence,'$.query')='page two kw'`, full.runId)[0];
    ok(sdRun && sdRun.c === 56 && sdRun.t > 0 && sdRun.t < sdRun.i, `striking-distance: the stake subtracts the clicks already earned (clicks ${sdRun?.c}, stake ${sdRun?.t})`);
    const nc = new Set((full.notCollected ?? []).map(n => n.checkId));
    const expectNc = ['crux-field-lcp', 'crux-field-inp', 'crux-field-cls', 'crux-regression', 'content-only-in-rendered-dom', 'coverage-not-indexed', 'canonical-conflict', 'soft-404-shell', 'rich-result-issues', 'backlinks-to-404', 'orphan-no-links', 'high-yield-cwv-fail'];
    ok(expectNc.every(id => nc.has(id)), `not collected: the CrUX, render, URL Inspection, backlink and lab-CWV checks are listed when their table is empty (missing: ${expectNc.filter(id => !nc.has(id)).join(', ') || 'none'})`);

    // ── 2. A category-filtered run is a drill-down, not the property's audit ─────────────────────
    console.log('filtered run');
    const filtered = runAudit(dataDir, site, { categories: ['schema'], topLimit: 50 });
    ok(filtered.total > 0 && filtered.top.length > 0 && filtered.top.every(f => f.category === 'schema'), `the filtered run's own reply returns its findings (${filtered.total}, all schema)`);
    const runs = q(`SELECT run_id, scope FROM audit_runs ORDER BY rowid`);
    ok(runs[1]?.scope === 'categories:schema' && runs[0]?.scope === 'core', `the filtered run records its scope (${runs.map(r => r.scope).join(', ')})`);
    a2.close();
    const lf = listFindings(dataDir, site, {});
    ok(lf.runId === full.runId && lf.total === full.total, `list_findings still reads the full run (${lf.total} of ${full.total})`);
    const dash = getDashboardData(dataDir, site);
    ok(dash.findings?.total === full.total, `the dashboard payload still reads the full run (${dash.findings?.total} of ${full.total})`);
    const a3 = new AuditDatabase(dbPathFor(dataDir, site));
    const hist = auditHistory(a3.db);
    ok(hist.healthHistory.length === 1 && hist.healthHistory[0].runId === full.runId && !hist.auditDeltas.some(d => d.runId === filtered.runId), 'history: the filtered run adds no health point and no delta');
    a3.close();
  }

  // ── 3. History deltas key site-level findings by query ────────────────────────────────────────
  console.log('history keys');
  {
    const site3 = 'sc-domain:engine-deltas.test';
    const { adb, db, add, sa } = property(site3, { status: 'completed', maxPages: 4000, crawled: 4 });
    for (const p of ['/', '/a', '/b', '/c']) add(p);
    const seed = (qs, other) => { for (let n = 4; n < 34; n++) for (const q of qs) { sa.run(day(n), q, `${H}/a`, `${H}/a`, 2, 40, 4); sa.run(day(n), q, H + other, H + other, 1, 30, 9); } };
    seed(['alpha widgets', 'beta widgets', 'gamma widgets'], '/b');
    adb.close();
    const r1 = runAudit(dataDir, site3, {});
    const b = new AuditDatabase(dbPathFor(dataDir, site3));
    b.db.prepare(`DELETE FROM search_analytics WHERE query IN ('alpha widgets','beta widgets')`).run();
    const sa2 = b.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0,?)`);
    for (let n = 4; n < 34; n++) for (const q of ['delta widgets', 'epsilon widgets']) { sa2.run(day(n), q, `${H}/a`, `${H}/a`, 2, 40, 4); sa2.run(day(n), q, `${H}/c`, `${H}/c`, 1, 30, 9); }
    b.close();
    const r2 = runAudit(dataDir, site3, {});
    const c = new AuditDatabase(dbPathFor(dataDir, site3));
    const cann = (run) => c.db.prepare(`SELECT COUNT(*) n FROM findings WHERE run_id=? AND check_id='keyword-cannibalisation'`).get(run).n;
    ok(cann(r1.runId) === 3 && cann(r2.runId) === 3, `fixture: 3 cannibalised queries in each run (${cann(r1.runId)}, ${cann(r2.runId)})`);
    // Only the cannibalisation findings differ in a way the old key hid: count them alone.
    const only = (a, bRun) => c.db.prepare(`SELECT COUNT(*) n FROM (SELECT json_extract(evidence,'$.query') FROM findings WHERE run_id=? AND check_id='keyword-cannibalisation' EXCEPT SELECT json_extract(evidence,'$.query') FROM findings WHERE run_id=? AND check_id='keyword-cannibalisation')`).get(a, bRun).n;
    const d = auditHistory(c.db).auditDeltas.find(x => x.runId === r2.runId);
    const others = (a, bRun) => c.db.prepare(`SELECT COUNT(*) n FROM (SELECT DISTINCT check_id, COALESCE(url_key,'site') FROM findings WHERE run_id=? AND check_id<>'keyword-cannibalisation' EXCEPT SELECT DISTINCT check_id, COALESCE(url_key,'site') FROM findings WHERE run_id=? AND check_id<>'keyword-cannibalisation')`).get(a, bRun).n;
    ok(only(r1.runId, r2.runId) === 2 && d && d.resolved >= 2 && d.resolved === 2 + others(r1.runId, r2.runId), `delta: the two cannibalised queries that went away count as resolved (resolved ${d?.resolved})`);
    ok(d && d.opened >= 2, `delta: the two new ones count as opened (opened ${d?.opened})`);
    c.close();
  }

  // ── 4. An audit during a crawl does not freeze a partial snapshot ─────────────────────────────
  console.log('snapshot');
  {
    const site4 = 'sc-domain:engine-snapshot.test';
    const { adb, db, add, gsc } = property(site4, { status: 'running', maxPages: 4000, crawled: 2 });
    db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, max_pages, urls_crawled, started_at, finished_at) VALUES ('c0',?, 'example.com','completed',4000,6,'2026-01-01T00:00:00Z','2026-01-01T00:10:00Z')`).run(`${H}/`);
    const snap = db.prepare(`INSERT INTO page_snapshots (crawl_id,url_key,captured_at,status_code,indexable,title,canonical_key) VALUES ('c0',?,'2026-01-01 00:10:00',200,1,?,?)`);
    for (const p of ['/', '/a', '/b', '/c', '/d', '/e']) snap.run(H + p, `Title ${p}`, H + p);
    add('/'); add('/a'); // the crawl has written 2 of 6 pages so far
    for (let n = 4; n < 40; n++) { gsc(day(n), 'ghost kw', '/not-crawled-yet', 3, 60, 6); gsc(day(n), 'home', '/', 5, 100, 3); }
    adb.close();
    ok(check(site4, 'ghost-pages').total === 0, 'ghost-pages: silent while the crawl is still running');
    runAudit(dataDir, site4, {});
    const a = new AuditDatabase(dbPathFor(dataDir, site4));
    const snapped = () => a.db.prepare(`SELECT COUNT(*) n FROM page_snapshots WHERE crawl_id='c1'`).get().n;
    ok(snapped() === 0, `run_audit on a running crawl takes no snapshot (${snapped()} rows)`);
    const pg = a.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,is_internal,indexable,content_type,title,word_count,canonical_key) VALUES ('c1',?,?,200,1,1,'text/html',?,300,?)`);
    for (const p of ['/b', '/c', '/d', '/e']) pg.run(H + p, H + p, `Title ${p}`, H + p);
    const done = new Date().toISOString();
    a.db.prepare(`UPDATE crawl_metadata SET status='completed', finished_at=?, urls_crawled=6 WHERE crawl_id='c1'`).run(done);
    snapshotCrawl(a.db, 'c1', done); // what the crawler does when it finishes
    ok(snapped() === 6, `the crawl's own snapshot at completion holds every page (${snapped()} rows)`);
    const drift = diffLatest(a.db);
    ok((drift.summary.removed ?? 0) === 0, `detect_changes reports no page as removed (${JSON.stringify(drift.summary)})`);
    a.close();
    // A completed crawl with no snapshot is still self-healed by run_audit.
    const b = new AuditDatabase(dbPathFor(dataDir, site4));
    b.db.prepare(`DELETE FROM page_snapshots WHERE crawl_id='c1'`).run();
    b.close();
    runAudit(dataDir, site4, {});
    const c = new AuditDatabase(dbPathFor(dataDir, site4));
    ok(c.db.prepare(`SELECT COUNT(*) n FROM page_snapshots WHERE crawl_id='c1'`).get().n === 6, 'run_audit still snapshots a COMPLETED crawl that has none');
    c.close();
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
