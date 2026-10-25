// Copyright (c) 2026 Richard Baxter / Houtini — Apache-2.0 (see LICENSE)
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { JobManager, jobsDbPath, RUNNER_STOPPED_ERROR, type ClaimedJob } from './JobManager.js';
import { runJobKind, submitJob, type JobDeps } from './jobKinds.js';
import { startPortfolioScheduler } from './portfolioSchedule.js';
import { PORTFOLIO_JOB_SCOPE } from './PortfolioStore.js';
import { GscClient } from './GscClient.js';
import { GscSync } from './GscSync.js';
import { UrlInspector } from './UrlInspector.js';
import { Crawler } from './Crawler.js';
import { Refresh } from './Refresh.js';
import { DataForSeoClient, dfsCacheDaysFromEnv } from './DataForSeoClient.js';
import { RankTracker } from './RankTracker.js';
import { Backlinks } from './Backlinks.js';
import { MajesticClient } from './MajesticClient.js';
import { WikidataClient } from './WikidataClient.js';
import { Entities } from './Entities.js';
import { CruxSync } from './CruxSync.js';
import { dataForSeoCredentials, optionalSecret, cruxApiKey } from './secrets.js';

/**
 * The job runner (#56): one long-running process that executes the jobs an MCP server queued in
 * `<dataDir>/_jobs.db` with SAC_JOB_RUNNER=external. It exists for the Docker MCP gateway, whose
 * workers are replaced on disconnect, recreate or reap: when the work runs here instead, a worker
 * can go away mid-crawl and the crawl carries on.
 *
 * The loop:
 * - claim the oldest queued job atomically (JobManager.claimNext), up to `concurrency` at once and
 *   never two for the same property;
 * - run it with the same job-kind function, heartbeat, progress throttle and finish write as an
 *   in-process job (JobManager.runClaimed);
 * - poll each running job's cancel flag every few seconds and abort the ones that were cancelled;
 * - heartbeat the runner itself into the `runners` table, so a queued job's status can tell
 *   "waiting for a busy runner" from "no runner is running".
 * On SIGTERM / SIGINT it stops claiming, aborts its running jobs, records them as `interrupted`
 * with a clear message, marks its heartbeat row stopped (with the time) and closes the registry before exiting.
 */

export interface JobRunnerOptions {
  dataDir: string;
  /** Jobs run at once (default 1). Two jobs for the same property never run together. */
  concurrency?: number;
  /** How often to look for queued work when idle (default 1 s). */
  pollMs?: number;
  /** How often to check running jobs' cancel flags (default 2 s; the contract is ≤ 5 s). */
  cancelPollMs?: number;
  /** The runner's own heartbeat (default 10 s; status treats > 60 s silence as "no runner"). */
  heartbeatMs?: number;
  /** On shutdown, how long running jobs get to wind down after their abort (default 8 s, inside docker stop's 10 s). */
  shutdownGraceMs?: number;
  /** Test seam: the per-job heartbeat (default 20 s, as in-process). */
  jobHeartbeatMs?: number;
  deps?: JobDeps;
  log?: (msg: string) => void;
}

const intFromEnv = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number.parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** The data dir, resolved exactly as the MCP server resolves it: SAC_DATA_DIR > ~/.seo-audit-console.json > Documents. */
export function runnerDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.SAC_DATA_DIR?.trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = JSON.parse(readFileSync(path.join(os.homedir(), '.seo-audit-console.json'), 'utf8')) as { dataDir?: string };
    if (cfg.dataDir) return cfg.dataDir;
  } catch { /* no persisted choice */ }
  return path.join(os.homedir(), 'Documents', 'seo-audit-console');
}

/**
 * The clients a job may need, built from the environment the same way the MCP server builds
 * them. The runner therefore needs the same credentials and keys as the MCP server's container.
 */
export function buildJobDeps(dataDir: string, env: NodeJS.ProcessEnv = process.env): JobDeps {
  const credPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  const gsc = credPath ? new GscClient(credPath) : null;
  const sync = gsc ? new GscSync(gsc, dataDir) : null;
  const inspector = gsc ? new UrlInspector(gsc, dataDir) : null;
  const crawler = new Crawler(dataDir);
  // Optional keys read placeholder-safe (#58), the same helpers as the MCP server.
  const dfsCreds = dataForSeoCredentials(env);
  const dfs = dfsCreds
    ? new DataForSeoClient(dfsCreds.user, dfsCreds.pass, path.join(dataDir, 'dataforseo-cache.db'), dfsCacheDaysFromEnv(env))
    : null;
  const rankTracker = dfs ? new RankTracker(dfs, dataDir) : null;
  const majesticKey = optionalSecret('MAJESTIC_API_KEY', env);
  const majestic = majesticKey
    ? new MajesticClient(majesticKey, path.join(dataDir, 'majestic-cache.db'), Number(env.MAJESTIC_CACHE_DAYS) || 30)
    : null;
  const backlinks = dfs ? new Backlinks(dfs, dataDir, majestic) : null;
  const entities = new Entities(new WikidataClient(path.join(dataDir, 'wikidata-cache.db')), dataDir);
  const cruxKey = cruxApiKey(env);
  const cruxSync = cruxKey ? new CruxSync(cruxKey, dataDir) : null;
  const refresh = new Refresh(sync, crawler, inspector, rankTracker, cruxSync);
  return { dataDir: () => dataDir, sync, inspector, crawler, refresh, rankTracker, backlinks, entities, dfs, cruxSync };
}

export class JobRunner {
  readonly jobs: JobManager;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly cancelPollMs: number;
  private readonly heartbeatMs: number;
  private readonly graceMs: number;
  private readonly deps: JobDeps;
  private readonly log: (msg: string) => void;
  private readonly version: string;
  private readonly running = new Map<string, Promise<void>>();
  /** Jobs whose cancel request has already been acted on: aborted (and logged) once, cleared when the job settles. */
  private readonly cancelling = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopping: Promise<void> | null = null;
  private ticking = false;
  private stopScheduler: (() => void) | null = null;

  constructor(opts: JobRunnerOptions) {
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.pollMs = opts.pollMs ?? 1_000;
    this.cancelPollMs = Math.min(opts.cancelPollMs ?? 2_000, 5_000);
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.graceMs = opts.shutdownGraceMs ?? 8_000;
    this.log = opts.log ?? ((m: string) => console.error(`[runner] ${m}`));
    this.jobs = new JobManager({ dbPath: jobsDbPath(opts.dataDir), ...(opts.jobHeartbeatMs ? { heartbeatMs: opts.jobHeartbeatMs } : {}) });
    if (!this.jobs.durable) throw new Error(`The job runner could not open the job registry at ${jobsDbPath(opts.dataDir)}; it has nothing to run without it.`);
    this.deps = opts.deps ?? buildJobDeps(opts.dataDir);
    this.version = packageVersion();
  }

  /** Start the claim, cancel-poll and heartbeat loops. */
  start(): void {
    this.beat();
    this.timers.push(setInterval(() => this.beat(), this.heartbeatMs));
    this.timers.push(setInterval(() => this.pollCancels(), this.cancelPollMs));
    this.timers.push(setInterval(() => this.tick(), this.pollMs));
    this.log(`started (pid ${process.pid}, v${this.version}, concurrency ${this.concurrency}, instance ${this.jobs.instanceId.slice(0, 8)})`);
    // Scheduled portfolio refreshes: the runner is the one long-running process under the gateway.
    // A due run is QUEUED (not run inline) so it goes through the normal claim loop and its limits.
    if (this.deps.dfs) {
      const queue = new JobManager({ dbPath: jobsDbPath(this.deps.dataDir()), runner: 'external' });
      this.stopScheduler = startPortfolioScheduler({
        dataDir: this.deps.dataDir,
        submit: args => submitJob(queue, 'portfolio', args, this.deps, PORTFOLIO_JOB_SCOPE),
        log: m => this.log(`portfolio: ${m}`),
      });
    }
    this.tick();
  }

  /** Claim queued jobs until the concurrency limit is reached or nothing is claimable. */
  private tick(): void {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      while (!this.stopping && this.running.size < this.concurrency) {
        const claimed = this.jobs.claimNext();
        if (!claimed) break;
        this.run(claimed);
      }
    } finally {
      this.ticking = false;
    }
  }

  private run(claimed: ClaimedJob): void {
    const { job, args } = claimed;
    this.log(`claimed ${job.id} ${job.type}${job.scope ? ` (${job.scope})` : ''}`);
    const t0 = Date.now();
    const p = this.jobs
      .runClaimed(claimed, (update, signal) => runJobKind(job.type, args, this.deps, update, signal))
      .then(() => {
        const done = this.jobs.get(job.id);
        this.log(`finished ${job.id} ${job.type}: ${done?.state ?? 'unknown'} in ${Math.round((Date.now() - t0) / 1000)} s${done?.error ? ` (${done.error})` : ''}`);
      })
      .finally(() => {
        this.running.delete(job.id);
        this.cancelling.delete(job.id);
        if (this.stopping) return;
        this.beat();
        // A slot is free: look for the next job straight away rather than on the next poll.
        setImmediate(() => this.tick());
      });
    this.running.set(job.id, p);
    this.beat();
  }

  private pollCancels(): void {
    if (this.stopping) return;
    // A cancelled job keeps its cancel flag (and its controller) until it settles, so it is listed on
    // every poll while it winds down: abort and log it once.
    for (const id of this.jobs.cancelRequests()) {
      if (this.cancelling.has(id)) continue;
      this.cancelling.add(id);
      if (this.jobs.cancel(id)) this.log(`cancel requested for ${id}: aborting`);
    }
  }

  private beat(): void {
    this.jobs.beatRunner({ pid: process.pid, host: os.hostname(), version: this.version, concurrency: this.concurrency, running: this.running.size });
  }

  /**
   * Graceful shutdown: stop claiming, abort every running job (each finishes as `interrupted`
   * with RUNNER_STOPPED_ERROR), give them `shutdownGraceMs` to wind down, record any that ignored
   * the abort as interrupted directly, mark the runner's heartbeat row stopped and close the registry.
   */
  stop(reason = RUNNER_STOPPED_ERROR): Promise<void> {
    if (this.stopping) return this.stopping;
    let done!: () => void;
    this.stopping = new Promise<void>(r => { done = r; });
    void (async () => {
      for (const t of this.timers) clearInterval(t);
      this.timers = [];
      this.stopScheduler?.();
      this.stopScheduler = null;
      const ids = [...this.running.keys()];
      if (ids.length) this.log(`stopping: interrupting ${ids.join(', ')}`);
      for (const id of ids) this.jobs.interrupt(id, reason);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.running.values()]),
        new Promise<void>(r => { timer = setTimeout(r, this.graceMs); }),
      ]);
      if (timer) clearTimeout(timer);
      for (const id of this.running.keys()) this.jobs.markInterrupted(id, reason);
      this.jobs.removeRunner();
      this.jobs.close();
      this.log('stopped');
    })().finally(() => done());
    return this.stopping;
  }
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch { return 'unknown'; }
}

/** The `seo-audit-runner` entry point: options from the environment, signal handling, run until stopped. */
export function runFromEnv(env: NodeJS.ProcessEnv = process.env): JobRunner {
  const dataDir = runnerDataDir(env);
  const runner = new JobRunner({
    dataDir,
    concurrency: intFromEnv(env.SAC_RUNNER_CONCURRENCY, 1, 1, 16),
    pollMs: intFromEnv(env.SAC_RUNNER_POLL_MS, 1_000, 50, 60_000),
    cancelPollMs: intFromEnv(env.SAC_RUNNER_CANCEL_POLL_MS, 2_000, 50, 5_000),
    heartbeatMs: intFromEnv(env.SAC_RUNNER_HEARTBEAT_MS, 10_000, 50, 30_000),
    shutdownGraceMs: intFromEnv(env.SAC_RUNNER_SHUTDOWN_MS, 8_000, 0, 120_000),
    ...(env.SAC_RUNNER_JOB_HEARTBEAT_MS ? { jobHeartbeatMs: intFromEnv(env.SAC_RUNNER_JOB_HEARTBEAT_MS, 20_000, 50, 60_000) } : {}),
  });
  console.error(`[runner] data dir ${dataDir}${env.GOOGLE_APPLICATION_CREDENTIALS ? '' : ' (GSC disabled: GOOGLE_APPLICATION_CREDENTIALS is not set)'}`);
  const onSignal = (sig: string): void => {
    console.error(`[runner] ${sig} received`);
    void runner.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
  runner.start();
  return runner;
}
