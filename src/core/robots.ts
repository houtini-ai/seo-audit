import { readCappedText, MAX_ROBOTS_BYTES } from './cappedBody.js';
import { isInternalHost } from './extract.js';
import { publicOnlyAgent } from './netGuard.js';
import { CHROME_HEADERS, looksBotBlocked, type FetchedAs } from './userAgents.js';
/**
 * robots.txt politeness gate, per RFC 9309:
 *  - the group whose user-agent line names this crawler's product token (exact, case-insensitive)
 *    replaces `*`; `User-agent: bot` does not name Googlebot (a substring match said it did);
 *  - Allow and Disallow patterns match the path AND query from the start, `*` matches any run of
 *    characters and a trailing `$` anchors the end (`Disallow: /*.pdf$`, `Disallow: /search?q=`);
 *  - the longest matching pattern wins, Allow wins a tie (`Allow: /$` + `Disallow: /` allows '/');
 *  - /robots.txt itself is always allowed;
 *  - rules and paths are compared percent-encoded the same way (§2.2.2): a space or non-ASCII
 *    character as its UTF-8 %XX, hex in upper case, an encoded unreserved character decoded, so
 *    `Disallow: /café/` matches the request path `/caf%C3%A9/`.
 * Pass `pathname + search` to isAllowed.
 */
export interface RobotsRules {
  isAllowed(pathAndQuery: string): boolean;
}

interface Rule { path: string; allow: boolean; re: RegExp }
const ALLOW_ALL: RobotsRules = { isAllowed: () => true };
/** RFC 9309 §2.3.1.4: a 5xx, a 429 or no response means robots.txt is unreachable, so nothing may be
 *  crawled (complete disallow). A 4xx means there is no robots.txt: everything may be crawled. */
export const robotsUnreachable = (status: number): boolean => status === 0 || status === 429 || status >= 500;

/**
 * One spelling for a rule and for the path it is matched against (RFC 9309 §2.2.2). Without it
 * `Disallow: /café/` and `Disallow: /my files/` never matched (a URL's pathname is always
 * percent-encoded), nor did `/caf%c3%a9` against `/caf%C3%A9`, and the disallowed URL was fetched.
 */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
export function normaliseRobotsPath(s: string): string {
  return s
    .replace(/[^\x21-\x7e]/gu, (c) => { try { return encodeURIComponent(c); } catch { return c; } }) // space, control, non-ASCII
    .replace(/%[0-9a-f]{2}/gi, (m) => { const ch = String.fromCharCode(parseInt(m.slice(1), 16)); return UNRESERVED.test(ch) ? ch : m.toUpperCase(); });
}

/**
 * The robots.txt product token a crawl answers to. A custom userAgent names its own token
 * (`MyBot/1.0` -> `mybot`, `Mozilla/5.0 (compatible; Googlebot/2.1; ...)` -> `googlebot`), so the
 * rules obeyed are the ones written for the identity the site sees. No userAgent, or a plain
 * browser string with no bot token, keeps the crawler's own `seo-audit-console`.
 */
export const DEFAULT_ROBOTS_TOKEN = 'seo-audit-console';
export function robotsTokenFor(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').trim();
  if (!ua) return DEFAULT_ROBOTS_TOKEN;
  const compatible = /compatible;\s*([a-z0-9_-]+)/i.exec(ua)?.[1];
  if (compatible) return compatible.toLowerCase();
  const first = productToken(ua);
  return first && first !== 'mozilla' ? first : DEFAULT_ROBOTS_TOKEN;
}

/** A robots.txt path pattern as an anchored RegExp: `*` = any run, a trailing `$` = end of URL. */
function patternRe(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}
/** The product token at the start of a user-agent line (`Googlebot/2.1` -> `googlebot`). */
const productToken = (agent: string): string => (/^[a-z0-9_-]+/i.exec(agent)?.[0] ?? '').toLowerCase();

function parseRules(txt: string, uaToken: string): Rule[] {
  return matchGroup(txt, uaToken).rules;
}

/** The most-specific group for a UA token: its rules, and whether a group NAMES the token (vs `*`). */
function matchGroup(txt: string, uaToken: string): { rules: Rule[]; named: boolean; matched: boolean } {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;

  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'disallow' || field === 'allow') && current) {
      // An empty Disallow value means "allow everything" — carries no restriction.
      if (value) { const path = normaliseRobotsPath(value); current.rules.push({ path, allow: field === 'allow', re: patternRe(path) }); }
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  // RFC 9309 §2.2.1: only the MOST SPECIFIC matching group applies — a bot-specific group
  // replaces the `*` group entirely (it does not merge with it). Otherwise a site that
  // whitelists this bot (`User-agent: seo-audit-console / Allow: /`) alongside a broad
  // `User-agent: * / Disallow: /` would still be blocked. Groups at equal specificity merge.
  const ua = uaToken.toLowerCase();
  const agentScore = (a: string): number => (a === '*' ? 0 : productToken(a) === ua ? a.length : -1);
  const groupScore = (g: { agents: string[] }): number => Math.max(-1, ...g.agents.map(agentScore));
  const best = Math.max(-1, ...groups.map(groupScore));
  if (best < 0) return { rules: [], named: false, matched: false };
  return { rules: groups.filter(g => groupScore(g) === best).flatMap(g => g.rules), named: best > 0, matched: true };
}

/**
 * What robots.txt says about one user-agent token, for the site root ('/'). `named`: a group names
 * this token (so its rules replace `*`, RFC 9309); `allowed`: '/' is crawlable under the group that
 * applies (no matching group at all = allowed).
 */
export function robotsVerdict(txt: string, uaToken: string): { named: boolean; allowed: boolean } {
  const g = matchGroup(txt, uaToken);
  return { named: g.named, allowed: makeRules(g.rules).isAllowed('/') };
}

function makeRules(rules: Rule[]): RobotsRules {
  if (!rules.length) return ALLOW_ALL;
  return {
    isAllowed(rawPath: string): boolean {
      const p = normaliseRobotsPath(rawPath);
      if (p === '/robots.txt') return true;
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.re.test(p)) continue;
        // longest match wins; Allow beats Disallow at equal length
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

/** Rules for one UA token from robots.txt text (same group matching and prefix rules as the crawl gate). */
export function rulesFromText(txt: string, uaToken: string): RobotsRules {
  return makeRules(parseRules(txt, uaToken));
}

/** A raw robots.txt fetch, so it can be stored and re-read by the audit (#55): status + body. */
export interface RobotsTxtFetch { status: number; body: string | null; /** 'chrome' when the crawler's own UA was bot-blocked and the Chrome retry answered. */ fetchedAs?: FetchedAs }

let guardAgent: ReturnType<typeof publicOnlyAgent> | null = null;
const MAX_HOPS = 5; // RFC 9309 §2.3.1.2: follow at least five consecutive redirects

/**
 * Fetch robots.txt and return the status and body (body only on a 2xx). status 0 = no response.
 * The crawl stores this (robots_txt table) so checks can ask what robots.txt says for Googlebot or
 * an AI bot without a live request, and the finding cites the stored bytes.
 *
 * Redirects are followed by hand, as the sitemap fetcher does: the property's own host is fetched
 * as-is (it may be local), every other host through publicOnlyAgent, so a robots.txt that redirects
 * to 169.254.169.254 or an intranet host is refused instead of read and stored. More than five
 * hops, or a refused hop, is "no response" (unreachable: nothing is crawled).
 *
 * `chromeFallback`: a bot block (403, 999, a WAF challenge) under the crawler's own UA is retried
 * once with the Chrome headers, like a page. Without it a walled site's 403 read as "no robots.txt,
 * crawl everything" while its pages were then fetched as Chrome, so its real rules were never seen.
 */
export async function fetchRobotsTxt(origin: string, userAgent: string, opts: { chromeFallback?: boolean } = {}): Promise<RobotsTxtFetch> {
  const ownHost = new URL(origin).hostname;
  const attempt = async (asChrome: boolean): Promise<Response | null> => {
    let current = new URL('/robots.txt', origin).toString();
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const own = isInternalHost(new URL(current).hostname, ownHost);
      const res = await fetch(current, {
        headers: { ...(asChrome ? CHROME_HEADERS : { 'user-agent': userAgent }), 'cache-control': 'no-cache' }, redirect: 'manual',
        signal: AbortSignal.timeout(10000),
        ...(own ? {} : { dispatcher: (guardAgent ??= publicOnlyAgent()) }),
      } as RequestInit);
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) return res;
      try { await res.body?.cancel(); } catch { /* no body */ }
      current = new URL(loc, current).toString();
      if (!/^https?:$/.test(new URL(current).protocol)) return null;
    }
    return null; // too many redirects
  };
  try {
    let res = await attempt(false);
    let fetchedAs: FetchedAs = 'bot';
    if (res && opts.chromeFallback && looksBotBlocked(res.status, n => res!.headers.get(n))) {
      try { await res.body?.cancel(); } catch { /* no body */ }
      res = await attempt(true);
      fetchedAs = 'chrome';
    }
    if (!res) return { status: 0, body: null };
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* no body */ } }
    return { status: res.status, body: res.ok ? (await readCappedText(res, MAX_ROBOTS_BYTES)).text : null, ...(fetchedAs === 'chrome' ? { fetchedAs } : {}) };
  } catch {
    return { status: 0, body: null };
  }
}
