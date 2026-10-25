// Site summary page, slice 1: the aggregations the Summary tab needs that the dashboard payload
// didn't carry (panels 2-9). Pure reads over data we already
// collect: no new collection, no LLM, no estimate.
//
// The one rule every function here follows: MISSING NEVER SHOWS AS ZERO. A month with no Search
// Console rows is null, not 0; a year-on-year comparison without 13 months of history is
// unavailable with a reason, not "0%"; a change summary from one crawl is "needs two crawls", not
// "0 pages changed". The UI renders those states as words.
import type Database from 'better-sqlite3';
import { diffLatest, type DriftResult } from '../audit/drift.js';
import { SMALL_BASE_MIN } from './displayRules.js';

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);

// ── GSC row shapes: count each day once ──────────────────────────────────────────────────────
//
// Every GSC total here reads the `gsc_rows` view (core/gscRows.ts, issue #61): a day stored in two
// row shapes (all-country and segmented rows) is read from ONE of them, so it is counted once.
export { type GscShape } from './gscRows.js';

// ── Panel 3: monthly clicks (up to 16 months) + year-on-year ─────────────────────────────────

export interface MonthPoint {
  /** 'YYYY-MM' */
  month: string;
  /** Null when Search Console holds no rows for the month (never 0). */
  clicks: number | null;
  impressions: number | null;
  /** Days with data, and the days the held range covers in this month. */
  days: number;
  expectedDays: number;
  daysInMonth: number;
  /** True when the month isn't fully covered: the current month (data stops before its end), the
   *  first month (history starts mid-month), or a month with missing days. Never compared as complete. */
  partial: boolean;
}
export interface MonthlyClicks {
  months: MonthPoint[];
  /** The full history held, so the UI can say "16 of 22 months shown" or "needs 13 months". */
  gscMinDate: string;
  gscMaxDate: string;
  monthsHeld: number;
  /** Set when history is longer than the 16 months shown. Never cap silently. */
  truncated?: { shownMonths: number; monthsHeld: number };
}
export type YearOnYear =
  | { available: true; window: { start: string; end: string }; priorWindow: { start: string; end: string }; clicks: number; priorYearClicks: number; priorYearDays: number }
  | { available: false; reason: 'needs-13-months'; gscMinDate: string; neededFrom: string };

const MAX_MONTHS = 16;
const DAY = 86_400_000;
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const ms = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const daysInMonth = (ym: string): number => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const addMonths = (ym: string, n: number): string => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };

/**
 * Monthly clicks and impressions, oldest first, for at most the last 16 months up to `maxDate` (the
 * finalised GSC date: trailing unfinalised days are already trimmed by the caller). Summed with the
 * same rows as every other GSC total in the payload (`gsc_rows`: each day counted once).
 */
export function monthlyClicks(db: Database.Database, maxDate: string): MonthlyClicks | null {
  const span = db.prepare(`SELECT MIN(date) lo FROM search_analytics`).get() as { lo: string | null };
  if (!span.lo) return null;
  const minDate = span.lo;
  const lastMonth = maxDate.slice(0, 7);
  const allMonths: string[] = [];
  for (let m = minDate.slice(0, 7); m <= lastMonth; m = addMonths(m, 1)) allMonths.push(m);
  const shown = allMonths.slice(-MAX_MONTHS);
  const from = `${shown[0]}-01` < minDate ? minDate : `${shown[0]}-01`;
  const rows = db.prepare(
    `SELECT substr(date,1,7) m, COUNT(DISTINCT date) days,
            SUM(clicks) clicks, SUM(impressions) impressions
     FROM gsc_rows WHERE date >= @from AND date <= @to GROUP BY m`,
  ).all({ from, to: maxDate }) as { m: string; days: number; clicks: number; impressions: number }[];
  const got = new Map(rows.map(r => [r.m, r]));
  const months: MonthPoint[] = shown.map(m => {
    const dim = daysInMonth(m);
    const start = `${m}-01` < minDate ? minDate : `${m}-01`;
    const endOfMonth = `${m}-${String(dim).padStart(2, '0')}`;
    const end = endOfMonth > maxDate ? maxDate : endOfMonth;
    const expectedDays = Math.max(0, Math.round((ms(end) - ms(start)) / DAY) + 1);
    const r = got.get(m);
    const days = r?.days ?? 0;
    return {
      month: m,
      clicks: days ? r!.clicks : null,
      impressions: days ? r!.impressions : null,
      days, expectedDays, daysInMonth: dim,
      partial: days < dim,
    };
  });
  const out: MonthlyClicks = { months, gscMinDate: minDate, gscMaxDate: maxDate, monthsHeld: allMonths.length };
  if (allMonths.length > shown.length) out.truncated = { shownMonths: shown.length, monthsHeld: allMonths.length };
  return out;
}

/**
 * The latest 28-day window vs the same 28 days 364 days earlier (52 weeks, so weekdays align).
 * Available only when the prior-year window is inside the held history; otherwise a reason.
 */
export function yearOnYear(db: Database.Database, maxDate: string): YearOnYear | null {
  const span = db.prepare(`SELECT MIN(date) lo FROM search_analytics`).get() as { lo: string | null };
  if (!span.lo) return null;
  const end = maxDate;
  const start = iso(ms(end) - 27 * DAY);
  const pEnd = iso(ms(end) - 364 * DAY);
  const pStart = iso(ms(start) - 364 * DAY);
  if (span.lo > pStart) return { available: false, reason: 'needs-13-months', gscMinDate: span.lo, neededFrom: pStart };
  const sum = (a: string, b: string): { clicks: number; days: number } => clicksBetween(db, a, b);
  const cur = sum(start, end);
  const prior = sum(pStart, pEnd);
  return { available: true, window: { start, end }, priorWindow: { start: pStart, end: pEnd }, clicks: cur.clicks, priorYearClicks: prior.clicks, priorYearDays: prior.days };
}

function clicksBetween(db: Database.Database, a: string, b: string): { clicks: number; days: number } {
  return db.prepare(
    `SELECT COALESCE(SUM(clicks),0) clicks, COUNT(DISTINCT date) days
     FROM gsc_rows WHERE date >= @a AND date <= @b`,
  ).get({ a, b }) as { clicks: number; days: number };
}

/** Clicks for the last 28 days and the prior 28, each day counted once (see GscShape). */
export interface ClickWindows { current: number; prior: number; window: { start: string; end: string }; priorWindow: { start: string; end: string } }
export function clickWindows(db: Database.Database, maxDate: string): ClickWindows {
  const start = iso(ms(maxDate) - 27 * DAY), pEnd = iso(ms(maxDate) - 28 * DAY), pStart = iso(ms(maxDate) - 55 * DAY);
  return {
    current: clicksBetween(db, start, maxDate).clicks, prior: clicksBetween(db, pStart, pEnd).clicks,
    window: { start, end: maxDate }, priorWindow: { start: pStart, end: pEnd },
  };
}

// ── Panel 3: event ticks (completed crawls and audits) ───────────────────────────────────────

export interface SummaryEvent { kind: 'crawl' | 'audit'; at: string; id: string }
/** Completed crawls and audits on or after `since` (ISO date; null = all), oldest first. */
export function summaryEvents(db: Database.Database, since: string | null): SummaryEvent[] {
  const norm = (s: string): string => s.replace('T', ' ').replace(/Z$/, '').slice(0, 19);
  const out: SummaryEvent[] = [];
  if (tableExists(db, 'crawl_metadata')) {
    for (const r of db.prepare(`SELECT crawl_id id, finished_at at FROM crawl_metadata WHERE status='completed' AND finished_at IS NOT NULL`).all() as { id: string; at: string }[]) out.push({ kind: 'crawl', at: norm(r.at), id: r.id });
  }
  if (tableExists(db, 'audit_runs')) {
    for (const r of db.prepare(`SELECT run_id id, finished_at at FROM audit_runs WHERE finished_at IS NOT NULL AND (status = 'completed' OR status IS NULL)`).all() as { id: string; at: string }[]) out.push({ kind: 'audit', at: norm(r.at), id: r.id });
  }
  return out.filter(e => !since || e.at.slice(0, 10) >= since).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// ── Panel 6: changed since the last crawl (drift over page_snapshots) ────────────────────────

export interface DriftSummary {
  /** Distinct crawls held in page_snapshots. Under 2 = "needs two crawls"; counts are then null. */
  snapshots: number;
  baselineCrawl: string | null; currentCrawl: string | null;
  baselineAt: string | null; currentAt: string | null;
  counts: {
    pagesChanged: number; added: number; removed: number; modified: number;
    /** Status moved from < 400 to >= 400 (a page that answered now errors). */
    nowErroring: number;
    /** robots meta or X-Robots-Tag gained noindex. */
    noindexAdded: number;
    canonicalChanged: number; titleChanged: number;
    /** Modified pages with a critical / high change, as detect_changes classifies them. */
    crit: number; high: number;
  } | null;
  /** The most severe changes first (detect_changes order), bounded; `total` says how many exist. */
  top: { urlKey: string; kind: 'modified' | 'added' | 'removed'; fields: string[]; severity: string }[];
  total: number;
  /** When set, a newer completed crawl is NOT in the diff: the UI shows this instead of the counts. */
  staleness: DriftResult['staleness'] | null;
}

const isNoindex = (v: unknown): boolean => /noindex/i.test(String(v ?? ''));

export function driftSummary(db: Database.Database): DriftSummary {
  const snapshots = (db.prepare(`SELECT COUNT(DISTINCT crawl_id) n FROM page_snapshots`).get() as { n: number }).n;
  const d = diffLatest(db);
  const base = {
    snapshots, baselineCrawl: d.baselineCrawl, currentCrawl: d.currentCrawl, baselineAt: d.baselineAt, currentAt: d.currentAt,
    staleness: d.staleness ?? null,
  };
  if (!d.baselineCrawl) return { ...base, counts: null, top: [], total: 0 };
  let nowErroring = 0, noindexAdded = 0, canonicalChanged = 0, titleChanged = 0;
  for (const c of d.changes) {
    if (c.kind !== 'modified') continue;
    const st = c.changes.find(f => f.field === 'status_code');
    if (st && Number(st.from ?? 0) < 400 && Number(st.to ?? 0) >= 400) nowErroring++;
    if (c.changes.some(f => (f.field === 'robots' || f.field === 'x_robots_tag') && isNoindex(f.to) && !isNoindex(f.from))) noindexAdded++;
    if (c.changes.some(f => f.field === 'canonical')) canonicalChanged++;
    if (c.changes.some(f => f.field === 'title')) titleChanged++;
  }
  const s = d.summary;
  const rank: Record<string, number> = { crit: 0, high: 1, med: 2, low: 3, info: 4 };
  const worst = (c: (typeof d.changes)[number]): string => c.kind === 'removed' ? 'high' : c.kind === 'added' ? 'info'
    : c.changes.map(f => f.severity).sort((a, b) => rank[a] - rank[b])[0] ?? 'info';
  return {
    ...base,
    counts: {
      pagesChanged: s.pagesChanged ?? 0, added: s.added ?? 0, removed: s.removed ?? 0, modified: s.modified ?? 0,
      nowErroring, noindexAdded, canonicalChanged, titleChanged, crit: s.crit ?? 0, high: s.high ?? 0,
    },
    top: d.changes.slice(0, 8).map(c => ({ urlKey: c.urlKey, kind: c.kind, fields: c.changes.map(f => f.field), severity: worst(c) })),
    total: d.changes.length,
  };
}

// ── Panel 4: what's broken, by area ──────────────────────────────────────────────────────────

export interface CategoryRow {
  category: string;
  /** Findings stored for the area in the latest run. */
  findings: number;
  /** Distinct pages affected (url_key not null). */
  pages: number;
  /** Whether the area also has site-wide findings (url_key null), shown as one "site" row. */
  site: boolean;
  /** Distinct affected keys (a page, or "site") per severity. Info counts with low. */
  crit: number; high: number; med: number; low: number;
  /** Findings from judgement-labelled (N) checks; they only exist when the audit ran with includeJudgement. */
  judgement: number;
  /** A check in the area hit the per-check storage cap, so the counts are a floor ("at least"). */
  capped: boolean;
  /** Since the previous comparable audit (same scope + check set). Null when there is no comparable pair. */
  opened: number | null; resolved: number | null;
  /** Checks of this area left out of opened / resolved because their findings were regrouped
   *  between the two audits (history.ts REGROUPED_CHECKS); the UI says so on the row. */
  regrouped?: string[];
}

const PER_CHECK_CAP = 500; // engine.ts MAX_PER_CHECK: a check storing this many was truncated

/**
 * Findings grouped by category for one run. `prevRunId` = the previous COMPARABLE completed run
 * (from auditHistory's latest delta, which already enforces the same scope and check set), or null.
 */
export function findingsByCategory(db: Database.Database, runId: string, prevRunId: string | null, regrouped: string[] = []): CategoryRow[] {
  const rows = db.prepare(
    `SELECT COALESCE(category,'other') category,
            COUNT(*) findings,
            COUNT(DISTINCT url_key) pages,
            MAX(CASE WHEN url_key IS NULL THEN 1 ELSE 0 END) site,
            COUNT(DISTINCT CASE WHEN severity='crit' THEN COALESCE(url_key,'site') END) crit,
            COUNT(DISTINCT CASE WHEN severity='high' THEN COALESCE(url_key,'site') END) high,
            COUNT(DISTINCT CASE WHEN severity='med' THEN COALESCE(url_key,'site') END) med,
            COUNT(DISTINCT CASE WHEN severity IN ('low','info') THEN COALESCE(url_key,'site') END) low,
            SUM(CASE WHEN labels LIKE '%"N"%' THEN 1 ELSE 0 END) judgement
     FROM findings WHERE run_id = ? GROUP BY COALESCE(category,'other')`,
  ).all(runId) as (Omit<CategoryRow, 'site' | 'capped' | 'opened' | 'resolved'> & { site: number })[];
  const capped = new Set((db.prepare(
    `SELECT COALESCE(MAX(category),'other') category FROM findings WHERE run_id = ? GROUP BY check_id HAVING COUNT(*) >= ${PER_CHECK_CAP}`,
  ).all(runId) as { category: string }[]).map(r => r.category));
  const delta = new Map<string, { opened: number; resolved: number }>();
  if (prevRunId) {
    // Keyed exactly like auditHistory: check_id + url_key ("site" when null), and leaving out the
    // same regrouped checks, so the change column adds up to the verdict and the health chart.
    const skip = regrouped.length ? ` AND check_id NOT IN (${regrouped.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')})` : '';
    const keys = `SELECT DISTINCT COALESCE(category,'other') category, check_id, COALESCE(url_key,'site') k FROM findings WHERE run_id = ?${skip}`;
    const diff = (a: string, b: string): { category: string; n: number }[] => db.prepare(
      `SELECT category, COUNT(*) n FROM (${keys} EXCEPT ${keys}) GROUP BY category`).all(a, b) as { category: string; n: number }[];
    for (const r of diff(runId, prevRunId)) delta.set(r.category, { opened: r.n, resolved: 0 });
    for (const r of diff(prevRunId, runId)) delta.set(r.category, { opened: delta.get(r.category)?.opened ?? 0, resolved: r.n });
  }
  // Which area each regrouped check belongs to (from either run, so an area emptied by the regrouping still says so).
  const regroupedBy = new Map<string, string[]>();
  if (prevRunId && regrouped.length) {
    for (const r of db.prepare(`SELECT DISTINCT COALESCE(category,'other') category, check_id FROM findings WHERE run_id IN (?, ?) AND check_id IN (${regrouped.map(() => '?').join(', ')})`)
      .all(runId, prevRunId, ...regrouped) as { category: string; check_id: string }[]) {
      regroupedBy.set(r.category, [...new Set([...(regroupedBy.get(r.category) ?? []), r.check_id])].sort());
    }
  }
  const out: CategoryRow[] = rows.map(r => ({
    ...r, site: !!r.site, capped: capped.has(r.category),
    opened: prevRunId ? (delta.get(r.category)?.opened ?? 0) : null,
    resolved: prevRunId ? (delta.get(r.category)?.resolved ?? 0) : null,
    ...(regroupedBy.has(r.category) ? { regrouped: regroupedBy.get(r.category) } : {}),
  }));
  // An area fully resolved since the previous audit has no rows in this run: keep it visible.
  if (prevRunId) for (const [category, d] of delta) {
    if (!out.some(r => r.category === category)) out.push({ category, findings: 0, pages: 0, site: false, crit: 0, high: 0, med: 0, low: 0, judgement: 0, capped: false, opened: d.opened, resolved: d.resolved });
  }
  return out.sort((a, b) => (b.crit - a.crit) || (b.high - a.high) || ((b.pages + Number(b.site)) - (a.pages + Number(a.site))));
}

/**
 * Per check: the summed clicks on the distinct pages a check flags (traffic_at_risk.clicks, which
 * runAudit fills from the 28 days to the audit's GSC end date). Labelled "current 28-day clicks on
 * affected pages", never as clicks you'd gain. Null where no finding carries a clicks figure.
 */
export function clicksAtRiskByCheck(db: Database.Database, runId: string): Map<string, number | null> {
  const rows = db.prepare(
    `SELECT check_id, SUM(c) clicks FROM (
       SELECT check_id, url_key, MAX(json_extract(traffic_at_risk,'$.clicks')) c
       FROM findings WHERE run_id = ? AND url_key IS NOT NULL AND json_valid(traffic_at_risk) GROUP BY check_id, url_key)
     GROUP BY check_id`,
  ).all(runId) as { check_id: string; clicks: number | null }[];
  return new Map(rows.map(r => [r.check_id, r.clicks]));
}

// ── Panel 8: AI Overview presence and citation (content recon) ───────────────────────────────

export interface AiOverviewSummary {
  /** Queries checked through content recon (one per page under recon). */
  checked: number;
  present: number;
  cited: number;
  /** AIO present and our domain not among its citations. */
  notCited: number;
  /** Citation never resolved (stored NULL): UNKNOWN, never "not cited". */
  unknown: number;
  checkedAt: string | null;
}
export function aiOverviewSummary(db: Database.Database): AiOverviewSummary | null {
  if (!tableExists(db, 'recon_page')) return null;
  const r = db.prepare(
    `SELECT COUNT(*) checked,
            COALESCE(SUM(CASE WHEN aio_present = 1 THEN 1 ELSE 0 END),0) present,
            COALESCE(SUM(CASE WHEN aio_cites_us = 1 THEN 1 ELSE 0 END),0) cited,
            COALESCE(SUM(CASE WHEN aio_present = 1 AND aio_cites_us = 0 THEN 1 ELSE 0 END),0) notCited,
            COALESCE(SUM(CASE WHEN aio_cites_us IS NULL THEN 1 ELSE 0 END),0) unknown,
            MAX(researched_at) checkedAt
     FROM recon_page`,
  ).get() as AiOverviewSummary;
  return r.checked ? r : null;
}

// ── Panel 7: gaining and losing pages ─────────────────────────────────────────────────────────

export interface PageMove { urlKey: string; clicks: number; prevClicks: number; change: number }
export interface PageMovers { gaining: PageMove[]; losing: PageMove[]; minPriorClicks: number; eligible: number }
/** The stated rule: only pages with at least this many clicks in the prior 28 days are ranked. */
export const MOVER_MIN_PRIOR = SMALL_BASE_MIN;

/** Largest absolute click changes, last 28 days vs the prior 28, across ALL pages (not a top-N subset). */
export function pageMovers(db: Database.Database, maxDate: string, limit = 3): PageMovers {
  const rows = db.prepare(
    `WITH cur AS (SELECT page_key, SUM(clicks) c FROM gsc_rows WHERE page_key IS NOT NULL AND date <= @max AND date > date(@max, '-28 days') GROUP BY page_key),
          prev AS (SELECT page_key, SUM(clicks) c FROM gsc_rows WHERE page_key IS NOT NULL AND date > date(@max, '-56 days') AND date <= date(@max, '-28 days') GROUP BY page_key)
     SELECT prev.page_key urlKey, COALESCE(cur.c,0) clicks, prev.c prevClicks, COALESCE(cur.c,0) - prev.c change
     FROM prev LEFT JOIN cur ON cur.page_key = prev.page_key WHERE prev.c >= @min`,
  ).all({ max: maxDate, min: MOVER_MIN_PRIOR }) as PageMove[];
  const gaining = rows.filter(r => r.change > 0).sort((a, b) => b.change - a.change).slice(0, limit);
  const losing = rows.filter(r => r.change < 0).sort((a, b) => a.change - b.change).slice(0, limit);
  return { gaining, losing, minPriorClicks: MOVER_MIN_PRIOR, eligible: rows.length };
}

// ── Panel 9: data coverage ────────────────────────────────────────────────────────────────────

export interface Coverage {
  gsc: { minDate: string; maxDate: string; months: number } | null;
  crawlPages: number;
  /** URL Inspection is a quota-bound SAMPLE. `inspected` = every URL inspected; `inspectedIndexable`
   *  = how many of the indexable crawled pages are among them (the spec's "n of N indexable"). */
  inspected: number;
  inspectedIndexable: number;
  indexablePages: number;
  cwvPages: number;
  backlinkPages: number;
}
export function coverage(db: Database.Database): Coverage {
  const n = (sql: string): number => { try { return (db.prepare(sql).get() as { n: number }).n ?? 0; } catch { return 0; } };
  const span = db.prepare(`SELECT MIN(date) lo, MAX(date) hi FROM search_analytics`).get() as { lo: string | null; hi: string | null };
  const months = span.lo && span.hi
    ? (Number(span.hi.slice(0, 4)) - Number(span.lo.slice(0, 4))) * 12 + Number(span.hi.slice(5, 7)) - Number(span.lo.slice(5, 7)) + 1
    : 0;
  return {
    gsc: span.lo && span.hi ? { minDate: span.lo, maxDate: span.hi, months } : null,
    crawlPages: n(`SELECT COUNT(*) n FROM pages WHERE is_internal=1`),
    inspected: n(`SELECT COUNT(*) n FROM url_inspection`),
    indexablePages: n(`SELECT COUNT(*) n FROM pages WHERE is_internal=1 AND status_code=200 AND indexable=1`),
    inspectedIndexable: n(`SELECT COUNT(*) n FROM pages p JOIN url_inspection u ON u.url_key = p.url_key WHERE p.is_internal=1 AND p.status_code=200 AND p.indexable=1`),
    cwvPages: n(`SELECT COUNT(*) n FROM page_cwv WHERE performance IS NOT NULL`),
    backlinkPages: n(`SELECT COUNT(*) n FROM page_backlinks`),
  };
}
