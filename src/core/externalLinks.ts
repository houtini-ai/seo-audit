/**
 * External link status (#36). The crawl stored outbound links but never checked them, so dead
 * affiliate/retailer pages and moved manufacturer docs were invisible. After each crawl, every
 * distinct external target is checked — politely and with a cache:
 *
 * - HEAD first; a ranged GET (bytes=0-0) when the server rejects HEAD (400/403/405/501) or errors.
 * - Hosts are handled one request at a time with a delay, several hosts in parallel, and a per-host
 *   cap per run (the rest are picked up by later crawls as the cache fills).
 * - Results are cached in external_link_status for cacheDays, so re-crawls don't re-hit every host.
 * - A bot wall (403/999/WAF challenge, plus 401/429) is retried once as Chrome; if Chrome gets a real
 *   answer that's recorded (fetched_as='chrome'), otherwise it's `unverifiable`, never broken: a
 *   bot wall says nothing about whether a human would reach the page.
 */
import type Database from 'better-sqlite3';
import { fetch as ufetch, type Dispatcher } from 'undici';
import { publicOnlyAgent } from './netGuard.js';

// Outbound link targets are written by whoever wrote the page, and so are their redirects: checked
// through an agent that only connects to public addresses (netGuard.ts) unless a caller passes its own.
let sharedPublicAgent: Dispatcher | null = null;
const publicAgent = (): Dispatcher => (sharedPublicAgent ??= publicOnlyAgent({ connections: 4, keepAliveTimeout: 10_000 }));
import { CHROME_HEADERS, looksBotBlocked, type FetchedAs } from './userAgents.js';

export type ExternalVerdict = 'ok' | 'redirected' | 'broken' | 'unverifiable';
export interface ExternalHop { url: string; status: number }
export interface ExternalCheck { url: string; status: number | null; finalUrl: string | null; chain: ExternalHop[]; verdict: ExternalVerdict; permanent: boolean; error: string | null; method: 'HEAD' | 'GET'; fetchedAs: FetchedAs; botWall?: boolean }

export interface ExternalOptions {
  userAgent: string;
  chromeFallback?: boolean;    // retry bot-blocked targets once as Chrome (default true)
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
  update?: (p: Record<string, unknown>) => void;
  cacheDays?: number;          // default 7
  maxTargets?: number;         // distinct targets per run, most-linked first (default 5000)
  perHostMax?: number;         // per host per run (default 300)
  hostConcurrency?: number;    // hosts in parallel (default 6)
  perHostDelayMs?: number;     // between requests to one host (default 750)
  timeoutMs?: number;          // per request (default 10000)
  budgetMs?: number;           // whole pass (default 15 min)
}

export interface ExternalSummary { targets: number; checked: number; cached: number; deferred: number; ok: number; redirected: number; broken: number; unverifiable: number; viaChrome: number }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function classifyError(e: unknown): string {
  const c = (e as any)?.cause?.code ?? (e as any)?.code ?? '';
  if (c === 'EBLOCKEDADDRESS') return 'private address: not checked';
  if (/ENOTFOUND|EAI_AGAIN/.test(c)) return 'dns';
  if (/bad port/i.test(String((e as any)?.cause?.message ?? ''))) return 'blocked port';
  if (/ECONNREFUSED/.test(c)) return 'connection refused';
  if (/ECONNRESET/.test(c)) return 'connection reset';
  if ((e as any)?.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(c)) return 'timeout';
  if (/CERT|SSL|TLS/i.test(c) || /certificate/i.test(String((e as any)?.cause?.message ?? ''))) return 'tls';
  return (e as any)?.message ? String((e as any).message).slice(0, 120) : 'fetch failed';
}

type CheckOpts = Required<Pick<ExternalOptions, 'userAgent' | 'timeoutMs'>> & { dispatcher?: Dispatcher; chromeFallback?: boolean; retryDelayMs?: number };

async function follow(url: string, method: 'HEAD' | 'GET', o: CheckOpts, ranged = true, chrome = false): Promise<{ status: number; finalUrl: string; chain: ExternalHop[]; botWall: boolean }> {
  const chain: ExternalHop[] = [];
  let current = url;
  for (let hop = 0; hop <= 6; hop++) {
    const res = await ufetch(current, {
      method, redirect: 'manual', dispatcher: o.dispatcher ?? publicAgent(), signal: AbortSignal.timeout(o.timeoutMs),
      headers: { ...(chrome ? CHROME_HEADERS : { 'user-agent': o.userAgent, accept: 'text/html,*/*;q=0.8' }), ...(method === 'GET' && ranged ? { range: 'bytes=0-0' } : {}) },
    });
    try { await res.body?.cancel(); } catch { /* closed */ }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      chain.push({ url: current, status: res.status });
      current = new URL(loc, current).toString();
      continue;
    }
    // botWall = identity might matter (403/999/WAF challenge). 401 and plain 429 are 'unverifiable'
    // too but a different UA won't help, so they never trigger the Chrome retry.
    return { status: res.status, finalUrl: current, chain, botWall: looksBotBlocked(res.status, n => res.headers.get(n)) };
  }
  throw Object.assign(new Error('too many redirects'), { code: 'TOO_MANY_REDIRECTS' });
}

/** Check one external URL. Exported for tests. */
export async function checkExternal(url: string, o: CheckOpts): Promise<ExternalCheck> {
  const first = await attempt(url, o, false);
  // Bot wall under our own UA: one retry as Chrome. If Chrome gets a real answer, that's the truth
  // about the link; if Chrome is walled too, it stays 'unverifiable'.
  if (o.chromeFallback !== false && first.botWall) {
    await sleep(o.retryDelayMs ?? 750); // same pacing as between targets: the host just pushed back
    const second = await attempt(url, o, true);
    if (second.verdict !== 'unverifiable') return second;
  }
  return first;
}

async function attempt(url: string, o: CheckOpts, chrome: boolean): Promise<ExternalCheck> {
  const fetchedAs: FetchedAs = chrome ? 'chrome' : 'bot';
  let method: 'HEAD' | 'GET' = 'HEAD';
  let r: Awaited<ReturnType<typeof follow>> | null = null;
  let err: unknown = null;
  try { r = await follow(url, 'HEAD', o, true, chrome); } catch (e) { err = e; }
  // Many servers mishandle HEAD: retry once as a 1-byte ranged GET before believing a failure.
  if (!r || [400, 403, 404, 405, 501].includes(r.status) || r.status >= 500) {
    try { const g = await follow(url, 'GET', o, true, chrome); r = g; method = 'GET'; err = null; } catch (e) { if (!r) err = e; }
    // 416: the server refused the byte range itself (empty or dynamic body), which says nothing
    // about the page. Retry once as a plain GET; the body is cancelled unread, as always.
    if (r && method === 'GET' && r.status === 416) { try { r = await follow(url, 'GET', o, false, chrome); } catch { /* keep the 416 result */ } }
  }
  // A target (or a redirect) on a private or local address is never requested: unknown, not broken.
  if (!r && ((err as any)?.cause?.code ?? (err as any)?.code) === 'EBLOCKEDADDRESS') return { url, status: null, finalUrl: null, chain: [], verdict: 'unverifiable', permanent: false, error: classifyError(err), method, fetchedAs };
  if (!r) return { url, status: null, finalUrl: null, chain: [], verdict: 'broken', permanent: false, error: classifyError(err), method, fetchedAs };
  const permanent = r.chain.some(h => h.status === 301 || h.status === 308);
  let verdict: ExternalVerdict;
  if (r.botWall || r.status === 401 || r.status === 429) verdict = 'unverifiable';
  else if (r.status >= 400) verdict = 'broken';
  else if (r.status >= 300) return { url, status: r.status, finalUrl: r.finalUrl, chain: r.chain, verdict: 'broken', permanent, error: 'redirect without a Location header', method, fetchedAs };
  else if (r.chain.length) verdict = 'redirected';
  else verdict = 'ok';
  return { url, status: r.status, finalUrl: r.finalUrl, chain: r.chain, verdict, permanent, error: null, method, fetchedAs, ...(r.botWall ? { botWall: true } : {}) };
}

export function ensureExternalSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_link_status (
      url_key TEXT PRIMARY KEY,          -- = links.target_key
      url TEXT NOT NULL,
      status INTEGER,                    -- final status (null = no response)
      final_url TEXT,
      redirect_chain TEXT,               -- JSON [{url,status}]
      permanent INTEGER,                 -- any 301/308 hop
      verdict TEXT,                      -- ok | redirected | broken | unverifiable
      method TEXT,                       -- HEAD | GET (ranged fallback)
      error TEXT,                        -- dns | timeout | connection refused | tls | …
      fetched_as TEXT,                   -- bot | chrome (Chrome retry after a bot wall)
      checked_at TEXT
    );
  `);
  if (!(db.prepare(`PRAGMA table_info(external_link_status)`).all() as { name: string }[]).some(c => c.name === 'fetched_as')) db.exec('ALTER TABLE external_link_status ADD COLUMN fetched_as TEXT');
}

/** Check every distinct external link target in the latest crawl, cached and host-throttled. */
export async function checkExternalLinks(db: Database.Database, opts: ExternalOptions): Promise<ExternalSummary> {
  ensureExternalSchema(db);
  const cacheDays = opts.cacheDays ?? 7;
  const perHostMax = opts.perHostMax ?? 300;
  const perHostDelay = opts.perHostDelayMs ?? 750;
  const o: CheckOpts = { userAgent: opts.userAgent, timeoutMs: opts.timeoutMs ?? 10000, dispatcher: opts.dispatcher, chromeFallback: opts.chromeFallback, retryDelayMs: perHostDelay };
  const deadline = Date.now() + (opts.budgetMs ?? 15 * 60_000);

  const targets = db.prepare(`
    SELECT l.target_key k, MIN(l.target_url) u, COUNT(DISTINCT l.source_key) n FROM links l
    WHERE l.is_internal = 0 AND (l.target_url LIKE 'http://%' OR l.target_url LIKE 'https://%')
    GROUP BY l.target_key ORDER BY n DESC LIMIT ?`).all(opts.maxTargets ?? 5000) as { k: string; u: string; n: number }[];
  const fresh = new Set((db.prepare(`SELECT url_key FROM external_link_status WHERE checked_at >= datetime('now', ?)`).all(`-${cacheDays} days`) as { url_key: string }[]).map(r => r.url_key));
  const todo = targets.filter(t => !fresh.has(t.k));

  const byHost = new Map<string, { k: string; u: string }[]>();
  let deferred = 0;
  for (const t of todo) {
    let h: string; try { h = new URL(t.u).hostname.toLowerCase(); } catch { continue; }
    const q = byHost.get(h) ?? byHost.set(h, []).get(h)!;
    if (q.length < perHostMax) q.push(t); else deferred++;
  }
  const upsert = db.prepare(`INSERT INTO external_link_status (url_key, url, status, final_url, redirect_chain, permanent, verdict, method, error, fetched_as, checked_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(url_key) DO UPDATE SET url=excluded.url, status=excluded.status, final_url=excluded.final_url, redirect_chain=excluded.redirect_chain,
      permanent=excluded.permanent, verdict=excluded.verdict, method=excluded.method, error=excluded.error, fetched_as=excluded.fetched_as, checked_at=excluded.checked_at`);
  const buf: ExternalCheck[] = [];
  const keyOf = new Map(todo.map(t => [t.u, t.k]));
  const flush = (): void => {
    if (!buf.length) return;
    const rows = buf.splice(0);
    db.transaction(() => { for (const c of rows) upsert.run(keyOf.get(c.url)!, c.url, c.status, c.finalUrl, JSON.stringify(c.chain), c.permanent ? 1 : 0, c.verdict, c.method, c.error, c.fetchedAs); })();
  };

  let checked = 0;
  const hosts = [...byHost.values()];
  let hi = 0;
  const worker = async (): Promise<void> => {
    while (hi < hosts.length && !opts.signal?.aborted) {
      const queue = hosts[hi++];
      for (let i = 0; i < queue.length; i++) {
        if (opts.signal?.aborted || Date.now() > deadline) { deferred += queue.length - i; break; }
        buf.push(await checkExternal(queue[i].u, o));
        checked++;
        if (buf.length >= 50) flush();
        if (checked % 25 === 0) opts.update?.({ phase: 'external-links', checked, total: todo.length });
        if (i < queue.length - 1) await sleep(perHostDelay);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.hostConcurrency ?? 6, hosts.length || 1) }, worker));
  flush();

  const counts = Object.fromEntries((db.prepare(`SELECT s.verdict v, COUNT(*) n FROM external_link_status s WHERE s.url_key IN (SELECT DISTINCT target_key FROM links WHERE is_internal = 0) GROUP BY s.verdict`).all() as { v: string; n: number }[]).map(r => [r.v, r.n]));
  const viaChrome = (db.prepare(`SELECT COUNT(*) n FROM external_link_status WHERE fetched_as = 'chrome' AND url_key IN (SELECT DISTINCT target_key FROM links WHERE is_internal = 0)`).get() as { n: number }).n;
  return { targets: targets.length, checked, cached: targets.length - todo.length, deferred, ok: counts.ok ?? 0, redirected: counts.redirected ?? 0, broken: counts.broken ?? 0, unverifiable: counts.unverifiable ?? 0, viaChrome };
}
