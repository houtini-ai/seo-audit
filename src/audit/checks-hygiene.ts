/**
 * #79 quick wins: crawl-hygiene checks over data the crawl already stores.
 *   - internal-nofollow          internal links carrying rel=nofollow into live, indexable pages
 *   - robots-txt-unreachable     robots.txt answered 5xx / 429 / nothing (Google pauses crawling)
 *   - robots-txt-health          size, syntax, orphan rules, split or conflicting groups, Sitemap: lines
 *   - sitemap-invalid            a declared or indexed sitemap that failed, isn't sitemap XML, or has bad <loc>s
 *   - sitemap-too-large          a sitemap file over 50,000 entries or 50 MB (sitemaps.org limits)
 *
 * Same contract as checks.ts: pure reads over stored rows, deterministic, thresholds from the
 * documentation they cite. Missing data = no finding, and checks that need a re-crawl to populate
 * their table say so through `collected`.
 */
import type { CheckContext, CheckDef, RawFinding } from './checks.js';
import { latestRobotsTxt } from '../core/robotsStore.js';
import { MAX_ROBOTS_BYTES, MAX_SITEMAP_BYTES } from '../core/cappedBody.js';
import { SITEMAP_MAX_ENTRIES } from '../core/sitemap.js';

const rows = (c: CheckContext, sql: string, ...args: unknown[]): any[] => c.db.prepare(sql).all(...args);
const one = (c: CheckContext, sql: string, ...args: unknown[]): any => c.db.prepare(sql).get(...args);
const tableExists = (c: CheckContext, name: string): boolean => !!one(c, `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, name);
const LIST_CAP = 10;

const ROBOTS_DOCS = 'https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt';
const SITEMAP_DOCS = 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap';

// ── internal-nofollow ────────────────────────────────────────────────────────────────────────
/**
 * Targets on routes nobody wants ranked. nofollow on links to these is harmless housekeeping, so they
 * are left out rather than reported (a cart or login page is usually noindex or disallowed anyway).
 */
const UTILITY_PATH = /\/(cart|basket|checkout|login|log-in|signin|sign-in|signup|sign-up|register|account|my-account|logout|wp-admin|wp-login\.php)(\/|$|\?)/i;
const pathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return ''; } };
const NOFOLLOW = (alias: string): string => `(' ' || LOWER(COALESCE(${alias}rel, '')) || ' ') LIKE '% nofollow %'`;

function internalNofollow(c: CheckContext): RawFinding[] {
  // Keyed on the TARGET: that is the page losing the internal signal, and its clicks are what's at stake.
  // Self-links (a "#" anchor normalises to the page itself) are excluded: they pass nothing either way.
  const hits = rows(c, `SELECT l.target_key tk, MIN(l.target_url) target, COUNT(*) n, COUNT(DISTINCT l.source_key) sources,
      GROUP_CONCAT(DISTINCT l.rel) rels,
      (SELECT COUNT(*) FROM links f WHERE f.target_key = l.target_key AND f.is_internal = 1 AND f.source_key <> f.target_key
         AND NOT ${NOFOLLOW('f.')}) followed
    FROM links l JOIN pages p ON p.url_key = l.target_key
    WHERE l.is_internal = 1 AND l.source_key <> l.target_key AND ${NOFOLLOW('l.')}
      AND p.status_code = 200 AND p.indexable = 1
    GROUP BY l.target_key`);
  const out: RawFinding[] = [];
  for (const h of hits) {
    if (UTILITY_PATH.test(pathOf(h.target))) continue;
    const sample = rows(c, `SELECT DISTINCT source_url FROM links WHERE target_key = ? AND is_internal = 1 AND source_key <> target_key AND ${NOFOLLOW('')} LIMIT 5`, h.tk)
      .map(r => r.source_url);
    out.push({ urlKey: h.tk, evidence: {
      target: h.target, nofollowLinks: h.n, fromPages: h.sources, followedInternalLinks: h.followed,
      rel: [...new Set(String(h.rels ?? '').split(','))].filter(Boolean), sampleSources: sample,
      note: h.followed === 0 ? 'every internal link to this page is nofollow' : 'some internal links to this page are nofollow',
    } });
  }
  return out;
}

// ── robots.txt ───────────────────────────────────────────────────────────────────────────────
/** Directives in common use. Anything else is reported as unknown (a typo like "Dissallow" silently does nothing). */
const KNOWN_DIRECTIVES = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'clean-param', 'content-signal', 'content-usage', 'request-rate', 'visit-time']);
/** Directives some sites still use that Google does not honour. */
const IGNORED_BY_GOOGLE: Record<string, string> = {
  noindex: 'Google stopped supporting noindex in robots.txt in September 2019; use a meta robots tag or X-Robots-Tag header',
  nofollow: 'not a robots.txt directive; Google ignores it',
};

export interface RobotsProblem { kind: string; detail: string; lines?: number[] }

/** Lint a robots.txt body. Pure, exported for the probe. */
export function lintRobotsTxt(body: string): RobotsProblem[] {
  const problems: RobotsProblem[] = [];
  if (Buffer.byteLength(body) >= MAX_ROBOTS_BYTES)
    problems.push({ kind: 'too-large', detail: `robots.txt is at or over Google's 500 KiB limit; rules after that point are ignored` });

  const malformed: number[] = [], orphan: number[] = [], emptyAgent: number[] = [], badSitemap: number[] = [];
  const unknown = new Map<string, number[]>(), ignored = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, ln: number): void => { (m.get(k) ?? m.set(k, []).get(k)!).push(ln); };
  let sitemaps = 0;
  type Group = { agents: string[]; rules: { allow: boolean; path: string; line: number }[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasRule = false;
  body.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const ln = i + 1;
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) { malformed.push(ln); return; }
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (IGNORED_BY_GOOGLE[key]) { push(ignored, key, ln); return; }
    if (!KNOWN_DIRECTIVES.has(key)) { push(unknown, m[1], ln); return; }
    if (key === 'user-agent') {
      if (!val) { emptyAgent.push(ln); return; }
      if (!cur || lastWasRule) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasRule = false;
      return;
    }
    if (key === 'allow' || key === 'disallow') {
      if (!cur) { orphan.push(ln); return; }
      if (val) cur.rules.push({ allow: key === 'allow', path: val, line: ln }); // an empty value is a valid no-op
      lastWasRule = true;
      return;
    }
    if (key === 'sitemap') {
      sitemaps++;
      try { if (!/^https?:$/.test(new URL(val).protocol)) badSitemap.push(ln); } catch { badSitemap.push(ln); }
    }
  });

  if (malformed.length) problems.push({ kind: 'malformed-line', detail: `${malformed.length} line(s) are not "field: value" and are ignored`, lines: malformed.slice(0, LIST_CAP) });
  for (const [k, ls] of unknown) problems.push({ kind: 'unknown-directive', detail: `"${k}" is not a robots.txt directive (a typo?), so ${ls.length} line(s) do nothing`, lines: ls.slice(0, LIST_CAP) });
  for (const [k, ls] of ignored) problems.push({ kind: 'ignored-by-google', detail: `${k}: ${IGNORED_BY_GOOGLE[k]}`, lines: ls.slice(0, LIST_CAP) });
  if (emptyAgent.length) problems.push({ kind: 'empty-user-agent', detail: 'User-agent with no value matches no crawler', lines: emptyAgent.slice(0, LIST_CAP) });
  if (orphan.length) problems.push({ kind: 'rule-before-user-agent', detail: `${orphan.length} Allow/Disallow line(s) come before any User-agent, so they belong to no group and are ignored`, lines: orphan.slice(0, LIST_CAP) });

  // Per user-agent token: split groups (Google merges them, but editing one and missing the other is
  // a common mistake) and the same path both allowed and disallowed (Google resolves it to Allow).
  const byAgent = new Map<string, { groups: number; rules: Group['rules'] }>();
  for (const g of groups) for (const a of new Set(g.agents)) {
    const e = byAgent.get(a) ?? byAgent.set(a, { groups: 0, rules: [] }).get(a)!;
    e.groups++; e.rules.push(...g.rules);
  }
  const split = [...byAgent].filter(([, e]) => e.groups > 1).map(([a, e]) => `${a} (${e.groups} groups)`);
  if (split.length) problems.push({ kind: 'split-groups', detail: `user-agent declared in more than one group (Google merges them): ${split.slice(0, LIST_CAP).join(', ')}${split.length > LIST_CAP ? `, and ${split.length - LIST_CAP} more` : ''}` });
  for (const [a, e] of byAgent) {
    const allowAt = new Map(e.rules.filter(r => r.allow).map(r => [r.path, r.line]));
    const clash = e.rules.filter(r => !r.allow && allowAt.has(r.path));
    if (clash.length) problems.push({ kind: 'conflicting-rules', detail: `for ${a}, ${[...new Set(clash.map(r => r.path))].slice(0, 5).join(', ')} is both allowed and disallowed; Google applies the Allow`, lines: clash.flatMap(r => [allowAt.get(r.path)!, r.line]).slice(0, LIST_CAP) });
  }

  if (badSitemap.length) problems.push({ kind: 'sitemap-not-absolute', detail: 'Sitemap: must be a full URL (https://...); a relative value is ignored', lines: badSitemap.slice(0, LIST_CAP) });
  if (sitemaps === 0) problems.push({ kind: 'no-sitemap-line', detail: 'no Sitemap: line, so crawlers you have not submitted the sitemap to by hand cannot find it' });
  return problems;
}

const storedRobots = (c: CheckContext) => (tableExists(c, 'robots_txt') ? latestRobotsTxt(c.db) : null);

// ── sitemaps ─────────────────────────────────────────────────────────────────────────────────
const sitemapFilesCollected = (c: CheckContext): string | null =>
  tableExists(c, 'sitemap_files') && one(c, `SELECT 1 FROM sitemap_files LIMIT 1`)
    ? null
    : 'Sitemap file details are recorded by crawls from 1.0.2 on. Re-crawl the property (start_crawl, or Run crawl in the dashboard) to check sitemap validity and size.';

const walkCapNote = (c: CheckContext): Record<string, unknown> =>
  one(c, `SELECT 1 FROM sitemap_files WHERE walk_capped = 1 LIMIT 1`)
    ? { walkCapped: true, capNote: 'the crawl stops reading sitemaps at 60 files or 100,000 URLs; sitemaps past that point were not checked' }
    : {};

export const HYGIENE_CHECKS: CheckDef[] = [
  {
    id: 'internal-nofollow', category: 'crawlability', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'Internal links marked nofollow',
    fix: 'Remove rel="nofollow" (and "sponsored" or "ugc") from links between your own pages. It stops internal links passing their signal to a page you want ranked, and it is usually a template default (an affiliate-link plugin stamping every link) rather than a choice. Links to cart, login and account pages are not reported.',
    run: internalNofollow,
  },
  {
    id: 'robots-txt-unreachable', category: 'crawlability', severity: 'high', labels: ['D'], certainty: 0.8, effortBase: 1, fixType: 'global',
    title: 'robots.txt returned a server error or no response',
    fix: `When robots.txt answers 5xx, 429 or nothing at all, Google stops crawling the site for 12 hours and keeps retrying; after 30 days it falls back to the last copy it has. Make robots.txt return 200 (or 404 if you have no rules). The request was made with the crawler's user agent, so a firewall challenge that Googlebot would pass can cause this: confirm in Search Console's robots.txt report. ${ROBOTS_DOCS}`,
    run: (c) => {
      const r = storedRobots(c);
      if (!r || !(r.status === 0 || r.status === 429 || r.status >= 500)) return [];
      return [{ urlKey: null, evidence: { robotsTxt: `${r.origin}/robots.txt`, status: r.status === 0 ? 'no response' : r.status, fetchedAt: r.fetchedAt } }];
    },
  },
  {
    id: 'robots-txt-health', category: 'crawlability', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'robots.txt has errors or no Sitemap: line',
    fix: `Fix the lines listed: unknown or misspelt directives and rules outside a User-agent group are ignored, Google applies Allow when a path is both allowed and disallowed, and anything past 500 KiB is cut off. Add a Sitemap: line with the full sitemap URL. ${ROBOTS_DOCS}`,
    run: (c) => {
      const r = storedRobots(c);
      if (!r || r.status < 200 || r.status >= 300 || r.body == null) return [];
      const problems = lintRobotsTxt(r.body);
      return problems.length ? [{ urlKey: null, evidence: { robotsTxt: `${r.origin}/robots.txt`, fetchedAt: r.fetchedAt, problems } }] : [];
    },
  },
  {
    id: 'sitemap-invalid', category: 'indexation', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'Sitemap that fails, is not sitemap XML, or lists bad URLs',
    fix: `A sitemap declared in robots.txt or listed by a sitemap index must return 200 with <urlset> or <sitemapindex> XML, and every <loc> must be a full http(s) URL. A failing or HTML sitemap gives Google nothing, and relative locs are dropped. Fix the URL or the generator, then resubmit in Search Console. Probes of conventional locations (/sitemap.xml) that don't exist are not reported. ${SITEMAP_DOCS}`,
    collected: sitemapFilesCollected,
    run: (c) => {
      if (sitemapFilesCollected(c)) return [];
      const bad = rows(c, `SELECT url, source, outcome, http_status st, kind, entries, invalid_locs inv FROM sitemap_files
        WHERE (source IN ('robots','index') AND outcome IN ('http-error','no-response','not-sitemap')) OR (outcome = 'ok' AND invalid_locs > 0)
        ORDER BY url`);
      const extra = walkCapNote(c);
      return bad.map(b => ({ urlKey: null, evidence: {
        sitemap: b.url, foundVia: b.source === 'robots' ? 'robots.txt' : b.source === 'index' ? 'sitemap index' : 'conventional location',
        problem: b.outcome === 'ok' ? `${b.inv} <loc> value(s) are not full http(s) URLs`
          : b.outcome === 'not-sitemap' ? 'answered 200 but is not sitemap XML (often an HTML page)'
          : b.outcome === 'no-response' ? 'no response' : `HTTP ${b.st}`,
        ...(b.outcome === 'ok' ? { kind: b.kind, entries: b.entries, invalidLocs: b.inv } : {}),
        ...extra,
      } }));
    },
  },
  {
    id: 'sitemap-too-large', category: 'indexation', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'Sitemap over the 50,000 URL or 50 MB limit',
    fix: `A single sitemap file may hold at most 50,000 URLs and 50 MB uncompressed (a sitemap index: 50,000 child sitemaps). Google ignores a file over the limit. Split it into several sitemaps listed by a sitemap index. ${SITEMAP_DOCS}`,
    collected: sitemapFilesCollected,
    run: (c) => {
      if (sitemapFilesCollected(c)) return [];
      const big = rows(c, `SELECT url, kind, entries, bytes, outcome FROM sitemap_files WHERE outcome = 'oversized' OR entries > ? OR bytes > ?`, SITEMAP_MAX_ENTRIES, MAX_SITEMAP_BYTES);
      const extra = walkCapNote(c);
      return big.map(b => ({ urlKey: null, evidence: {
        sitemap: b.url, kind: b.kind,
        ...(b.outcome === 'oversized' ? { problem: 'over 50 MB uncompressed; not read' }
          : { entries: b.entries, bytes: b.bytes, limit: `${SITEMAP_MAX_ENTRIES.toLocaleString('en-GB')} ${b.kind === 'sitemapindex' ? 'child sitemaps' : 'URLs'} per file` }),
        ...extra,
      } }));
    },
  },
];
