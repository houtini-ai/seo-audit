// #55 group B, item 3: redirect hygiene (redirect-to-non-indexable, redirect-to-homepage, redirect-loop,
// temporary-redirect-with-equity, redirect-retired) and the extended redirect-chain. A fixture DB with
// each check firing and not firing, then an end-to-end crawl of a local server (no network beyond 127.0.0.1).
// Run: node scripts/probe-redirects.mjs (after npm run build:server)
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { urlKey, hostFormForProperty } from '../dist/core/url-key.js';
import { CHECKS } from '../dist/audit/checks.js';
import { runAudit } from '../dist/audit/engine.js';
import { gscFreshness } from '../dist/core/gscFreshness.js';
import { loopPoint, NON_SEO_FLOW } from '../dist/audit/checks-redirects.js';
import { Crawler } from '../dist/core/Crawler.js';
import { rulesFromText, robotsVerdict } from '../dist/core/robots.js';

process.env.SAC_AUTOSERVE = '0';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const SITE = 'sc-domain:example.test';
const W = 'https://www.example.test';
const keyOpts = { hostForm: hostFormForProperty(SITE) };
const K = (p) => urlKey(p.startsWith('http') ? p : `${W}${p}`, keyOpts);
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
const runCheck = (db, id) => CHECKS.find(c => c.id === id).run({ db, gscMaxDate: gscFreshness(db).effectiveMax, brand: null });
const paths = (fs) => fs.map(f => f.urlKey.replace(/^https?:\/\/[^/]+/, '')).sort();
const IDS = ['redirect-to-non-indexable', 'redirect-to-homepage', 'redirect-loop', 'temporary-redirect-with-equity', 'redirect-retired'];

try {
  // ── 1. Pure helpers ───────────────────────────────────────────────────────────────────────
  {
    check('loopPoint: A->B->A revisits A', loopPoint([{ from: 'a', to: 'b', status: 301 }, { from: 'b', to: 'a', status: 301 }]) === 'a');
    check('loopPoint: a straight chain has no loop', loopPoint([{ from: 'a', to: 'b', status: 301 }, { from: 'b', to: 'c', status: 301 }]) === null);
    check('NON_SEO_FLOW: Shopify account/auth, cart and login flows; not /accountancy-guide or /products/x',
      ['https://x.test/account', 'https://x.test/account/login', 'https://x.test/customer_authentication/redirect?a=1', 'https://accounts.x.test/authentication/oauth/authorize?client_id=1', 'https://x.test/cart', 'https://x.test/wp-login.php']
        .every(u => NON_SEO_FLOW.test(u)) && !NON_SEO_FLOW.test('https://x.test/accountancy-guide') && !NON_SEO_FLOW.test('https://x.test/products/login-kit-x'));
  }

  // ── 2. Fixture DB: two crawls (c1 earlier, c2 latest) ───────────────────────────────────────
  const dir = tmp('sac-redir-');
  const D = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const day = (k) => new Date(Date.parse(D) - k * 86400000).toISOString().slice(0, 10);
  {
    const adb = new AuditDatabase(dbPathFor(dir, SITE));
    adb.upsertProperty(SITE, 'apex');
    const db = adb.db;
    db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES ('c1', ?, 'example.test', 'completed', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z')`).run(`${W}/`);
    db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES ('c2', ?, 'example.test', 'completed', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z')`).run(`${W}/`);
    const pg = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,indexable_reason,canonical_key,redirects,fetch_state,ipr,inlink_count) VALUES ('c2',?,?,?,?,1,?,?,?,?,?,1,1)`);
    const page = (p, status, { ct = 'text/html', indexable = status === 200 ? 1 : 0, reason = status === 200 ? null : `http-${status}`, canonical = null, redirects = null, fetchState = null } = {}) =>
      pg.run(`${W}${p}`, K(p), status, ct, indexable, reason, canonical, redirects ? JSON.stringify(redirects) : null, fetchState);
    page('/', 200); page('/live', 200); page('/mid', 200); page('/still-200', 200);
    page('/noidx', 200, { indexable: 0, reason: 'noindex-meta' });
    page('/canon', 200, { indexable: 0, reason: 'canonicalised', canonical: K('/live') });
    page('/dead', 404); page('/pdf', 200, { ct: 'application/pdf', indexable: 0, reason: 'non-html' });
    page('/legacy429', 429);
    pg.run(`${W}/rl`, K('/rl'), null, null, null, 'rate-limited', null, null, 'rate_limited');
    page('/loopb', 301, { reason: 'redirect' }); page('/capend', 302, { reason: 'redirect' });
    page('/gone-article', 404); page('/gone-quiet', 410); page('/gone-new', 404); page('/products/widget', 404); page('/gone-403', 403);
    pg.run(`${W}/rl-gone`, K('/rl-gone'), null, null, null, 'rate-limited', null, null, 'rate_limited');
    // pages.redirects-only records (source normalises to the same key as the final page).
    page('/norm', 200, { redirects: [{ from: 'http://www.example.test/norm', to: `${W}/norm`, status: 301 }] });
    page('/norm2', 200, { redirects: [{ from: 'http://www.example.test/norm2', to: `${W}/norm2/`, status: 301 }, { from: `${W}/norm2/`, to: `${W}/norm2`, status: 301 }] });
    page('/dead-norm', 404, { redirects: [{ from: 'http://www.example.test/dead-norm/', to: `${W}/dead-norm/`, status: 301 }] });
    // Legacy auth bounce stored as an off-site page row (status 302, 2-hop chain): redirect-chain used to report these.
    const authUrl = `${W}/customer_authentication/redirect?locale=en`;
    const authChain = [{ from: authUrl, to: 'https://accounts.example.test/?flags=1', status: 302 }, { from: 'https://accounts.example.test/?flags=1', to: 'https://accounts.example.test/authentication/oauth/authorize?client_id=x', status: 302 }];
    pg.run(authUrl, K(authUrl), 302, '', 0, 'redirect', null, JSON.stringify(authChain), null);

    const rs = db.prepare(`INSERT INTO redirect_sources (url_key,url,status,final_url,final_key,hops,chain,crawl_id) VALUES (?,?,?,?,?,?,?,'c2')`);
    const redirect = (src, hops) => { const chain = hops.map(([from, to, status]) => ({ from: from.startsWith('http') ? from : `${W}${from}`, to: to.startsWith('http') ? to : `${W}${to}`, status })); const fin = chain[chain.length - 1].to; rs.run(K(chain[0].from), chain[0].from, chain[0].status, fin, K(fin), chain.length, JSON.stringify(chain)); };
    redirect('/old-noidx', [['/old-noidx', '/noidx', 301]]);
    redirect('/old-canon', [['/old-canon', '/canon', 301]]);
    redirect('/old-dead', [['/old-dead', '/dead', 301]]);
    redirect('/old-dead-bl', [['/old-dead-bl', '/dead', 301]]);
    redirect('/old-rl', [['/old-rl', '/rl', 301]]);
    redirect('/old-429', [['/old-429', '/legacy429', 301]]);
    redirect('/old-pdf', [['/old-pdf', '/pdf', 301]]);
    redirect('/old-live', [['/old-live', '/live', 301]]);
    redirect('/old-chain', [['/old-chain', '/mid', 301], ['/mid', '/live', 301]]);
    redirect('/old-uncrawled', [['/old-uncrawled', '/never-crawled', 301]]);
    redirect('/old-offsite', [['/old-offsite', 'https://partner.other.test/x', 302]]);
    redirect('/account', [['/account', '/account/login', 302]]);
    redirect(authUrl, authChain.map(h => [h.from, h.to, h.status]));
    redirect('/old-deep', [['/old-deep', '/', 301]]);
    redirect('/old-deep-quiet', [['/old-deep-quiet', '/', 301]]);
    redirect('/index.html', [['/index.html', '/', 301]]);
    redirect('/en', [['/en', '/', 301]]);
    redirect('/old-deep-query', [['/old-deep-query', '/?ref=old', 301]]);
    redirect('/loopa', [['/loopa', '/loopb', 301], ['/loopb', '/loopa', 301], ['/loopa', '/loopb', 301], ['/loopb', '/loopa', 301], ['/loopa', '/loopb', 301]]);
    redirect('/cap1', [['/cap1', '/cap2', 302], ['/cap2', '/cap3', 302], ['/cap3', '/cap4', 302], ['/cap4', '/cap5', 302], ['/cap5', '/capend', 302]]);
    redirect('/temp-traffic', [['/temp-traffic', '/live', 302]]);
    redirect('/temp-inlinks', [['/temp-inlinks', '/live', 307]]);
    redirect('/temp-backlinks', [['/temp-backlinks', '/live', 303]]);
    redirect('/temp-quiet', [['/temp-quiet', '/live', 302]]);
    redirect('/perm-traffic', [['/perm-traffic', '/live', 301]]);
    redirect('/temp-offsite', [['/temp-offsite', 'https://shop.other.test/y', 302]]);
    redirect('/', [['/', '/en-au/', 302]]); // a geo homepage 302: deliberate

    // Snapshots: c1 = earlier crawl, c2 = the latest crawl (as runAudit would write it).
    const sn = db.prepare(`INSERT INTO page_snapshots (crawl_id,url_key,captured_at,status_code,indexable,schema_types) VALUES (?,?,?,?,?,?)`);
    for (const [p, st, types] of [['/gone-article', 200, 'Article'], ['/gone-quiet', 200, ''], ['/products/widget', 200, 'Product'], ['/still-200', 200, ''], ['/rl-gone', 200, ''], ['/gone-403', 200, ''], ['/dead', 404, '']])
      sn.run('c1', K(p), '2026-08-01 01:00:00', st, st === 200 ? 1 : 0, types);
    for (const p of ['/gone-article', '/gone-quiet', '/gone-new', '/products/widget']) sn.run('c2', K(p), '2026-09-01 01:00:00', 404, 0, '');

    // Equity: GSC (with one mixed-shape day for /gone-article), internal links, backlinks.
    const sa = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,0,5)`);
    for (let k = 0; k < 20; k++) sa.run(day(k), 'filler', `${W}/live`, K('/live'), '', '', 1, 10);
    sa.run(day(30), 'deep thing', `${W}/old-deep`, K('/old-deep'), '', '', 5, 40);
    sa.run(day(30), 'temp thing', `${W}/temp-traffic`, K('/temp-traffic'), '', '', 0, 50);
    sa.run(day(30), 'perm thing', `${W}/perm-traffic`, K('/perm-traffic'), '', '', 4, 50);
    sa.run(day(30), 'off thing', `${W}/temp-offsite`, K('/temp-offsite'), '', '', 4, 50);
    sa.run(day(30), 'home', `${W}/`, K('/'), '', '', 9, 90);
    sa.run(day(40), 'article', `${W}/gone-article`, K('/gone-article'), '', '', 3, 30);
    // Same day, segmented shape: since #65 it lives in search_analytics_segments and never adds to totals.
    db.prepare(`INSERT INTO search_analytics_segments (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?,?,0,5)`)
      .run(day(40), 'article', `${W}/gone-article`, K('/gone-article'), 'MOBILE', 'gbr', 3, 30);
    sa.run(day(40), 'quiet', `${W}/gone-quiet`, K('/gone-quiet'), '', '', 0, 2); // below the impressions floor
    sa.run(day(40), 'gone 403', `${W}/gone-403`, K('/gone-403'), '', '', 9, 90);
    const ln = db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,anchor_text,is_internal,placement) VALUES ('c2',?,?,?,?,'x',1,'body')`);
    ln.run(`${W}/live`, K('/live'), `${W}/temp-inlinks`, K('/temp-inlinks'));
    ln.run(`${W}/live`, K('/live'), `${W}/account`, K('/account'));
    ln.run(`${W}/live`, K('/live'), `${W}/old-offsite`, K('/old-offsite'));
    ln.run(`${W}/temp-quiet`, K('/temp-quiet'), `${W}/temp-quiet`, K('/temp-quiet')); // a self-link is not equity
    const bl = db.prepare(`INSERT INTO page_backlinks (url_key,url,backlinks,referring_domains) VALUES (?,?,?,?)`);
    bl.run(K('/old-dead-bl'), `${W}/old-dead-bl`, 4, 2);
    bl.run(K('/temp-backlinks'), `${W}/temp-backlinks`, 2, 1);
    adb.close();
  }

  {
    const adb = new AuditDatabase(dbPathFor(dir, SITE));
    const db = adb.db;

    const ni = runCheck(db, 'redirect-to-non-indexable');
    check('redirect-to-non-indexable: noindex, canonicalised and 404 targets fire', JSON.stringify(paths(ni)) === JSON.stringify(['/old-canon', '/old-dead', '/old-noidx']), JSON.stringify(paths(ni)));
    const canon = ni.find(f => f.urlKey === K('/old-canon'));
    check('redirect-to-non-indexable: evidence names the reason, final URL and where it canonicalises to', canon?.evidence.finalReason === 'canonicalised' && canon.evidence.finalCanonicalisesTo === K('/live') && canon.evidence.finalUrl === `${W}/canon`, JSON.stringify(canon?.evidence));
    check('redirect-to-non-indexable: backlinked source to a 404 left to backlinks-to-404; rate-limited, legacy 429, PDF, live, uncrawled, off-site, account and same-key http->https targets do not fire',
      !['/old-dead-bl', '/old-rl', '/old-429', '/old-pdf', '/old-live', '/old-uncrawled', '/old-offsite', '/account', '/dead-norm'].some(p => paths(ni).includes(p)));

    const hp = runCheck(db, 'redirect-to-homepage');
    check('redirect-to-homepage: deep URLs to "/" fire, the one with clicks first', JSON.stringify(hp.map(f => f.urlKey.replace(/^https?:\/\/[^/]+/, ''))) === JSON.stringify(['/old-deep', '/old-deep-quiet']), JSON.stringify(paths(hp)));
    check('redirect-to-homepage: equity carried (5 clicks) and hadEquity flags it', hp[0]?.evidence.equity.gsc.clicks === 5 && hp[0].evidence.hadEquity === true && hp[1]?.evidence.hadEquity === false, JSON.stringify(hp[0]?.evidence.equity));
    check('redirect-to-homepage: /index.html, a locale root (/en) and a home URL with a query do not fire', !paths(hp).some(p => ['/index.html', '/en', '/old-deep-query'].includes(p)));

    const loop = runCheck(db, 'redirect-loop');
    const la = loop.find(f => f.urlKey === K('/loopa')), cap = loop.find(f => f.urlKey === K('/cap1'));
    check('redirect-loop: a revisiting chain (loop) and a 5-hop unresolved chain (hop-cap) fire', loop.length === 2 && la?.evidence.kind === 'loop' && la.evidence.revisits === `${W}/loopa` && cap?.evidence.kind === 'hop-cap' && cap.evidence.lastStatus === 302, JSON.stringify(loop.map(f => f.evidence)));
    check('redirect-loop: the off-site auth bounce does not fire', !loop.some(f => f.urlKey.includes('customer_authentication')));

    const chain = runCheck(db, 'redirect-chain');
    check('redirect-chain (extended): the resolved internal 2-hop chain recorded on its final page', JSON.stringify(paths(chain)) === JSON.stringify(['/norm2']), JSON.stringify(paths(chain)));
    check('redirect-chain (extended): keyed by the FINAL page (what fix_finding reads), with the hop list', chain[0]?.evidence.chain.length === 2 && chain[0].evidence.source === 'http://www.example.test/norm2' && chain[0].evidence.hops === 2, JSON.stringify(chain[0]?.evidence));
    check('redirect-chain (extended): loops, hop-cap chains and the off-site login bounce are not chains', !paths(chain).some(p => ['/loopa', '/cap1'].includes(p) || p.includes('customer_authentication')));

    const tmpr = runCheck(db, 'temporary-redirect-with-equity');
    check('temporary-redirect-with-equity: 302 with impressions, 307 with an internal link, 303 with backlinks', JSON.stringify(paths(tmpr)) === JSON.stringify(['/temp-backlinks', '/temp-inlinks', '/temp-traffic']), JSON.stringify(paths(tmpr)));
    check('temporary-redirect-with-equity: ordered backlinks (2) before impressions-only; equity evidence present', tmpr[0]?.urlKey === K('/temp-backlinks') && tmpr.find(f => f.urlKey === K('/temp-traffic')).evidence.equity.gsc.impressions === 50 && tmpr.find(f => f.urlKey === K('/temp-inlinks')).evidence.equity.internalInlinks === 1, JSON.stringify(tmpr.map(f => [f.urlKey, f.evidence.equity])));
    check('temporary-redirect-with-equity: no-equity 302, a 301, the homepage geo 302, off-site, account and hop-cap 302s do not fire', !paths(tmpr).some(p => ['/temp-quiet', '/perm-traffic', '/', '/temp-offsite', '/account', '/cap1'].includes(p)));

    const ret = runCheck(db, 'redirect-retired');
    check('redirect-retired: 200 in the earlier crawl, 404 now, with clicks', ret.length === 1 && ret[0].urlKey === K('/gone-article') && ret[0].evidence.lastSeen200.crawlId === 'c1' && ret[0].evidence.status === 404, JSON.stringify(ret));
    check('redirect-retired: a mixed-shape GSC day is counted once (3 clicks, not 6)', ret[0]?.evidence.equity.gsc.clicks === 3, JSON.stringify(ret[0]?.evidence.equity));
    check('redirect-retired: no equity (410, 2 impressions), new 404, product URL, 403, rate-limited, still-200 and always-404 do not fire', !['/gone-quiet', '/gone-new', '/products/widget', '/gone-403', '/rl-gone', '/still-200', '/dead'].some(p => paths(ret).includes(p)));
    adb.close();

    // The whole engine: findings stored; the auth-bounce redirect-chain false positives gone.
    const audit = runAudit(dir, SITE, {});
    const ids = audit.byCheck.map(b => b.checkId);
    check('run_audit: all five new checks stored', IDS.every(id => ids.includes(id)), JSON.stringify(ids));
    const adb2 = new AuditDatabase(dbPathFor(dir, SITE));
    const stored = adb2.db.prepare(`SELECT check_id, url_key FROM findings WHERE run_id=? AND check_id='redirect-chain'`).all(audit.runId);
    adb2.close();
    check('run_audit: redirect-chain stores 1 finding (the off-site auth bounce row with 2 hops no longer counts)', stored.length === 1, JSON.stringify(stored));
  }

  // ── 3. Missing data = no finding; registry entries complete ──────────────────────────────────
  {
    const dir2 = tmp('sac-redir-empty-');
    const adb = new AuditDatabase(dbPathFor(dir2, SITE));
    const n = [...IDS, 'redirect-chain'].map(id => runCheck(adb.db, id).length);
    check('empty property: every redirect check returns nothing', n.every(x => x === 0), JSON.stringify(n));
    adb.close();
    const bad = IDS.filter(id => { const c = CHECKS.find(x => x.id === id); return !c || !c.category || !c.labels?.length || c.certainty !== 1 || !c.title || !c.fix || CHECKS.filter(x => x.id === id).length !== 1; });
    check('registry: the five redirect checks registered once, complete, deterministic', bad.length === 0, JSON.stringify(bad));
  }

  // ── 4. End to end: crawl a local server, then the checks read what the crawler recorded ───────
  {
    let origin = '';
    const html = (body, head = '') => `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}<p>${'word '.repeat(80)}</p></body></html>`;
    const server = http.createServer((req, res) => {
      const go = (status, to) => { res.writeHead(status, { location: to }); res.end(); };
      const u = req.url;
      if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html(['/a-loop', '/chain1', '/temp', '/old-home', '/noidx-src', '/final'].map(h => `<a href="${h}">${h}</a>`).join(' '))); }
      if (u === '/a-loop') return go(301, '/b-loop');
      if (u === '/b-loop') return go(301, '/a-loop');
      if (u === '/chain1') return go(301, '/chain2');
      if (u === '/chain2') return go(301, '/chain-end'); // reached only through the chain, so its row records it
      if (u === '/temp') return go(302, '/final');
      if (u === '/old-home') return go(301, '/');
      if (u === '/noidx-src') return go(301, '/noidx');
      if (u === '/noidx') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html('hidden', '<meta name="robots" content="noindex">')); }
      if (u === '/final' || u === '/chain-end') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html('final')); }
      res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>404</h1>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
    const site = `${origin}/`;
    const dir3 = tmp('sac-redir-crawl-');
    try {
      await new Crawler(dir3).run(site, { maxPages: 20, delayMs: 0, checkExternal: false }, () => {}, new AbortController().signal);
      const adb = new AuditDatabase(dbPathFor(dir3, site));
      const p = (fs) => fs.map(f => f.urlKey.replace(/^https?:\/\/[^/]+/, '')).sort(); // url_key forces https
      const got = (id) => JSON.stringify(p(runCheck(adb.db, id)));
      check('crawl -> redirect-loop: /a-loop (301 back and forth)', got('redirect-loop') === JSON.stringify(['/a-loop']), got('redirect-loop'));
      check('crawl -> redirect-chain: /chain1 -> /chain2 -> /chain-end (2 hops, on the final page)', got('redirect-chain') === JSON.stringify(['/chain-end']), got('redirect-chain'));
      check('crawl -> temporary-redirect-with-equity: /temp (302, linked from /)', got('temporary-redirect-with-equity') === JSON.stringify(['/temp']), got('temporary-redirect-with-equity'));
      check('crawl -> redirect-to-homepage: /old-home', got('redirect-to-homepage') === JSON.stringify(['/old-home']), got('redirect-to-homepage'));
      check('crawl -> redirect-to-non-indexable: /noidx-src (lands on noindex)', got('redirect-to-non-indexable') === JSON.stringify(['/noidx-src']), got('redirect-to-non-indexable'));
      adb.close();
    } finally { server.close(); }
  }

  // ── 5. Redirect hops are checked BEFORE they are requested ────────────────────────────────────
  // An internal link 302-ing to another host (here `localhost` on a second port, standing in for
  // 169.254.169.254 or a 10.x service) must never be requested, and a 301 into a robots-disallowed
  // path must not fetch that path. Following first and checking the final URL afterwards did both.
  {
    const otherHits = [];
    const other = http.createServer((req, res) => { otherHits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>INTERNAL</title>'); });
    await new Promise(r => other.listen(0, '127.0.0.1', r));
    const siteHits = [];
    const server = http.createServer((req, res) => {
      siteHits.push(req.url);
      const u = req.url;
      if (u === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /private/\n'); }
      if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>Home</title></head><body><a href="/go-private">a</a> <a href="/go-elsewhere">b</a></body></html>'); }
      if (u === '/go-private') { res.writeHead(301, { location: '/private/secret' }); return res.end(); }
      if (u === '/go-elsewhere') { res.writeHead(302, { location: `http://localhost:${other.address().port}/latest/meta-data/` }); return res.end(); }
      if (u.startsWith('/private/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>PRIVATE</title>'); }
      res.writeHead(404, { 'content-type': 'text/html' }); res.end('nf');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const site = `http://127.0.0.1:${server.address().port}/`;
    const dir5 = tmp('sac-redir-hops-');
    try {
      await new Crawler(dir5).run(site, { maxPages: 20, delayMs: 0, maxConcurrency: 1, checkExternal: false, siteProbes: false }, () => {}, new AbortController().signal);
      const adb = new AuditDatabase(dbPathFor(dir5, site));
      const row = (p) => adb.db.prepare(`SELECT status_code, indexable_reason, title FROM pages WHERE url LIKE ?`).get(`%${p}`);
      check('redirect hop to another host is never requested', otherHits.length === 0, JSON.stringify(otherHits));
      check('redirect hop into a robots-disallowed path is never requested', !siteHits.some(u => u.startsWith('/private/')), JSON.stringify(siteHits));
      const priv = row('/private/secret');
      check('the disallowed target is recorded as robots-disallowed, not as a fetched page', priv?.indexable_reason === 'robots-disallowed' && priv?.status_code == null && priv?.title == null, JSON.stringify(priv));
      const src = row('/go-private'), out = row('/go-elsewhere');
      check('both sources are stored as redirects (301, 302)', src?.status_code === 301 && src?.indexable_reason === 'redirect' && out?.status_code === 302 && out?.indexable_reason === 'redirect', JSON.stringify([src, out]));
      adb.close();
    } finally { server.close(); other.close(); }
  }

  // ── 6. robots.txt per RFC 9309 (review/11) ───────────────────────────────────────────────────
  {
    const r = (txt) => rulesFromText(txt, 'seo-audit-console');
    const pdf = r('User-agent: *\nDisallow: /*.pdf$\n');
    check('`*` and `$`: /*.pdf$ blocks /file.pdf and /a/b.pdf, not /file.pdfx or /file.pdf?x=1', !pdf.isAllowed('/file.pdf') && !pdf.isAllowed('/a/b.pdf') && pdf.isAllowed('/file.pdfx') && pdf.isAllowed('/file.pdf?x=1'));
    const star = r('User-agent: *\nDisallow: /private*\nDisallow: /*/admin/\n');
    check('`*` inside a pattern: /private* and /*/admin/', !star.isAllowed('/private-area') && !star.isAllowed('/shop/admin/users') && star.isAllowed('/admin/') && star.isAllowed('/public'));
    const q = r('User-agent: *\nDisallow: /search?q=\n');
    check('patterns match the query string too: /search?q= blocks /search?q=x, not /search', !q.isAllowed('/search?q=x') && q.isAllowed('/search'));
    const root = r('User-agent: *\nAllow: /$\nDisallow: /\n');
    check('Allow: /$ with Disallow: / allows the homepage only', root.isAllowed('/') && !root.isAllowed('/page'));
    const tie = r('User-agent: *\nDisallow: /a\nAllow: /a\n');
    check('Allow wins a tie; robots.txt itself is always allowed', tie.isAllowed('/a') && r('User-agent: *\nDisallow: /\n').isAllowed('/robots.txt'));
    check('`User-agent: bot` does not name Googlebot (no substring match)', JSON.stringify(robotsVerdict('User-agent: bot\nDisallow: /\n', 'Googlebot')) === '{"named":false,"allowed":true}');
    check('`User-agent: Googlebot/2.1` names googlebot (product token, any case)', JSON.stringify(robotsVerdict('User-agent: Googlebot/2.1\nDisallow: /\n', 'googlebot')) === '{"named":true,"allowed":false}');
  }

  // ── 7. An unreachable robots.txt stops the crawl before it writes; site probes obey robots.txt ──────
  {
    let robotsStatus = 200;
    let robotsBody = 'User-agent: *\nAllow: /\n';
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url === '/robots.txt') { res.writeHead(robotsStatus, { 'content-type': 'text/plain' }); return res.end(robotsBody); }
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>Home</title></head><body><a href="/a">a</a></body></html>'); }
      if (req.url === '/a') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>A</title></head><body>a</body></html>'); }
      res.writeHead(404, { 'content-type': 'text/html' }); res.end('nf');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const site = `http://127.0.0.1:${server.address().port}/`;
    const dir7 = tmp('sac-robots-');
    const crawl = (o = {}) => new Crawler(dir7).run(site, { maxPages: 10, delayMs: 0, maxConcurrency: 1, checkExternal: false, siteProbes: false, ...o }, () => {}, new AbortController().signal);
    const pages = () => { const a = new AuditDatabase(dbPathFor(dir7, site)); try { return a.db.prepare(`SELECT COUNT(*) n FROM pages WHERE status_code = 200`).get().n; } finally { a.close(); } };
    try {
      await crawl();
      check('a crawl with a reachable robots.txt stores its pages', pages() === 2, String(pages()));
      robotsStatus = 503;
      hits.length = 0;
      let err = null;
      try { await crawl(); } catch (e) { err = e; }
      check('robots.txt answering 503: the crawl stops and says why (RFC 9309: unreachable = disallow all)', /robots\.txt was unreachable \(HTTP 503\)/.test(err?.message ?? ''), String(err?.message));
      check('nothing but robots.txt was requested, and the previous crawl\'s pages are untouched', hits.every(h => h === '/robots.txt') && pages() === 2, JSON.stringify({ hits, pages: pages() }));
      robotsStatus = 404;
      await crawl();
      check('robots.txt answering 404 (none): the site is crawled', pages() === 2);
      robotsStatus = 200; robotsBody = 'User-agent: seo-audit-console\nDisallow: /\n';
      hits.length = 0;
      await crawl({ siteProbes: true });
      check('site probes never request a path robots.txt disallows', !hits.some(h => /seo-audit-probe|^\/a$/.test(h)), JSON.stringify(hits));
    } finally { server.close(); }
  }
} catch (e) {
  fail++;
  console.log(`FAIL  probe threw :: ${e?.stack ?? e}`);
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch (e) { console.log(`  (cleanup: ${e.code} on ${d})`); } }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
