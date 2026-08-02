import { AuditDatabase } from './AuditDatabase.js';
import { GscClient } from './GscClient.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty } from './url-key.js';
import type { FetchOptions, GscApiRow } from './types.js';

// Lean default: date×query×page is everything the audit + merged checks need, without
// the device×country multiplication that explodes row counts on large sites. Pass
// FULL_DIMENSIONS (segments) to also populate the device/country breakdowns.
const LITE_DIMENSIONS = ['date', 'query', 'page'];
export const FULL_DIMENSIONS = ['date', 'query', 'page', 'device', 'country'];

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
           (date, query, page, page_key, device, country, search_type, clicks, impressions, ctr, position)
         VALUES (@date, @query, @page, @page_key, @device, @country, @search_type, @clicks, @impressions, @ctr, @position)
         ON CONFLICT(date, query, page, device, country) DO UPDATE SET
           clicks = excluded.clicks, impressions = excluded.impressions, search_type = excluded.search_type,
           ctr = excluded.ctr, position = excluded.position, page_key = excluded.page_key`,
      );
      const insertMany = db.db.transaction((records: Record<string, unknown>[]) => {
        for (const r of records) insert.run(r);
      });

      let total = 0;
      let options2: FetchOptions = { ...options, dimensions: options.dimensions ?? LITE_DIMENSIONS };
      let dims = options2.dimensions!;

      // Summary/totals SUM across one grouping. Mixing lite (device='') with segmented
      // (device='DESKTOP'…) rows would double-count, so the table holds ONE grouping shape.
      const cnt = (sql: string): number => (db.db.prepare(sql).get() as { n: number }).n;
      const hasLite = cnt(`SELECT COUNT(*) n FROM search_analytics WHERE device = ''`) > 0;
      const hasSegmented = cnt(`SELECT COUNT(*) n FROM search_analytics WHERE device <> ''`) > 0;
      // PRESERVE existing history: a routine (default/lite) sync over segmented history must NOT
      // wipe it — keep segmenting instead, so a short window sync never destroys months of data.
      if (!dims.includes('device') && hasSegmented && !hasLite) {
        options2 = { ...options2, dimensions: FULL_DIMENSIONS };
        dims = options2.dimensions!;
      }
      const wantsSegments = dims.includes('device');
      // Only wipe on a genuine, unavoidable shape conflict (e.g. an explicit lite→segmented
      // upgrade, or a pre-existing mixed table) — never on the routine preserve path above.
      // The wipe is DEFERRED into the same transaction as the first fetched batch: if the
      // API call fails or the job is aborted before any rows arrive, months of history are
      // NOT destroyed and replaced by nothing.
      let mustWipe = (wantsSegments && hasLite) || (!wantsSegments && hasSegmented);
      // Search-type guard (mirrors the lite/segmented shape-guard): the unique index
      // (date,query,page,device,country) does NOT include search_type — rebuilding it on existing
      // rows would rewrite months of history — so the table holds ONE search type at a time.
      // Syncing a different type (e.g. discover over web history) would silently mix/overwrite
      // rows; treat it as a shape conflict instead, and let the wipe ride the first batch's
      // transaction exactly like the lite/segmented wipe (a failed fetch destroys nothing).
      const wantType = options.searchType ?? 'web';
      const storedTypes = (db.db
        .prepare(`SELECT DISTINCT COALESCE(search_type, 'web') t FROM search_analytics`)
        .all() as { t: string }[]).map(r => r.t);
      if (storedTypes.length && (storedTypes.length > 1 || storedTypes[0] !== wantType)) mustWipe = true;
      const wipeAndInsert = db.db.transaction((records: Record<string, unknown>[]) => {
        db.db.exec('DELETE FROM search_analytics');
        for (const r of records) insert.run(r);
      });

      // ── Incremental resume ─────────────────────────────────────────────────────────────────
      // The first sync pulls the requested window; every sync after that only fetches from the
      // last stored date minus a lag buffer (GSC restates the most recent ~3 days), instead of
      // re-pulling the whole window. Turns a 30-minute, 1.8M-row refresh into a seconds-long delta.
      // Runs AFTER the mode-guard: if the table was just wiped (shape conflict) MAX(date) is null →
      // full window. `fullResync` forces the full window. Only ever NARROWS the window (never widens
      // past the requested start), and resumes from wherever the data left off (covers any gap).
      const LAG_DAYS = 3;
      if (!options.fullResync && !mustWipe) { // a pending wipe means the stored MAX(date) is the OLD shape's — pull the full window
        const mx = (db.db.prepare('SELECT MAX(date) d FROM search_analytics').get() as { d: string | null }).d;
        if (mx) {
          const resume = new Date(Date.parse(mx) - LAG_DAYS * 86400000).toISOString().slice(0, 10);
          // Already synced past the requested window (e.g. a historical/comparison pull whose
          // endDate predates the stored data): no-op instead of calling GSC with start > end.
          if (resume > options2.endDate) {
            db.db.prepare(`UPDATE property_meta SET last_synced_at = datetime('now') WHERE site_url = ?`).run(siteUrl);
            return { siteUrl, rowsFetched: 0, startDate: options2.startDate, endDate: options2.endDate };
          }
          if (resume > options2.startDate) { options2 = { ...options2, startDate: resume }; }
        }
      }

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
            device: rec.device ?? '', // '' = not segmented (lite); keeps the unique index dedup working
            country: rec.country ?? '',
            search_type: wantType,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          };
        });
        if (mustWipe) { wipeAndInsert(records); mustWipe = false; }
        else insertMany(records);
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
