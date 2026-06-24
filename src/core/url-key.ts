/**
 * url-key — the single source of truth for the join between GSC data and crawl data.
 *
 * GSC stores Google-canonicalised URLs; the crawler stores raw discovered URLs.
 * Neither normalises, and they normalise differently — so a naive `page = url`
 * join silently misses trailing-slash / www / protocol / tracking-param variants.
 * Both write paths run their URL through `urlKey()` and store the result in a
 * `*_key` column; all joins use the key. The raw URL is kept for evidence, and
 * raw-vs-key divergence (esp. canonical mismatch) is itself a finding.
 *
 * See research/05 (normalisation pitfalls) and plan/architecture §2.
 */

/** Tracking / session params stripped before keying (prefix match for families). */
const TRACKING_PARAM_PREFIXES = ['utm_', 'mc_', 'hsa_', '_hs', 'pk_', 'piwik_', 'matomo_'];
const TRACKING_PARAM_EXACT = new Set([
  'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'twclid', 'ttclid',
  'igshid', 'mkt_tok', 'yclid', 'ref', 'ref_src', 'spm', 'vero_id', 'oly_anon_id',
  'oly_enc_id', '_ga', '_gl', 'gclsrc',
]);

export interface UrlKeyOptions {
  /**
   * Host form to unify to, derived from the GSC property at sync time:
   *  - 'apex'  → strip a leading `www.`
   *  - 'www'   → ensure a leading `www.`
   *  - 'asis'  → leave host as delivered (default; safest when property type unknown)
   */
  hostForm?: 'apex' | 'www' | 'asis';
  /** Force https (Google almost always canonicalises to https). Default true. */
  forceHttps?: boolean;
}

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some(p => lower.startsWith(p));
}

/**
 * Normalise a URL into a stable join key.
 * Returns the original trimmed string if it cannot be parsed (so a bad URL still
 * joins to itself rather than throwing).
 */
export function urlKey(rawUrl: string, options: UrlKeyOptions = {}): string {
  const { hostForm = 'asis', forceHttps = true } = options;
  const raw = (rawUrl ?? '').trim();
  if (!raw) return '';

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw; // un-parseable — key to itself, never throw on the hot path
  }

  // Only normalise http(s); leave other schemes (mailto:, tel:) untouched.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;

  // Scheme
  if (forceHttps) u.protocol = 'https:';

  // Host: lowercase (hosts are case-insensitive), strip default ports, unify www.
  let host = u.hostname.toLowerCase();
  if (hostForm === 'apex' && host.startsWith('www.')) host = host.slice(4);
  else if (hostForm === 'www' && !host.startsWith('www.')) host = `www.${host}`;
  u.hostname = host;
  // Strip default web ports unconditionally — after the https rewrite, a leftover
  // :80 would otherwise survive on an https key and break the join.
  if (u.port === '80' || u.port === '443') u.port = '';

  // Fragment never affects indexing identity.
  u.hash = '';

  // Query: drop tracking params, sort the rest for stable ordering. Preserve key case.
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!isTrackingParam(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Path: preserve case (paths are case-sensitive); strip a single trailing slash
  // except the root. Decode nothing — leave percent-encoding as delivered.
  let path = u.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  u.pathname = path;

  // Rebuild without a trailing '?' when there are no params.
  const query = u.searchParams.toString();
  return `${u.protocol}//${u.host}${u.pathname}${query ? `?${query}` : ''}`;
}

/**
 * The registrable brand label of a property — the first domain label, lower-cased, alphanumerics
 * only (so "sc-domain:ehi.com.au" → "ehi", "https://www.sim-racing.gg/" → "simracing"). Returns null
 * for labels under 3 chars (too short to match safely). Used for whole-token brand matching:
 * `(' '||LOWER(query)||' ') LIKE '% '||brand||' %'` — same scheme as the dashboard's branded split.
 */
export function brandToken(siteUrl: string): string | null {
  const host = (siteUrl ?? '').replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const b = (host.split('.')[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return b.length >= 3 ? b : null;
}

/** Derive the hostForm to use from a GSC property identifier. */
export function hostFormForProperty(siteUrl: string): UrlKeyOptions['hostForm'] {
  // Domain properties ("sc-domain:example.com") cover both — default to apex.
  if (siteUrl.startsWith('sc-domain:')) return 'apex';
  // URL-prefix properties carry their own host form; honour it.
  try {
    return new URL(siteUrl).hostname.toLowerCase().startsWith('www.') ? 'www' : 'apex';
  } catch {
    return 'asis';
  }
}
