import http from 'node:http';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Local dashboard webserver — the "Phase 2" delivery surface. Serves the built dashboard
 * UI at http://127.0.0.1:PORT with live data from the property SQLite DBs, so the report
 * lives in a real browser tab: no MCP-App host cache, no iframe sandbox, native file
 * downloads, and a property switcher. Localhost-only by design (binds 127.0.0.1).
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

const CACHE_DBS = new Set(['dataforseo-cache.db']);

/** Enumerate properties that have a local DB (property_meta.site_url is the source of truth). */
export function listLocalProperties(dataDir: string): { siteUrl: string; file: string }[] {
  let files: string[] = [];
  try { files = readdirSync(dataDir).filter(f => f.endsWith('.db') && !CACHE_DBS.has(f)); } catch { return []; }
  const out: { siteUrl: string; file: string }[] = [];
  for (const file of files.sort()) {
    let db: Database.Database | null = null;
    try {
      db = new Database(path.join(dataDir, file), { readonly: true, fileMustExist: true });
      const meta = db.prepare(`SELECT site_url FROM property_meta ORDER BY id LIMIT 1`).get() as { site_url: string } | undefined;
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
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      // 127.0.0.1 only — never expose the dashboard (or the SQLite data behind it) on the network.
      server.listen(opts.port ?? 0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0));
      });
    });
    server.unref(); // never keep the MCP process alive on our account
    const url = `http://127.0.0.1:${port}`;
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
