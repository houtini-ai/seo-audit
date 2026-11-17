/**
 * #55 summary slice 4, group A: site-level signals that feed the summary page.
 *   - site-wide-indexing-alarm  (item 1)  the one critical finding an owner must never miss
 *   - snippet-restricted, ai-search-bot-blocked (item 2)  AI-search visibility controls
 *   - crux-field-lcp / -inp / -cls, crux-regression (item 4)  field Core Web Vitals (CrUX)
 *   - nonbrand-decline-masked (item 5)  a ranking loss hidden inside a flat total
 *
 * Same contract as checks.ts: each check is a pure read over stored rows, deterministic, and its
 * thresholds come from Google's documentation or are stated in the check. Missing data means no
 * finding, never a zero. Appended to CHECKS in checks.ts.
 */
import { pageRowsFor } from '../core/gscPageTotals.js';
import type { CheckContext, CheckDef, RawFinding } from './checks.js';
import { latestRobotsTxt } from '../core/robotsStore.js';
import { robotsVerdict, rulesFromText } from '../core/robots.js';
import { AI_BOTS } from '../core/aiBots.js';
import { BAND_RANK, CWV_THRESHOLDS, cwvBand, type CwvBand, type CwvMetric } from '../core/CruxSync.js';
import { loadBrandQueries, brandPredicate } from '../core/brand.js';
import { GSC_ROWS, gscStorageState, hasGscRows } from '../core/gscRows.js';

const rows = (c: CheckContext, sql: string, ...args: unknown[]): any[] => c.db.prepare(sql).all(...args);
const one = (c: CheckContext, sql: string, ...args: unknown[]): any => c.db.prepare(sql).get(...args);
const tableExists = (c: CheckContext, name: string): boolean => !!one(c, `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, name);
const pct = (now: number, before: number): number => Math.round(((now - before) / before) * 1000) / 10;

/** robots.txt from the latest crawl, when it answered 2xx with a body. 4xx = no rules (Google treats it as allow-all); 5xx / no response = unknown. */
function storedRobots(c: CheckContext): { origin: string; body: string; fetchedAt: string } | null {
  if (!tableExists(c, 'robots_txt')) return null;
  const r = latestRobotsTxt(c.db);
  return r && r.status >= 200 && r.status < 300 && r.body != null ? { origin: r.origin, body: r.body, fetchedAt: r.fetchedAt } : null;
}

// ── Item 1: site-wide-indexing-alarm ─────────────────────────────────────────────────────────
/** Thresholds, stated: a sitemap "majority" is more than half of its crawled 200 URLs, and needs at least this many. */
export const SITEMAP_NOINDEX_MIN_URLS = 5;
/** Week-on-week drop in distinct pages earning impressions that raises the CRITICAL alarm. #55 proposed
 * "more than 20%", but the 0.16.0 end-to-end run showed a 58 -> 46 page dip (-21%) on a healthy small
 * site raising a critical: ordinary weekly variation. A shipped noindex or Disallow: / takes half or
 * more of the pages out within days, so the alarm is reserved for drops of that size. */
export const IMPRESSION_PAGES_DROP = 0.4;
/** The prior week needs at least this many pages with impressions, or a small site's noise reads as a collapse. */
export const IMPRESSION_PAGES_MIN = 50;

const NOINDEXED = (alias: string): string => `(${alias}indexable_reason IN ('noindex-meta','noindex-header') OR ${alias}noindex=1)`;

function indexingTriggers(c: CheckContext): Record<string, unknown>[] {
  const triggers: Record<string, unknown>[] = [];

  // (a) The homepage carries noindex (the crawl's root: click depth 0).
  const hp = one(c, `SELECT url, indexable_reason reason, robots, x_robots_tag xrt FROM pages WHERE status_code=200 AND click_depth=0 AND ${NOINDEXED('')} LIMIT 1`);
  if (hp) triggers.push({ trigger: 'homepage-noindex', url: hp.url, reason: hp.reason, metaRobots: hp.robots ?? null, xRobotsTag: hp.xrt ?? null });

  // (b) Most of the sitemap's crawled 200 URLs carry noindex (a staging noindex shipped to production).
  const sm = one(c, `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ${NOINDEXED('p.')} THEN 1 ELSE 0 END),0) ni
    FROM sitemap_urls s JOIN pages p ON p.url_key = s.url_key WHERE p.status_code=200`);
  if (sm && sm.n >= SITEMAP_NOINDEX_MIN_URLS && sm.ni / sm.n > 0.5) {
    const sample = rows(c, `SELECT p.url FROM sitemap_urls s JOIN pages p ON p.url_key = s.url_key WHERE p.status_code=200 AND ${NOINDEXED('p.')} LIMIT 5`).map(r => r.url);
    triggers.push({ trigger: 'sitemap-majority-noindex', sitemapUrlsCrawled: sm.n, noindex: sm.ni, sharePct: Math.round((sm.ni / sm.n) * 1000) / 10, threshold: `> 50% of crawled sitemap URLs (min ${SITEMAP_NOINDEX_MIN_URLS})`, sample });
  }

  // (c) robots.txt disallows '/' for Googlebot (RFC 9309 most-specific group, as the crawl gate reads it).
  const rb = storedRobots(c);
  if (rb) {
    const v = robotsVerdict(rb.body, 'Googlebot');
    if (!v.allowed) triggers.push({ trigger: 'robots-disallow-googlebot', robotsTxt: `${rb.origin}/robots.txt`, fetchedAt: rb.fetchedAt, group: v.named ? 'Googlebot' : '*', note: 'Googlebot may not fetch "/" under the group that applies to it' });
  }

  // (d) Distinct pages earning impressions fell > 20% week on week (last 7 finalised days vs the 7 before).
  const d = c.gscMaxDate;
  if (d) {
    const week = (endOffset: number): { pages: number; days: number; from: string; to: string } => one(c,
      `SELECT COUNT(DISTINCT CASE WHEN impressions > 0 THEN page_key END) pages, COUNT(DISTINCT date) days,
              date(?, '${-endOffset - 6} days') "from", date(?, '${-endOffset} days') "to"
       FROM ${pageRowsFor(c.db, d, 14).table} WHERE page_key IS NOT NULL AND date >= date(?, '${-endOffset - 6} days') AND date <= date(?, '${-endOffset} days')`, d, d, d, d);
    const cur = week(0), prior = week(7);
    if (cur.days === 7 && prior.days === 7 && prior.pages >= IMPRESSION_PAGES_MIN && cur.pages < prior.pages * (1 - IMPRESSION_PAGES_DROP)) {
      triggers.push({ trigger: 'impression-pages-drop', currentWeek: cur, priorWeek: prior, changePct: pct(cur.pages, prior.pages), threshold: `> ${IMPRESSION_PAGES_DROP * 100}% fewer pages with impressions, prior week >= ${IMPRESSION_PAGES_MIN} pages, finalised GSC days only` });
    }
  }
  return triggers;
}

// ── Item 2: snippet-restricted ───────────────────────────────────────────────────────────────
// Robots directive names that take a value after a colon (so "max-snippet: 0" is not a UA prefix).
const VALUED = new Set(['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);
/**
 * The snippet restrictions that apply to Google in a meta robots value and an X-Robots-Tag header.
 * X-Robots-Tag may scope directives to a crawler ("otherbot: nosnippet"); only unscoped or
 * googlebot-scoped ones count. Returns the restricting directives with where each was found.
 */
export function snippetRestrictions(metaRobots: string | null, xRobotsTag: string | null): { directive: string; source: 'meta' | 'header' }[] {
  const out: { directive: string; source: 'meta' | 'header' }[] = [];
  const scan = (value: string, source: 'meta' | 'header'): void => {
    let scope: string | null = null; // null = all crawlers
    for (const raw of value.toLowerCase().split(',')) {
      let tok = raw.trim();
      const m = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(tok);
      if (m && !VALUED.has(m[1]) && source === 'header') { scope = m[1]; tok = m[2].trim(); }
      if (scope && scope !== 'googlebot') continue;
      if (tok === 'nosnippet') out.push({ directive: 'nosnippet', source });
      else if (/^max-snippet\s*:\s*0$/.test(tok)) out.push({ directive: 'max-snippet:0', source });
    }
  };
  if (metaRobots) scan(metaRobots, 'meta');
  if (xRobotsTag) scan(xRobotsTag, 'header');
  return out;
}

// ── Item 2: ai-search-bot-blocked ────────────────────────────────────────────────────────────
/** How many of the top pages by GSC clicks are tested per search bot for a partial block. */
export const AI_BOT_TOP_PAGES = 50;

function aiSearchBotFindings(c: CheckContext): RawFinding[] {
  const rb = storedRobots(c);
  if (!rb) return [];
  // Top pages by clicks (28 finalised days) - a block on these costs the most citations.
  const top: string[] = c.gscMaxDate
    ? rows(c, `SELECT page_key FROM ${pageRowsFor(c.db, c.gscMaxDate, 28).table} WHERE page_key IS NOT NULL AND date > date(?, '-28 days') AND date <= ? GROUP BY page_key HAVING SUM(clicks) > 0 ORDER BY SUM(clicks) DESC LIMIT ?`, c.gscMaxDate, c.gscMaxDate, AI_BOT_TOP_PAGES).map(r => r.page_key)
    : [];
  const pathOf = (u: string): string | null => { try { const x = new URL(u); return x.pathname + x.search; } catch { return null; } };
  const blocked: Record<string, unknown>[] = [];
  for (const b of AI_BOTS.filter(x => x.group === 'search')) {
    const v = robotsVerdict(rb.body, b.token);
    if (!v.allowed) { blocked.push({ bot: b.token, operator: b.operator, use: b.note, scope: 'site', group: v.named ? b.token : '*' }); continue; }
    const rules = rulesFromText(rb.body, b.token);
    const paths = top.map(pathOf).filter((p): p is string => !!p && !rules.isAllowed(p));
    if (paths.length) blocked.push({ bot: b.token, operator: b.operator, use: b.note, scope: 'pages', group: v.named ? b.token : '*', topPagesBlocked: paths.length, of: top.length, sample: paths.slice(0, 10) });
  }
  if (!blocked.length) return [];
  // Training bots are reported for context only: blocking them is a choice, not an issue.
  const trainingBlocked = AI_BOTS.filter(x => x.group === 'training' && !robotsVerdict(rb.body, x.token).allowed).map(x => x.token);
  return [{ urlKey: null, evidence: { robotsTxt: `${rb.origin}/robots.txt`, fetchedAt: rb.fetchedAt, searchBotsBlocked: blocked, trainingBotsBlocked: trainingBlocked, note: 'search/citation bots only; training-bot blocks are listed for context and are not an issue' } }];
}

// ── Item 4: CrUX field data ──────────────────────────────────────────────────────────────────
/** A target's latest window counts only if it is within this many days of the newest window stored (a target that dropped out of CrUX is not "latest"). */
export const CRUX_RECENT_DAYS = 14;
/** crux-regression compares the newest window with the one 3 windows earlier (the last 4 windows). */
export const CRUX_REGRESSION_WINDOWS = 4;

interface CruxRow { scope: string; target: string; form_factor: string; period_first: string; period_last: string; p75: number | null; good: number | null; ni: number | null; poor: number | null; good_max: number | null; ni_max: number | null; source: string }

function cruxLatest(c: CheckContext, metric: CwvMetric): CruxRow[] {
  if (!tableExists(c, 'crux_metrics')) return [];
  return rows(c, `SELECT m.* FROM crux_metrics m
    WHERE m.metric = ? AND m.p75 IS NOT NULL
      AND m.period_last = (SELECT MAX(period_last) FROM crux_metrics x WHERE x.scope=m.scope AND x.target=m.target AND x.form_factor=m.form_factor AND x.metric=m.metric AND x.p75 IS NOT NULL)
      AND m.period_last >= date((SELECT MAX(period_last) FROM crux_metrics), '-${CRUX_RECENT_DAYS} days')
      AND NOT EXISTS (SELECT 1 FROM crux_targets t WHERE t.scope=m.scope AND t.target=m.target AND t.form_factor=m.form_factor AND t.status='insufficient_data')
    ORDER BY m.scope, m.target, m.form_factor`, metric) as CruxRow[];
}

function cruxEvidence(r: CruxRow, metric: CwvMetric, band: CwvBand): Record<string, unknown> {
  const t = CWV_THRESHOLDS[metric];
  return {
    metric: t.label, scope: r.scope, target: r.target, formFactor: r.form_factor,
    p75: r.p75, unit: t.unit || null, band,
    thresholds: { good: t.good, poor: t.poor, source: 'Google (web.dev/articles/vitals): good <= good, poor > poor, at p75' },
    distribution: { good: r.good, needsImprovement: r.ni, poor: r.poor },
    binEdgesAsReturned: { goodMax: r.good_max, niMax: r.ni_max },
    window: { first: r.period_first, last: r.period_last, source: r.source },
  };
}

function cruxFieldCheck(metric: CwvMetric): (c: CheckContext) => RawFinding[] {
  return (c) => cruxLatest(c, metric).flatMap(r => {
    const band = cwvBand(metric, r.p75);
    return band && band !== 'good' ? [{ urlKey: r.scope === 'url' ? r.target : null, evidence: cruxEvidence(r, metric, band) }] : [];
  });
}

function cruxRegression(c: CheckContext): RawFinding[] {
  const out: RawFinding[] = [];
  const metrics: CwvMetric[] = ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'];
  if (!tableExists(c, 'crux_metrics')) return out;
  const series = c.db.prepare(`SELECT period_last, p75, source FROM crux_metrics WHERE scope=? AND target=? AND form_factor=? AND metric=? AND p75 IS NOT NULL ORDER BY period_last DESC LIMIT ${CRUX_REGRESSION_WINDOWS}`);
  for (const metric of metrics) {
    for (const r of cruxLatest(c, metric)) {
      const s = (series.all(r.scope, r.target, r.form_factor, metric) as { period_last: string; p75: number; source: string }[]).reverse();
      if (s.length < 2) continue;
      const from = cwvBand(metric, s[0].p75)!, to = cwvBand(metric, s[s.length - 1].p75)!;
      if (BAND_RANK[to] <= BAND_RANK[from]) continue;
      out.push({
        urlKey: r.scope === 'url' ? r.target : null,
        evidence: {
          metric: CWV_THRESHOLDS[metric].label, scope: r.scope, target: r.target, formFactor: r.form_factor,
          fromBand: from, toBand: to, windows: s.map(w => ({ periodLast: w.period_last, p75: w.p75, band: cwvBand(metric, w.p75) })),
          thresholds: { good: CWV_THRESHOLDS[metric].good, poor: CWV_THRESHOLDS[metric].poor },
          note: `p75 moved into a worse band within the last ${CRUX_REGRESSION_WINDOWS} 28-day windows (windows overlap: a trend, not separate months)`,
        },
      });
    }
  }
  return out;
}

// ── Item 5: nonbrand-decline-masked ──────────────────────────────────────────────────────────
/** Thresholds, stated: total clicks no more than 5% down (flat or up) while non-brand clicks fall more than 15%. */
export const NONBRAND_TOTAL_FLAT = -0.05;
export const NONBRAND_DROP = -0.15;
/** The prior window needs this many non-brand clicks, or a small site's noise reads as a trend. */
export const NONBRAND_MIN_PRIOR_CLICKS = 100;

/**
 * Branded vs all query clicks in (fromExcl, toIncl], counted once per day. Same brand rule as the
 * dashboard's brandedSplit (whole-token match of the property's brand label, query-attributed rows
 * only). A day that holds BOTH GSC row shapes (all-country rows and segmented rows, found on real
 * databases) counts its all-country rows only, so it is not summed twice.
 */
export function brandedClicks(c: CheckContext, brand: string, fromExcl: string, toIncl: string): { branded: number; total: number; mixedDays: number } {
  // Integration (#63 x #64): with the property known and the gsc_rows views present, use the shared
  // rules - gsc_rows counts each day once (#61) and the brand predicate matches spaced spellings
  // ("sim racing cockpit"), the same as the dashboard's brandedSplit. Fallback below is #63's own.
  if (c.siteUrl && hasGscRows(c.db)) {
    const branded = loadBrandQueries(c.db, c.siteUrl) ? `CASE WHEN ${brandPredicate()} THEN clicks ELSE 0 END` : '0';
    const r = one(c, `SELECT COALESCE(SUM(${branded}),0) b, COALESCE(SUM(clicks),0) t
      FROM ${GSC_ROWS} WHERE query IS NOT NULL AND date > ? AND date <= ?`, fromExcl, toIncl);
    // Days still stored in both shapes (a pending or part-migrated database); once migrated,
    // gsc_day_shape is only evidence and no day is mixed (gscRows.ts gscMixedShape, 0.16.2).
    const state = gscStorageState(c.db);
    const m = state === 'done' ? null
      : one(c, `SELECT COUNT(*) n FROM gsc_day_shape WHERE total_shape IS NOT NULL${state === 'migrating' ? ' AND totals_from IS NULL' : ''} AND date > ? AND date <= ?`, fromExcl, toIncl);
    return { branded: r.b, total: r.t, mixedDays: m?.n ?? 0 };
  }
  const lite = `(COALESCE(device,'') = '' AND COALESCE(country,'') = '')`;
  const mixed = rows(c, `SELECT date FROM search_analytics WHERE date > ? AND date <= ? GROUP BY date HAVING SUM(${lite}) > 0 AND SUM(NOT ${lite}) > 0`, fromExcl, toIncl).map(r => r.date);
  const r = one(c, `SELECT COALESCE(SUM(CASE WHEN (' '||LOWER(query)||' ') LIKE ? THEN clicks ELSE 0 END),0) b, COALESCE(SUM(clicks),0) t
    FROM search_analytics WHERE query IS NOT NULL AND date > ? AND date <= ?
      AND (date NOT IN (SELECT value FROM json_each(?)) OR ${lite})`, `% ${brand} %`, fromExcl, toIncl, JSON.stringify(mixed));
  return { branded: r.b, total: r.t, mixedDays: mixed.length };
}

function nonbrandDeclineMasked(c: CheckContext): RawFinding[] {
  const d = c.gscMaxDate;
  const brand = (c.brand ?? '').replace(/[^a-z0-9]/g, '');
  if (!d || !brand) return [];
  const span = one(c, `SELECT julianday(?) - julianday(MIN(date)) s FROM search_analytics`, d)?.s ?? 0;
  if (span < 55) return []; // need both full 28-day windows
  const at = (offset: number): string => (one(c, `SELECT date(?, ?) d`, d, `${offset} days`) as { d: string }).d;
  const cur = brandedClicks(c, brand, at(-28), d);
  const prior = brandedClicks(c, brand, at(-56), at(-28));
  const curNon = cur.total - cur.branded, priorNon = prior.total - prior.branded;
  if (priorNon < NONBRAND_MIN_PRIOR_CLICKS || prior.total <= 0) return [];
  const totalChange = (cur.total - prior.total) / prior.total;
  const nonChange = (curNon - priorNon) / priorNon;
  if (totalChange < NONBRAND_TOTAL_FLAT || nonChange >= NONBRAND_DROP) return [];
  return [{
    urlKey: null,
    evidence: {
      brand, window: { current: `${at(-27)}..${d}`, prior: `${at(-55)}..${at(-28)}` },
      totalClicks: { current: cur.total, prior: prior.total, changePct: pct(cur.total, prior.total) },
      nonBrandClicks: { current: curNon, prior: priorNon, changePct: pct(curNon, priorNon) },
      brandedClicks: { current: cur.branded, prior: prior.branded, changePct: prior.branded ? pct(cur.branded, prior.branded) : null },
      thresholds: `total change >= ${NONBRAND_TOTAL_FLAT * 100}% and non-brand change < ${NONBRAND_DROP * 100}%, prior non-brand >= ${NONBRAND_MIN_PRIOR_CLICKS} clicks`,
      note: `brand = whole-token match of "${brand}" (the property's domain label, heuristic); query-attributed clicks only (GSC anonymised queries are excluded)`,
      ...(cur.mixedDays || prior.mixedDays ? { mixedShapeDaysCountedOnce: cur.mixedDays + prior.mixedDays } : {}),
    },
  }];
}

// ── The registry entries ─────────────────────────────────────────────────────────────────────
export const SIGNAL_CHECKS: CheckDef[] = [
  {
    id: 'site-wide-indexing-alarm', category: 'indexation', severity: 'crit', labels: ['D', 'G'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'Site-wide indexing alarm',
    fix: 'Something is stopping Google indexing the site as a whole: the homepage or most sitemap URLs carry noindex, robots.txt disallows "/" for Googlebot, or the number of pages earning impressions fell sharply week on week. Usually a staging setting (noindex, Disallow: /) that shipped to production, or a template/plugin change. Remove it today, then resubmit the sitemap and request indexing of the homepage in Search Console.',
    run: (c) => {
      const triggers = indexingTriggers(c);
      return triggers.length ? [{ urlKey: null, evidence: { triggers, note: 'one site-level finding; each trigger cites the stored rows it came from' } }] : [];
    },
  },
  {
    id: 'snippet-restricted', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Snippets blocked (nosnippet / max-snippet:0)',
    fix: 'This indexable page tells Google to show no text snippet (nosnippet, or max-snippet:0) in its robots meta tag or X-Robots-Tag header. Google documents that the same directives also keep the page\'s content out of AI Overviews and AI Mode, so it is listed without a description and cannot be quoted. Remove the directive (or set max-snippet:-1), unless there is a legal reason to restrict it; to hide one passage only, wrap it in data-nosnippet instead.',
    run: (c) => rows(c, `SELECT url_key urlKey, robots, x_robots_tag xrt FROM pages WHERE status_code=200 AND indexable=1
        AND (LOWER(robots) LIKE '%snippet%' OR LOWER(x_robots_tag) LIKE '%snippet%')`)
      .flatMap(r => {
        const hits = snippetRestrictions(r.robots, r.xrt);
        return hits.length ? [{ urlKey: r.urlKey, evidence: { directives: hits, metaRobots: r.robots ?? null, xRobotsTag: r.xrt ?? null } }] : [];
      }),
  },
  {
    id: 'ai-search-bot-blocked', category: 'crawlability', severity: 'high', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'AI search bots blocked in robots.txt',
    fix: 'robots.txt stops one or more AI SEARCH crawlers (the ones that fetch pages to cite in answers: OAI-SearchBot and ChatGPT-User for ChatGPT, Claude-SearchBot and Claude-User for Claude, PerplexityBot for Perplexity) from the site or from your top pages, so those assistants cannot cite you. Training crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended...) are a separate choice and blocking them does not affect citations. To be cited while still opting out of training, allow the search bots and keep the training-bot Disallow lines.',
    run: aiSearchBotFindings,
  },
  {
    id: 'crux-field-lcp', category: 'performance', severity: 'med', labels: ['G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Real-user LCP not good (CrUX p75)',
    fix: 'Chrome users\' Largest Contentful Paint at the 75th percentile is over Google\'s 2.5 s "good" threshold (poor above 4 s), measured over the latest 28-day CrUX window. The LCP sub-parts in the dashboard payload show which part to fix: server response (TTFB), resource load delay (discover the LCP image sooner: preload it, no lazy-load on it), load duration (smaller image, modern format, CDN) or render delay (render-blocking CSS/JS). Needs sync_crux.',
    run: cruxFieldCheck('largest_contentful_paint'),
  },
  {
    id: 'crux-field-inp', category: 'performance', severity: 'med', labels: ['G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Real-user INP not good (CrUX p75)',
    fix: 'Interaction to Next Paint at the 75th percentile is over Google\'s 200 ms "good" threshold (poor above 500 ms): taps and clicks take visibly long to respond. INP is field-only, so no lab tool reproduces it exactly. Break up long JavaScript tasks, defer third-party scripts, cut work in input handlers, and avoid large DOM updates on interaction. Needs sync_crux.',
    run: cruxFieldCheck('interaction_to_next_paint'),
  },
  {
    id: 'crux-field-cls', category: 'performance', severity: 'med', labels: ['G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Real-user CLS not good (CrUX p75)',
    fix: 'Cumulative Layout Shift at the 75th percentile is over Google\'s 0.1 "good" threshold (poor above 0.25): content jumps while people read. Give images, embeds and ad slots explicit dimensions, reserve space for late content, and avoid inserting content above what is already shown. Needs sync_crux.',
    run: cruxFieldCheck('cumulative_layout_shift'),
  },
  {
    id: 'crux-regression', category: 'performance', severity: 'high', labels: ['G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Core Web Vital regressed into a worse band (CrUX)',
    fix: 'A Core Web Vital\'s real-user p75 crossed into a worse Google band (good -> needs improvement -> poor) within the last four 28-day CrUX windows. Find what shipped around when it started (theme, plugin, script, image or hosting change) and roll it back or fix it. Needs sync_crux history.',
    run: cruxRegression,
  },
  {
    id: 'nonbrand-decline-masked', category: 'merged', severity: 'high', labels: ['G'], certainty: 1, effortBase: 5, fixType: 'global',
    title: 'Non-brand clicks falling behind a flat total',
    fix: 'Total clicks look flat or up, but clicks from non-brand queries (people who did not search for you by name) fell more than 15% on the prior 28 days: brand demand is masking a loss of rankings. Look at traffic-decay, lost-queries and position-slipping for the pages and queries that lost the clicks.',
    run: nonbrandDeclineMasked,
  },
];
