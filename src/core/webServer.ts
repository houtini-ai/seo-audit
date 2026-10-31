import http from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PACKAGE_VERSION, pinnedPackage } from './version.js';
import { hiddenProperties } from './hiddenProperties.js';

/**
 * Local dashboard webserver — the "Phase 2" delivery surface. Serves the built dashboard
 * UI at http://127.0.0.1:PORT with live data from the property SQLite DBs, so the report
 * lives in a real browser tab: no MCP-App host cache, no iframe sandbox, native file
 * downloads, and a property switcher.
 *
 * Localhost-only by design. Binds 127.0.0.1 by default; a container sets
 * SAC_DASHBOARD_BIND=0.0.0.0 (so a published `127.0.0.1:PORT->PORT` host mapping can reach it)
 * and SAC_DASHBOARD_PORT to a fixed, publishable port. The Host-header allowlist below defeats DNS
 * rebinding from a browser, but it is NOT access control: bound to 0.0.0.0, any client that can
 * reach the port and sends `Host: localhost` is answered, so publish the port to 127.0.0.1 only
 * (`-p 127.0.0.1:8788:8788`). The advertised URL host stays 127.0.0.1 (SAC_DASHBOARD_URL_HOST
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

/** `server` is null when we adopted a dashboard another process already serves on the fixed port. */
interface RunningServer { server: http.Server | null; port: number; url: string }
let running: RunningServer | null = null;
let starting: Promise<{ url: string; port: number }> | null = null;

/** DNS-rebinding / CSRF guard: only ever answer requests addressed to localhost itself.
 * A malicious page that rebinds its domain to 127.0.0.1 arrives with a foreign Host. */
function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const bare = host.replace(/:\d+$/, '').toLowerCase();
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]';
}

/** What the user replaces with their own volume: a process inside the container can see /data,
 * but never the name of the Docker volume mounted there. */
export const VOLUME_PLACEHOLDER = '<your-data-volume>';

/**
 * The one-line standalone dashboard container (README "Opening the dashboard"), on the same volume,
 * pinned to this server's version: an unpinned npx installs whatever is latest, which can be a
 * different release from the server and the job runner. --init forwards a stop signal to node.
 */
export function dashboardSidecarCmd(version: string | null = PACKAGE_VERSION, volume = VOLUME_PLACEHOLDER): string {
  return `docker run -d --init --name seo-audit-dashboard --restart unless-stopped -p 127.0.0.1:8788:8788 -e SAC_DATA_DIR=/data -e SAC_DASHBOARD_BIND=0.0.0.0 -e SAC_DASHBOARD_PORT=8788 -v ${volume}:/data node:22-slim npx -y -p ${pinnedPackage(version)} seo-audit-dashboard`;
}

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
  return `Running in a container: this link only works inside it${inner}. Run the dashboard sidecar on the same data volume, then open ${open}. Replace ${VOLUME_PLACEHOLDER} with the volume this MCP server mounts at /data (a process inside the container can't see its name):\n${dashboardSidecarCmd()}\nOr run get_dashboard${target} to see the dashboard in chat.`;
}

const CACHE_DBS = new Set(['dataforseo-cache.db', '_portfolio.db', '_jobs.db']);

/**
 * Is this a Search Console property name? GSC names a property `sc-domain:x.com` or a URL prefix
 * (`https://x.com/`). A bare domain (`autosimsport.net`) is a database that a DataForSEO call
 * (pull_backlinks, link_intersect, track_ranks) created for a site we don't own: it has data, but
 * it is not one of the user's properties.
 */
export const isGscProperty = (siteUrl: string): boolean => /^(sc-domain:|https?:\/\/)/i.test(siteUrl.trim());

/** Enumerate properties that have a local DB (property_meta.site_url is the source of truth).
 * `gsc` is false for a database named by a bare domain (see isGscProperty); `hidden` is the user's
 * hide flag (hiddenProperties.ts): left out of the dropdown and the portfolio, still served by URL. */
export function listLocalProperties(dataDir: string): { siteUrl: string; file: string; gsc: boolean; hidden: boolean }[] {
  let files: string[] = [];
  try { files = readdirSync(dataDir).filter(f => f.endsWith('.db') && !CACHE_DBS.has(f)); } catch { return []; }
  const out: { siteUrl: string; file: string; gsc: boolean; hidden: boolean }[] = [];
  const hidden = hiddenProperties(dataDir);
  for (const file of files.sort()) {
    let db: Database.Database | null = null;
    try {
      db = new Database(path.join(dataDir, file), { readonly: true, fileMustExist: true });
      // Legacy collided databases hold a row per property; the ACTIVE one (most recently synced)
      // owns the data, so ordering by id would name the wrong property in the switcher.
      const meta = db.prepare(
        `SELECT site_url FROM property_meta ORDER BY COALESCE(last_synced_at,'') DESC, id ASC LIMIT 1`,
      ).get() as { site_url: string } | undefined;
      if (meta?.site_url) out.push({ siteUrl: meta.site_url, file, gsc: isGscProperty(meta.site_url), hidden: hidden.has(meta.site_url) });
    } catch { /* not a property DB */ } finally { db?.close(); }
  }
  return out;
}

/** Is an Origin header (sent by a browser on every POST) one of this server's own localhost origins? */
function isLocalOrigin(origin: string): boolean {
  try { return isLocalHostHeader(new URL(origin).host); } catch { return false; }
}

/**
 * Identity proof for adopting a dashboard on the fixed port. The secret lives in the data dir
 * (0600), so only a process of the same user serving the SAME data dir can answer a nonce with the
 * right HMAC. Answering `/api/properties` with a list, the old test, adopted any service on the port,
 * and every dashboardUrl the MCP handed out then pointed at it.
 */
const SECRET_FILE = '.dashboard-secret';
function dashboardSecret(dataDir: string): Buffer {
  const file = path.join(dataDir, SECRET_FILE);
  try { const s = readFileSync(file); if (s.length >= 32) return s; } catch { /* create it */ }
  try { writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch { /* another process won the race */ }
  return readFileSync(file);
}
export const identityProof = (dataDir: string, nonce: string): string => createHmac('sha256', dashboardSecret(dataDir)).update(`seo-audit-dashboard:${nonce}`).digest('hex');

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

export async function startDashboardServer(opts: WebServerOptions): Promise<{ url: string; port: number }> {
  if (running?.server) return { url: running.url, port: running.port };
  // An adopted dashboard belongs to another process, which may have exited since: check it is still
  // there (and still ours) before handing its link out again; otherwise bind the port ourselves.
  if (running && !running.server) {
    if (await isOurDashboard(running.port, opts.dataDir())) return { url: running.url, port: running.port };
    running = null;
  }
  if (starting) return starting; // concurrent callers share one startup — never bind twice

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLocalHostHeader(req.headers.host)) return json(res, 403, { error: 'forbidden' });
      const u = new URL(req.url ?? '/', 'http://localhost');
      const route = u.pathname;

      // One dashboard. "/" is the domains view (every owned property and watched domain) once
      // there's more than one property; /dashboard?siteUrl= is a property, /dashboard?domain= a
      // watched domain. The domain dropdown moves between them. The old /portfolio routes redirect.
      const serve = (boot: Record<string, unknown>): void => {
        const props = listLocalProperties(opts.dataDir());
        const shown = props.filter(p => !p.hidden);
        const full = { ...boot, properties: shown.filter(p => p.gsc).map(p => p.siteUrl), others: shown.filter(p => !p.gsc).map(p => p.siteUrl) };
        const inject = `<script>window.__SAC_WEB__=${JSON.stringify(full).replace(/</g, '\\u003c')};</script>`;
        // Replacement FUNCTION, not string — $-sequences in the payload must stay literal.
        const html = opts.uiHtml().replace(/<head([^>]*)>/i, (_m, attrs: string) => `<head${attrs}>${inject}`);
        // Never framed by another page (clickjacking the sidebar's actions).
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
        res.end(html);
      };
      const redirect = (to: string): void => { res.writeHead(302, { location: to }); res.end(); };

      if (req.method === 'GET' && route === '/portfolio') return redirect('/');
      if (req.method === 'GET' && route === '/portfolio/domain') {
        const d = u.searchParams.get('d');
        return redirect(d ? `/dashboard?domain=${encodeURIComponent(d)}` : '/');
      }
      if (req.method === 'GET' && (route === '/' || route === '/dashboard')) {
        const siteUrl = u.searchParams.get('siteUrl');
        const domain = u.searchParams.get('domain');
        if (siteUrl) return serve({ siteUrl });
        if (domain) return serve({ siteUrl: '', domain });
        const owned = listLocalProperties(opts.dataDir()).filter(p => p.gsc && !p.hidden);
        if (route === '/' && owned.length === 1 && !u.searchParams.has('all')) return redirect(`/dashboard?siteUrl=${encodeURIComponent(owned[0].siteUrl)}`);
        return serve({ siteUrl: '', view: 'domains' });
      }

      if (req.method === 'GET' && route === '/api/identity') {
        const nonce = u.searchParams.get('nonce') ?? '';
        if (!/^[0-9a-f]{32}$/.test(nonce)) return json(res, 400, { error: 'nonce must be 32 hex characters' });
        return json(res, 200, { app: 'seo-audit-dashboard', version: PACKAGE_VERSION, proof: identityProof(opts.dataDir(), nonce) });
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
        // A browser sends Origin on every POST: refuse one from any page that isn't this server
        // (a sandboxed or file: page sends the literal "null").
        const origin = req.headers.origin;
        if (origin && !isLocalOrigin(origin)) return json(res, 403, { error: 'forbidden origin' });
        const body = JSON.parse((await readBody(req)) || '{}') as { name?: string; arguments?: Record<string, unknown> };
        // Own properties only: `constructor`, `toString` and the rest of the prototype chain are not handlers.
        const handler = typeof body.name === 'string' && Object.hasOwn(opts.call, body.name) ? opts.call[body.name] : undefined;
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
    // Advertised host is the address the user's browser reaches — 127.0.0.1 for a host-run process,
    // and also for a container whose port is published to the host's 127.0.0.1:PORT.
    const urlHost = process.env.SAC_DASHBOARD_URL_HOST || '127.0.0.1';
    let port: number;
    try {
      port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantPort, bindHost, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : wantPort);
        });
      });
    } catch (e) {
      // A fixed port from the env that's already taken: if a standalone `seo-audit-dashboard` holds
      // it (the bare-metal fixed-address setup), hand out its link rather than failing. Only when the
      // port came from the env: an explicit opts.port is the standalone process itself.
      const inUse = (e as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!inUse || opts.port !== undefined || !(await isOurDashboard(wantPort, opts.dataDir()))) throw e;
      const url = `http://${urlHost}:${wantPort}`;
      running = { server: null, port: wantPort, url };
      return { url, port: wantPort };
    }
    server.unref(); // never keep the MCP process alive on our account
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
  if (!s) return false; // adopted: another process owns that dashboard
  await new Promise<void>(resolve => s.close(() => resolve()));
  return true;
}

/** Is 127.0.0.1:port this app's dashboard serving THIS data dir? It must answer a fresh nonce
 *  with the HMAC of the data dir's secret (identityProof), which no other service can. */
async function isOurDashboard(port: number, dataDir: string): Promise<boolean> {
  try {
    const nonce = randomBytes(16).toString('hex');
    const r = await fetch(`http://127.0.0.1:${port}/api/identity?nonce=${nonce}`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const body = (await r.json()) as { app?: unknown; proof?: unknown };
    if (body.app !== 'seo-audit-dashboard' || typeof body.proof !== 'string') return false;
    const want = Buffer.from(identityProof(dataDir, nonce), 'hex');
    const got = Buffer.from(body.proof, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

export function dashboardServerUrl(): string | null {
  return running?.url ?? null;
}
