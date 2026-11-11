/**
 * TLS certificate probe (#79 tls-expiring). One TLS handshake per host at crawl time: read the leaf
 * certificate's validity window, issuer and names, and whether Node's default trust store accepts it
 * for that hostname. No HTTP request is sent. Results go to the tls_certs table; the check compares
 * `valid_to` with the time the AUDIT runs, so an expiry date captured weeks ago still counts down.
 */
import tls from 'node:tls';
import type Database from 'better-sqlite3';

export interface TlsProbeResult {
  host: string;
  /** False when no handshake completed (connection refused, timeout, no TLS on 443). */
  reached: boolean;
  validFrom: string | null;   // ISO
  validTo: string | null;     // ISO
  issuer: string | null;
  /** Subject alternative names, comma-separated as Node reports them (DNS:a, DNS:b). */
  altNames: string | null;
  /** Node's verdict with the default CA store and hostname check: null = trusted and matching. */
  authError: string | null;
  error: string | null;
}

const toIso = (s: string | undefined): string | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Handshake with `host:port`, never throwing. `timeoutMs` bounds the whole attempt. */
export function probeTls(host: string, port = 443, timeoutMs = 8000): Promise<TlsProbeResult> {
  const base: TlsProbeResult = { host, reached: false, validFrom: null, validTo: null, issuer: null, altNames: null, authError: null, error: null };
  return new Promise(resolve => {
    let settled = false;
    const done = (r: TlsProbeResult): void => { if (!settled) { settled = true; resolve(r); } };
    // rejectUnauthorized:false so an expired or mismatched certificate is still READ (that is what
    // we want to report); the verdict comes from `authorized` / `authorizationError`.
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const issuer = cert?.issuer ? [cert.issuer.O, cert.issuer.CN].filter(Boolean).join(' / ') || null : null;
      done({
        ...base, reached: true,
        validFrom: toIso(cert?.valid_from), validTo: toIso(cert?.valid_to),
        issuer, altNames: cert?.subjectaltname ?? null,
        authError: socket.authorized ? null : String(socket.authorizationError ?? 'not trusted'),
      });
      socket.end();
    });
    socket.on('timeout', () => { done({ ...base, error: 'timeout' }); socket.destroy(); });
    socket.on('error', (e: Error & { code?: string }) => done({ ...base, error: e.code ?? e.message }));
    setTimeout(() => { done({ ...base, error: 'timeout' }); socket.destroy(); }, timeoutMs + 1000).unref();
  });
}

export function ensureTlsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tls_certs (
      host TEXT PRIMARY KEY,
      reached INTEGER NOT NULL,
      valid_from TEXT,
      valid_to TEXT,
      issuer TEXT,
      alt_names TEXT,
      auth_error TEXT,           -- NULL = trusted and matching the hostname
      error TEXT,                -- why no handshake completed
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function storeTls(db: Database.Database, r: TlsProbeResult): void {
  ensureTlsSchema(db);
  db.prepare(`INSERT INTO tls_certs (host, reached, valid_from, valid_to, issuer, alt_names, auth_error, error, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(host) DO UPDATE SET reached=excluded.reached, valid_from=excluded.valid_from, valid_to=excluded.valid_to,
      issuer=excluded.issuer, alt_names=excluded.alt_names, auth_error=excluded.auth_error, error=excluded.error, fetched_at=excluded.fetched_at`)
    .run(r.host, r.reached ? 1 : 0, r.validFrom, r.validTo, r.issuer, r.altNames, r.authError, r.error);
}

/** Two-label public suffixes common enough to matter, so `example.co.uk` reads as an apex. */
const TWO_PART_SUFFIX = /\.(co|com|org|net|gov|ac|edu|ltd|plc|me)\.(uk|au|nz|za|jp|br|in|mx|sg|tr|il|kr|ar|my|ph|pk|ng|ke|eg)$/i;

/**
 * The www/apex twin of a host, or null when there isn't one to probe: `www.example.com` <->
 * `example.com`, and nothing for a subdomain such as `blog.example.com` (its www.-prefixed name is
 * not a twin, and a *.example.com certificate cannot cover a second label).
 */
export function tlsTwin(host: string): string | null {
  const h = host.toLowerCase();
  if (h.startsWith('www.')) return h.slice(4);
  const labels = h.split('.');
  const apexLabels = TWO_PART_SUFFIX.test(h) ? 3 : 2;
  return labels.length === apexLabels ? `www.${h}` : null;
}

/** Days from `now` to `validTo` (negative = expired), or null. */
export function daysLeft(validTo: string | null, now: Date = new Date()): number | null {
  if (!validTo) return null;
  const t = Date.parse(validTo);
  return Number.isFinite(t) ? Math.floor((t - now.getTime()) / 86400000) : null;
}
