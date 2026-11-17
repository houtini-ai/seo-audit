/**
 * CrUX field data collection + storage (#55 item 4). Design: the CrUX request/response and storage
 * comment on issue #55.
 *
 * What runs: the origin x PHONE/DESKTOP, plus the top N URLs by GSC clicks (default 50) x PHONE/
 * DESKTOP. A target's first collection asks queryHistoryRecord (backfills ~25 weekly windows) and
 * then queryRecord (the freshest window, a few days newer than the last weekly one); later runs ask
 * queryRecord only, at most once per 7 days per target, since CrUX publishes weekly. The PK upsert
 * means each run adds only the new window. A 404 NOT_FOUND (not enough traffic) is recorded in
 * crux_targets as 'insufficient_data' and re-asked after 28 days rather than every week.
 *
 * Retention: everything (small: ~10 metrics x 52 windows x 51 targets x 2 form factors a year).
 * The windows OVERLAP (each is 28 days, a week apart): show them as a trend, never sum them.
 */
import { pageRowsFor } from './gscPageTotals.js';
import type Database from 'better-sqlite3';
import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty, type UrlKeyOptions } from './url-key.js';
import { gscFreshness } from './gscFreshness.js';
import { CruxApiError, CruxClient, type CruxFormFactor, type CruxParsed, type CruxQuery, type CruxScope } from './CruxClient.js';

export { ensureCruxSchema } from './cruxSchema.js';
import { ensureCruxSchema } from './cruxSchema.js';

export type CruxStatus = 'ok' | 'insufficient_data' | 'error';

/** Upsert one parsed response for a target. Returns rows written (metrics, fractions). */
export function storeCrux(db: Database.Database, scope: CruxScope, target: string, formFactor: string, parsed: CruxParsed, source: 'record' | 'history'): { metrics: number; fractions: number } {
  const m = db.prepare(
    `INSERT INTO crux_metrics (scope,target,form_factor,metric,period_first,period_last,p75,good,ni,poor,good_max,ni_max,source,fetched_at)
     VALUES (@scope,@target,@ff,@metric,@periodFirst,@periodLast,@p75,@good,@ni,@poor,@goodMax,@niMax,@source,datetime('now'))
     ON CONFLICT(scope,target,form_factor,metric,period_last) DO UPDATE SET period_first=excluded.period_first, p75=excluded.p75,
       good=excluded.good, ni=excluded.ni, poor=excluded.poor, good_max=excluded.good_max, ni_max=excluded.ni_max,
       source=excluded.source, fetched_at=excluded.fetched_at`);
  const f = db.prepare(
    `INSERT INTO crux_fractions (scope,target,form_factor,metric,period_last,bucket,fraction) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(scope,target,form_factor,metric,period_last,bucket) DO UPDATE SET fraction=excluded.fraction`);
  db.transaction(() => {
    for (const r of parsed.metrics) m.run({ scope, target, ff: formFactor, source, ...r });
    for (const r of parsed.fractions) f.run(scope, target, formFactor, r.metric, r.periodLast, r.bucket, r.fraction);
  })();
  return { metrics: parsed.metrics.length, fractions: parsed.fractions.length };
}

export function setCruxTarget(db: Database.Database, scope: CruxScope, target: string, formFactor: string, status: CruxStatus, queryUrl: string, error: string | null = null): void {
  db.prepare(`INSERT INTO crux_targets (scope,target,form_factor,status,last_checked,error,query_url) VALUES (?,?,?,?,datetime('now'),?,?)
    ON CONFLICT(scope,target,form_factor) DO UPDATE SET status=excluded.status, last_checked=excluded.last_checked, error=excluded.error, query_url=excluded.query_url`)
    .run(scope, target, formFactor, status, error, queryUrl);
}

// ── Google's thresholds (web.dev/articles/vitals; FCP and TTFB from their own metric pages) ──
// Band at p75: good when p75 <= good, poor when p75 > poor, needs-improvement between.
export const CWV_THRESHOLDS = {
  largest_contentful_paint: { good: 2500, poor: 4000, unit: 'ms', label: 'LCP' },
  interaction_to_next_paint: { good: 200, poor: 500, unit: 'ms', label: 'INP' },
  cumulative_layout_shift: { good: 0.1, poor: 0.25, unit: '', label: 'CLS' },
  first_contentful_paint: { good: 1800, poor: 3000, unit: 'ms', label: 'FCP' },
  experimental_time_to_first_byte: { good: 800, poor: 1800, unit: 'ms', label: 'TTFB' },
} as const;
export type CwvMetric = keyof typeof CWV_THRESHOLDS;
export type CwvBand = 'good' | 'needs-improvement' | 'poor';
export const BAND_RANK: Record<CwvBand, number> = { good: 0, 'needs-improvement': 1, poor: 2 };

export function cwvBand(metric: CwvMetric, p75: number | null): CwvBand | null {
  if (p75 == null || !Number.isFinite(p75)) return null;
  const t = CWV_THRESHOLDS[metric];
  return p75 <= t.good ? 'good' : p75 <= t.poor ? 'needs-improvement' : 'poor';
}

// ── Target selection ─────────────────────────────────────────────────────────────────────────
/**
 * The origin CrUX keys on: where users actually land. The GSC page URL with the most clicks in the
 * latest 28 finalised days names it (so an apex sc-domain property served on www asks for www);
 * else the crawl's most common 200 origin; else the property's own origin.
 */
export function cruxOrigin(db: Database.Database, siteUrl: string): string {
  const max = gscFreshness(db).effectiveMax;
  if (max) {
    const r = db.prepare(`SELECT page FROM ${pageRowsFor(db, max, 28).table} WHERE page IS NOT NULL AND date > date(?, '-28 days') AND date <= ? GROUP BY page ORDER BY SUM(clicks) DESC LIMIT 1`).get(max, max) as { page: string } | undefined;
    if (r) { try { return new URL(r.page).origin; } catch { /* fall through */ } }
  }
  const pages = db.prepare(`SELECT url FROM pages WHERE status_code=200 LIMIT 500`).all() as { url: string }[];
  const counts = new Map<string, number>();
  for (const p of pages) { try { const o = new URL(p.url).origin; counts.set(o, (counts.get(o) ?? 0) + 1); } catch { /* skip */ } }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  const seed = siteUrl.startsWith('sc-domain:') ? `https://${siteUrl.slice('sc-domain:'.length)}/` : siteUrl;
  return new URL(seed).origin;
}

/** Top URLs by GSC clicks in the latest 28 finalised days, one per url_key (the most-clicked raw URL). */
export function topClickedUrls(db: Database.Database, limit: number, keyOpts: UrlKeyOptions): string[] {
  const max = gscFreshness(db).effectiveMax;
  if (!max || limit <= 0) return [];
  const rows = db.prepare(
    `SELECT page, page_key, SUM(clicks) c FROM ${pageRowsFor(db, max, 28).table}
     WHERE page IS NOT NULL AND date > date(?, '-28 days') AND date <= ? GROUP BY page HAVING c > 0 ORDER BY c DESC LIMIT ?`,
  ).all(max, max, limit * 4) as { page: string; page_key: string | null; c: number }[];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const k = r.page_key ?? urlKey(r.page, keyOpts);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r.page);
    if (out.length >= limit) break;
  }
  return out;
}

// ── The sync job ────────────────────────────────────────────────────────────────────────────
export interface CruxSyncOptions {
  /** Explicit URLs to collect (replaces the top-N-by-clicks selection). */
  urls?: string[];
  /** How many top URLs by GSC clicks (default 50; 0 = origin only). */
  limit?: number;
  /** Ignore the 7-day / 28-day re-ask windows. */
  force?: boolean;
  formFactors?: CruxFormFactor[];
}

export interface CruxSyncResult {
  siteUrl: string;
  origin: string;
  targets: number;
  queried: number;
  skippedFresh: number;
  ok: number;
  insufficientData: number;
  errors: { target: string; formFactor: string; error: string }[];
  calls: number;
  rowsWritten: { metrics: number; fractions: number };
  windows: { first: string | null; last: string | null };
}

/** Re-ask windows: CrUX publishes weekly; a target without data is unlikely to gain it within a month. */
export const CRUX_REFRESH_DAYS = { ok: 7, insufficient_data: 28 } as const;
export const CRUX_DEFAULT_URL_LIMIT = 50;

export class CruxSync {
  constructor(private readonly key: string, private readonly dataDir: string, private readonly clientOpts: ConstructorParameters<typeof CruxClient>[1] = {}) {}

  async run(siteUrl: string, opts: CruxSyncOptions, update: (p: Record<string, unknown>) => void, signal: AbortSignal): Promise<CruxSyncResult> {
    const client = new CruxClient(this.key, this.clientOpts);
    const adb = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
    try {
      const db = adb.db;
      ensureCruxSchema(db);
      const keyOpts: UrlKeyOptions = { hostForm: hostFormForProperty(siteUrl) };
      const origin = cruxOrigin(db, siteUrl);
      const urls = opts.urls?.length ? opts.urls : topClickedUrls(db, opts.limit ?? CRUX_DEFAULT_URL_LIMIT, keyOpts);
      const ffs: CruxFormFactor[] = opts.formFactors?.length ? opts.formFactors : ['PHONE', 'DESKTOP'];
      type T = { scope: CruxScope; target: string; query: CruxQuery; queryUrl: string; ff: CruxFormFactor };
      const targets: T[] = [];
      for (const ff of ffs) targets.push({ scope: 'origin', target: origin, query: { origin }, queryUrl: origin, ff });
      for (const u of urls) for (const ff of ffs) targets.push({ scope: 'url', target: urlKey(u, keyOpts), query: { url: u }, queryUrl: u, ff });

      const statusOf = db.prepare(`SELECT status, (julianday('now') - julianday(last_checked)) age FROM crux_targets WHERE scope=? AND target=? AND form_factor=?`);
      const hasHistory = db.prepare(`SELECT 1 FROM crux_metrics WHERE scope=? AND target=? AND form_factor=? AND source='history' LIMIT 1`);
      const res: CruxSyncResult = { siteUrl, origin, targets: targets.length, queried: 0, skippedFresh: 0, ok: 0, insufficientData: 0, errors: [], calls: 0, rowsWritten: { metrics: 0, fractions: 0 }, windows: { first: null, last: null } };
      const noteWindows = (p: CruxParsed): void => {
        for (const w of p.periods) {
          if (!res.windows.first || w.first < res.windows.first) res.windows.first = w.first;
          if (!res.windows.last || w.last > res.windows.last) res.windows.last = w.last;
        }
      };

      let i = 0;
      for (const t of targets) {
        if (signal.aborted) break;
        i++;
        const prev = statusOf.get(t.scope, t.target, t.ff) as { status: CruxStatus; age: number } | undefined;
        const freshFor = prev?.status === 'ok' ? CRUX_REFRESH_DAYS.ok : prev?.status === 'insufficient_data' ? CRUX_REFRESH_DAYS.insufficient_data : 0;
        if (!opts.force && prev && freshFor && prev.age < freshFor) { res.skippedFresh++; continue; }
        res.queried++;
        update({ phase: 'crux', done: i, total: targets.length, target: t.queryUrl, formFactor: t.ff });
        try {
          let gotData = false;
          if (!hasHistory.get(t.scope, t.target, t.ff)) {
            const h = await client.queryHistoryRecord(t.query, t.ff);
            if (h.status === 'ok') {
              const w = storeCrux(db, t.scope, t.target, t.ff, h.parsed, 'history');
              res.rowsWritten.metrics += w.metrics; res.rowsWritten.fractions += w.fractions;
              noteWindows(h.parsed);
              gotData = true;
            }
          }
          const r = await client.queryRecord(t.query, t.ff);
          if (r.status === 'ok') {
            const w = storeCrux(db, t.scope, t.target, t.ff, r.parsed, 'record');
            res.rowsWritten.metrics += w.metrics; res.rowsWritten.fractions += w.fractions;
            noteWindows(r.parsed);
            gotData = true;
          }
          setCruxTarget(db, t.scope, t.target, t.ff, gotData ? 'ok' : 'insufficient_data', t.queryUrl);
          if (gotData) res.ok++; else res.insufficientData++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // A bad or unauthorised key fails every call the same way: stop, don't burn the quota.
          if (err instanceof CruxApiError && [400, 401, 403].includes(err.httpStatus) && res.ok === 0 && res.insufficientData === 0) {
            throw new Error(`CrUX API rejected the request (${msg}). Check CRUX_API_KEY is a Google API key with the Chrome UX Report API enabled.`);
          }
          setCruxTarget(db, t.scope, t.target, t.ff, 'error', t.queryUrl, msg.slice(0, 300));
          res.errors.push({ target: t.queryUrl, formFactor: t.ff, error: msg.slice(0, 300) });
        }
      }
      res.calls = client.calls;
      update({ phase: 'crux', done: targets.length, total: targets.length, queried: res.queried, ok: res.ok, insufficientData: res.insufficientData, errors: res.errors.length });
      return res;
    } finally {
      adb.close();
    }
  }
}

// ── Dashboard payload: cwvField ────────────────────────────────────────────────────────────
export interface CwvFieldMetric { p75: number | null; good: number | null; ni: number | null; poor: number | null; band: CwvBand | null }
export interface CwvFieldFormFactor {
  period: { first: string; last: string };
  /** Where the latest window came from: 'record' = the current 28 days, 'history' = a weekly
   *  history window only (no current record: CrUX had too little recent traffic). */
  source: 'record' | 'history';
  /** Distinct 28-day windows held for LCP / INP / CLS (they overlap: a trend, never a sum). */
  windows: number;
  metrics: { lcp: CwvFieldMetric | null; inp: CwvFieldMetric | null; cls: CwvFieldMetric | null; fcp: CwvFieldMetric | null; ttfb: CwvFieldMetric | null; rtt: { p75: number | null } | null };
  /** LCP sub-parts at p75 (ms): which part of LCP to fix. Null when CrUX had no value. */
  lcpBreakdown: { ttfb: number | null; loadDelay: number | null; loadDuration: number | null; renderDelay: number | null };
  lcpResourceType: Record<string, number> | null;
  /** Share of navigations served from the back/forward cache, or null. */
  bfcacheShare: number | null;
  /** p75 per window, oldest first. The windows overlap (28 days, a week apart): a trend, never a sum. */
  history: { lcp: { periodLast: string; p75: number | null }[]; inp: { periodLast: string; p75: number | null }[]; cls: { periodLast: string; p75: number | null }[] };
}
export interface CwvField {
  origin: string;
  fetchedAt: string;
  thresholds: typeof CWV_THRESHOLDS;
  formFactors: Partial<Record<'PHONE' | 'DESKTOP', CwvFieldFormFactor>>;
  /** When the origin was last asked, per form factor (crux_targets), so the UI can say how old the
   *  newest window is relative to the last check. */
  lastChecked: string | null;
}

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);

/** Latest origin window per form factor + history p75 series. Null when nothing was collected. */
export function cwvFieldPayload(db: Database.Database): CwvField | null {
  if (!tableExists(db, 'crux_metrics')) return null;
  const o = db.prepare(`SELECT target, MAX(fetched_at) at FROM crux_metrics WHERE scope='origin' GROUP BY target ORDER BY at DESC LIMIT 1`).get() as { target: string; at: string } | undefined;
  if (!o) return null;
  const checked = tableExists(db, 'crux_targets')
    ? (db.prepare(`SELECT MAX(last_checked) at FROM crux_targets WHERE scope='origin' AND target=?`).get(o.target) as { at: string | null }).at
    : null;
  const out: CwvField = { origin: o.target, fetchedAt: o.at, thresholds: CWV_THRESHOLDS, formFactors: {}, lastChecked: checked };
  const CORE = `metric IN ('largest_contentful_paint','interaction_to_next_paint','cumulative_layout_shift')`;
  const rowAt = db.prepare(`SELECT p75, good, ni, poor, period_first FROM crux_metrics WHERE scope='origin' AND target=? AND form_factor=? AND metric=? AND period_last=?`);
  const frac = db.prepare(`SELECT bucket, fraction FROM crux_fractions WHERE scope='origin' AND target=? AND form_factor=? AND metric=? AND period_last=?`);
  const series = db.prepare(`SELECT period_last periodLast, p75 FROM crux_metrics WHERE scope='origin' AND target=? AND form_factor=? AND metric=? ORDER BY period_last`);
  for (const ff of ['PHONE', 'DESKTOP'] as const) {
    const latest = db.prepare(`SELECT MAX(period_last) last FROM crux_metrics WHERE scope='origin' AND target=? AND form_factor=? AND ${CORE}`).get(o.target, ff) as { last: string | null };
    if (!latest.last) continue;
    const src = db.prepare(`SELECT MAX(CASE WHEN source='record' THEN 1 ELSE 0 END) rec, COUNT(DISTINCT period_last) n FROM crux_metrics WHERE scope='origin' AND target=? AND form_factor=? AND ${CORE}`).get(o.target, ff) as { rec: number; n: number };
    const latestSrc = db.prepare(`SELECT MAX(CASE WHEN source='record' THEN 1 ELSE 0 END) rec FROM crux_metrics WHERE scope='origin' AND target=? AND form_factor=? AND period_last=?`).get(o.target, ff, latest.last) as { rec: number };
    const at = (metric: string): { p75: number | null; good: number | null; ni: number | null; poor: number | null; period_first: string } | undefined => rowAt.get(o.target, ff, metric, latest.last) as any;
    const m = (metric: CwvMetric): CwvFieldMetric | null => {
      const r = at(metric);
      return r ? { p75: r.p75, good: r.good, ni: r.ni, poor: r.poor, band: cwvBand(metric, r.p75) } : null;
    };
    const p = (metric: string): number | null => at(metric)?.p75 ?? null;
    const fr = (metric: string): Record<string, number> | null => {
      const rows = frac.all(o.target, ff, metric, latest.last) as { bucket: string; fraction: number | null }[];
      const map: Record<string, number> = {};
      for (const r of rows) if (r.fraction != null) map[r.bucket] = r.fraction;
      return rows.length ? map : null;
    };
    const first = at('largest_contentful_paint')?.period_first ?? at('interaction_to_next_paint')?.period_first ?? at('cumulative_layout_shift')?.period_first ?? latest.last;
    const nav = fr('navigation_types');
    const rtt = at('round_trip_time');
    out.formFactors[ff] = {
      period: { first, last: latest.last },
      source: latestSrc.rec ? 'record' : 'history',
      windows: src.n,
      metrics: {
        lcp: m('largest_contentful_paint'), inp: m('interaction_to_next_paint'), cls: m('cumulative_layout_shift'),
        fcp: m('first_contentful_paint'), ttfb: m('experimental_time_to_first_byte'), rtt: rtt ? { p75: rtt.p75 } : null,
      },
      lcpBreakdown: {
        ttfb: p('largest_contentful_paint_image_time_to_first_byte'),
        loadDelay: p('largest_contentful_paint_image_resource_load_delay'),
        loadDuration: p('largest_contentful_paint_image_resource_load_duration'),
        renderDelay: p('largest_contentful_paint_image_element_render_delay'),
      },
      lcpResourceType: fr('largest_contentful_paint_resource_type'),
      bfcacheShare: nav?.back_forward_cache ?? null,
      history: {
        lcp: series.all(o.target, ff, 'largest_contentful_paint') as { periodLast: string; p75: number | null }[],
        inp: series.all(o.target, ff, 'interaction_to_next_paint') as { periodLast: string; p75: number | null }[],
        cls: series.all(o.target, ff, 'cumulative_layout_shift') as { periodLast: string; p75: number | null }[],
      },
    };
  }
  return Object.keys(out.formFactors).length ? out : null;
}
