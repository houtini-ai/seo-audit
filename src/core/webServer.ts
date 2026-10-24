import http from 'node:http';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Local dashboard webserver — the "Phase 2" delivery surface. Serves the built dashboard
 * UI at http://127.0.0.1:PORT with live data from the property SQLite DBs, so the report
 * lives in a real browser tab: no MCP-App host cache, no iframe sandbox, native file
 * downloads, and a property switcher.
 *
 * Localhost-only by design. Binds 127.0.0.1 by default; a container sets
 * SAC_DASHBOARD_BIND=0.0.0.0 (so a published `127.0.0.1:PORT->PORT` host mapping can reach it)
 * and SAC_DASHBOARD_PORT to a fixed, publishable port. Even bound to 0.0.0.0, the Host-header
 * allowlist below refuses any request not addressed to localhost, so the SQLite data is never
 * answered to a network client. The advertised URL host stays 127.0.0.1 (SAC_DASHBOARD_URL_HOST
 * to override) — that is the address the user's browser actually reaches.
 */

/** Named server-side handlers the web UI may invoke via POST /api/call (allowlist). */
export type WebCallHandlers = Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>;

export interface WebServerOptions {
  dataDir: () => string;
  /** Returns the built dashboard.html template (read per-request so rebuilds show without restart). */
  uiHtml: () => string;
  call: WebCallHandlers;
  port?: number;
}

interface RunningServer { server: http.Server; port: number; url: string }
let running: RunningServer | null = null;
let starting: Promise<{ url: string; port: number }> | null = null;

/** DNS-rebinding / CSRF guard: only ever answer requests addressed to localhost itself.
 * A malicious page that rebinds its domain to 127.0.0.1 arrives with a foreign Host. */
function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const bare = host.replace(/:\d+$/, '').toLowerCase();
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]';
}

/** The one-line standalone dashboard container (README "Opening the dashboard"), on the same volume. */
export const DASHBOARD_SIDECAR_CMD =
  'docker run -d --name seo-audit-dashboard --restart unless-stopped -p 127.0.0.1:8788:8788 -e SAC_DATA_DIR=/data -e SAC_DASHBOARD_BIND=0.0.0.0 -e SAC_DASHBOARD_PORT=8788 -v seo-audit-data:/data node:22-slim npx -y -p @houtini/seo-audit-console seo-audit-dashboard';

export interface ContainerProbe { env: NodeJS.ProcessEnv; exists: (p: string) => boolean; read: (p: string) => string | null }
const realProbe = (): ContainerProbe => ({
  env: process.env,
  exists: (p) => { try { return existsSync(p); } catch { return false; } },
  read: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
});

/** True when this process runs inside a container: Docker's /.dockerenv, Podman's
 * /run/.containerenv, or a container cgroup for PID 1. SAC_DATA_DIR=/data is deliberately NOT a
 * signal: a bare-metal Linux install may use /data too, and would then lose its working link. */
export function inContainer(probe: ContainerProbe = realProbe()): boolean {
  if (probe.exists('/.dockerenv') || probe.exists('/run/.containerenv')) return true;
  const cg = probe.read('/proc/1/cgroup');
  return !!cg && /docker|containerd|kubepods|libpod|lxc/i.test(cg);
}

/**
 * Can the user's browser open the advertised dashboard URL? On bare metal, always (it is the host's
 * own 127.0.0.1). Inside a container, only when the operator published a fixed port: bound to
 * 0.0.0.0 (SAC_DASHBOARD_BIND) on SAC_DASHBOARD_PORT, or named the reachable host explicitly
 * (SAC_DASHBOARD_URL_HOST). Otherwise the server sits on a random port inside the container (the
 * Docker MCP gateway's worker), and 127.0.0.1:<port> on the host reaches nothing.
 */
export function dashboardReachable(probe: ContainerProbe = realProbe()): boolean {
  if (!inContainer(probe)) return true;
  const e = probe.env;
  if (e.SAC_DASHBOARD_URL_HOST) return true;
  return e.SAC_DASHBOARD_BIND === '0.0.0.0' && Number(e.SAC_DASHBOARD_PORT) > 0;
}

/** What to say instead of an openable link when the dashboard runs where the host can't reach it. */
export function containerDashboardNote(siteUrl?: string, containerUrl?: string | null): string {
  const inner = containerUrl ? ` (${containerUrl})` : '';
  const target = siteUrl ? ` for ${siteUrl}` : '';
  const open = `http://127.0.0.1:8788/dashboard${siteUrl ? `?siteUrl=${encodeURIComponent(siteUrl)}` : ''}`;
  return `Running in a container: this link only works inside it${inner}. Run the dashboard sidecar on the same data volume (use your volume's name), then open ${open}:\n${DASHBOARD_SIDECAR_CMD}\nOr run get_dashboard${target} to see the dashboard in chat.`;
}

const CACHE_DBS = new Set(['dataforseo-cache.db', '_portfolio.db', '_jobs.db']);

/** Enumerate properties that have a local DB (property_meta.site_url is the source of truth). */
export function listLocalProperties(dataDir: string): { siteUrl: string; file: string }[] {
  let files: string[] = [];
  try { files = readdirSync(dataDir).filter(f => f.endsWith('.db') && !CACHE_DBS.has(f)); } catch { return []; }
  const out: { siteUrl: string; file: string }[] = [];
  for (const file of files.sort()) {
    let db: Database.Database | null = null;
    try {
      db = new Database(path.join(dataDir, file), { readonly: true, fileMustExist: true });
      // Legacy collided databases hold a row per property; the ACTIVE one (most recently synced)
      // owns the data, so ordering by id would name the wrong property in the switcher.
      const meta = db.prepare(
        `SELECT site_url FROM property_meta ORDER BY COALESCE(last_synced_at,'') DESC, id ASC LIMIT 1`,
      ).get() as { site_url: string } | undefined;
      if (meta?.site_url) out.push({ siteUrl: meta.site_url, file });
    } catch { /* not a property DB */ } finally { db?.close(); }
  }
  return out;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
};

const readBody = (req: http.IncomingMessage, limit = 256 * 1024): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function pickerPage(props: { siteUrl: string }[]): string {
  const items = props.length
    ? props.map(p => `<li><a href="/dashboard?siteUrl=${encodeURIComponent(p.siteUrl)}">${esc(p.siteUrl)}</a></li>`).join('')
    : '<li>No properties yet — run refresh_property first.</li>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>SEO Audit Console</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.3rem}ul{line-height:2}a{color:#cd2026}</style></head>
<body><h1>SEO Audit Console — choose a property</h1><ul>${items}</ul></body></html>`;
}

export async function startDashboardServer(opts: WebServerOptions): Promise<{ url: string; port: number }> {
  if (running) return { url: running.url, port: running.port };
  if (starting) return starting; // concurrent callers share one startup — never bind twice

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLocalHostHeader(req.headers.host)) return json(res, 403, { error: 'forbidden' });
      const u = new URL(req.url ?? '/', 'http://localhost');
      const route = u.pathname;

      if (req.method === 'GET' && (route === '/' || route === '/dashboard')) {
        const props = listLocalProperties(opts.dataDir());
        const siteUrl = u.searchParams.get('siteUrl');
        if (!siteUrl) {
          if (route === '/' && props.length === 1) {
            res.writeHead(302, { location: `/dashboard?siteUrl=${encodeURIComponent(props[0].siteUrl)}` });
            return res.end();
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(pickerPage(props));
        }
        const boot = { siteUrl, properties: props.map(p => p.siteUrl) };
        const inject = `<script>window.__SAC_WEB__=${JSON.stringify(boot).replace(/</g, '\\u003c')};</script>`;
        // Replacement FUNCTION, not string — $-sequences in the payload must stay literal.
        const html = opts.uiHtml().replace(/<head([^>]*)>/i, (_m, attrs: string) => `<head${attrs}>${inject}`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }

      if (req.method === 'GET' && route === '/api/properties') {
        return json(res, 200, { properties: listLocalProperties(opts.dataDir()) });
      }

      if (req.method === 'POST' && route === '/api/call') {
        // Require a JSON content-type: cross-origin "simple" requests can only send
        // text/plain without a CORS preflight, so this blocks blind CSRF POSTs.
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
          return json(res, 415, { error: 'content-type must be application/json' });
        }
        const body = JSON.parse((await readBody(req)) || '{}') as { name?: string; arguments?: Record<string, unknown> };
        const handler = body.name ? opts.call[body.name] : undefined;
        if (!handler) return json(res, 404, { error: `unknown tool ${body.name ?? ''}` });
        try {
          const structuredContent = await handler(body.arguments ?? {});
          return json(res, 200, { structuredContent });
        } catch (e) {
          return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  starting = (async () => {
    // Bind host: 127.0.0.1 by default (never expose the SQLite data on the network). A container
    // sets SAC_DASHBOARD_BIND=0.0.0.0 so a published 127.0.0.1:PORT->PORT host mapping can reach it;
    // the Host-header allowlist above still refuses anything not addressed to localhost.
    const bindHost = process.env.SAC_DASHBOARD_BIND || '127.0.0.1';
    // Port: explicit arg > SAC_DASHBOARD_PORT (a fixed, publishable port for Docker) > 0 (random).
    const wantPort = opts.port ?? (Number(process.env.SAC_DASHBOARD_PORT) || 0);
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(wantPort, bindHost, () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : wantPort);
      });
    });
    server.unref(); // never keep the MCP process alive on our account
    // Advertised host is the address the user's browser reaches — 127.0.0.1 for a host-run process,
    // and also for a container whose port is published to the host's 127.0.0.1:PORT.
    const urlHost = process.env.SAC_DASHBOARD_URL_HOST || '127.0.0.1';
    const url = `http://${urlHost}:${port}`;
    running = { server, port, url };
    return { url, port };
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export async function stopDashboardServer(): Promise<boolean> {
  if (!running) return false;
  const s = running.server;
  running = null;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return true;
}

export function dashboardServerUrl(): string | null {
  return running?.url ?? null;
}
