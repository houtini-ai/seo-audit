import { AuditDatabase } from './AuditDatabase.js';
import { GscClient } from './GscClient.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty } from './url-key.js';
import type { FetchOptions, GscApiRow } from './types.js';

const SYNC_DIMENSIONS = ['query', 'page', 'date', 'device', 'country'];

export interface SyncResult {
  siteUrl: string;
  rowsFetched: number;
  startDate: string;
  endDate: string;
}

/**
 * Fetch GSC search analytics into a property's SQLite DB, computing the
 * normalised `page_key` on write so it joins to crawl data later.
 */
export class GscSync {
  constructor(private readonly gsc: GscClient, private readonly dataDir: string) {}

  async run(
    siteUrl: string,
    options: FetchOptions,
    update: (p: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<SyncResult> {
    const db = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
    try {
      const hostForm = hostFormForProperty(siteUrl);
      db.upsertProperty(siteUrl, hostForm ?? 'asis');

      const insert = db.db.prepare(
        `INSERT INTO search_analytics
           (date, query, page, page_key, device, country, clicks, impressions, ctr, position)
         VALUES (@date, @query, @page, @page_key, @device, @country, @clicks, @impressions, @ctr, @position)
         ON CONFLICT(date, query, page, device, country) DO UPDATE SET
           clicks = excluded.clicks, impressions = excluded.impressions,
           ctr = excluded.ctr, position = excluded.position, page_key = excluded.page_key`,
      );
      const insertMany = db.db.transaction((records: Record<string, unknown>[]) => {
        for (const r of records) insert.run(r);
      });

      let total = 0;
      const options2: FetchOptions = { ...options, dimensions: options.dimensions ?? SYNC_DIMENSIONS };
      const dims = options2.dimensions!;

      await this.gsc.fetchSearchAnalytics(siteUrl, options2, signal, ({ rows }) => {
        const records = rows.map((row: GscApiRow) => {
          const keys = row.keys ?? [];
          const rec: Record<string, string | null> = {};
          dims.forEach((d, i) => (rec[d] = keys[i] ?? null));
          const page = rec.page;
          return {
            date: rec.date,
            query: rec.query ?? null,
            page: page ?? null,
            page_key: page ? urlKey(page, { hostForm }) : null,
            device: rec.device ?? null,
            country: rec.country ?? null,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          };
        });
        insertMany(records);
        total += records.length;
        update({ siteUrl, rowsFetched: total });
      });

      db.db.prepare(`UPDATE property_meta SET last_synced_at = datetime('now') WHERE site_url = ?`).run(siteUrl);
      return { siteUrl, rowsFetched: total, startDate: options2.startDate, endDate: options2.endDate };
    } finally {
      db.close();
    }
  }
}
