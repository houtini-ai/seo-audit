/**
 * Minimal robots.txt politeness gate. Not the full RFC 9309 audit parser
 * (that's a later analyzer module) — just enough to crawl owned sites
 * respectfully: honour Disallow for our UA token and `*`.
 */
export interface RobotsRules {
  isAllowed(pathname: string): boolean;
}

const ALLOW_ALL: RobotsRules = { isAllowed: () => true };

function parseDisallows(txt: string, uaToken: string): string[] {
  const lines = txt.split(/\r?\n/);
  const groups: { agents: string[]; disallows: string[] }[] = [];
  let current: { agents: string[]; disallows: string[] } | null = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'disallow' && current) {
      if (value) current.disallows.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  const ua = uaToken.toLowerCase();
  const matching = groups.filter(g => g.agents.some(a => a === '*' || ua.includes(a)));
  return matching.flatMap(g => g.disallows);
}

export async function fetchRobots(origin: string, userAgent: string, uaToken = 'seo-audit-console'): Promise<RobotsRules> {
  try {
    const res = await fetch(new URL('/robots.txt', origin), {
      headers: { 'user-agent': userAgent },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return ALLOW_ALL;
    const disallows = parseDisallows(await res.text(), uaToken);
    if (disallows.length === 0) return ALLOW_ALL;
    return { isAllowed: (p: string) => !disallows.some(d => d === '/' ? true : p.startsWith(d)) };
  } catch {
    return ALLOW_ALL; // robots unavailable → don't block (owned-site crawl)
  }
}
