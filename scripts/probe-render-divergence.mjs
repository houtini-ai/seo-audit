// #55 group E, item 9: canonical-changed-by-js, title-changed-by-js, noindex-changed-by-js and
// hydration-content-loss, plus schema-only-rendered (1.0.8). Pure cases (mainWordCount, the raw-vs-rendered diff on canned HTML), the
// checks over canned render_audit rows (current and pre-0.16.0 rows, and the not-collected notes), then
// one real render of a local server's pages in headless Chromium when Playwright and its browser are
// installed (skipped cleanly otherwise). No network beyond 127.0.0.1.
// Run: node scripts/probe-render-divergence.mjs (after npm run build:server)
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { hostFormForProperty } from '../dist/core/url-key.js';
import { extractPage } from '../dist/core/extract.js';
import { CHECKS } from '../dist/audit/checks.js';
import { runAudit } from '../dist/audit/engine.js';
import { gscFreshness } from '../dist/core/gscFreshness.js';
import { mainWordCount, diffRawVsRendered, auditRender, schemaTypeList } from '../dist/core/renderAudit.js';
import { rendererAvailable, renderHtml, closeRenderer } from '../dist/core/render.js';
import { HYDRATION_MIN_RAW_WORDS, HYDRATION_MAX_RATIO } from '../dist/audit/checks-render.js';

process.env.SAC_AUTOSERVE = '0';
let pass = 0, fail = 0, skipped = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const skip = (name, why) => { skipped++; console.log(`skip  ${name} :: ${why}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
const ctxOf = (db) => ({ db, gscMaxDate: gscFreshness(db).effectiveMax, brand: null });
const chk = (id) => CHECKS.find(c => c.id === id);
const runCheck = (db, id) => chk(id).run(ctxOf(db));
const noteOf = (db, id) => chk(id).collected(ctxOf(db));
const IDS = ['canonical-changed-by-js', 'title-changed-by-js', 'noindex-changed-by-js', 'hydration-content-loss', 'schema-only-rendered'];
const W = (n) => 'word '.repeat(n).trim();
const KO = { hostForm: 'apex' };

try {
  // ── 1. Main-content words ─────────────────────────────────────────────────────────────────
  {
    check('mainWordCount: <main> only; scripts/styles dropped', mainWordCount(`<body><nav>${W(50)}</nav><main><p>${W(10)}</p><script>var a=1</script><style>p{}</style></main><footer>${W(30)}</footer></body>`) === 10);
    check('mainWordCount: [role=main] when there is no <main>', mainWordCount(`<body><div role="main">${W(7)}</div><div>${W(40)}</div></body>`) === 7);
    check('mainWordCount: no main -> body minus nav/header/footer/aside', mainWordCount(`<body><header>${W(5)}</header><nav>${W(5)}</nav><div>${W(12)}</div><aside>${W(9)}</aside><footer>${W(5)}</footer></body>`) === 12);
    check('mainWordCount: empty main is 0', mainWordCount('<body><main></main><p>x</p></body>') === 0);
  }

  // ── 2. The diff on canned raw vs rendered HTML ────────────────────────────────────────────
  {
    const url = 'https://example.test/p';
    const raw = `<html><head><title>Server</title><link rel="canonical" href="/p"><meta name="robots" content="noindex"></head><body><main>${W(300)}</main></body></html>`;
    const ren = `<html><head><title>Client</title><link rel="canonical" href="https://example.test/other"></head><body><main>${W(20)}</main></body></html>`;
    const d = diffRawVsRendered(extractPage(raw, url, 'example.test', KO), extractPage(ren, url, 'example.test', KO), { raw, rendered: ren });
    check('diff: title, canonical (absolute both sides), noindex removed, main words', d.titleChanged && d.canonicalChanged && d.rawCanonical === 'https://example.test/p' && d.renderedCanonical === 'https://example.test/other'
      && d.rawNoindex === true && d.renderedNoindex === false && d.robotsChanged && d.rawRobots === 'noindex' && d.renderedRobots === null && d.rawMainWords === 300 && d.renderedMainWords === 20, JSON.stringify(d));
    const hdr = diffRawVsRendered(extractPage(raw, url, 'example.test', KO, 'noindex'), extractPage(ren, url, 'example.test', KO, 'noindex'));
    check('diff: an X-Robots-Tag noindex holds on both sides, so JS removing the meta is no change; no HTML -> main words null', hdr.rawNoindex && hdr.renderedNoindex && !hdr.robotsChanged && hdr.rawMainWords === null);
    const slash = diffRawVsRendered(extractPage('<link rel="canonical" href="https://example.test/p/">', url, 'example.test', KO), extractPage('<link rel="canonical" href="https://example.test/p">', url, 'example.test', KO));
    check('diff: a trailing-slash-only canonical difference is not a change', !slash.canonicalChanged);
    const LD = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
    const sRaw = `<html><head>${LD({ '@context': 'https://schema.org', '@type': 'WebPage', mainEntity: { '@type': 'Article' } })}</head><body></body></html>`;
    const sRen = `<html><head>${LD({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': ['Product', 'https://schema.org/Thing'] }] })}</head><body></body></html>`;
    const sd = diffRawVsRendered(extractPage(sRaw, url, 'example.test', KO), extractPage(sRen, url, 'example.test', KO));
    check('diff: JSON-LD types on both sides (nested own edges, @graph, array @type, prefix stripped)', same(sd.rawSchemaTypes, ['article', 'webpage']) && same(sd.renderedSchemaTypes, ['product', 'thing', 'webpage']), JSON.stringify([sd.rawSchemaTypes, sd.renderedSchemaTypes]));
    check('schemaTypeList: no JSON-LD -> []; offers/brand are not walked', same(schemaTypeList(null), []) && same(schemaTypeList(JSON.stringify([JSON.stringify({ '@type': 'Product', brand: { '@type': 'Brand' } })])), ['product']));
  }

  // ── 3. Checks over canned render_audit rows ───────────────────────────────────────────────
  {
    const site = 'sc-domain:example.test';
    const dir = tmp('sac-render-');
    const adb = new AuditDatabase(dbPathFor(dir, site));
    adb.upsertProperty(site, hostFormForProperty(site));
    const db = adb.db;
    for (const id of IDS) check(`not collected while render_audit is empty: ${id}`, /render_audit is empty/.test(noteOf(db, id) ?? ''));
    const ins = db.prepare(`INSERT INTO render_audit (url_key, raw_word_count, rendered_word_count, raw_internal_links, rendered_internal_links, links_only_rendered, title_changed, raw_title, rendered_title, canonical_changed,
      raw_canonical, rendered_canonical, raw_robots, rendered_robots, x_robots_tag, raw_noindex, rendered_noindex, robots_changed, raw_main_words, rendered_main_words, raw_status)
      VALUES (@k, @rw, @dw, 0, 0, 0, @tc, @rt, @dt, @cc, @rc, @dc, @rr, @dr, @xrt, @rn, @dn, @rch, @rm, @dm, 200)`);
    const row = (k, o = {}) => ins.run({ k: `https://example.test/${k}`, rw: 400, dw: 400, tc: 0, rt: 't', dt: 't', cc: 0, rc: `https://example.test/${k}`, dc: `https://example.test/${k}`, rr: null, dr: null, xrt: null, rn: 0, dn: 0, rch: 0, rm: 300, dm: 300, ...o });
    row('stable');
    row('title', { tc: 1, rt: 'Server title', dt: 'Client title' });
    row('title-wiped', { tc: 1, rt: 'Server title', dt: '' });
    row('title-only-js', { tc: 1, rt: '', dt: 'Client title' });            // content-only-in-rendered-dom's, not this check
    row('canon', { cc: 1, rc: 'https://example.test/canon', dc: 'https://example.test/other' });
    row('canon-added', { cc: 1, rc: null, dc: 'https://example.test/canon-added' });
    row('canon-removed', { cc: 1, rc: 'https://example.test/canon-removed', dc: null });
    row('noidx-removed', { rr: 'noindex', rn: 1, dn: 0, rch: 1 });
    row('noidx-added', { dr: 'noindex,follow', rn: 0, dn: 1, rch: 1 });
    row('noidx-header', { rr: 'noindex', xrt: 'noindex', rn: 1, dn: 1, rch: 0 });  // header holds: no change
    row('hydrate', { rm: 400, dm: 40 });
    row('hydrate-edge', { rm: 400, dm: 200 });                              // exactly 50%: fires
    row('hydrate-ok', { rm: 400, dm: 201 });                                // just over 50%: no
    row('hydrate-short', { rm: HYDRATION_MIN_RAW_WORDS - 1, dm: 0 });       // too short to judge
    // A pre-0.16.0 row: only the old columns.
    db.prepare(`INSERT INTO render_audit (url_key, raw_word_count, rendered_word_count, title_changed, raw_title, rendered_title, canonical_changed) VALUES ('https://example.test/legacy', 500, 100, 0, 't', 't', 1)`).run();
    const keys = (id) => runCheck(db, id).map(f => f.urlKey.replace('https://example.test/', '')).sort();
    const ev = (id, k) => runCheck(db, id).find(f => f.urlKey === `https://example.test/${k}`)?.evidence;
    check('canonical-changed-by-js: changed, added, removed, and the legacy row', same(keys('canonical-changed-by-js'), ['canon', 'canon-added', 'canon-removed', 'legacy']), JSON.stringify(keys('canonical-changed-by-js')));
    check('canonical-changed-by-js: kinds and values; the legacy row says re-run', ev('canonical-changed-by-js', 'canon').kind === 'changed-by-js' && ev('canonical-changed-by-js', 'canon').renderedCanonical === 'https://example.test/other'
      && ev('canonical-changed-by-js', 'canon-added').kind === 'added-by-js' && ev('canonical-changed-by-js', 'canon-removed').kind === 'removed-by-js'
      && /re-run render_pages/.test(ev('canonical-changed-by-js', 'legacy').kind) && ev('canonical-changed-by-js', 'legacy').rawCanonical === undefined && !!ev('canonical-changed-by-js', 'canon').rule);
    check('title-changed-by-js: changed and wiped; a title only after JS is not this check', same(keys('title-changed-by-js'), ['title', 'title-wiped']) && ev('title-changed-by-js', 'title-wiped').kind === 'removed-by-js');
    check('noindex-changed-by-js: both directions; a header noindex is no change', same(keys('noindex-changed-by-js'), ['noidx-added', 'noidx-removed'])
      && ev('noindex-changed-by-js', 'noidx-removed').kind === 'noindex-removed-by-js' && ev('noindex-changed-by-js', 'noidx-added').kind === 'noindex-added-by-js');
    check(`hydration-content-loss: <= ${HYDRATION_MAX_RATIO * 100}% of >= ${HYDRATION_MIN_RAW_WORDS} raw main words; the legacy row on whole-body words`, same(keys('hydration-content-loss'), ['hydrate', 'hydrate-edge', 'legacy'])
      && ev('hydration-content-loss', 'hydrate').lostPct === 90 && ev('hydration-content-loss', 'hydrate').basis === 'main content' && /whole body/.test(ev('hydration-content-loss', 'legacy').basis), JSON.stringify(keys('hydration-content-loss')));
    check('schema-only-rendered: rows from before 1.0.8 -> says re-run', /predates 1.0.8/.test(noteOf(db, 'schema-only-rendered') ?? '') && runCheck(db, 'schema-only-rendered').length === 0);
    const sset = db.prepare(`UPDATE render_audit SET raw_schema_types = ?, rendered_schema_types = ? WHERE url_key = ?`);
    for (const k of ['stable', 'title', 'canon', 'hydrate']) sset.run('["organization","website"]', '["organization","website"]', `https://example.test/${k}`);
    sset.run('["webpage"]', '["product","webpage"]', 'https://example.test/title-wiped');      // added by JS
    sset.run('["faqpage","webpage"]', '["webpage"]', 'https://example.test/canon-added');      // removed by JS
    sset.run('["article"]', '["newsarticle"]', 'https://example.test/canon-removed');          // changed
    sset.run('[]', '["product"]', 'https://example.test/hydrate-ok');                        // differs, but the raw fetch was blocked:
    db.prepare(`UPDATE render_audit SET raw_status = 403 WHERE url_key = 'https://example.test/hydrate-ok'`).run(); // not a finding
    check('schema-only-rendered: added, removed and changed; identical sets are not findings', same(keys('schema-only-rendered'), ['canon-added', 'canon-removed', 'title-wiped']), JSON.stringify(keys('schema-only-rendered')));
    const sa = ev('schema-only-rendered', 'title-wiped'), sr = ev('schema-only-rendered', 'canon-added'), sc = ev('schema-only-rendered', 'canon-removed');
    check('schema-only-rendered: kinds, the types each way, rich-result types named', sa.kind === 'added-by-js' && same(sa.onlyAfterJs, ['product']) && same(sa.richResultTypes, ['product'])
      && sr.kind === 'removed-by-js' && same(sr.removedByJs, ['faqpage']) && /lost/.test(sr.note) && sc.kind === 'changed-by-js' && same(sc.onlyAfterJs, ['newsarticle']) && same(sc.removedByJs, ['article']) && !!sa.rule, JSON.stringify({ sa, sr, sc }));
    check('collected() null with current rows', IDS.every(id => noteOf(db, id) === null));
    db.exec(`DELETE FROM render_audit WHERE raw_noindex IS NOT NULL`);
    check('only pre-0.16.0 rows: noindex-changed-by-js says re-run; the others still read', /predates 0.16.0/.test(noteOf(db, 'noindex-changed-by-js') ?? '') && noteOf(db, 'canonical-changed-by-js') === null);
    adb.close();
    const r = runAudit(dir, site, {});
    check('runAudit: notCollected carries noindex-changed-by-js', (r.notCollected ?? []).some(n => n.checkId === 'noindex-changed-by-js'), JSON.stringify(r.notCollected));
  }

  // ── 4. A real render (Playwright + Chromium), skipped cleanly when absent ─────────────────
  {
    const page = (title, head, body, script) => `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
    const main = `<main><h1>Guide</h1><p>${W(300)}</p></main>`;
    const routes = {
      '/stable': page('Stable', '<link rel="canonical" href="/stable">', main),
      '/title': page('Server title', '<link rel="canonical" href="/title">', main, `document.title = 'Client title';`),
      '/canon': page('Canon', '<link rel="canonical" href="/canon">', main, `document.querySelector('link[rel=canonical]').href = '/somewhere-else';`),
      '/noidx-removed': page('NR', '<meta name="robots" content="noindex"><link rel="canonical" href="/noidx-removed">', main, `document.querySelector('meta[name=robots]').remove();`),
      '/noidx-added': page('NA', '<link rel="canonical" href="/noidx-added">', main, `var m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex'; document.head.appendChild(m);`),
      '/hydrate': page('Hydrate', '<link rel="canonical" href="/hydrate">', main, `document.querySelector('main').innerHTML = '<p>Loading</p>';`),
      '/schema-js': page('Schema', '<link rel="canonical" href="/schema-js">', main, `var s = document.createElement('script'); s.type = 'application/ld+json'; s.textContent = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'X' }); document.head.appendChild(s);`),
    };
    const server = http.createServer((req, res) => {
      const body = routes[req.url];
      if (!body) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const site = `http://127.0.0.1:${server.address().port}/`;
    try {
      let why = null;
      if (!(await rendererAvailable())) why = 'the optional playwright package is not installed';
      else {
        try { await renderHtml(`${site}stable`, 'probe'); } catch (e) { why = `Chromium would not launch (${String(e?.message ?? e).slice(0, 120)})`; }
        finally { await closeRenderer(); }
      }
      if (why) skip('real render', why);
      else {
        const dir = tmp('sac-render-real-');
        const out = await auditRender(dir, site, { urls: Object.keys(routes).map(p => `${site}${p.slice(1)}`), limit: 10 });
        check('real render: every page rendered', out.available && out.audited === Object.keys(routes).length, JSON.stringify({ available: out.available, audited: out.audited }));
        const adb = new AuditDatabase(dbPathFor(dir, site));
        const db = adb.db;
        const k = (p) => `${site}${p.slice(1)}`;
        const got = (id) => runCheck(db, id).map(f => f.urlKey).sort();
        check('real render -> title-changed-by-js: /title only', same(got('title-changed-by-js'), [k('/title')]), JSON.stringify(got('title-changed-by-js')));
        check('real render -> canonical-changed-by-js: /canon only', same(got('canonical-changed-by-js'), [k('/canon')]), JSON.stringify(got('canonical-changed-by-js')));
        check('real render -> noindex-changed-by-js: both directions', same(got('noindex-changed-by-js'), [k('/noidx-added'), k('/noidx-removed')].sort()), JSON.stringify(got('noindex-changed-by-js')));
        check('real render -> hydration-content-loss: /hydrate only', same(got('hydration-content-loss'), [k('/hydrate')]), JSON.stringify(got('hydration-content-loss')));
        check('real render -> schema-only-rendered: /schema-js only, Product added by JS', same(got('schema-only-rendered'), [k('/schema-js')]) && same(runCheck(db, 'schema-only-rendered')[0]?.evidence.onlyAfterJs, ['product']), JSON.stringify(got('schema-only-rendered')));
        const st = db.prepare(`SELECT raw_status s, raw_main_words rm, rendered_main_words dm FROM render_audit WHERE url_key = ?`).get(k('/stable'));
        check('real render -> stored raw status and main words (stable page unchanged)', st.s === 200 && st.rm === st.dm && st.rm >= 300, JSON.stringify(st));
        adb.close();
      }
    } finally { server.close(); await closeRenderer(); }
  }
} catch (e) {
  fail++;
  console.log(`FAIL  probe threw :: ${e?.stack ?? e}`);
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch (e) { console.log(`  (cleanup: ${e.code} on ${d})`); } }
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
