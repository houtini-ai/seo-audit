import { AuditDatabase } from './AuditDatabase.js';
import Database from 'better-sqlite3';
import { SEGMENTS, gscStorageState, refreshLegacyDayShapes, segmentSql, segmentsMaxDate, settleGscTotals, type SettleResult } from './gscRows.js';
import { gb, migrateGscStorage, type GscMigrationResult } from './gscMigrate.js';
import { GscClient } from './GscClient.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty } from './url-key.js';
import type { FetchOptions, GscApiRow } from './types.js';

// Lean default: date×query×page is everything the audit + merged checks need, without
// the device×country multiplication that explodes row counts on large sites. Pass
// FULL_DIMENSIONS (segments) to also populate the device/country breakdowns.
const LITE_DIMENSIONS = ['date', 'query', 'page'];
export const FULL_DIMENSIONS = ['date', 'query', 'page', 'device', 'country'];

/** Days re-pulled (and replaced) before the last stored date: GSC restates the most recent days. */
export const LAG_DAYS = 4;

/** Where an incremental sync resumes: last stored date minus LAG_DAYS, never before the requested start. */
export function incrementalStart(maxStoredDate: string | null, requestedStart: string): string {
  return planIncremental(maxStoredDate, requestedStart, '9999-12-31').startDate;
}

/** The one incremental rule, shared by run() and plannedRange(): the range to fetch, whether the
 *  re-pulled lag days are replaced (from replaceFrom), and whether there is nothing to fetch. */
export function planIncremental(maxStoredDate: string | null, start: string, end: string): { startDate: string; replaceFrom: string | null; noop: boolean } {
  if (!maxStoredDate) return { startDate: start, replaceFrom: null, noop: false };
  const resume = new Date(Date.parse(maxStoredDate) - LAG_DAYS * 86400000).toISOString().slice(0, 10);
  if (resume > end) return { startDate: start, replaceFrom: null, noop: true }; // already synced past the requested window
  return resume > start ? { startDate: resume, replaceFrom: resume, noop: false } : { startDate: start, replaceFrom: null, noop: false };
}

export interface SyncResult {
  siteUrl: string;
  rowsFetched: number;
  startDate: string;
  endDate: string;
  /** Where the rows went: search_analytics (all-country totals) or search_analytics_segments (#65). */
  table?: string;
  /** Totals settled from segment rows over the synced window (#65). */
  settled?: SettleResult;
  /** The one-time storage migration, when this sync ran it (#65). */
  migration?: GscMigrationResult;
  /**
   * Set when the migration was refused (not enough free disk): the sync still ran, in the old
   * (#64) layout the views read correctly, and this says so in plain words.
   */
  storageMigrationDeferred?: string;
  /** The dimensions actually fetched: a lite request on a property whose segments are kept current fetches segments. */
  dimensions?: string[];
  /** Set when the sync was cancelled: rows fetched before the cancel, discarded (nothing was written). */
  discarded?: number;
}

/** True when a dimension set produces segment rows (a device or a country). */
export const isSegmentSync = (dims: string[]): boolean => dims.includes('device') || dims.includes('country');

const daysBefore = (date: string, n: number): string => new Date(Date.parse(date) - n * 86400000).toISOString().slice(0, 10);

/**
 * The last stored date of the totals and of the segment rows, read the same way in every storage
 * layout (#65): totals = any search_analytics row (before the migration a segment-only day still
 * has totals, through the views); segments = the segment table plus, before the migration, the
 * segment rows still in search_analytics. So the answer does not change when a sync migrates first.
 */
export function storedMaxDates(db: Database.Database): { totals: string | null; segments: string | null } {
  // Every lookup walks the date index from the top (the plan for a start reply rides on these).
  // A table missing (a read-only handle on a database this version never opened) reads as empty.
  const max = (sql: string): string | null => {
    try { return (db.prepare(sql).get() as { d: string | null } | undefined)?.d ?? null; } catch { return null; }
  };
  const totals = max(`SELECT MAX(date) d FROM search_analytics`);
  return { totals, segments: segmentsMaxDate(db) };
}

/**
 * The dimensions a sync fetches. A lite request on a property whose segment rows are kept current
 * (they reach the totals' last LAG_DAYS) keeps segmenting, so the breakdowns never go stale (the
 * pre-#65 rule). One decision, shared by run() and plannedRange(), so the start reply states the
 * range the job really fetches.
 */
export function syncDimensions(requested: string[] | undefined, max: { totals: string | null; segments: string | null }): { dimensions: string[]; segmentsKept: boolean } {
  const dims = requested ?? LITE_DIMENSIONS;
  if (!isSegmentSync(dims) && max.segments && (!max.totals || max.segments >= daysBefore(max.totals, LAG_DAYS))) {
    return { dimensions: FULL_DIMENSIONS, segmentsKept: true };
  }
  return { dimensions: dims, segmentsKept: false };
}

/**
 * The search types stored, read from the first and last row (by rowid) of each table: constant
 * time. The property holds one search type at a time (a sync of another type wipes both tables
 * first, and rows from before the column existed default to web), so the end rows answer it. The
 * old UNION over every row scanned both tables: 2.7 s on a warm 7.6M-row property, and it ran
 * before the sync's first network call, so it blocked the event loop.
 */
export function storedSearchTypes(db: Database.Database): string[] {
  const types = new Set<string>();
  for (const table of ['search_analytics', SEGMENTS]) {
    for (const dir of ['ASC', 'DESC']) {
      const r = db.prepare(`SELECT COALESCE(search_type, 'web') t FROM ${table} ORDER BY rowid ${dir} LIMIT 1`).get() as { t: string } | undefined;
      if (r) types.add(r.t);
    }
  }
  return [...types];
}

export interface GscSyncOptions {
  /** Test seam: free bytes on the data volume, for the storage migration's disk check. */
  freeBytes?: (dir: string) => number;
}

/**
 * Fetch GSC search analytics into a property's SQLite DB, computing the
 * normalised `page_key` on write so it joins to crawl data later.
 */
export class GscSync {
  constructor(private readonly gsc: GscClient, private readonly dataDir: string, private readonly opts: GscSyncOptions = {}) {}

  /** The range a sync with these options will fetch, for the start reply (#33). It takes the same
   *  dimension decision as run() (syncDimensions: a lite request may keep segmenting) and the same
   *  stored dates, so it states the real range. A different search type still forces the full
   *  window (checking it means scanning the tables); the finished job reports the range used. */
  plannedRange(siteUrl: string, options: FetchOptions): { startDate: string; endDate: string; incremental: boolean; noop?: boolean; dimensions: string[]; segmentsKept?: boolean } {
    let max: { totals: string | null; segments: string | null } = { totals: null, segments: null };
    try {
      // A plain read-only handle: two index-backed MAX(date) lookups and nothing else. The tool's
      // reply waits on this, so no schema ensure work (AuditDatabase) and no write lock.
      const db = new Database(dbPathFor(this.dataDir, siteUrl), { readonly: true, fileMustExist: true });
      try { max = storedMaxDates(db); } finally { db.close(); }
    } catch { /* no DB yet, or one this version never opened */ }
    const { dimensions, segmentsKept } = syncDimensions(options.dimensions, max);
    const shape = { dimensions, ...(segmentsKept ? { segmentsKept } : {}) };
    if (options.fullResync) return { startDate: options.startDate, endDate: options.endDate, incremental: false, ...shape };
    const plan = planIncremental(isSegmentSync(dimensions) ? max.segments : max.totals, options.startDate, options.endDate);
    return { startDate: plan.startDate, endDate: options.endDate, incremental: plan.startDate !== options.startDate, ...(plan.noop ? { noop: true } : {}), ...shape };
  }

  async run(
    siteUrl: string,
    options: FetchOptions,
    update: (p: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<SyncResult> {
    const dbFile = dbPathFor(this.dataDir, siteUrl);
    const db = new AuditDatabase(dbFile);
    try {
      const hostForm = hostFormForProperty(siteUrl);
      db.upsertProperty(siteUrl, hostForm ?? 'asis');

      // The stored grain is date × query × page: a sync without one of them would write rows that
      // every reader mistakes for that grain (and the totals aggregation could not rebuild).
      const asked = options.dimensions ?? LITE_DIMENSIONS;
      const missing = ['date', 'query', 'page'].filter(d => !asked.includes(d));
      if (missing.length) throw new Error(`GSC sync needs the date, query and page dimensions (the stored grain); missing ${missing.join(', ')} in [${asked.join(', ')}].`);

      // ── One-time storage migration (#65) ───────────────────────────────────────────────────
      // A database still in the #64 layout (segment rows mixed into search_analytics) is moved
      // first: backup, then day-by-day batches. Aborted part-way = it resumes on the next sync.
      // Refused for lack of disk = deferred: nothing is moved, and this sync runs in the old layout
      // (below), which the views already read correctly, only slower.
      let migration: GscMigrationResult | undefined;
      let deferred: string | undefined;
      if (gscStorageState(db.db) !== 'done') {
        // Progress rides its own key: `phase` belongs to the caller (refresh_property's widget).
        update({ siteUrl, storageMigration: { phase: 'starting' } });
        migration = await migrateGscStorage(db.db, dbFile, {
          signal, onProgress: p => update({ siteUrl, storageMigration: p }),
          ...(this.opts.freeBytes ? { freeBytes: this.opts.freeBytes } : {}),
        });
        if (migration.refused) {
          const need = migration.needBytes != null ? `needs ${gb(migration.needBytes)} free${migration.freeBytes != null ? ` (the volume has ${gb(migration.freeBytes)})` : ''}` : 'could not start';
          deferred = `storage migration deferred: ${need}; sync ran in the old layout, totals stay correct via the views (only slower). Free some space and sync again to migrate.`;
          console.error(`[gsc-sync] ${siteUrl}: ${deferred} ${migration.refused}`);
          update({ siteUrl, storageMigration: { phase: 'deferred', reason: deferred } });
        } else if (gscStorageState(db.db) !== 'done') {
          return { siteUrl, rowsFetched: 0, startDate: options.startDate, endDate: options.endDate, migration };
        }
      }
      // The old (#64) layout: every row goes into search_analytics, and gsc_day_shape picks one shape
      // per day for the views (refreshLegacyDayShapes after the write). No guard trigger exists yet.
      const legacy = gscStorageState(db.db) !== 'done';

      const stored = storedMaxDates(db.db);
      const { dimensions: dims } = syncDimensions(asked, stored);
      let options2: FetchOptions = { ...options, dimensions: dims };
      // The sync guard (#65): segment rows go to search_analytics_segments, all-country rows to
      // search_analytics, never the other way (each table's trigger refuses the wrong shape too).
      // In the old layout both go to search_analytics, and only the rows of the shape class this
      // sync writes are ever replaced, so a day never holds two segment shapes the views can't pick.
      const segments = isSegmentSync(dims);
      const table = segments && !legacy ? SEGMENTS : 'search_analytics';
      const SEG = segmentSql();
      const ownClass = segments ? SEG : `NOT ${SEG}`;

      // ── Every write is staged, then applied in ONE transaction after the whole fetch succeeded ──
      // GSC pages rows sorted by clicks across the whole window, so the first page already touches
      // every day with only its top rows. Committing page by page meant a sync that failed or was
      // cancelled on page 2 left every day of the window truncated, and the next incremental sync
      // resumed from the latest stored day, so those days were never fetched again; a search-type
      // wipe or a segment window replace that rode the first page destroyed the previous history
      // on a failure. Now a failure, an abort or an exception leaves the stored rows exactly as they
      // were. The lag-day replace (#22) always worked this way; the other paths now do too.
      // The stage is a TEMP table on disk (a first sync can stage millions of rows; this connection's
      // temp_store would otherwise keep them in RAM). It disappears with the connection.
      db.db.pragma('temp_store = FILE');
      const STAGE_COLS = 'date, query, page, page_key, device, country, search_type, clicks, impressions, ctr, position';
      db.db.exec(`CREATE TEMP TABLE IF NOT EXISTS sa_stage (${STAGE_COLS})`);
      db.db.exec('DELETE FROM sa_stage');
      const stageIns = db.db.prepare(`INSERT INTO sa_stage (${STAGE_COLS}) VALUES (@date, @query, @page, @page_key, @device, @country, @search_type, @clicks, @impressions, @ctr, @position)`);
      const stageRows = db.db.transaction((records: Record<string, unknown>[]) => { for (const r of records) stageIns.run(r); });

      let total = 0;
      // Search-type guard: the unique indexes (date,query,page,device,country) do NOT include
      // search_type (rebuilding them on existing rows would rewrite months of history), so the
      // property holds ONE search type at a time. Syncing a different type (e.g. discover over web
      // history) would silently mix/overwrite rows; it wipes both tables instead, in the apply
      // transaction, so a failed fetch destroys nothing.
      const wantType = options.searchType ?? 'web';
      const storedTypes = storedSearchTypes(db.db);
      const mustWipe = storedTypes.length > 0 && (storedTypes.length > 1 || storedTypes[0] !== wantType);
      /**
       * How the staged rows land: 'wipe' (another search type: empty both tables first), 'lag'
       * (replace the re-pulled days [from, to] of this sync's shape class, #22), 'window' (a
       * full-window segment sync replaces that window's segment rows, so a day never holds two
       * segment shapes) or 'upsert' (merge, e.g. a first sync or a totals fullResync).
       */
      const applyStaged = db.db.transaction((mode: 'wipe' | 'lag' | 'window' | 'upsert', from: string, to: string) => {
        if (mode === 'wipe') db.db.exec(`DELETE FROM search_analytics; DELETE FROM ${SEGMENTS}; DELETE FROM gsc_day_shape;`);
        else if (mode === 'lag') {
          if (!legacy) db.db.prepare(`DELETE FROM ${table} WHERE date >= ? AND date <= ?`).run(from, to);
          else {
            db.db.prepare(`DELETE FROM search_analytics WHERE date >= ? AND date <= ? AND ${ownClass}`).run(from, to);
            if (segments) db.db.prepare(`DELETE FROM ${SEGMENTS} WHERE date >= ? AND date <= ?`).run(from, to); // a migrated day's segments: one table per day
          }
        } else if (mode === 'window') {
          db.db.prepare(`DELETE FROM ${SEGMENTS} WHERE date >= ? AND date <= ?`).run(from, to);
          if (legacy) db.db.prepare(`DELETE FROM search_analytics WHERE date >= ? AND date <= ? AND ${SEG}`).run(from, to);
        }
        db.db.exec(`INSERT INTO ${table} (${STAGE_COLS}) SELECT ${STAGE_COLS} FROM sa_stage WHERE true
          ON CONFLICT(date, query, page, device, country) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions,
            search_type = excluded.search_type, ctr = excluded.ctr, position = excluded.position, page_key = excluded.page_key`);
        // Distinct-query FTS index (#35).
        db.db.exec(`INSERT OR IGNORE INTO sa_queries(query) SELECT DISTINCT query FROM sa_stage WHERE query IS NOT NULL`);
        db.db.exec('DELETE FROM sa_stage');
      });

      // ── Incremental resume ─────────────────────────────────────────────────────────────────
      // The first sync pulls the requested window; every sync after that only fetches from the
      // last stored date (in the table this sync writes) minus a lag buffer (GSC restates the most
      // recent few days), instead of re-pulling the whole window. Turns a 30-minute, 1.8M-row refresh
      // into a seconds-long delta. A pending search-type wipe pulls the full window. `fullResync`
      // forces the full window. Only ever NARROWS the window (never widens past the requested start).
      // Re-pulled lag days are REPLACED, not merged (#22): GSC can drop or merge rows while a day
      // finalises, and an upsert would leave those stale rows behind. See stageRows/applyStaged.
      const result = (rowsFetched: number, extra: Partial<SyncResult> = {}): SyncResult =>
        ({ siteUrl, rowsFetched, startDate: options2.startDate, endDate: options2.endDate, table, dimensions: dims, ...extra, ...(migration ? { migration } : {}), ...(deferred ? { storageMigrationDeferred: deferred } : {}) });
      let replaceFrom: string | null = null;
      if (!options.fullResync && !mustWipe) {
        const plan = planIncremental(segments ? stored.segments : stored.totals, options2.startDate, options2.endDate);
        // Already synced past the requested window (e.g. a historical/comparison pull whose
        // endDate predates the stored data): no-op instead of calling GSC with start > end.
        if (plan.noop) {
          db.db.prepare(`UPDATE property_meta SET last_synced_at = datetime('now') WHERE site_url = ?`).run(siteUrl);
          return result(0);
        }
        if (plan.replaceFrom) { options2 = { ...options2, startDate: plan.startDate }; replaceFrom = plan.replaceFrom; }
      }
      // A full-window segment sync over stored segment rows replaces that window (in the apply
      // transaction, like the wipe), so a day never holds two segment shapes.
      const replaceWindow = segments && !mustWipe && !replaceFrom
        && (!!db.db.prepare(`SELECT 1 FROM ${SEGMENTS} WHERE date >= ? AND date <= ? LIMIT 1`).get(options2.startDate, options2.endDate)
          || (legacy && !!db.db.prepare(`SELECT 1 FROM search_analytics WHERE date >= ? AND date <= ? AND ${SEG} LIMIT 1`).get(options2.startDate, options2.endDate)));
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
            device: rec.device ?? '', // '' = not segmented; keeps the unique index dedup working
            country: rec.country ?? '',
            search_type: wantType,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          };
        });
        stageRows(records);
        total += records.length;
        update({ siteUrl, rowsFetched: total });
      });

      // Cancelled part-way (the client stops paging on abort, it doesn't throw): nothing is written,
      // last_synced_at is not touched, and the staged rows go with the connection.
      if (signal.aborted) return result(0, { discarded: total });
      // An empty response never wipes or replaces stored days.
      if (total > 0) {
        const mode = mustWipe ? 'wipe' : replaceFrom ? 'lag' : replaceWindow ? 'window' : 'upsert';
        applyStaged(mode, replaceFrom ?? options2.startDate, options2.endDate);
      }
      // The writer owns the totals: over the synced window, each day's totals in search_analytics
      // become the fuller of the all-country rows and the segment rows aggregated (#65). In the old
      // layout the views pick per day instead, from gsc_day_shape, brought up to date here.
      if (legacy && total > 0) refreshLegacyDayShapes(db.db, options2.startDate, options2.endDate);
      const settled = total > 0 && !legacy ? settleGscTotals(db.db, options2.startDate, options2.endDate, segments) : undefined;
      db.db.prepare(`UPDATE property_meta SET last_synced_at = datetime('now') WHERE site_url = ?`).run(siteUrl);
      return result(total, settled ? { settled } : {});
    } finally {
      db.close();
    }
  }
}
