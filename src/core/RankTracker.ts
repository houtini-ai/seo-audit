import { AuditDatabase } from './AuditDatabase.js';
import { DataForSeoClient } from './DataForSeoClient.js';
import { dbPathFor } from './paths.js';
import { hostFormForProperty } from './url-key.js';

export interface RankTrackResult {
  siteUrl: string;
  target: string;
  periods: number;
  range: { start: string; end: string } | null;
  cached: boolean;
  cost: number;
}

function domainFromProperty(siteUrl: string): string {
  return siteUrl.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

const n = (v: unknown): number => Number(v) || 0;

/**
 * Ingests the DataForSEO over-time sequence (monthly rank distribution + ETV) into
 * rank_history, so charts have a real time axis to reconcile against GSC's daily data.
 */
export class RankTracker {
  constructor(private readonly dfs: DataForSeoClient, private readonly dataDir: string) {}

  async run(
    siteUrl: string,
    opts: { location?: string | number },
    update: (p: Record<string, unknown>) => void,
    _signal: AbortSignal,
  ): Promise<RankTrackResult> {
    const target = domainFromProperty(siteUrl);
    const db = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
    try {
      db.upsertProperty(siteUrl, hostFormForProperty(siteUrl) ?? 'asis');
      if (opts.location !== undefined) db.setDfsLocation(siteUrl, opts.location);
      const location = opts.location ?? db.getDfsLocation(siteUrl);
      const r = await this.dfs.historicalRankOverview(target, location);
      const items: any[] = r.tasks[0]?.result?.[0]?.items ?? [];
      const upsert = db.db.prepare(
        `INSERT INTO rank_history (period, pos_1_3, pos_4_10, pos_11_20, pos_21_100, etv, count, source, fetched_at)
         VALUES (@period,@pos_1_3,@pos_4_10,@pos_11_20,@pos_21_100,@etv,@count,'dataforseo:historical_rank_overview',datetime('now'))
         ON CONFLICT(period) DO UPDATE SET pos_1_3=excluded.pos_1_3, pos_4_10=excluded.pos_4_10,
           pos_11_20=excluded.pos_11_20, pos_21_100=excluded.pos_21_100, etv=excluded.etv,
           count=excluded.count, fetched_at=datetime('now')`,
      );
      const rows = items.map(it => {
        const o = it.metrics?.organic ?? {};
        const period = `${it.year}-${String(it.month).padStart(2, '0')}`;
        return {
          period,
          pos_1_3: n(o.pos_1) + n(o.pos_2_3),
          pos_4_10: n(o.pos_4_10),
          pos_11_20: n(o.pos_11_20),
          pos_21_100:
            n(o.pos_21_30) + n(o.pos_31_40) + n(o.pos_41_50) + n(o.pos_51_60) +
            n(o.pos_61_70) + n(o.pos_71_80) + n(o.pos_81_90) + n(o.pos_91_100),
          etv: n(o.etv),
          count: n(o.count),
        };
      });
      const tx = db.db.transaction((rs: Record<string, unknown>[]) => { for (const row of rs) upsert.run(row); });
      tx(rows);

      const periods = rows.map(r2 => r2.period).sort();
      update({ siteUrl, periods: periods.length });
      return {
        siteUrl,
        target,
        periods: periods.length,
        range: periods.length ? { start: periods[0], end: periods[periods.length - 1] } : null,
        cached: r.cached,
        cost: r.cost,
      };
    } finally {
      db.close();
    }
  }
}
