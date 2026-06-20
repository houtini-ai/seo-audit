import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';

export interface DashboardData {
  siteUrl: string;
  empty?: boolean;
  dateRange?: { current: string; prior: string; maxDate: string };
  summary?: {
    current: { clicks: number; impressions: number; ctr: number; position: number };
    prior: { clicks: number; impressions: number; ctr: number; position: number };
  };
  rankTrend?: { date: string; clicks: number; position: number }[];
  topKeywords?: {
    query: string;
    clicks: number;
    prevClicks: number;
    clicksChange: number;
    position: number;
    prevPosition: number;
  }[];
}

interface Totals { clicks: number; impressions: number; position: number }

/** Build the dashboard payload for a property from its synced GSC history. */
export function getDashboardData(dataDir: string, siteUrl: string): DashboardData {
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const maxRow = db.db.prepare('SELECT MAX(date) d FROM search_analytics').get() as { d: string | null };
    const maxDate = maxRow?.d;
    if (!maxDate) return { siteUrl, empty: true };

    const totals = (start: string, end?: string): Totals => {
      const where = end
        ? `date > date(?, '${start}') AND date <= date(?, '${end}')`
        : `date > date(?, '${start}')`;
      const args = end ? [maxDate, maxDate] : [maxDate];
      const r = db.db
        .prepare(`SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions, COALESCE(AVG(position),0) position FROM search_analytics WHERE ${where}`)
        .get(...args) as Totals;
      return r;
    };
    const cur = totals('-28 days');
    const prior = totals('-56 days', '-28 days');
    const ctr = (t: Totals): number => (t.impressions ? t.clicks / t.impressions : 0);

    const rankTrend = db.db
      .prepare(
        `SELECT date, COALESCE(SUM(clicks),0) clicks, COALESCE(AVG(position),0) position
         FROM search_analytics WHERE date > date(?, '-90 days') GROUP BY date ORDER BY date`,
      )
      .all(maxDate) as { date: string; clicks: number; position: number }[];

    const curKw = db.db
      .prepare(
        `SELECT query, SUM(clicks) clicks, AVG(position) position
         FROM search_analytics WHERE query IS NOT NULL AND date > date(?, '-28 days')
         GROUP BY query ORDER BY clicks DESC LIMIT 15`,
      )
      .all(maxDate) as { query: string; clicks: number; position: number }[];
    const priorKw = db.db
      .prepare(
        `SELECT query, SUM(clicks) clicks, AVG(position) position
         FROM search_analytics WHERE query IS NOT NULL AND date > date(?, '-56 days') AND date <= date(?, '-28 days')
         GROUP BY query`,
      )
      .all(maxDate, maxDate) as { query: string; clicks: number; position: number }[];
    const priorMap = new Map(priorKw.map(k => [k.query, k]));

    const topKeywords = curKw.map(k => {
      const p = priorMap.get(k.query);
      return {
        query: k.query,
        clicks: k.clicks,
        prevClicks: p?.clicks ?? 0,
        clicksChange: k.clicks - (p?.clicks ?? 0),
        position: Math.round(k.position * 10) / 10,
        prevPosition: p ? Math.round(p.position * 10) / 10 : 0,
      };
    });

    return {
      siteUrl,
      dateRange: { current: `last 28d to ${maxDate}`, prior: 'prior 28d', maxDate },
      summary: {
        current: { ...cur, ctr: ctr(cur) },
        prior: { ...prior, ctr: ctr(prior) },
      },
      rankTrend,
      topKeywords,
    };
  } finally {
    db.close();
  }
}
