/**
 * robots.txt politeness gate. Honours both Disallow AND Allow with longest-prefix-match
 * (most specific path wins; Allow wins ties) — so a broad `Disallow: /` paired with
 * `Allow: /public/` doesn't wrongly empty the crawl. NB: prefix match only — `*`/`$`
 * wildcard patterns (e.g. `Disallow: /*?`) are not yet interpreted (owned-site crawl).
 */
export interface RobotsRules {
  isAllowed(pathname: string): boolean;
}

interface Rule { path: string; allow: boolean }
const ALLOW_ALL: RobotsRules = { isAllowed: () => true };

function parseRules(txt: string, uaToken: string): Rule[] {
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
      if (value) current.rules.push({ path: value, allow: field === 'allow' });
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
  const agentScore = (a: string): number => (a === '*' ? 0 : ua.includes(a) ? a.length : -1);
  const groupScore = (g: { agents: string[] }): number => Math.max(-1, ...g.agents.map(agentScore));
  const best = Math.max(-1, ...groups.map(groupScore));
  if (best < 0) return [];
  return groups.filter(g => groupScore(g) === best).flatMap(g => g.rules);
}

function makeRules(rules: Rule[]): RobotsRules {
  if (!rules.length) return ALLOW_ALL;
  return {
    isAllowed(p: string): boolean {
      let best: Rule | null = null;
      for (const r of rules) {
        if (!p.startsWith(r.path)) continue;
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
