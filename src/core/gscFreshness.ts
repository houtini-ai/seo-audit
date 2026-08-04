import type Database from 'better-sqlite3';

export interface GscFreshness {
  /** Latest date present in search_analytics (may be a partial-data day). */
  rawMax: string | null;
  /** Latest date whose data looks finalised — use this for windows and charts. */
  effectiveMax: string | null;
  /** How many trailing days were trimmed as still-being-finalised. */
  trimmedDays: number;
}

/**
 * Google Search Console finalises data ~2–3 days late, so the most recent day(s) in the DB are
 * partial — a sharp downward cliff that reads as "traffic is tanking" and panics SEOs. Detect and
 * trim those trailing partial days *data-drivenly*: drop any trailing day whose impressions fall
 * below 50% of the recent (stable-window) median, capped at 3 days. This catches the crater on
 * busy sites without over-trimming a genuinely low-traffic site whose every day is small.
 */
export function gscFreshness(db: Database.Database): GscFreshness {
  const rows = db
    .prepare(`SELECT date, SUM(impressions) i FROM search_analytics WHERE date IS NOT NULL GROUP BY date ORDER BY date`)
    .all() as { date: string; i: number }[];
  if (rows.length === 0) return { rawMax: null, effectiveMax: null, trimmedDays: 0 };
  const rawMax = rows[rows.length - 1].date;

  // Calendar guard first: GSC marks roughly the last two days as not-yet-finalised, and a partial
  // day can still clear the 50%-of-median test below (a 70%-of-normal day reads as a worrying dip,
  // not a crater). Never chart a day within 2 days of now, regardless of its numbers.
  const cutoff = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  let calTrimmed = 0;
  while (rows.length - 1 - calTrimmed >= 0 && rows[rows.length - 1 - calTrimmed].date > cutoff) calTrimmed++;
  if (calTrimmed >= rows.length) return { rawMax, effectiveMax: rawMax, trimmedDays: 0 };
  const kept = rows.slice(0, rows.length - calTrimmed);

  if (kept.length < 8) return { rawMax, effectiveMax: kept[kept.length - 1].date, trimmedDays: calTrimmed };

  // Reference level from a recent stable window (last ~21 days, excluding the last 3 that may be partial).
  const stable = kept.slice(Math.max(0, kept.length - 24), kept.length - 3).map(r => r.i).sort((a, b) => a - b);
  const median = stable.length ? stable[Math.floor(stable.length / 2)] : 0;
  if (median <= 0) return { rawMax, effectiveMax: kept[kept.length - 1].date, trimmedDays: calTrimmed };

  let trimmed = 0;
  for (let k = kept.length - 1; k >= 0 && trimmed < 3; k--) {
    if (kept[k].i < median * 0.5) trimmed++;
    else break;
  }
  const effectiveMax = kept[kept.length - 1 - trimmed].date;
  return { rawMax, effectiveMax, trimmedDays: calTrimmed + trimmed };
}
