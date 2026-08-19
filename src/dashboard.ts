import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDashboardServer } from './core/webServer.js';
import { buildWebCallHandlers } from './core/webHandlers.js';
import { DataForSeoClient } from './core/DataForSeoClient.js';

/**
 * Standalone dashboard server — the Docker-aware delivery surface.
 *
 * The MCP server itself talks stdio behind the Docker MCP gateway, which does NOT publish
 * container ports, so a dashboard served from inside the MCP container is unreachable from the
 * host. This entrypoint is a SEPARATE, publishable process: it mounts the same SAC_DATA_DIR (the
 * shared `mcp-sac-data` volume, read-only is fine) and serves the exact same dashboard on a fixed,
 * published port — so the reports get a stable URL that always reflects the live database.
 *
 * Run it as a sidecar container (the image ENTRYPOINT is `node dist/index.js`, so override it —
 * bins aren't on PATH in the runtime image; WORKDIR is /app):
 *   docker run -d --name seo-audit-dashboard \
 *     -p 127.0.0.1:8788:8788 \
 *     -e SAC_DASHBOARD_BIND=0.0.0.0 -e SAC_DASHBOARD_PORT=8788 -e SAC_DATA_DIR=/data \
 *     -v mcp-sac-data:/data:ro \
 *     --entrypoint node houtini-seo-audit-local:latest dist/dashboard.js
 * then open http://127.0.0.1:8788/. DataForSEO creds (optional) enable the Content-research tab.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SAC_DATA_DIR || path.join(os.homedir(), 'Documents', 'seo-audit-console');
const dataDir = (): string => DATA_DIR;

const dfsUser = process.env.DATAFORSEO_USERNAME;
const dfsPass = process.env.DATAFORSEO_PASSWORD;
const dfs = dfsUser && dfsPass
  ? new DataForSeoClient(dfsUser, dfsPass, path.join(DATA_DIR, 'dataforseo-cache.db'), Number(process.env.DATAFORSEO_CACHE_DAYS) || 7)
  : null;
const apiKeys = (): { dataforseo: boolean; majestic: boolean; firecrawl: boolean; supadata: boolean } => ({
  dataforseo: !!dfs,
  majestic: !!process.env.MAJESTIC_API_KEY,
  firecrawl: !!process.env.FIRECRAWL_API_KEY,
  supadata: !!process.env.SUPADATA_API_KEY,
});

// Same built UI the MCP serves (Vite output tree: dist/src/ui/dashboard.html, next to this file).
const uiHtml = (): string => readFileSync(path.join(__dirname, 'src', 'ui', 'dashboard.html'), 'utf8');

async function main(): Promise<void> {
  const { url } = await startDashboardServer({
    dataDir,
    uiHtml,
    call: buildWebCallHandlers({ dataDir, dfs, apiKeys }),
    ...(process.env.SAC_DASHBOARD_PORT ? { port: Number(process.env.SAC_DASHBOARD_PORT) } : {}),
  });
  // Never stdout — parity with the MCP's stdio rule (and harmless here). Log the reachable URL.
  console.error(`[seo-audit-dashboard] serving ${url} — data dir ${DATA_DIR}, DataForSEO ${dfs ? 'on' : 'off'}`);
  // startDashboardServer unref()s its listener so it can't hold an MCP process open; this is a
  // dedicated process whose whole job is to stay up, so keep the event loop alive explicitly.
  setInterval(() => { /* keep-alive */ }, 1 << 30);
}

main().catch((e) => { console.error('[seo-audit-dashboard] failed to start:', e); process.exit(1); });
