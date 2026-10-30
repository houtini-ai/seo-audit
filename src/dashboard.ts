#!/usr/bin/env node
// Copyright (c) 2026 Richard Baxter / Houtini — Apache-2.0 (see LICENSE)
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDashboardServer, stopDashboardServer } from './core/webServer.js';
import { buildWebCallHandlers } from './core/webHandlers.js';
import { JobManager, jobsDbPath, jobRunnerModeFromEnv, runnerAlive } from './core/JobManager.js';
import { buildJobDeps } from './core/jobRunner.js';
import { DataForSeoClient, dfsCacheDaysFromEnv } from './core/DataForSeoClient.js';
import { resolveDataDir } from './core/paths.js';
import { dataForSeoCredentials, optionalSecret } from './core/secrets.js';

/**
 * Standalone dashboard server — the Docker-aware delivery surface.
 *
 * The MCP server itself talks stdio behind the Docker MCP gateway, which does NOT publish
 * container ports, so a dashboard served from inside the MCP container is unreachable from the
 * host. This entrypoint is a SEPARATE, publishable process: it mounts the same SAC_DATA_DIR (the
 * shared `mcp-sac-data` volume, writable: the dashboard actions start jobs) and serves the exact same dashboard on a fixed,
 * published port — so the reports get a stable URL that always reflects the live database.
 *
 * Run it as a sidecar container (the image ENTRYPOINT is `node dist/index.js`, so override it —
 * bins aren't on PATH in the runtime image; WORKDIR is /app):
 *   docker run -d --name seo-audit-dashboard \
 *     -p 127.0.0.1:8788:8788 \
 *     -e SAC_DASHBOARD_BIND=0.0.0.0 -e SAC_DASHBOARD_PORT=8788 -e SAC_DATA_DIR=/data \
 *     -v mcp-sac-data:/data \
 *     --entrypoint node houtini-seo-audit-local:latest dist/dashboard.js
 * then open http://127.0.0.1:8788/. DataForSEO creds (optional) enable the Content-research tab.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same resolution as the MCP server: SAC_DATA_DIR > the data_location choice > Documents default (#50).
const DATA_DIR = resolveDataDir();
const dataDir = (): string => DATA_DIR;

// Optional keys are read placeholder-safe (#58), same helper as the MCP server.
const dfsCreds = dataForSeoCredentials();
const dfs = dfsCreds
  ? new DataForSeoClient(dfsCreds.user, dfsCreds.pass, path.join(DATA_DIR, 'dataforseo-cache.db'), dfsCacheDaysFromEnv())
  : null;
const majesticOn = !!optionalSecret('MAJESTIC_API_KEY');
const apiKeys = (): { dataforseo: boolean; majestic: boolean } => ({
  dataforseo: !!dfs,
  majestic: majesticOn,
});

// Same built UI the MCP serves (Vite output tree: dist/src/ui/dashboard.html, next to this file).
const uiHtml = (): string => readFileSync(path.join(__dirname, 'src', 'ui', 'dashboard.html'), 'utf8');

// Dashboard actions (crawl, sync, inspect). Under the Docker gateway this container has no Search
// Console credentials, so a job is queued for the job runner whenever one is alive (or
// SAC_JOB_RUNNER=external says so); with no runner, the job runs here, where a crawl still works.
const jobDeps = buildJobDeps(DATA_DIR);
const queue = new JobManager({ dbPath: jobsDbPath(DATA_DIR), runner: 'external' });
const local = new JobManager({ dbPath: jobsDbPath(DATA_DIR) });
const pickJobs = (): JobManager => (jobRunnerModeFromEnv() === 'external' || runnerAlive(DATA_DIR) ? queue : local);

async function main(): Promise<void> {
  const { url } = await startDashboardServer({
    dataDir,
    uiHtml,
    call: buildWebCallHandlers({ dataDir, dfs, apiKeys, jobs: { pick: pickJobs, deps: jobDeps, gsc: () => !!jobDeps.sync } }),
    ...(process.env.SAC_DASHBOARD_PORT ? { port: Number(process.env.SAC_DASHBOARD_PORT) } : {}),
  });
  // Never stdout — parity with the MCP's stdio rule (and harmless here). Log the reachable URL.
  console.error(`[seo-audit-dashboard] serving ${url} — data dir ${DATA_DIR}, DataForSEO ${dfs ? 'on' : 'off'}`);
  // startDashboardServer unref()s its listener so it can't hold an MCP process open; this is a
  // dedicated process whose whole job is to stay up, so keep the event loop alive explicitly.
  setInterval(() => { /* keep-alive */ }, 1 << 30);
  // A docker stop is a normal stop: exit 0, so the npx wrapper doesn't log it as an npm error.
  // A crawl the dashboard started in this process is recorded as interrupted by the job registry.
  const stop = (sig: string): void => {
    console.error(`[seo-audit-dashboard] ${sig}: stopping`);
    void stopDashboardServer().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((e) => { console.error('[seo-audit-dashboard] failed to start:', e); process.exit(1); });
