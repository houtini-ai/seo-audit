// Regression test for the external job runner (#56): SAC_JOB_RUNNER=external queues jobs in _jobs.db
// and a separate seo-audit-runner process claims and runs them.
// Run: node scripts/probe-runner.mjs   (after npm run build:server). No network beyond 127.0.0.1.
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JobManager, jobsDbPath, liveJobTypes, RUNNER_INTERRUPTED_ERROR, RUNNER_STOPPED_ERROR, QUEUED_NOTE } from '../dist/core/JobManager.js';
import { submitJob, runJobKind, ftsDbFile } from '../dist/core/jobKinds.js';
import { JobRunner } from '../dist/core/jobRunner.js';
import { Crawler } from '../dist/core/Crawler.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor, jobScopeFor } from '../dist/core/paths.js';
import { getDataFreshness } from '../dist/core/dataFreshness.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 20_000, every = 50) => {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return v; await sleep(every); }
};
const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_BIN = path.resolve(here, '../dist/runner.js');

// ── A local site whose pages answer slowly, so a crawl is still running when we kill or cancel it ──
let slowMs = 0;
let origin = '';
const page = (n) => `<!doctype html><html lang="en"><head><title>P${n}</title></head><body><main>` +
  [1, 2, 3].map(k => `<a href="/p/${n + k}/">p${n + k}</a>`).join('') + '</main></body></html>';
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, origin);
  const send = () => {
    if (pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    const m = /^\/(?:p\/(\d+)\/)?$/.exec(pathname);
    if (!m) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>404</h1>'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(Number(m[1] ?? 0)));
  };
  if (slowMs && pathname !== '/robots.txt') setTimeout(send, slowMs); else send();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${server.address().port}`;
const site = `${origin}/`;

const root = mkdtempSync(path.join(tmpdir(), 'sac-runner-'));
const opened = [];
const JM = (o) => { const m = new JobManager(o); opened.push(m); return m; };
const children = [];
const noDeps = {}; // the external path never touches deps
// The runner child processes build their deps from the env (buildJobDeps); in this process only the
// crawler is needed, and skipping the rest keeps cache DBs (wikidata) from being held open at cleanup.
const crawlOnlyDeps = (dir) => ({ dataDir: () => dir, crawler: new Crawler(dir), sync: null, inspector: null, refresh: null, rankTracker: null, backlinks: null, entities: null, dfs: null });
const crawlArgs = (maxPages) => ({ siteUrl: site, maxPages, maxConcurrency: 1, delayMs: 0, checkExternal: false });

/** Start `seo-audit-runner` as a child process on `dataDir`, with fast poll intervals. */
function spawnRunner(dataDir, env = {}) {
  const childEnv = { ...process.env, SAC_DATA_DIR: dataDir, SAC_RUNNER_POLL_MS: '100', SAC_RUNNER_CANCEL_POLL_MS: '200', SAC_RUNNER_HEARTBEAT_MS: '200', ...env };
  for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'DATAFORSEO_USERNAME', 'DATAFORSEO_PASSWORD', 'MAJESTIC_API_KEY', 'SAC_JOB_RUNNER']) delete childEnv[k];
  const child = spawn(process.execPath, [RUNNER_BIN], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const r = { child, log: [], exited: false, code: null };
  const take = d => r.log.push(...String(d).split(/\r?\n/).filter(Boolean));
  child.stderr.on('data', take);
  child.stdout.on('data', take);
  r.exit = new Promise(res => child.once('exit', (code) => { r.exited = true; r.code = code; res(); }));
  children.push(r);
  return r;
}
const kill = async (r, sig = 'SIGKILL') => { if (!r.exited) { r.child.kill(sig); await r.exit; } };
const claimedIds = (r) => r.log.map(l => /\[runner\] claimed (\w+)/.exec(l)?.[1]).filter(Boolean);
const settled = (jm, id) => { const j = jm.get(id); return j && ['completed', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null; };

try {
  // ── Queued with no runner: the status says so, with the docker run line ─────────────────────
  {
    const dir = path.join(root, 'norunner');
    const mcp = JM({ dbPath: jobsDbPath(dir), runner: 'external', runnerStaleMs: 300 });
    check('external mode is on with a registry', mcp.external === true, '');
    const id = submitJob(mcp, 'crawl', { siteUrl: site, maxPages: 2 }, noDeps, jobScopeFor(dir, site));
    const fresh = mcp.get(id);
    check('a submitted job is queued, not run in the MCP process', fresh?.state === 'queued' && mcp.runningIds().length === 0, JSON.stringify(fresh));
    check('a just-queued job reads "waiting for the job runner"', fresh?.note === QUEUED_NOTE, fresh?.note);
    const ro = new Database(jobsDbPath(dir), { readonly: true });
    const row = ro.prepare('SELECT args, scope FROM jobs WHERE id = ?').get(id);
    ro.close();
    check('the queued row carries the kind\'s JSON arguments and the property scope', JSON.parse(row.args).maxPages === 2 && row.scope === jobScopeFor(dir, site), JSON.stringify(row));
    check('the start hint warns that no runner has heartbeated', /no job runner has heartbeated/.test(mcp.queuedHint()) && /docker run/.test(mcp.queuedHint()), mcp.queuedHint());
    await sleep(400);
    const stale = mcp.get(id);
    check('queued past the (scaled) 60 s with no runner: says no runner seems to be running', stale?.state === 'queued' && /no job runner seems to be running/.test(stale.note ?? ''), stale?.note);
    check('...and gives the docker run line', (stale?.note ?? '').includes('docker run -d --init --name seo-audit-runner') && (stale?.note ?? '').includes('npx -y -p @houtini/seo-audit-console@') && (stale?.note ?? '').includes(' seo-audit-runner'), stale?.note);
    check('...whose env flags include every optional key the runner needs, CRUX_API_KEY too', ['DATAFORSEO_USERNAME', 'DATAFORSEO_PASSWORD', 'MAJESTIC_API_KEY', 'CRUX_API_KEY'].every(k => (stale?.note ?? '').includes(`-e ${k} `)), stale?.note);
    const live = liveJobTypes(dir, jobScopeFor(dir, site));
    check('liveJobTypes reports the queued type separately from live ones', !!live && live.queued?.has('crawl') && !live.has('crawl'), JSON.stringify({ live: live && [...live], queued: live?.queued && [...live.queued] }));
    check('a queued job counts for destructive guards (possiblyRunning)', mcp.possiblyRunning().some(j => j.id === id && j.state === 'queued'), JSON.stringify(mcp.possiblyRunning()));
    check('cancel() on a queued job cancels it at once', mcp.cancel(id) === true && mcp.get(id)?.state === 'cancelled', JSON.stringify(mcp.get(id)));
  }

  // ── Dashboard freshness: a queued crawl reads as queued ─────────────────────────────────────
  {
    const fdb = new AuditDatabase(path.join(root, 'fresh.db'));
    fdb.db.prepare("INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at, urls_crawled) VALUES ('c1', ?, 'x', 'completed', '2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z', 10)").run(site);
    const live = Object.assign(new Set(), { queued: new Set(['crawl']) });
    const crawl = getDataFreshness(fdb.db, live).sources.find(s => s.kind === 'crawl');
    check('freshness: a queued crawl reads "queued: waiting for the job runner"', crawl?.state === 'queued' && /^queued: waiting for the job runner/.test(crawl.detail), JSON.stringify(crawl));
    const none = getDataFreshness(fdb.db, new Set()).sources.find(s => s.kind === 'crawl');
    check('freshness: nothing queued leaves the crawl as stored', none?.state === 'completed', JSON.stringify(none));
    fdb.close();
  }

  // ── A queued job nothing can claim is stale: shown, never live, never deleted ───────────────
  {
    const dir = path.join(root, 'stale-queue');
    const mcp = JM({ dbPath: jobsDbPath(dir), runner: 'external', runnerStaleMs: 300, queuedFreshMs: 300 });
    const id = submitJob(mcp, 'crawl', { siteUrl: site, maxPages: 2 }, noDeps, jobScopeFor(dir, site));
    check('a just-queued job is live for destructive guards (a runner may be starting)', mcp.possiblyRunning().some(j => j.id === id) && !mcp.get(id)?.noRunner, JSON.stringify(mcp.get(id)));
    await sleep(400);
    const stale = mcp.get(id);
    check('queued past the fresh window with no runner: no longer blocks prune / repair', !mcp.possiblyRunning().some(j => j.id === id), JSON.stringify(mcp.possiblyRunning()));
    check('...is still in the registry, still queued, marked noRunner', stale?.state === 'queued' && stale.noRunner === true, JSON.stringify(stale));
    mcp.beatRunner({ pid: 1, host: 'h', version: 'v', concurrency: 1, running: 0 });
    check('a fresh runner heartbeat makes the old queued job live again', mcp.possiblyRunning().some(j => j.id === id) && !mcp.get(id)?.noRunner, JSON.stringify(mcp.get(id)));
    mcp.removeRunner();
    // liveJobTypes (the dashboard's read, real 2 min window): an old queued row with no runner.
    const raw = new Database(jobsDbPath(dir));
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    raw.prepare(`UPDATE jobs SET started_at = ?, updated_at = ? WHERE id = ?`).run(old, old, id);
    raw.close();
    const scope = jobScopeFor(dir, site);
    const lt = liveJobTypes(dir, scope);
    check('liveJobTypes: an old queued crawl with no runner is queuedNoRunner, not queued', !!lt && !lt.queued?.has('crawl') && lt.queuedNoRunner?.has('crawl'), JSON.stringify({ q: lt && [...lt.queued], nr: lt && [...lt.queuedNoRunner] }));
    mcp.beatRunner({ pid: 1, host: 'h', version: 'v', concurrency: 1, running: 0 });
    const lt2 = liveJobTypes(dir, scope);
    check('liveJobTypes: with a fresh runner heartbeat it is queued again', !!lt2 && lt2.queued?.has('crawl') && !lt2.queuedNoRunner?.has('crawl'), JSON.stringify({ q: lt2 && [...lt2.queued], nr: lt2 && [...lt2.queuedNoRunner] }));
    mcp.removeRunner();
    const fdb = new AuditDatabase(path.join(root, 'fresh-norunner.db'));
    fdb.db.prepare("INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at, urls_crawled) VALUES ('c1', ?, 'x', 'completed', '2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z', 10)").run(site);
    const crawl = getDataFreshness(fdb.db, Object.assign(new Set(), { queued: new Set(), queuedNoRunner: new Set(['crawl']) })).sources.find(s => s.kind === 'crawl');
    check('freshness: a crawl queued with no runner keeps its stored state and says "queued: no job runner"', crawl?.state === 'completed' && /^queued: no job runner/.test(crawl.detail), JSON.stringify(crawl));
    fdb.close();
  }

  // ── Per-property exclusion in the claim ─────────────────────────────────────────────────────
  {
    const dir = path.join(root, 'scope');
    const a = JM({ dbPath: jobsDbPath(dir) });
    const raw = new Database(jobsDbPath(dir));
    const at = (ms) => new Date(Date.now() + ms).toISOString();
    const ins = raw.prepare(`INSERT INTO jobs (id,type,state,started_at,updated_at,heartbeat_at,progress,instance_id,scope,args) VALUES (?,?,?,?,?,?,'{}',?,?,'{}')`);
    ins.run('live0001', 'crawl', 'running', at(0), at(0), at(0), 'other', 'A.db');
    ins.run('qa000001', 'sync', 'queued', at(1), at(1), null, 'mcp', 'A.db');
    ins.run('qb000001', 'sync', 'queued', at(2), at(2), null, 'mcp', 'B.db');
    raw.close();
    const first = a.claimNext();
    check('a property with a live job is skipped; the next property\'s job is claimed', first?.job.id === 'qb000001' && first.job.state === 'running', JSON.stringify(first));
    check('nothing else is claimable while property A is busy', a.claimNext() === null, '');
  }

  // ── Two processes racing claimNext() never claim the same job ───────────────────────────────
  {
    const dir = path.join(root, 'race');
    const N = 300;
    JM({ dbPath: jobsDbPath(dir) }); // creates the schema
    const raw = new Database(jobsDbPath(dir));
    const ins = raw.prepare(`INSERT INTO jobs (id,type,state,started_at,updated_at,progress,instance_id,args) VALUES (?,?,'queued',?,?,'{}','seed','{}')`);
    raw.transaction(() => { for (let i = 0; i < N; i++) { const t = new Date(Date.now() + i).toISOString(); ins.run(`r${String(i).padStart(7, '0')}`, 'crawl', t, t); } })();
    raw.close();
    const modUrl = pathToFileURL(path.resolve(here, '../dist/core/JobManager.js')).href;
    const code = [
      `import { JobManager } from ${JSON.stringify(modUrl)};`,
      `const jm = new JobManager({ dbPath: ${JSON.stringify(jobsDbPath(dir))} });`,
      // Both claimers start on the same wall-clock tick, so the claims really interleave.
      `const startAt = ${Date.now() + 4000};`,
      'while (Date.now() < startAt) await new Promise(r => setTimeout(r, 1));',
      'const got = []; let misses = 0;',
      'while (misses < 3) { const c = jm.claimNext(); if (c) { got.push(c.job.id); misses = 0; await new Promise(r => setImmediate(r)); } else { misses++; await new Promise(r => setTimeout(r, 5)); } }',
      'jm.close(); console.log(JSON.stringify(got));',
    ].join('\n');
    const race = () => new Promise((res) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; c.stdout.on('data', d => { out += d; }); c.once('exit', () => { try { res(JSON.parse(out)); } catch { res([]); } });
    });
    const [x, y] = await Promise.all([race(), race()]);
    const both = x.filter(id => y.includes(id));
    check('two claimers took every queued job between them', new Set([...x, ...y]).size === N && x.length + y.length === N, `${x.length} + ${y.length}`);
    check('two claimers never claimed the same job', both.length === 0, JSON.stringify(both.slice(0, 5)));
    console.log(`  ..  claim race split ${x.length} / ${y.length}`);
  }

  // ── Enqueue → a runner process claims and completes it; cancel; SIGKILL ─────────────────────
  {
    const dir = path.join(root, 'main');
    const jdb = jobsDbPath(dir);
    const mcp = JM({ dbPath: jdb, runner: 'external' });
    const scope = jobScopeFor(dir, site);
    const id = submitJob(mcp, 'crawl', crawlArgs(3), noDeps, scope);
    const r = spawnRunner(dir);
    const done = await waitFor(() => settled(mcp, id), 30_000);
    check('a runner claims and completes the queued crawl', done?.state === 'completed', JSON.stringify(done ?? mcp.get(id)) + '\n' + r.log.join('\n'));
    check('the completed job carries the crawl result', done?.result?.siteUrl === site && done.result.crawled >= 1, JSON.stringify(done?.result).slice(0, 300));
    check('the runner logged the claim', claimedIds(r).includes(id), r.log.join('\n'));
    check('a live runner is visible to the MCP side', mcp.runnerAlive(), String(mcp.lastRunnerBeat()));
    const db = new AuditDatabase(dbPathFor(dir, site));
    const pages = db.db.prepare('SELECT COUNT(*) n FROM pages').get().n;
    db.close();
    check('the crawl wrote pages to the property DB from the runner process', pages >= 1, String(pages));

    // Cancel a running job: the runner polls the flag and aborts it.
    slowMs = 300;
    const cid = submitJob(mcp, 'crawl', crawlArgs(200), noDeps, scope);
    check('a queued job reads "waiting for the job runner" while a runner is alive', mcp.get(cid)?.state !== 'queued' || mcp.get(cid)?.note === QUEUED_NOTE, JSON.stringify(mcp.get(cid)));
    const running = await waitFor(() => mcp.get(cid)?.state === 'running', 15_000);
    check('the second crawl is running in the runner', running, JSON.stringify(mcp.get(cid)));
    const t0 = Date.now();
    check('cancel() on a runner\'s running job sets the flag', mcp.cancel(cid) === true && mcp.get(cid)?.cancelRequested === true, JSON.stringify(mcp.get(cid)));
    const cancelled = await waitFor(() => mcp.get(cid)?.state === 'cancelled', 10_000);
    check('the runner aborts a cancelled job within 5 s', cancelled && Date.now() - t0 <= 5_000, `${Date.now() - t0} ms, ${JSON.stringify(mcp.get(cid))}`);

    // SIGKILL the runner mid-job: the job reads interrupted once its heartbeat is stale.
    const kid = submitJob(mcp, 'crawl', crawlArgs(200), noDeps, scope);
    const kr = await waitFor(() => mcp.get(kid)?.state === 'running', 15_000);
    check('the third crawl is running before the kill', kr, JSON.stringify(mcp.get(kid)));
    await kill(r, 'SIGKILL');
    const reader = JM({ dbPath: jdb, staleMs: 400 });
    await sleep(600);
    const dead = reader.get(kid);
    check('a killed runner\'s job reads as interrupted, naming the runner', dead?.state === 'interrupted' && dead.error === RUNNER_INTERRUPTED_ERROR, JSON.stringify(dead));
    check('...in list() too', reader.list().find(j => j.id === kid)?.state === 'interrupted', '');
    slowMs = 0;
  }

  // ── Two runners on one queue: every job runs exactly once ───────────────────────────────────
  {
    const dir = path.join(root, 'two');
    const m2 = JM({ dbPath: jobsDbPath(dir), runner: 'external' });
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const s = `https://site${i}.example/`;
      new AuditDatabase(dbPathFor(dir, s)).close(); // integrity needs the property DB to exist
      ids.push(submitJob(m2, 'integrity', { siteUrl: s, mode: 'quick' }, noDeps, jobScopeFor(dir, s)));
    }
    const r1 = spawnRunner(dir, { SAC_RUNNER_CONCURRENCY: '2' });
    const r2 = spawnRunner(dir, { SAC_RUNNER_CONCURRENCY: '2' });
    const allDone = await waitFor(() => ids.every(id => settled(m2, id)), 30_000);
    check('two runners complete every queued job', allDone && ids.every(id => m2.get(id)?.state === 'completed'), JSON.stringify(ids.map(id => m2.get(id))) + '\n' + [...r1.log, ...r2.log].join('\n'));
    const claims = [...claimedIds(r1), ...claimedIds(r2)];
    check('two runners never claim the same job', ids.every(id => claims.filter(c => c === id).length === 1), JSON.stringify({ r1: claimedIds(r1), r2: claimedIds(r2) }));
    check('job results come back through the registry', typeof m2.get(ids[0])?.result === 'object', JSON.stringify(m2.get(ids[0])?.result));
    await kill(r1); await kill(r2);
  }

  // ── Graceful stop (what SIGTERM does): the running job is recorded as interrupted ───────────
  {
    slowMs = 300;
    const dir = path.join(root, 'graceful');
    const m3 = JM({ dbPath: jobsDbPath(dir), runner: 'external' });
    const runner = new JobRunner({ dataDir: dir, pollMs: 50, heartbeatMs: 100, shutdownGraceMs: 5_000, deps: crawlOnlyDeps(dir), log: () => {} });
    runner.start();
    const gid = submitJob(m3, 'crawl', crawlArgs(200), noDeps, jobScopeFor(dir, site));
    const gr = await waitFor(() => m3.get(gid)?.state === 'running', 15_000);
    check('an in-process JobRunner claims the job', gr, JSON.stringify(m3.get(gid)));
    await runner.stop();
    const g = m3.get(gid);
    check('a graceful stop records the running job as interrupted with the stop message', g?.state === 'interrupted' && g.error === RUNNER_STOPPED_ERROR, JSON.stringify(g));
    check('a graceful stop removes the runner heartbeat', m3.lastRunnerBeat() === null, String(m3.lastRunnerBeat()));

    // A real SIGTERM where the platform delivers one (on Windows, kill() ends the process outright).
    if (process.platform !== 'win32') {
      const sid = submitJob(m3, 'crawl', crawlArgs(200), noDeps, jobScopeFor(dir, site));
      const rs = spawnRunner(dir);
      await waitFor(() => m3.get(sid)?.state === 'running', 15_000);
      rs.child.kill('SIGTERM');
      await rs.exit;
      const s = m3.get(sid);
      check('SIGTERM: the runner exits 0 and the job reads interrupted (stopped)', rs.code === 0 && s?.state === 'interrupted' && s.error === RUNNER_STOPPED_ERROR, JSON.stringify({ code: rs.code, s }));
    } else {
      console.log('  ..  real SIGTERM not testable on Windows (the graceful-stop checks above cover the same path)');
    }
    slowMs = 0;
  }

  // ── Through the real MCP tools: start_crawl queues, check_crawl_status reports, a runner finishes it ──
  {
    const dir = path.join(root, 'e2e');
    const env = { ...process.env, SAC_DATA_DIR: dir, SAC_JOB_RUNNER: 'external', SAC_AUTOSERVE: '0' };
    for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'DATAFORSEO_USERNAME', 'DATAFORSEO_PASSWORD', 'MAJESTIC_API_KEY']) delete env[k];
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(here, '../dist/index.js')], env, stderr: 'ignore' });
    const client = new Client({ name: 'probe-runner', version: '0' });
    await client.connect(transport);
    const text = (r) => (r.content ?? []).map(c => c.text ?? '').join('\n');
    try {
      const started = await client.callTool({ name: 'start_crawl', arguments: { siteUrl: site, maxPages: 3, maxConcurrency: 1, checkExternal: false } });
      const jobId = started.structuredContent?.jobId;
      check('MCP start_crawl in external mode replies status "queued"', started.structuredContent?.status === 'queued' && /Queued/.test(text(started)), text(started));
      const q = await client.callTool({ name: 'check_crawl_status', arguments: { jobId } });
      check('check_crawl_status reads "queued: waiting for the job runner"', text(q).includes(`Job ${jobId} (crawl): queued: waiting for the job runner`), text(q));
      const r = spawnRunner(dir);
      let last = q;
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        last = await client.callTool({ name: 'check_crawl_status', arguments: { jobId } });
        if (/: (completed|failed|cancelled|interrupted)/.test(text(last))) break;
        await sleep(200);
      }
      check('check_crawl_status reports the runner\'s completed crawl with its result', text(last).startsWith(`Job ${jobId} (crawl): completed`) && last.structuredContent?.result?.crawled >= 1, text(last) + '\n' + r.log.join('\n'));
      check('...and points at the dashboard tools (the runner serves no dashboard link)', /The data is in/.test(text(last)), text(last));
      await kill(r);
    } finally {
      await client.close();
    }
  }

  // ── A cancelled job that is slow to wind down is aborted and logged once, not every poll ─────
  {
    const dir = path.join(root, 'cancel-once');
    const logs = [];
    // A crux job whose body ignores its abort signal for a while, so it is still running (with its
    // cancel flag set) across many cancel polls.
    const slowDeps = { dataDir: () => dir, cruxSync: { run: () => sleep(1_200).then(() => ({ ok: true })) } };
    const runner = new JobRunner({ dataDir: dir, deps: slowDeps, pollMs: 50, cancelPollMs: 50, heartbeatMs: 100, log: m => logs.push(m) });
    runner.start();
    const mcp = JM({ dbPath: jobsDbPath(dir), runner: 'external' });
    const id = submitJob(mcp, 'crux', { siteUrl: site }, noDeps, jobScopeFor(dir, site));
    await waitFor(() => mcp.get(id)?.state === 'running', 5_000);
    mcp.cancel(id);
    const done = await waitFor(() => settled(mcp, id), 10_000);
    const aborts = logs.filter(l => l.startsWith(`cancel requested for ${id}`)).length;
    check('a slow-to-stop cancelled job is aborted and logged once across many polls', !!done && aborts === 1, `${aborts} cancel log lines; ${JSON.stringify(done)}`);
    await runner.stop();
  }

  // ── fts-index stores the DB's bare file name; the process that runs it resolves its own path ──
  {
    const s = 'https://fts.example/';
    const mcpDir = path.join(root, 'fts-mcp');
    const runnerDir = path.join(root, 'fts-runner-mount'); // the same volume, mounted at another path
    new AuditDatabase(dbPathFor(mcpDir, s)).close();
    new AuditDatabase(dbPathFor(runnerDir, s)).close();
    const dbName = path.basename(dbPathFor(mcpDir, s));
    const mcp = JM({ dbPath: jobsDbPath(mcpDir), runner: 'external' });
    const id = submitJob(mcp, 'fts-index', { siteUrl: s, dbName, indexes: ['links_fts'] }, noDeps, jobScopeFor(mcpDir, s));
    const ro = new Database(jobsDbPath(mcpDir), { readonly: true });
    const stored = JSON.parse(ro.prepare('SELECT args FROM jobs WHERE id = ?').get(id).args);
    ro.close();
    check('a queued fts-index job stores no path from the MCP process', stored.dbName === dbName && !JSON.stringify(stored).includes('fts-mcp') && !/[\\/]/.test(stored.dbName) && !('dbFile' in stored), JSON.stringify(stored));
    const progress = {};
    const res = await runJobKind('fts-index', stored, { dataDir: () => runnerDir }, p => Object.assign(progress, p), new AbortController().signal);
    check('the runner builds the index in ITS data dir', progress.dbFile === path.join(runnerDir, dbName) && res?.indexes?.includes('links_fts'), JSON.stringify({ progress, res }));
    mcp.cancel(id);
    let threw = 0;
    for (const bad of ['../x.db', path.join(mcpDir, dbName), 'notadb.txt', '']) { try { ftsDbFile(runnerDir, bad); } catch { threw++; } }
    check('fts-index refuses anything but a bare .db file name', threw === 4, `${threw}/4 refused`);
    // In-process: same file as before (dataDir + the property's DB file name).
    const m = JM({ dbPath: jobsDbPath(path.join(root, 'fts-inproc')) });
    const ipId = submitJob(m, 'fts-index', { siteUrl: s, dbName, indexes: ['links_fts'] }, { dataDir: () => mcpDir }, jobScopeFor(mcpDir, s));
    const ip = await waitFor(() => settled(m, ipId), 15_000);
    check('in-process fts-index builds the same DB the MCP resolved', ip?.state === 'completed' && ip.progress?.dbFile === dbPathFor(mcpDir, s), JSON.stringify(ip));
  }

  // ── In-process mode is unchanged: submit() runs the kind here, no queued row ────────────────
  {
    const dir = path.join(root, 'inproc');
    const s = 'https://inproc.example/';
    new AuditDatabase(dbPathFor(dir, s)).close();
    const m4 = JM({ dbPath: jobsDbPath(dir) });
    check('default mode is in-process', m4.external === false, '');
    const id = submitJob(m4, 'integrity', { siteUrl: s, mode: 'quick' }, { dataDir: () => dir }, jobScopeFor(dir, s));
    const st = m4.get(id)?.state;
    const done = await waitFor(() => m4.get(id)?.state === 'completed', 15_000);
    check('in-process submit runs at once and completes', st === 'running' && done, `${st} → ${m4.get(id)?.state}`);
    const ro = new Database(jobsDbPath(dir), { readonly: true });
    const row = ro.prepare('SELECT state, args FROM jobs WHERE id = ?').get(id);
    ro.close();
    check('in-process rows store no arguments (nothing for a runner to claim)', row.args === null && row.state === 'completed', JSON.stringify(row));
  }
} finally {
  for (const r of children) await kill(r);
  for (const m of opened) m.close();
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  await sleep(100);
  try { rmSync(root, { recursive: true, force: true }); } catch (e) { console.log(`  ..  cleanup: ${e.message}`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
