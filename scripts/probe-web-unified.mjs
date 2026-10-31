#!/usr/bin/env node
// The one dashboard's web surface (src/core/webServer.ts + webHandlers.ts): routes, the owned /
// others split, the request guards (Host allowlist, JSON-only POST, the boot payload's escaping),
// the /api/call action guards (unknown properties, non-free kinds, duplicate jobs), hiding, findings
// paging and the worker build. A local server on 127.0.0.1 with a temporary data dir; jobs are only
// queued (external runner mode), so nothing is crawled and no API is called.
// Run:  npm run build:server && node scripts/probe-web-unified.mjs
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { startDashboardServer, stopDashboardServer, listLocalProperties } from '../dist/core/webServer.js';
import { buildWebCallHandlers } from '../dist/core/webHandlers.js';
import { JobManager, jobsDbPath } from '../dist/core/JobManager.js';
import { getDashboardDataAsync } from '../dist/core/dashboardAsync.js';

process.env.SAC_AUTOSERVE = '0';
delete process.env.SAC_DASHBOARD_PORT;
delete process.env.SAC_DASHBOARD_BIND;
let pass = 0, fail = 0;
const ok = (cond, msg, detail = '') => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}${detail ? ` :: ${detail}` : ''}`); } };

const dataDir = mkdtempSync(path.join(tmpdir(), 'sac-web-'));
process.env.SAC_DATA_DIR = dataDir;
const OWNED = 'sc-domain:owned.test';
const OTHER = 'rival.test';           // a bare-domain database (DataForSEO-only), not a GSC property
const XSS = 'sc-domain:x.test</script><script>alert(1)</script>';

function property(site, findings = 0) {
  const adb = new AuditDatabase(dbPathFor(dataDir, site));
  adb.upsertProperty(site, 'apex');
  if (findings) {
    adb.db.prepare(`INSERT INTO audit_runs (run_id,scope,started_at,finished_at,finding_count,status) VALUES ('r1','core','2026-10-01 09:00:00','2026-10-01 09:01:00',?, 'completed')`).run(findings);
    const ins = adb.db.prepare(`INSERT INTO findings (run_id,check_id,category,severity,labels,certainty,url_key,evidence,traffic_at_risk,effort,priority,recommendation) VALUES ('r1',?,?,?,'["D"]',1,?,'{}','{}','{}',?,'{"title":"t","text":"f"}')`);
    for (let i = 0; i < findings; i++) ins.run(i % 2 ? 'title-missing' : 'noindex-traffic', i % 2 ? 'onpage' : 'indexation', i % 3 ? 'med' : 'crit', `https://owned.test/p${i}`, findings - i);
  }
  adb.close();
}
property(OWNED, 620);
property(OTHER);

/** A raw request, so the Host and Content-Type headers are exactly what the test says. */
function req(port, { method = 'GET', path: p = '/', host = `127.0.0.1:${port}`, type, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host !== null) headers.host = host;
    if (type) headers['content-type'] = type;
    if (body != null) headers['content-length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, setHost: false }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

const queue = new JobManager({ dbPath: jobsDbPath(dataDir), runner: 'external' });
const local = new JobManager({ dbPath: jobsDbPath(dataDir) });
let pick = queue;
const handlers = buildWebCallHandlers({
  dataDir: () => dataDir, dfs: null, apiKeys: () => ({ dataforseo: false, majestic: false }),
  jobs: { pick: () => pick, deps: { dataDir: () => dataDir }, gsc: () => false },
});
const call = (port, name, args = {}) => req(port, { method: 'POST', path: '/api/call', type: 'application/json', body: JSON.stringify({ name, arguments: args }) })
  .then(r => ({ ...r, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })() }));

const UI = '<!doctype html><html><head><title>ui</title></head><body>dashboard</body></html>';
const { port, url } = await startDashboardServer({ dataDir: () => dataDir, uiHtml: () => UI, call: handlers });

try {
  // ── 1. Properties: GSC properties vs bare-domain databases ─────────────────────────────────
  console.log('properties');
  {
    const props = listLocalProperties(dataDir);
    ok(props.find(p => p.siteUrl === OWNED)?.gsc === true, 'a sc-domain: property is a GSC property');
    ok(props.find(p => p.siteUrl === OTHER)?.gsc === false, 'a bare-domain database is not one of the user\'s properties');
    ok(url === `http://127.0.0.1:${port}`, `the advertised URL is 127.0.0.1 (${url})`);
  }

  // ── 2. Routes ─────────────────────────────────────────────────────────────────────────────
  console.log('routes');
  {
    const root = await req(port, { path: '/' });
    ok(root.status === 302 && root.headers.location === `/dashboard?siteUrl=${encodeURIComponent(OWNED)}`, `one owned property: / redirects to its dashboard (${root.status} ${root.headers.location})`);
    const all = await req(port, { path: '/?all=1' });
    ok(all.status === 200 && /"view":"domains"/.test(all.body), '/?all=1 serves the domains view');
    ok(/"properties":\["sc-domain:owned.test"\]/.test(all.body) && /"others":\["rival.test"\]/.test(all.body), 'the boot payload splits owned properties from other databases');
    const pf = await req(port, { path: '/portfolio' });
    ok(pf.status === 302 && pf.headers.location === '/', 'the old /portfolio route redirects to /');
    const pd = await req(port, { path: '/portfolio/domain?d=rival.test' });
    ok(pd.status === 302 && pd.headers.location === '/dashboard?domain=rival.test', 'the old /portfolio/domain route redirects to /dashboard?domain=');
    const odd = await req(port, { path: '/portfolio/domain?d=//evil.example' });
    ok(odd.status === 302 && odd.headers.location.startsWith('/dashboard?domain='), `a /portfolio/domain redirect stays on this server (${odd.headers.location})`);
    const nf = await req(port, { path: '/nope' });
    ok(nf.status === 404, 'an unknown route is a 404');
  }

  // ── 3. Request guards ─────────────────────────────────────────────────────────────────────
  console.log('request guards');
  {
    for (const host of ['localhost.evil.example', '127.0.0.1.nip.io', 'evil.example']) {
      const r = await req(port, { path: '/api/properties', host });
      ok(r.status === 403, `Host ${host} is refused (DNS rebinding)`, String(r.status));
    }
    const noHost = await req(port, { path: '/api/properties', host: null });
    ok(noHost.status === 403 || noHost.status === 400, `a request with no Host is refused (${noHost.status})`);
    for (const host of [`localhost:${port}`, `[::1]:${port}`]) {
      const r = await req(port, { path: '/api/properties', host });
      ok(r.status === 200, `Host ${host} is answered`, String(r.status));
    }
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const r = await req(port, { method: 'POST', path: '/api/call', type, body: JSON.stringify({ name: 'list_domains' }) });
      ok(r.status === 415, `POST /api/call with content-type ${type ?? '(none)'} is refused (CSRF)`, String(r.status));
    }
    const unknown = await call(port, 'drop_everything');
    ok(unknown.status === 404, 'a name outside the allowlist is a 404');
    const xss = await req(port, { path: `/dashboard?siteUrl=${encodeURIComponent(XSS)}` });
    ok(xss.status === 200 && !xss.body.includes('</script><script>alert(1)') && xss.body.includes('\\u003c/script>'), 'the boot payload escapes </script> in a siteUrl');
    const dollar = await req(port, { path: `/dashboard?siteUrl=${encodeURIComponent("sc-domain:a$&b$'c.test")}` });
    ok(dollar.body.includes("a$&b$'c.test"), 'the boot payload keeps $-sequences literal');
  }

  // ── 4. Action guards ──────────────────────────────────────────────────────────────────────
  console.log('action guards');
  {
    const before = readdirSync(dataDir).filter(f => f.endsWith('.db')).length;
    const ghost = await call(port, 'start_job', { siteUrl: 'sc-domain:ghost.test', kind: 'crawl' });
    ok(ghost.status === 500 && /unknown property/.test(ghost.json?.error ?? ''), 'start_job refuses a property with no local database');
    const audit = await call(port, 'run_audit', { siteUrl: 'sc-domain:ghost.test' });
    ok(audit.status === 500 && /unknown property/.test(audit.json?.error ?? ''), 'run_audit refuses an unknown property');
    ok(readdirSync(dataDir).filter(f => f.endsWith('.db')).length === before && !existsSync(dbPathFor(dataDir, 'sc-domain:ghost.test')), 'no empty database was created for the unknown property');
    const paid = await call(port, 'start_job', { siteUrl: OWNED, kind: 'ranks' });
    ok(paid.status === 500 && /crawl, sync, inspect/.test(paid.json?.error ?? ''), 'start_job refuses a kind that is not free (ranks)');
    const first = await call(port, 'start_job', { siteUrl: OWNED, kind: 'crawl', maxPages: 10 });
    ok(first.status === 200 && first.json?.structuredContent?.queued === true && first.json.structuredContent.jobId, 'start_job queues a crawl for a known property');
    const dup = await call(port, 'start_job', { siteUrl: OWNED, kind: 'crawl' });
    ok(dup.status === 500 && /already running or queued/.test(dup.json?.error ?? ''), 'a second crawl for the same property is refused');
    pick = local;
    const sync = await call(port, 'start_job', { siteUrl: OWNED, kind: 'sync' });
    ok(sync.status === 500 && /Search Console credentials/.test(sync.json?.error ?? ''), 'a Search Console sync without credentials (and no runner) is refused');
    pick = queue;
    const status = await call(port, 'action_status', { siteUrl: OWNED });
    ok(status.json?.structuredContent?.jobs?.some(j => j.type === 'crawl'), 'action_status lists the queued crawl for the property');
    const cancel = await call(port, 'cancel_job', { id: first.json?.structuredContent?.jobId });
    ok(cancel.json?.structuredContent?.cancelled === true, 'cancel_job cancels the queued crawl');
  }

  // ── 5. Hiding ─────────────────────────────────────────────────────────────────────────────
  console.log('hiding');
  {
    const h = await call(port, 'set_property_hidden', { siteUrl: OWNED, hidden: true });
    ok(h.status === 200 && h.json?.structuredContent?.hidden?.includes(OWNED), 'set_property_hidden hides the property');
    const d = (await call(port, 'list_domains')).json?.structuredContent;
    ok(!d?.properties?.includes(OWNED) && d?.hidden?.includes(OWNED), 'a hidden property leaves the domain list and is listed as hidden');
    const byUrl = await req(port, { path: `/dashboard?siteUrl=${encodeURIComponent(OWNED)}` });
    ok(byUrl.status === 200 && !/"properties":\["sc-domain:owned.test"\]/.test(byUrl.body), 'a hidden property is still served by URL, but not offered in the boot list');
    const root = await req(port, { path: '/' });
    ok(root.status === 200, 'with the only owned property hidden, / serves the domains view instead of redirecting');
    await call(port, 'set_property_hidden', { siteUrl: OWNED, hidden: false });
    ok((await call(port, 'list_domains')).json?.structuredContent?.properties?.includes(OWNED), 'unhiding brings it back');
  }

  // ── 6. Findings paging and filters (every finding, not the payload's top 50) ─────────────────
  console.log('findings');
  {
    const all = (await call(port, 'list_findings', { siteUrl: OWNED, limit: 1000 })).json?.structuredContent;
    ok(all?.total === 620 && all.rows.length === 500, `limit is capped at 500 (total ${all?.total}, rows ${all?.rows?.length})`);
    const crit = (await call(port, 'list_findings', { siteUrl: OWNED, severity: 'crit', limit: 50 })).json?.structuredContent;
    ok(crit?.total === 207 && crit.rows.every(r => r.severity === 'crit'), `the severity filter counts and returns only that severity (${crit?.total})`);
    const cat = (await call(port, 'list_findings', { siteUrl: OWNED, category: 'onpage', checkId: 'title-missing', limit: 10 })).json?.structuredContent;
    ok(cat?.total === 310 && cat.rows.every(r => r.check_id === 'title-missing'), `category + check filters combine (${cat?.total})`);
    const p1 = (await call(port, 'list_findings', { siteUrl: OWNED, limit: 100, offset: 0 })).json?.structuredContent;
    const p2 = (await call(port, 'list_findings', { siteUrl: OWNED, limit: 100, offset: 100 })).json?.structuredContent;
    ok(p1?.rows?.[0]?.priority > p2?.rows?.[0]?.priority && p2?.offset === 100, 'offset pages forward in priority order');
    const neg = (await call(port, 'list_findings', { siteUrl: OWNED, offset: -5, limit: 1 })).json?.structuredContent;
    ok(neg?.offset === 0, 'a negative offset is read as 0');
  }

  // ── 7. The payload is built on a worker, and identical requests share one build ───────────────
  console.log('worker build');
  {
    const a = getDashboardDataAsync(dataDir, OWNED);
    const b = getDashboardDataAsync(dataDir, OWNED);
    ok(a === b, 'two identical concurrent requests share one build');
    const data = await a;
    ok(data?.siteUrl === OWNED || data?.findings?.runId === 'r1', 'the worker returns the property payload');
    const viaApi = (await call(port, 'get_dashboard_data', { siteUrl: OWNED })).json?.structuredContent;
    ok(viaApi?.apiKeys?.dataforseo === false && viaApi?.findings?.total === 620, 'get_dashboard_data returns the payload with the key status');
  }
} catch (e) {
  fail++;
  console.log(`  FAIL probe threw :: ${e?.stack ?? e}`);
} finally {
  await stopDashboardServer();
  queue.close?.(); local.close?.();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
