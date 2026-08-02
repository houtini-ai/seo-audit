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
        `INSERT INTO rank_history (period, pos_1_3, pos_4_10, pos_11_20, pos_21_100, etv, keyword_count,
           is_new, is_up, is_down, is_lost, estimated_paid_traffic_cost, source, fetched_at)
         VALUES (@period,@pos_1_3,@pos_4_10,@pos_11_20,@pos_21_100,@etv,@keyword_count,
           @is_new,@is_up,@is_down,@is_lost,@estimated_paid_traffic_cost,'dataforseo:historical_rank_overview',datetime('now'))
         ON CONFLICT(period) DO UPDATE SET pos_1_3=excluded.pos_1_3, pos_4_10=excluded.pos_4_10,
           pos_11_20=excluded.pos_11_20, pos_21_100=excluded.pos_21_100, etv=excluded.etv,
           keyword_count=excluded.keyword_count, is_new=excluded.is_new, is_up=excluded.is_up,
           is_down=excluded.is_down, is_lost=excluded.is_lost,
           estimated_paid_traffic_cost=excluded.estimated_paid_traffic_cost, fetched_at=datetime('now')`,
      );
      const rows = items.filter(it => Number.isInteger(it?.year) && Number.isInteger(it?.month)).map(it => {
        const o = it.metrics?.organic ?? {};
        // Guard year/month — a malformed item would upsert an "undefined-NaN" period row
        // that then poisons the dashboard's rank-history axis and date reconciliation.
        const period = `${it.year}-${String(it.month).padStart(2, '0')}`;
        const pos_1_3 = n(o.pos_1) + n(o.pos_2_3);
        const pos_4_10 = n(o.pos_4_10);
        const pos_11_20 = n(o.pos_11_20);
        const pos_21_100 =
          n(o.pos_21_30) + n(o.pos_31_40) + n(o.pos_41_50) + n(o.pos_51_60) +
          n(o.pos_61_70) + n(o.pos_71_80) + n(o.pos_81_90) + n(o.pos_91_100);
        // DataForSEO names the total field `count`; fall back to summing the buckets
        // so keyword_count isn't a silent 0 if the field name differs.
        return {
          period, pos_1_3, pos_4_10, pos_11_20, pos_21_100,
          etv: n(o.etv),
          keyword_count: n(o.count) || (pos_1_3 + pos_4_10 + pos_11_20 + pos_21_100),
          // Keyword-movement counts + paid-value equivalent — same response, previously dropped.
          is_new: n(o.is_new), is_up: n(o.is_up), is_down: n(o.is_down), is_lost: n(o.is_lost),
          estimated_paid_traffic_cost: o.estimated_paid_traffic_cost != null ? n(o.estimated_paid_traffic_cost) : null,
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
