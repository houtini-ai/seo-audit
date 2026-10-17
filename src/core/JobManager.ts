import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { JobState } from './types.js';

export interface Job {
  id: string;
  type: string;
  state: JobState;
  startedAt: string;
  updatedAt: string;
  progress: Record<string, unknown>;
  error?: string;
  result?: unknown;
  /** Last time the owning process said it was still working on this job (durable jobs only). */
  heartbeatAt?: string;
  /** What the job works on - the property's database file name - so "is a job running FOR THIS
   * property" can be answered. Recorded at start, so it is in the registry from the first write. */
  scope?: string;
}

/**
 * A plain-language pointer for SQLite corruption errors, which otherwise surface as a bare
 * "database disk image is malformed" with no next step (#33, #34). Empty for anything else.
 */
export function corruptionHint(error: string | undefined | null): string {
  if (!error) return '';
  return /SQLITE_CORRUPT|disk image is malformed|missing from index|database corrupt/i.test(error)
    ? ' (The property database looks damaged. Run data_storage with check:true to find the damaged index, then prune with action:"repair" to back up the file and rebuild it.)'
    : '';
}

/** The job registry's file in the data dir. The leading underscore keeps it clear of property
 * databases: sanitizeProperty() strips leading underscores, so no property stem can match it. */
export const JOBS_DB_NAME = '_jobs.db';
export const jobsDbPath = (dataDir: string): string => path.join(dataDir, JOBS_DB_NAME);

export const INTERRUPTED_ERROR =
  'The server process running this job exited before it finished, so no further work was done. ' +
  "Under the Docker MCP gateway, set longLived: true on this server's catalog entry (see README, Docker).";

const HEARTBEAT_MS = 20_000;
const STALE_MS = 90_000;
/**
 * How long a job stored as `running` is treated as possibly alive by DESTRUCTIVE guards (vacuum,
 * delete-property, repair). The heartbeat is a timer on the main thread, so a long synchronous step
 * in the owning process (a big run_audit, a large triage_404s) can starve it past STALE_MS and the
 * job briefly reads `interrupted` everywhere else. That is cosmetic and clears on the next beat, but
 * a prune that trusted it would write to a database the job is still writing. So guards use this
 * far longer window instead.
 */
const SAFETY_STALE_MS = 30 * 60_000;
const PROGRESS_THROTTLE_MS = 2_000;
/** Results above this are not persisted (the in-process copy is kept); a crawl result is a few KB. */
const MAX_RESULT_BYTES = 2_000_000;

type JobFn = (update: (p: Record<string, unknown>) => void, signal: AbortSignal) => Promise<unknown>;

export interface JobManagerOptions {
  /** SQLite file for the durable registry. Omit for memory-only (tests, one-off scripts). */
  dbPath?: string;
  /** How many jobs to keep, in memory and in the DB. */
  maxRetained?: number;
  /** Test seams. */
  heartbeatMs?: number;
  staleMs?: number;
  progressThrottleMs?: number;
}

interface JobRow {
  id: string; type: string; state: string; started_at: string; updated_at: string; heartbeat_at: string | null;
  progress: string | null; error: string | null; result: string | null; instance_id: string; scope: string | null;
}

const FINISHED = new Set<JobState>(['completed', 'failed', 'cancelled', 'interrupted']);

const parseJson = (s: string | null): unknown => {
  if (s == null) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Generic async-job registry — the return-jobId-then-poll pattern that keeps
 * long operations (GSC sync, crawl) off the synchronous MCP tool-call path so
 * they never hit the client timeout. Mirrors better-search-console's sync model.
 *
 * The in-memory Map is the fast path for this process. With a dbPath, every job is also written
 * to a small SQLite registry (on start, on progress at most every ~2 s, on a ~20 s heartbeat, and
 * on finish), so a later process can still answer for it (#9): a finished job's result survives a
 * restart, and a job whose owner died reads as `interrupted` instead of vanishing. Under the
 * Docker MCP gateway each tool call can run in a fresh container, which is exactly that case.
 *
 * Several processes may share one data dir (Claude Desktop plus the gateway), so nothing here
 * rewrites another process's rows. "Interrupted" is decided on read, from a stale heartbeat.
 */
export class JobManager {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private readonly maxRetained: number;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly throttleMs: number;
  private readonly instanceId = randomUUID();
  private db: Database.Database | null = null;
  private warned = false;

  constructor(opts: JobManagerOptions | number = {}) {
    const o: JobManagerOptions = typeof opts === 'number' ? { maxRetained: opts } : opts;
    this.maxRetained = o.maxRetained ?? 50;
    this.heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS;
    this.staleMs = o.staleMs ?? STALE_MS;
    this.throttleMs = o.progressThrottleMs ?? PROGRESS_THROTTLE_MS;
    if (o.dbPath) this.openDb(o.dbPath);
  }

  /** True when jobs are being written to the durable registry. */
  get durable(): boolean {
    return this.db !== null;
  }

  private openDb(dbPath: string): void {
    try {
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 5000');
      db.exec(`CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        heartbeat_at TEXT,
        progress TEXT,
        error TEXT,
        result TEXT,
        instance_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_started ON jobs(started_at);`);
      // scope arrived after the first durable registry shipped: add it to existing files.
      const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[];
      if (!cols.some(c => c.name === 'scope')) db.exec(`ALTER TABLE jobs ADD COLUMN scope TEXT`);
      this.db = db;
    } catch (err) {
      this.db = null;
      this.warn(`could not open the job registry at ${dbPath} (${errText(err)}); jobs are tracked in memory only, so they will not survive a restart.`);
    }
  }

  /** One stderr line per process: stdout is the MCP stdio channel. */
  private warn(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    console.error(`[jobs] ${msg}`);
  }

  private write(job: Job, withResult = false): void {
    if (!this.db) return;
    try {
      let result: string | null = null;
      if (withResult && job.result !== undefined) {
        try {
          const s = JSON.stringify(job.result);
          result = s.length <= MAX_RESULT_BYTES ? s : JSON.stringify({ note: `Result too large to persist (${s.length} bytes); it was only available from the process that ran the job.` });
        } catch { result = null; }
      }
      this.db.prepare(`INSERT INTO jobs (id, type, state, started_at, updated_at, heartbeat_at, progress, error, result, instance_id, scope)
        VALUES (@id, @type, @state, @startedAt, @updatedAt, @heartbeatAt, @progress, @error, @result, @instanceId, @scope)
        ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at, heartbeat_at=excluded.heartbeat_at,
          progress=excluded.progress, error=excluded.error, result=COALESCE(excluded.result, jobs.result)`)
        .run({
          id: job.id, type: job.type, state: job.state, startedAt: job.startedAt, updatedAt: job.updatedAt,
          heartbeatAt: job.heartbeatAt ?? null, progress: JSON.stringify(job.progress ?? {}), error: job.error ?? null,
          result, instanceId: this.instanceId, scope: job.scope ?? null,
        });
    } catch (err) {
      this.warn(`writing to the job registry failed (${errText(err)}); continuing in memory.`);
    }
  }

  /** `opts.scope`: what the job works on (the property DB file name) - see Job.scope. */
  start(type: string, fn: JobFn, opts: { scope?: string } = {}): string {
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const job: Job = { id, type, state: 'running', startedAt: now, updatedAt: now, progress: {} };
    if (opts.scope) job.scope = opts.scope;
    if (this.db) job.heartbeatAt = now;
    const controller = new AbortController();
    this.jobs.set(id, job);
    this.controllers.set(id, controller);
    this.write(job);
    this.prune();

    // Progress is written at most once per throttle window; anything newer is flushed by the
    // next heartbeat or the final write. Starts at 0 so the FIRST update is written straight away -
    // a job that reports once and then works silently (the FTS worker) would otherwise keep that
    // progress out of the registry until the first heartbeat, ~20 s later.
    let lastWrite = 0;
    const update = (p: Record<string, unknown>): void => {
      job.progress = { ...job.progress, ...p };
      job.updatedAt = new Date().toISOString();
      if (job.state === 'running' && this.db && Date.now() - lastWrite >= this.throttleMs) {
        lastWrite = Date.now();
        this.write(job);
      }
    };

    // The heartbeat says "this process is still on it". unref() so a running job never holds
    // the process open on its own.
    const heartbeat = this.db
      ? setInterval(() => {
        if (job.state !== 'running') return;
        job.heartbeatAt = new Date().toISOString();
        lastWrite = Date.now();
        this.write(job);
      }, this.heartbeatMs)
      : null;
    heartbeat?.unref();

    const finish = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      job.updatedAt = new Date().toISOString();
      if (this.db) job.heartbeatAt = job.updatedAt;
      this.write(job, true);
    };

    // Run detached — do NOT await. The tool returns the id immediately.
    // Promise.resolve().then(...) so a synchronous throw in fn becomes a rejection
    // (caught below) rather than an uncaught exception that crashes the MCP process.
    Promise.resolve()
      .then(() => fn(update, controller.signal))
      .then(result => {
        job.result = result;
        job.state = controller.signal.aborted ? 'cancelled' : 'completed';
        finish();
      })
      .catch((err: unknown) => {
        job.state = 'failed';
        job.error = errText(err);
        finish();
        // stdout is the MCP stdio channel, so failures go to stderr (the client's server log).
        console.error(`[job ${id}] ${type} failed: ${job.error}${corruptionHint(job.error)}`);
      })
      .finally(() => this.controllers.delete(id));

    return id;
  }

  /** A DB row as a Job, with a dead owner's `running` reported as `interrupted`. */
  private fromRow(r: JobRow): Job {
    let state = r.state as JobState;
    let error = r.error ?? undefined;
    if (state === 'running' && r.instance_id !== this.instanceId) {
      const beat = Date.parse(r.heartbeat_at ?? r.updated_at);
      if (!Number.isFinite(beat) || Date.now() - beat > this.staleMs) {
        state = 'interrupted';
        error = INTERRUPTED_ERROR;
      }
    }
    const job: Job = {
      id: r.id, type: r.type, state, startedAt: r.started_at, updatedAt: r.updated_at,
      progress: (parseJson(r.progress) as Record<string, unknown> | undefined) ?? {},
    };
    if (r.heartbeat_at) job.heartbeatAt = r.heartbeat_at;
    if (r.scope) job.scope = r.scope;
    if (error !== undefined) job.error = error;
    const result = parseJson(r.result);
    if (result !== undefined) job.result = result;
    return job;
  }

  /** Memory first, then the registry (a job from another or an earlier process). */
  get(id: string): Job | undefined {
    const mem = this.jobs.get(id);
    if (mem) return mem;
    if (!this.db) return undefined;
    try {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
      return row ? this.fromRow(row) : undefined;
    } catch (err) {
      this.warn(`reading the job registry failed (${errText(err)}).`);
      return undefined;
    }
  }

  /** This process's jobs plus recent ones from the registry, newest first. */
  list(): Job[] {
    const out = new Map<string, Job>(this.jobs);
    if (this.db) {
      try {
        const rows = this.db.prepare('SELECT * FROM jobs ORDER BY started_at DESC LIMIT ?').all(this.maxRetained) as JobRow[];
        for (const r of rows) if (!out.has(r.id)) out.set(r.id, this.fromRow(r));
      } catch (err) {
        this.warn(`reading the job registry failed (${errText(err)}).`);
      }
    }
    return [...out.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  /**
   * Jobs that may still be writing, for DESTRUCTIVE guards: this process's running jobs plus any
   * registry row stored as `running` whose heartbeat is within SAFETY_STALE_MS. Deliberately not
   * list()'s derived state, which reads a job `interrupted` once its heartbeat is 90 s stale - an
   * owner that is merely busy (event loop blocked by a long synchronous step) looks dead for a while.
   */
  possiblyRunning(windowMs = SAFETY_STALE_MS): Job[] {
    const out = new Map<string, Job>();
    for (const j of this.jobs.values()) if (j.state === 'running') out.set(j.id, j);
    if (this.db) {
      try {
        const since = new Date(Date.now() - windowMs).toISOString();
        const rows = this.db.prepare(`SELECT * FROM jobs WHERE state = 'running' AND COALESCE(heartbeat_at, updated_at) >= ?`).all(since) as JobRow[];
        for (const r of rows) {
          if (out.has(r.id)) continue;
          const j = this.fromRow(r);
          out.set(r.id, { ...j, state: 'running' }); // a guard treats it as live, whatever list() would show
        }
      } catch (err) {
        this.warn(`reading the job registry failed (${errText(err)}).`);
      }
    }
    return [...out.values()];
  }

  /** Only this process's jobs can be cancelled: another process's job has no handle here. */
  cancel(id: string): boolean {
    const c = this.controllers.get(id);
    if (!c) return false;
    c.abort();
    return true;
  }

  /** Close the registry file (tests, shutdown). Later writes are skipped; memory keeps working. */
  close(): void {
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
  }

  private prune(): void {
    if (this.jobs.size > this.maxRetained) {
      const done = [...this.jobs.values()]
        .filter(j => FINISHED.has(j.state))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
      while (this.jobs.size > this.maxRetained && done.length) {
        this.jobs.delete(done.shift()!.id);
      }
    }
    if (!this.db) return;
    // Keep the newest maxRetained rows. Older rows go when finished, or when "running" with a
    // heartbeat over a day old (an owner that died long ago). A live job is never pruned.
    try {
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
      this.db.prepare(`DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY started_at DESC LIMIT ?)
        AND (state <> 'running' OR COALESCE(heartbeat_at, updated_at) < ?)`).run(this.maxRetained, dayAgo);
    } catch (err) {
      this.warn(`pruning the job registry failed (${errText(err)}).`);
    }
  }
}

/**
 * Job types with a live owner (state running, fresh heartbeat) in a data dir's registry, read
 * without a JobManager - for the dashboard, which may run in its own process. Null when there is
 * no registry to ask (an older server, or memory-only), so callers conclude nothing from it.
 *
 * `scope` (a property's DB file name) narrows it to jobs for that property, so a live crawl on
 * property A no longer vouches for property B's dead one. Rows with no scope (written before it
 * existed) still count for every property: unknown is treated as possibly ours, never as dead.
 */
export function liveJobTypes(dataDir: string, scope?: string | null, staleMs = STALE_MS): Set<string> | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(jobsDbPath(dataDir), { readonly: true, fileMustExist: true });
    const since = new Date(Date.now() - staleMs).toISOString();
    const hasScope = (db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).some(c => c.name === 'scope');
    const rows = (scope && hasScope
      ? db.prepare(`SELECT DISTINCT type FROM jobs WHERE state = 'running' AND COALESCE(heartbeat_at, updated_at) >= ? AND (scope = ? OR scope IS NULL)`).all(since, scope)
      : db.prepare(`SELECT DISTINCT type FROM jobs WHERE state = 'running' AND COALESCE(heartbeat_at, updated_at) >= ?`).all(since)) as { type: string }[];
    return new Set(rows.map(r => r.type));
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
