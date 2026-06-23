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
  if (rows.length < 8) return { rawMax, effectiveMax: rawMax, trimmedDays: 0 };

  // Reference level from a recent stable window (last ~21 days, excluding the last 3 that may be partial).
  const stable = rows.slice(Math.max(0, rows.length - 24), rows.length - 3).map(r => r.i).sort((a, b) => a - b);
  const median = stable.length ? stable[Math.floor(stable.length / 2)] : 0;
  if (median <= 0) return { rawMax, effectiveMax: rawMax, trimmedDays: 0 };

  let trimmed = 0;
  for (let k = rows.length - 1; k >= 0 && trimmed < 3; k--) {
    if (rows[k].i < median * 0.5) trimmed++;
    else break;
  }
  const effectiveMax = rows[rows.length - 1 - trimmed].date;
  return { rawMax, effectiveMax, trimmedDays: trimmed };
}
