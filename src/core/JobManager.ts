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
  /** A queued job's status line: waiting for the job runner, or that no runner seems to be running (#56). */
  note?: string;
  /** Set when a cancel was requested for a job another process (the job runner) owns (#56). */
  cancelRequested?: boolean;
  /**
   * A queued job nothing can claim: no runner has heartbeated recently and it was queued over
   * QUEUED_FRESH_MS ago. Decided on read (the row is never rewritten or deleted for it); such a job
   * does not count as live for destructive guards, and status text shows it as "queued (no runner)".
   */
  noRunner?: boolean;
}

/**
 * Where jobs run (#56). `in-process` (the default, and what bare-metal npx always uses): the MCP
 * process runs the job itself. `external`: the MCP only queues a row in `_jobs.db`, and a separate
 * long-running `seo-audit-runner` process claims and runs it - so the MCP process (a Docker MCP
 * gateway worker) can be replaced mid-job without killing the work.
 */
export type JobRunnerMode = 'in-process' | 'external';
export const jobRunnerModeFromEnv = (env: NodeJS.ProcessEnv = process.env): JobRunnerMode =>
  /^external$/i.test((env.SAC_JOB_RUNNER ?? '').trim()) ? 'external' : 'in-process';

/** The documented runner container, quoted wherever a queued job has no runner to claim it. */
export const RUNNER_DOCKER_RUN =
  'docker run -d --init --name seo-audit-runner --restart unless-stopped -v mcp-sac-data:/data -v mcp-sac-creds:/creds:ro ' +
  '-e SAC_DATA_DIR=/data -e GOOGLE_APPLICATION_CREDENTIALS=/creds/gsc.json ' +
  '-e DATAFORSEO_USERNAME -e DATAFORSEO_PASSWORD -e MAJESTIC_API_KEY -e CRUX_API_KEY ' +
  'node:22-slim npx -y -p @houtini/seo-audit-console seo-audit-runner';
export const QUEUED_NOTE = 'waiting for the job runner';

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
  'Under the Docker MCP gateway, run the job runner sidecar and set SAC_JOB_RUNNER=external on the catalog entry ' +
  "(see README, Docker), and keep longLived: true on this server's catalog entry.";
/** A job the job runner claimed, whose runner stopped heartbeating (killed, crashed, host restarted). */
export const RUNNER_INTERRUPTED_ERROR =
  'The job runner running this job exited before it finished (it was killed, crashed or restarted), so no further work was done. ' +
  'Re-run the job; `docker logs seo-audit-runner` shows why the runner stopped.';
/** Written by a runner that is shutting down cleanly (SIGTERM / SIGINT) with this job still running. */
export const RUNNER_STOPPED_ERROR =
  'The job runner was stopped (SIGTERM, e.g. docker stop or an image update) while this job was running, so it did not finish. ' +
  'Re-run the job once the runner is back up.';

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
/** A runner that has not heartbeated for this long is presumed gone (it beats every ~10 s). */
const RUNNER_STALE_MS = 60_000;
/**
 * A queued job counts as live (it may start writing at any moment) while a runner is heartbeating,
 * or for this long after it was queued - long enough for a runner that is starting up to claim it.
 * Past that, with no runner, nothing can claim it, so it no longer blocks prune / repair.
 */
const QUEUED_FRESH_MS = 2 * 60_000;
const DAY_MS = 86_400_000;
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
  /** `external`: start()-by-kind (submit) queues jobs for the job runner instead of running them (#56). */
  runner?: JobRunnerMode;
  runnerStaleMs?: number;
  queuedFreshMs?: number;
}

/** A queued job a runner has claimed: the row (now `running`, owned by the runner) and its arguments. */
export interface ClaimedJob { job: Job; args: Record<string, unknown> }

/** What a runner reports about itself on each heartbeat. */
export interface RunnerInfo { pid: number; host: string; version: string; concurrency: number; running: number }

interface JobRow {
  id: string; type: string; state: string; started_at: string; updated_at: string; heartbeat_at: string | null;
  progress: string | null; error: string | null; result: string | null; instance_id: string; scope: string | null;
  args: string | null; cancel_requested: number | null;
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
 *
 * External mode (#56): submit() inserts a `queued` row carrying the job's kind and JSON arguments
 * instead of running it, and a job runner process (src/core/jobRunner.ts) claims it atomically
 * with claimNext() and runs it through runClaimed() - the same heartbeat, progress throttle and
 * finish path as an in-process job. The two exceptions to "never rewrite another process's row":
 * cancel() flips a queued row straight to `cancelled`, and sets `cancel_requested` on a runner's
 * running row (the runner polls it). Both are single guarded UPDATEs, so they cannot race a claim.
 */
export class JobManager {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  /** Jobs this process is stopping on purpose (runner shutdown): they finish as `interrupted`. */
  private interrupts = new Map<string, string>();
  private readonly maxRetained: number;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly throttleMs: number;
  private readonly runnerStaleMs: number;
  private readonly queuedFreshMs: number;
  private readonly mode: JobRunnerMode;
  readonly instanceId = randomUUID();
  private db: Database.Database | null = null;
  private warned = false;

  constructor(opts: JobManagerOptions | number = {}) {
    const o: JobManagerOptions = typeof opts === 'number' ? { maxRetained: opts } : opts;
    this.maxRetained = o.maxRetained ?? 50;
    this.heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS;
    this.staleMs = o.staleMs ?? STALE_MS;
    this.throttleMs = o.progressThrottleMs ?? PROGRESS_THROTTLE_MS;
    this.runnerStaleMs = o.runnerStaleMs ?? RUNNER_STALE_MS;
    this.queuedFreshMs = o.queuedFreshMs ?? QUEUED_FRESH_MS;
    this.mode = o.runner ?? 'in-process';
    if (o.dbPath) this.openDb(o.dbPath);
  }

  /** True when jobs are being written to the durable registry. */
  get durable(): boolean {
    return this.db !== null;
  }

  /** True when submit() queues jobs for an external job runner (needs the durable registry). */
  get external(): boolean {
    return this.mode === 'external' && this.db !== null;
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
      CREATE INDEX IF NOT EXISTS jobs_started ON jobs(started_at);
      CREATE TABLE IF NOT EXISTS runners (
        instance_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        info TEXT
      );`);
      // Columns added after the first durable registry shipped: add them to existing files.
      // scope (0.15), and for the job runner (#56) the queued job's arguments + the cancel flag.
      const cols = new Set((db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map(c => c.name));
      if (!cols.has('scope')) db.exec(`ALTER TABLE jobs ADD COLUMN scope TEXT`);
      if (!cols.has('args')) db.exec(`ALTER TABLE jobs ADD COLUMN args TEXT`);
      if (!cols.has('cancel_requested')) db.exec(`ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0`);
      // 0.16.1: a cleanly stopped runner keeps its row, marked stopped, so the queued-job advice can
      // say when the last runner stopped instead of "no runner has ever checked in".
      const rcols = new Set((db.prepare(`PRAGMA table_info(runners)`).all() as { name: string }[]).map(c => c.name));
      if (!rcols.has('stopped_at')) db.exec(`ALTER TABLE runners ADD COLUMN stopped_at TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, started_at)`);
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
    this.write(job);
    this.prune();
    // Run detached — do NOT await. The tool returns the id immediately.
    void this.launch(job, fn);
    return id;
  }

  /**
   * Start a job of a named kind from its arguments (#56). In external mode it is queued for the
   * job runner and `run` is not called here; otherwise `run` runs in this process. The arguments
   * are JSON round-tripped on both paths, so in-process runs see exactly what a runner would read
   * back from the registry. External mode without a registry falls back to running in-process.
   */
  submit(
    type: string,
    args: Record<string, unknown>,
    run: (args: Record<string, unknown>, update: (p: Record<string, unknown>) => void, signal: AbortSignal) => Promise<unknown>,
    opts: { scope?: string } = {},
  ): string {
    const plain = JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>;
    if (this.mode === 'external') {
      const id = this.db ? this.enqueue(type, plain, opts) : null;
      if (id) return id;
      this.warn('SAC_JOB_RUNNER=external, but the job registry is unavailable, so jobs cannot be queued for a runner; running them in this process.');
    }
    return this.start(type, (update, signal) => run(plain, update, signal), opts);
  }

  /** Insert a `queued` row for a job runner to claim. Null if the registry write failed. */
  private enqueue(type: string, args: Record<string, unknown>, opts: { scope?: string }): string | null {
    if (!this.db) return null;
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO jobs (id, type, state, started_at, updated_at, heartbeat_at, progress, error, result, instance_id, scope, args, cancel_requested)
        VALUES (?, ?, 'queued', ?, ?, NULL, '{}', NULL, NULL, ?, ?, ?, 0)`)
        .run(id, type, now, now, this.instanceId, opts.scope ?? null, JSON.stringify(args));
    } catch (err) {
      this.warn(`queueing a job in the registry failed (${errText(err)}).`);
      return null;
    }
    this.prune();
    return id;
  }

  /**
   * Run a job body against an in-memory Job that is already in the registry: heartbeat,
   * throttled progress, and the finish write. Shared by start() and the runner's runClaimed(),
   * so in-process and runner jobs report identically. Resolves when the job has settled.
   */
  private launch(job: Job, fn: JobFn): Promise<void> {
    const id = job.id;
    const controller = new AbortController();
    this.jobs.set(id, job);
    this.controllers.set(id, controller);

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
      const why = this.interrupts.get(id);
      if (why !== undefined) { job.state = 'interrupted'; job.error = why; }
      job.updatedAt = new Date().toISOString();
      if (this.db) job.heartbeatAt = job.updatedAt;
      this.write(job, true);
    };

    // The body starts on a later turn of the event loop (setImmediate), never in this one: a job's
    // first synchronous stretch (opening a multi-GB database, a planning query) would otherwise run
    // in the microtask queue ahead of the tool's own reply, so the client waited on the job's DB
    // work before it saw the job id (33.8 s for sync_gsc on a 5.5 GB property in 0.16.1).
    // Run through a promise so a synchronous throw in fn becomes a rejection (caught below)
    // rather than an uncaught exception that crashes the MCP process.
    return new Promise<void>(resolve => setImmediate(resolve))
      .then(() => fn(update, controller.signal))
      .then(result => {
        job.result = result;
        job.state = controller.signal.aborted ? 'cancelled' : 'completed';
        finish();
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) {
          // Stopped on purpose: a cancel (or a runner shutdown, which finish() turns into
          // interrupted). The abort error is how the work stopped, not why it failed.
          job.state = 'cancelled';
        } else {
          job.state = 'failed';
          job.error = errText(err);
        }
        finish();
        // stdout is the MCP stdio channel, so failures go to stderr (the client's server log).
        if (job.state === 'failed') console.error(`[job ${id}] ${job.type} failed: ${job.error}${corruptionHint(job.error)}`);
      })
      .finally(() => { this.controllers.delete(id); this.interrupts.delete(id); });
  }

  // ── Job runner side (#56) ────────────────────────────────────────────────────────────────────

  /**
   * Atomically claim the oldest queued job, for a job runner. One UPDATE ... RETURNING under an
   * IMMEDIATE transaction: the write lock is taken before the row is chosen, so two runners can
   * never claim the same job. A job is skipped while another job for the same property (scope) is
   * live - stored running with a fresh heartbeat, in a runner or any in-process MCP - so one
   * property never has two jobs at once. Returns null when nothing is claimable.
   */
  claimNext(): ClaimedJob | null {
    if (!this.db) return null;
    const db = this.db;
    const now = new Date().toISOString();
    const fresh = new Date(Date.now() - this.staleMs).toISOString();
    const claim = db.transaction((): JobRow | undefined => db.prepare(`UPDATE jobs
        SET state = 'running', instance_id = @me, heartbeat_at = @now, updated_at = @now
      WHERE id = (
        SELECT q.id FROM jobs q
        WHERE q.state = 'queued' AND q.args IS NOT NULL
          AND (q.scope IS NULL OR NOT EXISTS (
            SELECT 1 FROM jobs r WHERE r.state = 'running' AND r.scope = q.scope
              AND COALESCE(r.heartbeat_at, r.updated_at) >= @fresh))
        ORDER BY q.started_at, q.rowid LIMIT 1)
        AND state = 'queued'
      RETURNING *`).get({ me: this.instanceId, now, fresh }) as JobRow | undefined);
    let row: JobRow | undefined;
    try {
      row = claim.immediate();
    } catch (err) {
      this.warn(`claiming a queued job failed (${errText(err)}).`);
      return null;
    }
    if (!row) return null;
    const job = this.fromRow(row);
    return { job, args: (parseJson(row.args) as Record<string, unknown> | undefined) ?? {} };
  }

  /** Run a claimed job here (the runner). Resolves when it has finished, failed or been stopped. */
  runClaimed(claimed: ClaimedJob, fn: JobFn): Promise<void> {
    const job: Job = { ...claimed.job, state: 'running', heartbeatAt: new Date().toISOString() };
    delete job.note;
    return this.launch(job, fn);
  }

  /** This process's running jobs whose cancel flag another process has set (the runner polls this). */
  cancelRequests(): string[] {
    if (!this.db) return [];
    try {
      return (this.db.prepare(`SELECT id FROM jobs WHERE instance_id = ? AND state = 'running' AND cancel_requested = 1`).all(this.instanceId) as { id: string }[])
        .map(r => r.id).filter(id => this.controllers.has(id));
    } catch (err) {
      this.warn(`reading cancel requests failed (${errText(err)}).`);
      return [];
    }
  }

  /** Stop one of this process's jobs on purpose: it finishes as `interrupted` with `reason`. */
  interrupt(id: string, reason: string): boolean {
    const c = this.controllers.get(id);
    if (!c) return false;
    this.interrupts.set(id, reason);
    c.abort();
    return true;
  }

  /** IDs of the jobs this process is running right now. */
  runningIds(): string[] {
    return [...this.controllers.keys()];
  }

  /**
   * Last resort for a job that ignored its abort signal during a shutdown: record it as
   * interrupted directly (only while it is still this process's running row).
   */
  markInterrupted(id: string, reason: string): void {
    const mem = this.jobs.get(id);
    if (mem && mem.state === 'running') { mem.state = 'interrupted'; mem.error = reason; }
    if (!this.db) return;
    try {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE jobs SET state = 'interrupted', error = ?, updated_at = ?, heartbeat_at = ? WHERE id = ? AND state = 'running' AND instance_id = ?`)
        .run(reason, now, now, id, this.instanceId);
    } catch (err) {
      this.warn(`marking job ${id} interrupted failed (${errText(err)}).`);
    }
  }

  /** The runner's own heartbeat: "a runner is alive and claiming jobs from this registry". */
  beatRunner(info: RunnerInfo): void {
    if (!this.db) return;
    try {
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO runners (instance_id, started_at, heartbeat_at, info) VALUES (?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, info = excluded.info, stopped_at = NULL`)
        .run(this.instanceId, now, now, JSON.stringify(info));
      this.db.prepare(`DELETE FROM runners WHERE heartbeat_at < ?`).run(new Date(Date.now() - DAY_MS).toISOString());
    } catch (err) {
      this.warn(`writing the runner heartbeat failed (${errText(err)}).`);
    }
  }

  /**
   * A clean shutdown marks the runner's row stopped (0.16.1; it used to delete it), so status text
   * stops counting it as alive at once but can still say when the last runner stopped.
   */
  removeRunner(): void {
    try { this.db?.prepare(`UPDATE runners SET stopped_at = ? WHERE instance_id = ?`).run(new Date().toISOString(), this.instanceId); } catch { /* closing anyway */ }
  }

  /** The newest heartbeat of a runner that hasn't stopped, or null when none is registered. */
  lastRunnerBeat(): string | null {
    if (!this.db) return null;
    try {
      const r = this.db.prepare(`SELECT MAX(heartbeat_at) at FROM runners WHERE stopped_at IS NULL`).get() as { at: string | null } | undefined;
      return r?.at ?? null;
    } catch { return null; }
  }

  /** The most recently seen runner: its last heartbeat, and when it stopped if it shut down cleanly. Null if none ever checked in. */
  lastRunnerSeen(): { heartbeatAt: string; stoppedAt: string | null } | null {
    if (!this.db) return null;
    try {
      const r = this.db.prepare(`SELECT heartbeat_at, stopped_at FROM runners ORDER BY COALESCE(stopped_at, heartbeat_at) DESC LIMIT 1`).get() as { heartbeat_at: string; stopped_at: string | null } | undefined;
      return r ? { heartbeatAt: r.heartbeat_at, stoppedAt: r.stopped_at ?? null } : null;
    } catch { return null; }
  }

  /** True when some runner heartbeated within the last ~60 s. */
  runnerAlive(): boolean {
    const at = this.lastRunnerBeat();
    const t = at ? Date.parse(at) : NaN;
    return Number.isFinite(t) && Date.now() - t <= this.runnerStaleMs;
  }

  /**
   * Whether a queued job may still be claimed: a runner heartbeated within ~60 s (it will claim the
   * job, whichever process queued it - so this does not depend on this process's own mode), or the
   * job was queued under QUEUED_FRESH_MS ago (a runner may be starting). `alive` lets a caller
   * checking many rows read the runners table once.
   */
  queuedIsLive(queuedAt: string, alive: boolean = this.runnerAlive()): boolean {
    if (alive) return true;
    const waited = Date.now() - Date.parse(queuedAt);
    return Number.isFinite(waited) && waited < this.queuedFreshMs;
  }

  /**
   * The status line for a queued job. "waiting for the job runner" - unless it has waited over
   * ~60 s and no runner has heartbeated in that time, when it says no runner seems to be running
   * and how to start one.
   */
  queuedNote(queuedAt: string): string {
    if (this.runnerAlive()) return QUEUED_NOTE;
    const waited = Date.now() - Date.parse(queuedAt);
    if (!Number.isFinite(waited) || waited <= this.runnerStaleMs) return QUEUED_NOTE;
    return this.noRunnerAdvice();
  }

  /** "No runner seems to be running", with the last-seen time and the docker run line. */
  noRunnerAdvice(): string {
    const last = this.lastRunnerSeen();
    const seen = !last ? 'no runner has ever checked in to this data directory'
      : last.stoppedAt ? `the last runner stopped at ${last.stoppedAt}`
      : `the last runner heartbeat was at ${last.heartbeatAt}`;
    return `${QUEUED_NOTE}, but no job runner seems to be running (${seen}). ` +
      `This server is set to SAC_JOB_RUNNER=external, so jobs only run when a runner claims them. Start one on the same data volume: ${RUNNER_DOCKER_RUN} ` +
      '(the bare -e DATAFORSEO_* / MAJESTIC_API_KEY / CRUX_API_KEY flags copy those keys from your shell: the runner needs the same keys as the MCP server, so drop only the ones you do not use; on Windows Git Bash prefix MSYS_NO_PATHCONV=1). The job stays queued until a runner picks it up.';
  }

  /** What to say when a job has just been queued: the waiting line, plus the advice if no runner is alive. */
  queuedHint(): string {
    return this.runnerAlive()
      ? `Queued for the job runner (${QUEUED_NOTE}).`
      : `Queued, but no job runner has heartbeated in the last ${Math.round(this.runnerStaleMs / 1000)} s. If it stays queued: ${this.noRunnerAdvice()}`;
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────

  /** A DB row as a Job, with a dead owner's `running` reported as `interrupted`. */
  private fromRow(r: JobRow): Job {
    let state = r.state as JobState;
    let error = r.error ?? undefined;
    let note: string | undefined;
    if (state === 'running' && r.instance_id !== this.instanceId) {
      const beat = Date.parse(r.heartbeat_at ?? r.updated_at);
      if (!Number.isFinite(beat) || Date.now() - beat > this.staleMs) {
        state = 'interrupted';
        // A row with stored arguments was claimed by a job runner; anything else ran in an MCP process.
        error = r.args != null ? RUNNER_INTERRUPTED_ERROR : INTERRUPTED_ERROR;
      }
    }
    let noRunner = false;
    if (state === 'queued') {
      note = this.queuedNote(r.started_at);
      noRunner = !this.queuedIsLive(r.started_at);
    }
    const job: Job = {
      id: r.id, type: r.type, state, startedAt: r.started_at, updatedAt: r.updated_at,
      progress: (parseJson(r.progress) as Record<string, unknown> | undefined) ?? {},
    };
    if (r.heartbeat_at) job.heartbeatAt = r.heartbeat_at;
    if (r.scope) job.scope = r.scope;
    if (error !== undefined) job.error = error;
    if (note !== undefined) job.note = note;
    if (r.cancel_requested && state === 'running') job.cancelRequested = true;
    if (noRunner) job.noRunner = true;
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
   * Queued jobs (#56) count too, reported as `queued`, while something can claim them (queuedIsLive:
   * a runner heartbeated recently, or the job was queued in the last ~2 min). A queued row nothing can
   * claim is stale and does not block prune / repair; it stays in the registry, marked noRunner.
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
        const queued = this.db.prepare(`SELECT * FROM jobs WHERE state = 'queued' AND started_at >= ?`).all(new Date(Date.now() - DAY_MS).toISOString()) as JobRow[];
        const alive = queued.length ? this.runnerAlive() : false;
        for (const r of queued) if (!out.has(r.id) && this.queuedIsLive(r.started_at, alive)) out.set(r.id, this.fromRow(r));
      } catch (err) {
        this.warn(`reading the job registry failed (${errText(err)}).`);
      }
    }
    return [...out.values()];
  }

  /**
   * Cancel a job. This process's own job is aborted at once. Otherwise, through the registry
   * (#56): a queued job is marked `cancelled` before any runner can claim it, and a job runner's
   * running job gets `cancel_requested`, which the runner polls (every few seconds) and turns into
   * an abort. A running job owned by another MCP process has no handle here, so that stays false.
   */
  cancel(id: string): boolean {
    const c = this.controllers.get(id);
    if (c) { c.abort(); return true; }
    if (!this.db) return false;
    try {
      const now = new Date().toISOString();
      const q = this.db.prepare(`UPDATE jobs SET state = 'cancelled', cancel_requested = 1, updated_at = ?, error = 'Cancelled before a job runner picked it up.' WHERE id = ? AND state = 'queued'`).run(now, id);
      if (q.changes) return true;
      const r = this.db.prepare(`UPDATE jobs SET cancel_requested = 1 WHERE id = ? AND state = 'running' AND args IS NOT NULL`).run(id);
      return r.changes > 0;
    } catch (err) {
      this.warn(`writing a cancel request failed (${errText(err)}).`);
      return false;
    }
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
    // Keep the newest maxRetained rows. Older rows go when finished, or when "running" / "queued"
    // and over a day old (an owner that died long ago, a queue no runner ever served). A live or
    // waiting job is never pruned.
    try {
      const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
      this.db.prepare(`DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY started_at DESC LIMIT ?)
        AND (state NOT IN ('running', 'queued') OR COALESCE(heartbeat_at, updated_at) < ?)`).run(this.maxRetained, dayAgo);
    } catch (err) {
      this.warn(`pruning the job registry failed (${errText(err)}).`);
    }
  }
}

/** liveJobTypes()'s answer: the live job types, plus (#56) the types queued for a job runner. */
export interface LiveJobs extends Set<string> {
  /** Types queued with something able to claim them (a fresh runner heartbeat, or queued in the last ~2 min). */
  queued?: Set<string>;
  /** Types queued (under a day ago) that nothing can claim: no runner is heartbeating. Shown, never live. */
  queuedNoRunner?: Set<string>;
}

/**
 * Job types with a live owner (state running, fresh heartbeat) in a data dir's registry, read
 * without a JobManager - for the dashboard, which may run in its own process. Null when there is
 * no registry to ask (an older server, or memory-only), so callers conclude nothing from it.
 *
 * `scope` (a property's DB file name) narrows it to jobs for that property, so a live crawl on
 * property A no longer vouches for property B's dead one. Rows with no scope (written before it
 * existed) still count for every property: unknown is treated as possibly ours, never as dead.
 *
 * `.queued` (#56) carries the types waiting in the queue for a job runner (under a day old) that a
 * runner can still claim (a runner heartbeat within ~60 s, or queued in the last ~2 min), so the
 * dashboard can say "queued" instead of showing the last finished run as current. Queued rows past
 * that with no live runner go in `.queuedNoRunner` instead: shown as "queued: no job runner", not live.
 */
export function liveJobTypes(dataDir: string, scope?: string | null, staleMs = STALE_MS): LiveJobs | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(jobsDbPath(dataDir), { readonly: true, fileMustExist: true });
    const since = new Date(Date.now() - staleMs).toISOString();
    const hasScope = (db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).some(c => c.name === 'scope');
    const byScope = !!(scope && hasScope);
    const rows = (byScope
      ? db.prepare(`SELECT DISTINCT type FROM jobs WHERE state = 'running' AND COALESCE(heartbeat_at, updated_at) >= ? AND (scope = ? OR scope IS NULL)`).all(since, scope)
      : db.prepare(`SELECT DISTINCT type FROM jobs WHERE state = 'running' AND COALESCE(heartbeat_at, updated_at) >= ?`).all(since)) as { type: string }[];
    const out: LiveJobs = new Set(rows.map(r => r.type));
    const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
    const queued = (byScope
      ? db.prepare(`SELECT type, started_at FROM jobs WHERE state = 'queued' AND started_at >= ? AND (scope = ? OR scope IS NULL)`).all(dayAgo, scope)
      : db.prepare(`SELECT type, started_at FROM jobs WHERE state = 'queued' AND started_at >= ?`).all(dayAgo)) as { type: string; started_at: string }[];
    const hasRunners = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runners'`).get();
    const hasStopped = hasRunners && (db.prepare(`PRAGMA table_info(runners)`).all() as { name: string }[]).some(c => c.name === 'stopped_at');
    const beat = hasRunners ? (db.prepare(`SELECT MAX(heartbeat_at) at FROM runners${hasStopped ? ' WHERE stopped_at IS NULL' : ''}`).get() as { at: string | null } | undefined)?.at ?? null : null;
    const beatMs = beat ? Date.parse(beat) : NaN;
    const runnerAlive = Number.isFinite(beatMs) && Date.now() - beatMs <= RUNNER_STALE_MS;
    const freshSince = Date.now() - QUEUED_FRESH_MS;
    out.queued = new Set();
    out.queuedNoRunner = new Set();
    for (const r of queued) {
      const t = Date.parse(r.started_at);
      if (runnerAlive || (Number.isFinite(t) && t > freshSince)) out.queued.add(r.type);
      else out.queuedNoRunner.add(r.type);
    }
    for (const t of out.queued) out.queuedNoRunner.delete(t);
    return out;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
