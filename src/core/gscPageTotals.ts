/**
 * gscPageTotals — GSC page totals (date × page), the source for every PAGE or SITE total (#118).
 *
 * Why it exists. The main sync stores date × query × page (gsc_rows). Asking GSC for the `query`
 * dimension drops anonymised queries and the long tail it withholds for privacy, so a page or site
 * total summed from those rows is short, and a page whose traffic is all long-tail has no rows at
 * all. Measured 2026-11-17 over 28 days on two production sites: 58% and 65% of page-only clicks
 * were missing from the query rows, and most `index-bloat` findings ("no impressions in 90 days")
 * on one of them had impressions in the page totals.
 *
 * So every sync also fetches date × page into `gsc_page_totals` (same columns readers use: date,
 * page, page_key, clicks, impressions, ctr, position). Readers:
 *   - a PAGE or SITE total (clicks/impressions/position of a page, a template, the whole site;
 *     "does this page get traffic") reads `pageRowsFor(...)`;
 *   - anything that needs the query (top query, cannibalisation, striking distance, brand split)
 *     stays on gsc_rows, which is right for those questions.
 *
 * `pageRowsFor` picks the table per window: gsc_page_totals when it covers the whole window, else
 * gsc_rows with source 'query-attributed', so a database not synced since this change (or a window
 * older than GSC's 16-month retention, which the page totals cannot backfill) still works and says
 * which numbers it used. A check that compares two windows asks once, for the earliest date it
 * reads, so its current and previous windows never come from different sources.
 */
import type Database from 'better-sqlite3';
import { gscTotalsSource } from './gscRows.js';

export const PAGE_TOTALS = 'gsc_page_totals';

/** Days of slack at either end of a window: GSC can lack a page row for the first/last day. */
const EDGE_DAYS = 3;

export type PageTotalsSource = 'page-totals' | 'query-attributed';

export function ensurePageTotalsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PAGE_TOTALS} (
      date TEXT NOT NULL,
      page TEXT NOT NULL,
      page_key TEXT,
      search_type TEXT NOT NULL DEFAULT 'web',
      clicks INTEGER NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      ctr REAL NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pt_unique ON ${PAGE_TOTALS}(date, page);
    CREATE INDEX IF NOT EXISTS idx_pt_pk_date ON ${PAGE_TOTALS}(page_key, date, clicks, impressions, position);
    CREATE INDEX IF NOT EXISTS idx_pt_date_metrics ON ${PAGE_TOTALS}(date, page_key, clicks, impressions, position);
  `);
}

/** MIN/MAX date of the page totals; nulls when empty or the table does not exist (read-only handle). */
export function pageTotalsRange(db: Database.Database): { min: string | null; max: string | null } {
  try {
    const r = db.prepare(`SELECT MIN(date) min, MAX(date) max FROM ${PAGE_TOTALS}`).get() as { min: string | null; max: string | null };
    return { min: r.min, max: r.max };
  } catch {
    return { min: null, max: null };
  }
}

const addDays = (date: string, n: number): string => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);

/**
 * The table for page/site totals over the `daysBack`-day window ending at `to`: gsc_page_totals
 * when it covers the window (within EDGE_DAYS at each end), else gsc_rows. `range` lets a caller
 * that asks many times read MIN/MAX once.
 */
export function pageRowsFor(
  db: Database.Database,
  to: string | null,
  daysBack: number,
  range: { min: string | null; max: string | null } = pageTotalsRange(db),
): { table: string; source: PageTotalsSource } {
  // The query rows: the gsc_rows view, or raw search_analytics on a read-only handle to a database
  // this version never opened (gscTotalsSource).
  const fallback = { table: gscTotalsSource(db), source: 'query-attributed' as const };
  if (!to || !range.min || !range.max) return fallback;
  const from = addDays(to, -(daysBack - 1)); // first day the window reads
  if (range.min > addDays(from, EDGE_DAYS)) return fallback;
  if (range.max < addDays(to, -EDGE_DAYS)) return fallback;
  return { table: PAGE_TOTALS, source: 'page-totals' };
}

/** A per-context resolver: reads MIN/MAX once, answers per window. */
export function pageRowsResolver(db: Database.Database, to: string | null): (daysBack: number) => { table: string; source: PageTotalsSource } {
  const range = pageTotalsRange(db);
  return (daysBack: number) => pageRowsFor(db, to, daysBack, range);
}

/** The table for a page's whole stored history (lifetime equity of a dead or redirected URL). */
export function lifetimePageRows(db: Database.Database): string {
  let r: { lo: string | null; hi: string | null } = { lo: null, hi: null };
  try { r = db.prepare(`SELECT MIN(date) lo, MAX(date) hi FROM search_analytics`).get() as typeof r; } catch { /* no GSC table */ }
  if (!r.lo || !r.hi) return gscTotalsSource(db);
  return pageRowsFor(db, r.hi, Math.round((Date.parse(r.hi) - Date.parse(r.lo)) / 86400000) + 1).table;
}
