// Copyright (c) 2026 Richard Baxter / Houtini — Apache-2.0 (see LICENSE)
import type { GscSync } from './GscSync.js';
import type { UrlInspector } from './UrlInspector.js';
import type { Crawler } from './Crawler.js';
import type { Refresh } from './Refresh.js';
import type { RankTracker } from './RankTracker.js';
import type { Backlinks } from './Backlinks.js';
import type { Entities } from './Entities.js';
import type { DataForSeoClient } from './DataForSeoClient.js';
import type { CruxSync } from './CruxSync.js';
import path from 'node:path';
import type { FetchOptions } from './types.js';
import type { FtsIndex } from './fts.js';
import type { JobManager } from './JobManager.js';
import { checkIntegrity, repairIndexes } from './integrity.js';
import { backfillInWorker } from './fts.js';
import { auditRender } from './renderAudit.js';
import { findNearDuplicates } from './nearDuplicate.js';
import { runReconJob, type ReconJobArgs } from './reconJob.js';
import { runPortfolioRefresh, type PortfolioRefreshArgs } from './PortfolioRefresh.js';
import { getDashboardDataAsync } from './dashboardAsync.js';

/**
 * The named job kinds (#56). Every async job the MCP starts is one of these, run from its
 * arguments alone: in the MCP process (the default) or, with SAC_JOB_RUNNER=external, by the
 * job runner from the arguments stored on the queued `_jobs.db` row. Both paths call the same
 * function here, so a job behaves the same wherever it runs.
 *
 * The kind names are the job `type` strings that were already in the registry ('sync', 'crawl',
 * 'refresh', ...), so status text, liveJobTypes() and dashboard freshness read them unchanged.
 * run_audit is not here: it is a synchronous tool, not a job.
 */

export type Update = (p: Record<string, unknown>) => void;
type Body = (update: Update, signal: AbortSignal) => Promise<unknown>;

/** What a job kind may use. The MCP builds one from its clients; the runner builds its own. */
export interface JobDeps {
  dataDir: () => string;
  sync: GscSync | null;
  inspector: UrlInspector | null;
  crawler: Crawler;
  refresh: Refresh;
  rankTracker: RankTracker | null;
  backlinks: Backlinks | null;
  entities: Entities;
  dfs: DataForSeoClient | null;
  /** CrUX field data (#55); null when CRUX_API_KEY is unset or a placeholder. */
  cruxSync: CruxSync | null;
  /**
   * MCP process only: after a data job (sync, crawl, inspect, refresh) start the browser
   * dashboard and put its link on the result. The runner has no reachable dashboard port, so it
   * leaves this out and the status reply points at get_dashboard / open_dashboard instead.
   */
  withDashboard?: (siteUrl: string, fn: Body) => Body;
}

const NO_GSC = 'GOOGLE_APPLICATION_CREDENTIALS is not set — required for Search Console access.';
const NO_DFS = 'DATAFORSEO_USERNAME / DATAFORSEO_PASSWORD not set — required for DataForSEO.';
const NO_CRUX = 'CRUX_API_KEY is not set (or still a placeholder) - required for CrUX.';
const need = <T>(v: T | null, msg: string): T => {
  if (!v) throw new Error(msg);
  return v;
};
/**
 * A data job (sync, crawl, inspect, refresh, CrUX) changes what the dashboard shows, so its cached
 * payload is stale the moment the job finishes. Rebuild it in the background (a worker thread), so
 * the next dashboard load is instant instead of a cold build. Best-effort: a failure costs nothing.
 */
const warmDashboard = (fn: Body, deps: JobDeps, siteUrl: string): Body => async (update, signal) => {
  const result = await fn(update, signal);
  if (!signal.aborted) void getDashboardDataAsync(deps.dataDir(), siteUrl).catch(() => { /* warm-up only */ });
  return result;
};
const dataJob = (deps: JobDeps, siteUrl: string, fn: Body): Body => {
  const warm = warmDashboard(fn, deps, siteUrl);
  return deps.withDashboard ? deps.withDashboard(siteUrl, warm) : warm;
};

/** Arguments per kind. Property kinds carry siteUrl (their scope is derived from it); the portfolio
 * kind is cross-property and is scoped to '_portfolio.db' instead. */
export interface JobArgsByKind {
  sync: { siteUrl: string; options: FetchOptions };
  crawl: { siteUrl: string } & Parameters<Crawler['run']>[1];
  inspect: { siteUrl: string; limit?: number };
  refresh: { siteUrl: string } & Parameters<Refresh['run']>[1];
  rank_history: { siteUrl: string; location?: string | number };
  backlinks: { siteUrl: string } & Parameters<Backlinks['run']>[1];
  entities: { siteUrl: string; limit?: number; language?: string };
  render: { siteUrl: string; limit?: number; urls?: string[] };
  duplicates: { siteUrl: string; threshold?: number; limit?: number };
  integrity: { siteUrl: string; mode: 'quick' | 'full' };
  repair: { siteUrl: string };
  /** `dbName`: the property DB's FILE NAME (as the job scope), never an absolute path - the process
   * that runs the job resolves it in its own data dir, which a runner may mount at another path. */
  'fts-index': { siteUrl: string; dbName: string; indexes: FtsIndex[] };
  recon: ReconJobArgs;
  crux: { siteUrl: string } & Parameters<CruxSync['run']>[1];
  portfolio: PortfolioRefreshArgs;
}
export type JobKindName = keyof JobArgsByKind;

type KindFn<K extends JobKindName> = (args: JobArgsByKind[K], deps: JobDeps, update: Update, signal: AbortSignal) => Promise<unknown>;

export const JOB_KINDS: { [K in JobKindName]: KindFn<K> } = {
  sync: ({ siteUrl, options }, deps, update, signal) =>
    dataJob(deps, siteUrl, (u, s) => need(deps.sync, NO_GSC).run(siteUrl, options, u, s))(update, signal),
  crawl: ({ siteUrl, ...opts }, deps, update, signal) =>
    dataJob(deps, siteUrl, (u, s) => deps.crawler.run(siteUrl, opts, u, s))(update, signal),
  inspect: ({ siteUrl, limit }, deps, update, signal) =>
    dataJob(deps, siteUrl, (u, s) => need(deps.inspector, NO_GSC).run(siteUrl, { limit }, u, s))(update, signal),
  refresh: ({ siteUrl, ...opts }, deps, update, signal) =>
    dataJob(deps, siteUrl, (u, s) => deps.refresh.run(siteUrl, opts, u, s))(update, signal),
  rank_history: ({ siteUrl, location }, deps, update, signal) =>
    need(deps.rankTracker, NO_DFS).run(siteUrl, { location }, update, signal),
  backlinks: ({ siteUrl, ...opts }, deps, update, signal) =>
    need(deps.backlinks, NO_DFS).run(siteUrl, opts, update, signal),
  entities: ({ siteUrl, limit, language }, deps, update, signal) =>
    deps.entities.run(siteUrl, { ...(limit != null ? { limit } : {}), ...(language ? { language } : {}) }, update, signal),
  render: ({ siteUrl, limit, urls }, deps, update, signal) =>
    auditRender(deps.dataDir(), siteUrl, { ...(limit != null ? { limit } : {}), ...(urls?.length ? { urls } : {}) }, update, signal),
  duplicates: ({ siteUrl, threshold, limit }, deps) =>
    findNearDuplicates(deps.dataDir(), siteUrl, { ...(threshold != null ? { threshold } : {}), ...(limit != null ? { limit } : {}) }),
  integrity: ({ siteUrl, mode }, deps) => checkIntegrity(deps.dataDir(), siteUrl, mode),
  repair: ({ siteUrl }, deps) => repairIndexes(deps.dataDir(), siteUrl),
  'fts-index': async ({ siteUrl, dbName, indexes }, deps, update, signal) => {
    const dbFile = ftsDbFile(deps.dataDir(), dbName);
    update({ dbFile, siteUrl, indexes });
    return backfillInWorker(dbFile, indexes, signal);
  },
  recon: (args, deps, update, signal) => runReconJob(deps.dataDir(), need(deps.dfs, NO_DFS), args, update, signal),
  crux: ({ siteUrl, ...opts }, deps, update, signal) =>
    dataJob(deps, siteUrl, (u, s) => need(deps.cruxSync, NO_CRUX).run(siteUrl, opts, u, s))(update, signal),
  portfolio: (args, deps, update, signal) =>
    runPortfolioRefresh(deps.dataDir(), need(deps.dfs, NO_DFS), deps.rankTracker, args, update, signal),
};

/** The fts-index job's database, resolved in THIS process's data dir from the stored bare file name. */
export function ftsDbFile(dataDir: string, dbName: string): string {
  if (!dbName || path.basename(dbName) !== dbName || !dbName.endsWith('.db')) {
    throw new Error(`fts-index: "${dbName}" is not a property database file name.`);
  }
  return path.join(dataDir, dbName);
}

export const isJobKind = (type: string): type is JobKindName => Object.prototype.hasOwnProperty.call(JOB_KINDS, type);

/** Run one kind from its (stored) arguments. Unknown kinds fail with a version-skew hint. */
export function runJobKind(type: string, args: Record<string, unknown>, deps: JobDeps, update: Update, signal: AbortSignal): Promise<unknown> {
  if (!isJobKind(type)) {
    return Promise.reject(new Error(`Unknown job type "${type}". The process running it is older or newer than the MCP server that queued it: run the same @houtini/seo-audit-console version in both.`));
  }
  return (JOB_KINDS[type] as KindFn<JobKindName>)(args as unknown as JobArgsByKind[JobKindName], deps, update, signal);
}

/**
 * Start a job of a named kind: queued for the job runner when the manager is in external mode,
 * otherwise run here. The arguments are JSON round-tripped on both paths, so a kind never sees
 * anything in-process that the runner could not have read back from the registry.
 */
export function submitJob<K extends JobKindName>(jobs: JobManager, kind: K, args: JobArgsByKind[K], deps: JobDeps, scope?: string): string {
  return jobs.submit(kind, args as unknown as Record<string, unknown>, (a, update, signal) => runJobKind(kind, a, deps, update, signal), scope ? { scope } : {});
}
