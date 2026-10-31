// Regression test for the external-link pass + checks (#36) against a local "external" server on
// a second loopback address. Run: node scripts/probe-external.mjs (after build:server)
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { checkExternalLinks } from '../dist/core/externalLinks.js';
import { allowPrivateAddressesForTests } from '../dist/core/netGuard.js';
// Local 127.0.0.1 servers stand in for third-party hosts here; the SSRF guard (netGuard.ts) would refuse them.
allowPrivateAddressesForTests(true);
import { CHECKS } from '../dist/audit/checks.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const hits = [];
let X = '';
const ext = http.createServer((req, res) => {
  const p = new URL(req.url, X).pathname;
  hits.push(`${req.method} ${p} ${Date.now()}`);
  if (p === '/ok') { res.writeHead(200); return res.end('ok'); }
  if (p === '/gone') { res.writeHead(404); return res.end(); }
  if (p === '/moved') { res.writeHead(301, { location: `${X}/new` }); return res.end(); }
  if (p === '/new' || p === '/') { res.writeHead(200); return res.end('x'); }
  if (p === '/product-removed') { res.writeHead(301, { location: `${X}/` }); return res.end(); }
  if (p === '/head-hater') { if (req.method === 'HEAD') { res.writeHead(405); return res.end(); } res.writeHead(206, { 'content-range': 'bytes 0-0/10' }); return res.end('x'); }
  if (p === '/bot') { res.writeHead(403, { server: 'cloudflare' }); return res.end(); }
  if (p === '/range-hater') { if (req.method === 'HEAD') { res.writeHead(405); return res.end(); } if (req.headers.range) { res.writeHead(416); return res.end(); } res.writeHead(200); return res.end('x'); }
  if (p === '/no-location') { res.writeHead(302); return res.end(); }
  if (p === '/hang') return; // never answers
  res.writeHead(500); res.end();
});
await new Promise(r => ext.listen(0, '127.0.0.2', r));
X = `http://127.0.0.2:${ext.address().port}`;

// A real closed port: bind, note it, close (port 1 is on fetch's blocked-port list).
const closed = await new Promise(r => { const t = http.createServer(); t.listen(0, '127.0.0.3', () => { const p = t.address().port; t.close(() => r(p)); }); });
const REFUSED = `http://127.0.0.3:${closed}/refused`;
const dbPath = path.join(tmpdir(), `sac-ext-${process.pid}.db`);
rmSync(dbPath, { force: true });
const w = new AuditDatabase(dbPath);
const db = w.db;
const S = 'https://site.example';
db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status) VALUES ('c1','${S}','site.example','completed')`).run();
db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,external_links) VALUES ('c1',?,?,200,1,9)`).run(`${S}/a`, `${S}/a`);
db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable,external_links) VALUES ('c1',?,?,200,1,1)`).run(`${S}/b`, `${S}/b`);
const link = db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,anchor_text,is_internal) VALUES ('c1',?,?,?,?,?,0)`);
const targets = ['/ok', '/gone', '/moved', '/product-removed', '/head-hater', '/bot', '/hang', '/range-hater', '/no-location'].map(p => X + p);
for (const t of targets) link.run(`${S}/a`, `${S}/a`, t, t, `anchor ${t.split('/').pop()}`);
link.run(`${S}/b`, `${S}/b`, `${X}/gone`, `${X}/gone`, 'same dead link');
link.run(`${S}/a`, `${S}/a`, REFUSED, REFUSED, 'refused host');

try {
  const t0 = Date.now();
  const sum = await checkExternalLinks(db, { userAgent: 'probe', perHostDelayMs: 100, timeoutMs: 1500 });
  const st = Object.fromEntries(db.prepare(`SELECT url, verdict, status, error, method, permanent FROM external_link_status`).all().map(r => [r.url.replace(X, '').replace(`http://127.0.0.3:${closed}`, ''), r]));
  check('distinct targets checked once each', sum.targets === 10 && sum.checked === 10, JSON.stringify(sum));
  check('416 on the ranged GET → plain GET → ok', st['/range-hater']?.verdict === 'ok', JSON.stringify(st['/range-hater']));
  check('3xx without Location → broken, not ok', st['/no-location']?.verdict === 'broken' && st['/no-location'].error.includes('Location'), JSON.stringify(st['/no-location']));
  check('200 → ok', st['/ok']?.verdict === 'ok', JSON.stringify(st['/ok']));
  check('404 → broken', st['/gone']?.verdict === 'broken' && st['/gone'].status === 404, JSON.stringify(st['/gone']));
  check('301 deep link → redirected, permanent', st['/moved']?.verdict === 'redirected' && st['/moved'].permanent === 1, JSON.stringify(st['/moved']));
  check('HEAD rejected (405) → ranged GET fallback succeeds', st['/head-hater']?.verdict === 'ok' && st['/head-hater'].method === 'GET', JSON.stringify(st['/head-hater']));
  check('Cloudflare 403 → unverifiable, not broken', st['/bot']?.verdict === 'unverifiable', JSON.stringify(st['/bot']));
  check('hung request → broken (timeout)', st['/hang']?.verdict === 'broken' && st['/hang'].error === 'timeout', JSON.stringify(st['/hang']));
  check('refused host → broken (connection refused)', st['/refused']?.verdict === 'broken' && st['/refused'].error === 'connection refused', JSON.stringify(st['/refused']));
  const extHits = hits.map(h => Number(h.split(' ')[2])).sort((a, b) => a - b);
  check('one host is paced, not hammered', extHits.length >= 7 && Date.now() - t0 >= 600, `${extHits.length} hits in ${Date.now() - t0}ms`);

  const again = await checkExternalLinks(db, { userAgent: 'probe', perHostDelayMs: 0, timeoutMs: 1500 });
  check('re-run inside the cache window re-checks nothing', again.checked === 0 && again.cached === 10, JSON.stringify(again));

  const ctx = { db, gscMaxDate: null };
  const broken = Object.fromEntries(CHECKS.find(c => c.id === 'external-broken').run(ctx).map(f => [f.urlKey.replace(S, ''), f.evidence]));
  check('external-broken: per linking page, counts dead links (not bot walls)', broken['/a']?.broken === 4 && broken['/b']?.broken === 1 && !JSON.stringify(broken).includes('/bot'), JSON.stringify(broken));
  check('external-broken evidence carries status/error and anchor', broken['/a'].examples.some(e => e.status === 404 && e.anchor === 'anchor gone') && broken['/a'].examples.some(e => e.status === 'timeout'), JSON.stringify(broken['/a']));
  const red = CHECKS.find(c => c.id === 'external-redirected').run(ctx);
  check('external-redirected flags the homepage redirect as likely removed', red.length === 1 && red[0].evidence.redirected === 2 && red[0].evidence.toHomepage === 1, JSON.stringify(red));
} finally {
  ext.close(); w.close(); rmSync(dbPath, { force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
