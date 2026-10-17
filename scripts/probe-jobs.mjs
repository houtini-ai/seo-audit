// Regression test for async-job reporting, the durable job registry (#9), data_storage lastCrawl and incremental GSC replace.
// Run: node scripts/probe-jobs.mjs   (after npm run build:server)
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { JobManager, corruptionHint, jobsDbPath, liveJobTypes, JOBS_DB_NAME } from '../dist/core/JobManager.js';
import { getDataFreshness } from '../dist/core/dataFreshness.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { GscSync } from '../dist/core/GscSync.js';
import { storageSummary } from '../dist/core/dataStorage.js';
import { dbPathFor } from '../dist/core/paths.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const dir = mkdtempSync(path.join(tmpdir(), 'sac-jobs-'));
const site = 'https://example.com/';

// ── JobManager: failure reason kept, corruption hint only for SQLite corruption (#33) ──────
{
  const jm = new JobManager();
  const origErr = console.error; const logged = []; console.error = (...a) => logged.push(a.join(' '));
  const id = jm.start('sync', async () => { throw new Error('database disk image is malformed'); });
  await new Promise(r => setTimeout(r, 20));
  console.error = origErr;
  const job = jm.get(id);
  check('failed job keeps its error', job.state === 'failed' && job.error === 'database disk image is malformed', JSON.stringify(job));
  check('failure logged to stderr with job id', logged.some(l => l.includes(id) && l.includes('malformed')), JSON.stringify(logged));
  check('corruption hint for malformed DB', corruptionHint(job.error).includes('data_storage'), corruptionHint(job.error));
  check('no corruption hint for ordinary errors', corruptionHint('fetch failed') === '', corruptionHint('fetch failed'));
}

// ── data_storage.lastCrawl counts only completed crawls (#20, #29) ──────────────────────────
{
  const db = new AuditDatabase(dbPathFor(dir, site));
  db.db.prepare(`INSERT OR IGNORE INTO property_meta (site_url) VALUES (?)`).run(site);
  const ins = db.db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES (?,?,?,?,?,?)`);
  ins.run('c1', site, 'example.com', 'completed', '2026-10-07T09:00:00.000Z', '2026-10-07T09:30:00.000Z');
  ins.run('c2', site, 'example.com', 'running', '2026-10-16T17:45:45.414Z', null);
  db.close();
  const p = storageSummary(dir, site).properties[0];
  check('lastCrawl is the last COMPLETED crawl', p.lastCrawl === '2026-10-07T09:30:00.000Z', p.lastCrawl);
  check('incomplete latest run is surfaced', p.latestCrawlRun?.status === 'running' && p.latestCrawlRun.startedAt.startsWith('2026-10-16'), JSON.stringify(p.latestCrawlRun));
}

// ── GSC incremental sync replaces the lag days instead of merging into them (#22) ───────────
{
  const row = (date, query, clicks) => ({ keys: [date, query, `${site}p`], clicks, impressions: clicks * 10, ctr: 0.1, position: 3 });
  let served = [];
  const fakeGsc = { fetchSearchAnalytics: async (_s, opts, _sig, onBatch) => { served.push(opts.startDate); await onBatch({ rows: served.length === 1 ? first : second }); } };
  const first = [row('2026-10-01', 'a', 10), row('2026-10-05', 'a', 9), row('2026-10-06', 'partial', 2), row('2026-10-06', 'dropped-later', 1)];
  const second = [row('2026-10-03', 'a', 11), row('2026-10-06', 'partial', 40), row('2026-10-07', 'a', 12)];
  const sync = new GscSync(fakeGsc, dir);
  await sync.run(site, { startDate: '2026-09-01', endDate: '2026-10-16' }, () => {}, new AbortController().signal);
  const r2 = await sync.run(site, { startDate: '2026-09-01', endDate: '2026-10-16' }, () => {}, new AbortController().signal);
  const db = new AuditDatabase(dbPathFor(dir, site));
  const rows = db.db.prepare(`SELECT date, query, clicks FROM search_analytics ORDER BY date, query`).all();
  db.close();
  check('second sync resumed from max date minus lag days', served[1] === '2026-10-02' && r2.startDate === '2026-10-02', JSON.stringify({ served, r2 }));
  check('day before the window is untouched', rows.some(r => r.date === '2026-10-01' && r.clicks === 10), JSON.stringify(rows));
  check('partial final day replaced with the finalised figure', rows.find(r => r.date === '2026-10-06' && r.query === 'partial')?.clicks === 40, JSON.stringify(rows));
  check('row Google dropped from a re-pulled day is removed', !rows.some(r => r.query === 'dropped-later'), JSON.stringify(rows));
  const plan = sync.plannedRange(site, { startDate: '2026-09-01', endDate: '2026-10-16' });
  check('plannedRange reports the incremental start the job will use', plan.incremental && plan.startDate === '2026-10-03', JSON.stringify(plan));
  check('plannedRange with full:true keeps the requested window', sync.plannedRange(site, { startDate: '2026-09-01', endDate: '2026-10-16', fullResync: true }).startDate === '2026-09-01', '');
  check('day inside the window but absent from the re-pull is removed', !rows.some(r => r.date === '2026-10-05'), JSON.stringify(rows));
}

// ── Review findings: the lag-day replace is bounded and atomic ──────────────────────────────
{
  const site2 = 'https://atomic.example/';
  const row = (date, query, clicks) => ({ keys: [date, query, `${site2}p`], clicks, impressions: clicks * 10, ctr: 0.1, position: 3 });
  const seed = [row('2026-10-05', 'a', 5), row('2026-10-08', 'a', 8), row('2026-10-09', 'later', 9), row('2026-10-10', 'later', 10)];
  const stored = () => { const d = new AuditDatabase(dbPathFor(dir, site2)); try { return d.db.prepare(`SELECT date, query, clicks FROM search_analytics ORDER BY date`).all(); } finally { d.close(); } };
  await new GscSync({ fetchSearchAnalytics: async (_s, _o, _sig, onBatch) => onBatch({ rows: seed }) }, dir)
    .run(site2, { startDate: '2026-10-01', endDate: '2026-10-16', fullResync: true }, () => {}, new AbortController().signal);

  // Historical pull ending before the stored max: rows after endDate must survive.
  await new GscSync({ fetchSearchAnalytics: async (_s, opts, _sig, onBatch) => onBatch({ rows: [row('2026-10-07', 'a', 7)] }) }, dir)
    .run(site2, { startDate: '2026-10-01', endDate: '2026-10-08' }, () => {}, new AbortController().signal);
  const afterHist = stored();
  check('sync ending before stored data keeps rows after its endDate', afterHist.some(r => r.date === '2026-10-09') && afterHist.some(r => r.date === '2026-10-10'), JSON.stringify(afterHist));

  // Failure on page 2: nothing in the lag window is lost.
  const before = JSON.stringify(stored());
  let threw = false;
  try {
    await new GscSync({ fetchSearchAnalytics: async (_s, _o, _sig, onBatch) => { await onBatch({ rows: [row('2026-10-07', 'x', 1)] }); throw new Error('429 on page 2'); } }, dir)
      .run(site2, { startDate: '2026-10-01', endDate: '2026-10-16' }, () => {}, new AbortController().signal);
  } catch { threw = true; }
  check('a failure on a later page leaves the stored lag days untouched', threw && JSON.stringify(stored()) === before, JSON.stringify(stored()));

  // Empty response: stored days are not wiped.
  await new GscSync({ fetchSearchAnalytics: async () => {} }, dir).run(site2, { startDate: '2026-10-01', endDate: '2026-10-16' }, () => {}, new AbortController().signal);
  check('an empty response never wipes stored days', JSON.stringify(stored()) === before, JSON.stringify(stored()));
}

// ── Durable job registry (#9) ────────────────────────────────────────────────────────────────
{
  const jdir = path.join(dir, 'jobs');
  const jdb = jobsDbPath(jdir);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // Every durable manager is closed at the end: Windows can't delete an open SQLite file.
  const opened = [];
  const JM = (o) => { const m = new JobManager(o); opened.push(m); return m; };
  const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };

  // (b) A completed job's result survives a restart (a new JobManager = a new process).
  {
    const a = JM({ dbPath: jdb });
    check('registry opens', a.durable, 'durable=false');
    const id = a.start('crawl', async (update) => { update({ crawled: 3 }); return { siteUrl: site, crawled: 3 }; });
    await sleep(30);
    const b = JM({ dbPath: jdb });
    const job = b.get(id);
    check('completed job result survives a restart', job?.state === 'completed' && job.result?.crawled === 3 && job.progress?.crawled === 3, JSON.stringify(job));
    check('list() merges registry rows from the earlier process', b.list().some(j => j.id === id), JSON.stringify(b.list()));
    check('unknown id is still not found', b.get('nope1234') === undefined, '');
    const fid = await quiet(async () => { const f = a.start('sync', async () => { throw new Error('boom'); }); await sleep(30); return f; });
    check('failed job error survives a restart', JM({ dbPath: jdb }).get(fid)?.error === 'boom', '');
  }

  // (a1) A stale "running" row from another process reads as interrupted.
  {
    const raw = new Database(jdb);
    const ins = raw.prepare('INSERT INTO jobs (id,type,state,started_at,updated_at,heartbeat_at,progress,instance_id) VALUES (?,?,?,?,?,?,?,?)');
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    ins.run('stale001', 'crawl', 'running', old, old, old, '{"crawled":12}', 'some-other-process');
    const fresh = new Date().toISOString();
    ins.run('fresh001', 'sync', 'running', fresh, fresh, fresh, '{}', 'another-live-process');
    raw.close();
    const b = JM({ dbPath: jdb });
    const st = b.get('stale001');
    check('stale running row reads as interrupted', st?.state === 'interrupted' && /exited before it finished/.test(st.error ?? '') && /longLived: true/.test(st.error ?? '') && st.progress.crawled === 12, JSON.stringify(st));
    check('a live process\'s running row stays running', b.get('fresh001')?.state === 'running', JSON.stringify(b.get('fresh001')));
    const ro = new Database(jdb, { readonly: true });
    check('the stale row is not rewritten on read', ro.prepare("SELECT state FROM jobs WHERE id='stale001'").get().state === 'running', '');
    ro.close();
    const live = liveJobTypes(jdir);
    check('liveJobTypes sees only fresh running jobs', !!live && live.has('sync') && !live.has('crawl'), JSON.stringify(live && [...live]));
    check('liveJobTypes is null without a registry', liveJobTypes(path.join(dir, 'no-such-dir')) === null, '');
  }

  // (a2) A real process killed mid-job: running while its heartbeat is fresh, interrupted once stale.
  {
    const modUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/core/JobManager.js')).href;
    const code = [
      `import { JobManager } from ${JSON.stringify(modUrl)};`,
      `const jm = new JobManager({ dbPath: ${JSON.stringify(jdb)}, heartbeatMs: 100000 });`,
      `const id = jm.start('crawl', (update) => { update({ phase: 'crawl' }); return new Promise(() => {}); });`,
      'console.log(id); setInterval(() => {}, 1000);',
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let exited = false;
    const exitP = new Promise(r => child.once('exit', () => { exited = true; r(); }));
    const id = await Promise.race([
      new Promise(r => child.stdout.once('data', d => r(String(d).trim()))),
      exitP.then(() => null),
      sleep(15_000).then(() => null),
    ]);
    check('child process started a job', !!id, `exited=${exited}`);
    if (id) {
      const b = JM({ dbPath: jdb, staleMs: 400 });
      check('another process\'s live job reads as running', b.get(id)?.state === 'running', JSON.stringify(b.get(id)));
      child.kill('SIGKILL');
      await exitP;
      await sleep(500);
      const dead = b.get(id);
      check('a killed process\'s job reads as interrupted once its heartbeat is stale', dead?.state === 'interrupted' && /longLived/.test(dead.error ?? ''), JSON.stringify(dead));
      check('list() reports it as interrupted too', b.list().find(j => j.id === id)?.state === 'interrupted', '');
    } else child.kill('SIGKILL');
  }

  // Heartbeat + throttled progress reach the registry while the job runs.
  {
    const a = JM({ dbPath: jdb, heartbeatMs: 50, progressThrottleMs: 20 });
    let release; const gate = new Promise(r => { release = r; });
    const id = a.start('crawl', async (update) => { update({ n: 1 }); await sleep(40); update({ n: 2 }); await gate; return {}; });
    const firstBeat = JM({ dbPath: jdb }).get(id)?.heartbeatAt;
    await sleep(150);
    const mid = JM({ dbPath: jdb }).get(id);
    check('heartbeat refreshes while running', mid?.state === 'running' && mid.heartbeatAt > firstBeat, JSON.stringify({ firstBeat, mid }));
    check('throttled progress is written', mid?.progress?.n === 2, JSON.stringify(mid?.progress));
    release(); await sleep(20);
  }

  // (c) Memory-only fallback when the registry path isn't writable (its parent is a file).
  {
    const blocker = path.join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const origErr = console.error; const logged = []; console.error = (...a) => logged.push(a.join(' '));
    const m = JM({ dbPath: path.join(blocker, JOBS_DB_NAME) });
    const id = m.start('sync', async () => ({ ok: true }));
    await sleep(20);
    console.error = origErr;
    check('unwritable registry falls back to memory-only', !m.durable && m.get(id)?.state === 'completed', JSON.stringify(m.get(id)));
    check('fallback warns once on stderr', logged.filter(l => l.includes('[jobs]')).length === 1 && /memory only/.test(logged[0] ?? ''), JSON.stringify(logged));
  }

  // Pruning keeps the newest rows and never drops a live job.
  {
    const pdir = path.join(dir, 'prune');
    const a = JM({ dbPath: jobsDbPath(pdir), maxRetained: 3 });
    let release; const gate = new Promise(r => { release = r; });
    const live = a.start('crawl', () => gate);
    for (let i = 0; i < 5; i++) { await sleep(5); a.start('sync', async () => i); }
    await sleep(10);
    const ro = new Database(jobsDbPath(pdir), { readonly: true });
    const rows = ro.prepare('SELECT id, state FROM jobs').all();
    ro.close();
    check('registry pruned to the newest rows, live job kept', rows.length <= 4 && rows.some(r => r.id === live), JSON.stringify(rows));
    release(); await sleep(10);
  }
  for (const m of opened) m.close();
}

// ── Dashboard freshness: a 'running' crawl with no live owner reads as interrupted (#9) ───────
{
  const fdb = new AuditDatabase(path.join(dir, 'fresh.db'));
  fdb.db.prepare("INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at) VALUES ('c9', ?, 'example.com', 'running', '2026-10-16T17:45:45.414Z')").run(site);
  const crawlState = (live) => getDataFreshness(fdb.db, live).sources.find(s => s.kind === 'crawl')?.state;
  check('orphaned running crawl reads as interrupted', crawlState(new Set()) === 'interrupted', crawlState(new Set()));
  const orphanErr = getDataFreshness(fdb.db, new Set()).sources.find(s => s.kind === 'crawl')?.error;
  check('orphaned crawl uses the shared interrupted wording', orphanErr === 'The server process running this crawl exited before it finished.', orphanErr);
  check('running crawl with a live crawl job stays running', crawlState(new Set(['crawl'])) === 'running', crawlState(new Set(['crawl'])));
  check('no registry: crawl state left as stored', crawlState(null) === 'running', crawlState(null));
  fdb.close();
}

// ── 0.15.0: an audit stored 'running' isn't taken at its word ──────────────────────────────────
// run_audit writes status='running' at start, so a process killed mid-audit left it 'running'
// forever: the 30-minute fallback only ever applied to legacy NULL-status rows.
{
  const adb = new AuditDatabase(path.join(dir, 'audit-state.db'));
  const auditState = () => getDataFreshness(adb.db, null).sources.find(s => s.kind === 'audit')?.state;
  adb.db.prepare("INSERT INTO audit_runs (run_id, scope, started_at, status) VALUES ('r-old', 'full', datetime('now','-2 hours'), 'running')").run();
  check('an audit left running for hours reads as interrupted', auditState() === 'interrupted', auditState());
  adb.db.prepare("INSERT INTO audit_runs (run_id, scope, started_at, status) VALUES ('r-new', 'full', datetime('now','-1 minute'), 'running')").run();
  check('an audit that started a minute ago still reads as running', auditState() === 'running', auditState());
  adb.db.prepare("UPDATE audit_runs SET status='failed' WHERE run_id='r-new'").run();
  check('a recorded terminal status is still reported as-is', auditState() === 'failed', auditState());
  adb.close();
}

// ── 0.15.0: job scope, per-property liveness, the conservative guard, first progress write ─────
{
  const sdir = path.join(dir, 'scope');
  const sjdb = jobsDbPath(sdir);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const a = new JobManager({ dbPath: sjdb });
  let release; const gate = new Promise(r => { release = r; });
  const id = a.start('crawl', async (update) => { update({ phase: 'crawl' }); await gate; return {}; }, { scope: 'a.example.db' });
  await sleep(20);
  const ro = new Database(sjdb, { readonly: true });
  const row = ro.prepare('SELECT scope, progress FROM jobs WHERE id = ?').get(id);
  ro.close();
  check('a job\'s scope is in the registry from its first write', row?.scope === 'a.example.db', JSON.stringify(row));
  check('the first progress update is written at once, not held for the ~20 s heartbeat', JSON.parse(row?.progress ?? '{}').phase === 'crawl', row?.progress);
  const forA = liveJobTypes(sdir, 'a.example.db');
  const forB = liveJobTypes(sdir, 'b.example.db');
  check('liveJobTypes(scope) sees the live crawl for its own property', !!forA && forA.has('crawl'), JSON.stringify(forA && [...forA]));
  check('...and NOT for another property (a live crawl on A no longer vouches for B)', !!forB && !forB.has('crawl'), JSON.stringify(forB && [...forB]));

  const raw = new Database(sjdb);
  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const ins = raw.prepare('INSERT INTO jobs (id,type,state,started_at,updated_at,heartbeat_at,progress,instance_id,scope) VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run('legacy01', 'refresh', 'running', at(0), at(0), at(0), '{}', 'old-proc', null);                 // pre-scope row
  ins.run('busy0001', 'sync', 'running', at(5 * 60_000), at(5 * 60_000), at(5 * 60_000), '{}', 'busy-proc', 'a.example.db'); // starved heartbeat
  ins.run('dead0001', 'crawl', 'running', at(2 * 3600_000), at(2 * 3600_000), at(2 * 3600_000), '{}', 'dead-proc', 'a.example.db'); // long dead
  raw.close();
  const forB2 = liveJobTypes(sdir, 'b.example.db');
  check('an unscoped (pre-0.15) live job still counts for every property', !!forB2 && forB2.has('refresh'), JSON.stringify(forB2 && [...forB2]));

  const b = new JobManager({ dbPath: sjdb });
  check('list() reads a 5-minute-stale owner as interrupted (display state)', b.get('busy0001')?.state === 'interrupted', JSON.stringify(b.get('busy0001')));
  const guard = b.possiblyRunning().map(j => j.id);
  check('possiblyRunning() still counts that busy owner, so no prune runs under it', guard.includes('busy0001'), JSON.stringify(guard));
  check('...but not an owner dead for hours', !guard.includes('dead0001'), JSON.stringify(guard));
  check('...and a process\'s own live job is always included', a.possiblyRunning().some(j => j.id === id), JSON.stringify(a.possiblyRunning().map(j => j.id)));
  check('possiblyRunning() reports every guarded job as running', b.possiblyRunning().every(j => j.state === 'running'), '');
  release();
  await sleep(20);
  a.close(); b.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
