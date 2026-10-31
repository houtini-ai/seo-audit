/**
 * robots.txt politeness gate, per RFC 9309:
 *  - the group whose user-agent line names this crawler's product token (exact, case-insensitive)
 *    replaces `*`; `User-agent: bot` does not name Googlebot (a substring match said it did);
 *  - Allow and Disallow patterns match the path AND query from the start, `*` matches any run of
 *    characters and a trailing `$` anchors the end (`Disallow: /*.pdf$`, `Disallow: /search?q=`);
 *  - the longest matching pattern wins, Allow wins a tie (`Allow: /$` + `Disallow: /` allows '/');
 *  - /robots.txt itself is always allowed.
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
      if (value) current.rules.push({ path: value, allow: field === 'allow', re: patternRe(value) });
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
    isAllowed(p: string): boolean {
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

export async function fetchRobots(origin: string, userAgent: string, uaToken = 'seo-audit-console'): Promise<RobotsRules> {
  try {
    const res = await fetch(new URL('/robots.txt', origin), {
      headers: { 'user-agent': userAgent, 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return ALLOW_ALL;
    return makeRules(parseRules(await res.text(), uaToken));
  } catch {
    return ALLOW_ALL; // robots unavailable → don't block (owned-site crawl)
  }
}

/** Rules for one UA token from robots.txt text (same group matching and prefix rules as the crawl gate). */
export function rulesFromText(txt: string, uaToken: string): RobotsRules {
  return makeRules(parseRules(txt, uaToken));
}

/** A raw robots.txt fetch, so it can be stored and re-read by the audit (#55): status + body. */
export interface RobotsTxtFetch { status: number; body: string | null }

/**
 * Fetch robots.txt and return the status and body (body only on a 2xx). status 0 = no response.
 * The crawl stores this (robots_txt table) so checks can ask what robots.txt says for Googlebot or
 * an AI bot without a live request, and the finding cites the stored bytes.
 */
export async function fetchRobotsTxt(origin: string, userAgent: string): Promise<RobotsTxtFetch> {
  try {
    const res = await fetch(new URL('/robots.txt', origin), {
      headers: { 'user-agent': userAgent, 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(10000),
    });
    return { status: res.status, body: res.ok ? (await res.text()).slice(0, 512 * 1024) : null };
  } catch {
    return { status: 0, body: null };
  }
}
