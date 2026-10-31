/**
 * dataStorage — data-hygiene: what's on disk per property (sizes, row counts, last
 * sync/crawl), plus explicit prune actions (vacuum / clear-crawl-history /
 * delete-property). Destructive actions require confirm:true and refuse loudly,
 * naming exactly what would be deleted. Never touches a DB while a job is running.
 */
import Database from 'better-sqlite3';
import { readdirSync, statSync, existsSync, rmSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { dbPathFor } from './paths.js';

/** How many recent audit runs / crawl snapshots clear-crawl-history keeps. */
export const KEEP_RECENT = 5;

const CACHE_DB_NAMES = new Set([
  'dataforseo-cache.db', 'wikidata-cache.db', 'majestic-cache.db',
  // The portfolio database (cross-property; holds no property_meta), reported with the caches.
  '_portfolio.db',
  // Legacy: caches of the competitor fetchers removed in 0.15.0. Still listed so a leftover file on
  // an existing install is reported as a (deletable) cache, never mistaken for a property database.
  'firecrawl-cache.db', 'supadata-cache.db',
]);

export interface PropertyStorage {
  file: string;
  siteUrl: string | null;
  bytes: number;            // db + -wal + -shm
  searchAnalytics: number;
  /** Device/country rows (search_analytics_segments, #65). */
  searchAnalyticsSegments: number;
  pages: number;
  links: number;
  pageSnapshots: number;
  findings: number;
  lastSynced: string | null;
  /** finished_at of the most recent COMPLETED crawl. Running, failed or cancelled runs never count (#20). */
  lastCrawl: string | null;
  /** The most recent crawl run when it did NOT complete (still running, failed, cancelled, or died
   *  with its process), so a dead job is visible instead of masquerading as the last crawl. */
  latestCrawlRun?: { status: string; startedAt: string; error: string | null };
  linkProspects: number;         // rows in link_prospects (0 = link_intersect never run)
  linkProspectsFetched: string | null; // MAX(fetched_at) — freshness of the intersect (may be stale)
  /** Other properties sharing this file (pre-per-form-filename databases) — their data is mixed in. */
  sharedWith?: string[];
  /** The GSC storage layout (#65): migrated, pending, migrating, or deferred (with why). */
  gscStorage: GscStorageInfo;
  /** `<file>.bak-*` backups beside this database (the GSC migration's, a repair's, or hand-made). */
  backups: BackupFile[];
}

export interface GscStorageInfo {
  state: 'migrated' | 'pending' | 'migrating' | 'deferred' | 'unknown';
  /** Plain words: what the state means, and for deferred why (from the last refused attempt). */
  note: string;
  /** The backup the migration made, when it made one. */
  backup?: string | null;
  updatedAt?: string | null;
}

export interface BackupFile {
  file: string;
  /** The database it is a backup of. */
  of: string;
  bytes: number;
  modified: string;
  /** 'gsc-migration' = the backup the #65 migration took (gsc_storage_state.backup); 'other' = a repair's or hand-made. */
  kind: 'gsc-migration' | 'other';
}

export interface StorageSummary {
  dataDir: string;
  properties: PropertyStorage[];
  caches: { file: string; bytes: number }[];
  other: { file: string; bytes: number }[];
  /** Every `*.db.bak-*` file in the data dir (also listed per property), counted in totalBytes. */
  backups: BackupFile[];
  backupBytes: number;
  /** Empty `-wal` (and its `-shm`) left beside a backup by an older version: removed by this listing. */
  straySidecarsRemoved: string[];
  reportsBytes: number;
  totalBytes: number;
}

/** A backup's name: `<name>.db.bak-<stamp>`; its SQLite sidecars end in -wal / -shm. */
const BACKUP_RE = /^(.+\.db)\.bak-.+$/;
const isSidecar = (f: string): boolean => f.endsWith('-wal') || f.endsWith('-shm');

/**
 * Remove the -wal/-shm left beside a backup when the WAL is empty (or gone). A read-only handle on a
 * WAL-mode copy creates them and can't delete them on close; with an empty WAL they hold nothing.
 * Returns the files removed.
 */
export function removeEmptySidecars(file: string): string[] {
  const wal = `${file}-wal`, shm = `${file}-shm`;
  let walBytes = 0;
  try { walBytes = statSync(wal).size; } catch { walBytes = 0; }
  if (walBytes > 0) return [];
  const removed: string[] = [];
  for (const f of [wal, shm]) if (existsSync(f)) { try { rmSync(f, { force: true }); removed.push(path.basename(f)); } catch { /* in use: leave it */ } }
  return removed;
}

function readGscStorage(db: Database.Database): GscStorageInfo {
  let row: { state: string; backup: string | null; detail: string | null; updated_at: string | null } | undefined;
  try { row = db.prepare(`SELECT state, backup, detail, updated_at FROM gsc_storage_state WHERE id = 1`).get() as typeof row; } catch { row = undefined; }
  if (!row) return { state: 'unknown', note: 'not recorded yet: this version has not opened the database for a sync (the next sync records it, and migrates if needed)' };
  let detail: { deferred?: { reason?: string; at?: string } ; daysDone?: number; finishedAt?: string } = {};
  try { detail = row.detail ? JSON.parse(row.detail) : {}; } catch { detail = {}; }
  const base = { backup: row.backup, updatedAt: row.updated_at };
  if (row.state === 'done') return { ...base, state: 'migrated', note: `migrated to the 0.16 layout${detail.finishedAt ? ` (${detail.finishedAt.slice(0, 16).replace('T', ' ')})` : ''}${row.backup ? '; its pre-migration backup can be deleted once you are happy with the data' : ''}` };
  if (detail.deferred?.reason) return { ...base, state: 'deferred', note: `deferred${detail.deferred.at ? ` ${detail.deferred.at.slice(0, 16).replace('T', ' ')}` : ''}${row.state === 'migrating' ? ' part-way through' : ''}: ${detail.deferred.reason}` };
  if (row.state === 'migrating') return { ...base, state: 'migrating', note: `migration under way or interrupted${detail.daysDone != null ? ` (${detail.daysDone} days moved)` : ''}; the next sync resumes it` };
  return { ...base, state: 'pending', note: 'pending: the next sync migrates it (backup first, then day by day)' };
}

const sizeWithSidecars = (dbFile: string): number => {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += statSync(dbFile + suffix).size; } catch { /* absent */ }
  }
  return total;
};

const dirSize = (dir: string): number => {
  let total = 0;
  try {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) total += dirSize(p);
      else { try { total += statSync(p).size; } catch { /* raced */ } }
    }
  } catch { /* absent */ }
  return total;
};

const safeCount = (db: Database.Database, table: string): number => {
  try { return (db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get() as { n: number }).n; } catch { return 0; }
};

/**
 * Row counts are the slow part of a listing: COUNT(*) reads a whole index, which on a cold 5.5 GB
 * property took most of the 9.1 s first call (the 0.1 s second call was the page cache). They only
 * change when the file does, so they are kept in `_storage-counts.json` beside the databases, keyed
 * by the size and mtime of the database and its WAL: a later listing (another gateway worker
 * included) reuses them until a write touches either file. Best effort: an unreadable or unwritable
 * cache just means counting.
 */
export const COUNTS_CACHE_FILE = '_storage-counts.json';
const COUNTED_TABLES = ['search_analytics', 'search_analytics_segments', 'pages', 'links', 'page_snapshots', 'findings', 'link_prospects'] as const;
type Counts = Record<(typeof COUNTED_TABLES)[number], number>;
interface CountsEntry { stamp: string; counts: Counts }
const fileStamp = (dbFile: string): string => ['', '-wal'].map(sfx => {
  try { const st = statSync(dbFile + sfx); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; }
}).join('|');
function readCountsCache(dataDir: string): Record<string, CountsEntry> {
  try { return JSON.parse(readFileSync(path.join(dataDir, COUNTS_CACHE_FILE), 'utf8')) as Record<string, CountsEntry>; } catch { return {}; }
}
function writeCountsCache(dataDir: string, cache: Record<string, CountsEntry>): void {
  const file = path.join(dataDir, COUNTS_CACHE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(cache)); renameSync(tmp, file); } catch { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } }
}

export function storageSummary(dataDir: string, siteUrl?: string): StorageSummary {
  const properties: PropertyStorage[] = [];
  const caches: { file: string; bytes: number }[] = [];
  const other: { file: string; bytes: number }[] = [];
  let all: string[] = [];
  try { all = readdirSync(dataDir); } catch { /* dataDir absent */ }
  const files = all.filter(f => f.endsWith('.db'));
  // The property's actual file (dbPathFor), not its stem: an adopted legacy file or a Domain
  // property moved off a shared stem lives under another name.
  const wantFile = siteUrl ? path.basename(dbPathFor(dataDir, siteUrl)) : null;
  // Backups (`x.db.bak-<stamp>`), with their stray empty sidecars cleared first.
  const straySidecarsRemoved: string[] = [];
  const backupNames = all.filter(f => BACKUP_RE.test(f) && !isSidecar(f)).sort();
  for (const b of backupNames) straySidecarsRemoved.push(...removeEmptySidecars(path.join(dataDir, b)));
  const backupsAll: BackupFile[] = backupNames.map(b => {
    const full = path.join(dataDir, b);
    let modified = '';
    try { modified = statSync(full).mtime.toISOString(); } catch { /* raced */ }
    return { file: b, of: BACKUP_RE.exec(b)![1], bytes: sizeWithSidecars(full), modified, kind: 'other' as BackupFile['kind'] };
  });

  const countsCache = readCountsCache(dataDir);
  let countsChanged = false;
  for (const file of files.sort()) {
    const full = path.join(dataDir, file);
    const bytes = sizeWithSidecars(full);
    const stamp = fileStamp(full);
    if (CACHE_DB_NAMES.has(file)) { caches.push({ file, bytes }); continue; }
    let db: Database.Database | null = null;
    try {
      db = new Database(full, { readonly: true, fileMustExist: true });
      const isProperty = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='property_meta'`).get();
      if (!isProperty) { other.push({ file, bytes }); continue; }
      // The ACTIVE property (most recently synced) owns the data. Ordering by id reported the
      // first property ever created, which on a legacy collided database is the wrong one.
      const metaRows = db.prepare(
        `SELECT site_url, last_synced_at FROM property_meta ORDER BY COALESCE(last_synced_at,'') DESC, id ASC`,
      ).all() as { site_url: string; last_synced_at: string | null }[];
      const meta = metaRows[0];
      // >1 property in one file = a database created before per-form filenames. Say so rather than
      // silently attributing every row to one of them.
      const sharedWith = metaRows.length > 1 ? metaRows.slice(1).map(r => r.site_url) : undefined;
      if (wantFile && file !== wantFile) continue;
      let lastCrawl: string | null = null;
      let latestCrawlRun: PropertyStorage['latestCrawlRun'];
      try {
        lastCrawl = (db.prepare(`SELECT MAX(finished_at) t FROM crawl_metadata WHERE status = 'completed'`).get() as { t: string | null }).t;
        const latest = db.prepare(`SELECT status, started_at, error FROM crawl_metadata ORDER BY started_at DESC LIMIT 1`).get() as { status: string; started_at: string; error: string | null } | undefined;
        if (latest && latest.status !== 'completed') latestCrawlRun = { status: latest.status, startedAt: latest.started_at, error: latest.error ?? null };
      } catch { /* no crawl table */ }
      const gscStorage = readGscStorage(db);
      const backups = backupsAll.filter(b => b.of === file).map(b => (gscStorage.backup && path.basename(gscStorage.backup) === b.file ? { ...b, kind: 'gsc-migration' as const } : b));
      for (const b of backups) { const i = backupsAll.findIndex(x => x.file === b.file); if (i >= 0) backupsAll[i] = b; }
      let linkProspectsFetched: string | null = null;
      try {
        linkProspectsFetched = (db.prepare(`SELECT MAX(fetched_at) t FROM link_prospects`).get() as { t: string | null }).t;
      } catch { /* no link_prospects table (pre-link_intersect DB) */ }
      let counts = countsCache[file]?.stamp === stamp ? countsCache[file].counts : null;
      if (!counts) {
        const db2 = db;
        counts = Object.fromEntries(COUNTED_TABLES.map(t => [t, safeCount(db2, t)])) as Counts;
        countsCache[file] = { stamp, counts };
        countsChanged = true;
      }
      properties.push({
        file,
        siteUrl: meta?.site_url ?? null,
        bytes,
        searchAnalytics: counts.search_analytics,
        searchAnalyticsSegments: counts.search_analytics_segments,
        pages: counts.pages,
        links: counts.links,
        pageSnapshots: counts.page_snapshots,
        findings: counts.findings,
        lastSynced: meta?.last_synced_at ?? null,
        linkProspects: counts.link_prospects,
        linkProspectsFetched,
        ...(sharedWith ? { sharedWith } : {}),
        gscStorage,
        backups,
        lastCrawl,
        ...(latestCrawlRun ? { latestCrawlRun } : {}),
      });
    } catch {
      other.push({ file, bytes });
    } finally {
      db?.close();
    }
  }

  if (countsChanged) {
    // Drop entries for databases that are gone, then save.
    for (const k of Object.keys(countsCache)) if (!files.includes(k)) delete countsCache[k];
    writeCountsCache(dataDir, countsCache);
  }
  const reportsBytes = dirSize(path.join(dataDir, 'reports'));
  // Narrowed to one property: only its backups.
  const backups = wantFile ? backupsAll.filter(b => b.of === wantFile) : backupsAll;
  const backupBytes = backups.reduce((s, b) => s + b.bytes, 0);
  const totalBytes = properties.reduce((s, p) => s + p.bytes, 0)
    + caches.reduce((s, c) => s + c.bytes, 0)
    + other.reduce((s, o) => s + o.bytes, 0)
    + backupBytes
    + reportsBytes;
  return { dataDir, properties, caches, other, backups, backupBytes, straySidecarsRemoved, reportsBytes, totalBytes };
}

export const fmtBytes = (n: number): string => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

export interface PruneResult {
  ok: boolean;
  refused?: string;         // loud refusal text (missing confirm, running job, no DB)
  action: string;
  siteUrl: string;
  detail: Record<string, unknown>;
}

export function pruneProperty(
  dataDir: string,
  siteUrl: string,
  action: 'vacuum' | 'clear-crawl-history' | 'delete-property',
  confirm: boolean,
  runningJobs: { id: string; type: string }[],
): PruneResult {
  const base: Pick<PruneResult, 'action' | 'siteUrl'> = { action, siteUrl };
  if (runningJobs.length) {
    return {
      ...base, ok: false, detail: { runningJobs },
      refused: `Refusing to ${action} while ${runningJobs.length} job(s) are running (${runningJobs.map(j => `${j.type}#${j.id}`).join(', ')}) — a prune mid-sync/crawl can corrupt or race the write. Wait for them to finish and retry.`,
    };
  }
  const dbFile = dbPathFor(dataDir, siteUrl);
  if (!existsSync(dbFile)) {
    return { ...base, ok: false, refused: `No database for ${siteUrl} at ${dbFile} — nothing to ${action}. Check list via data_storage (no args).`, detail: { dbFile } };
  }
  const bytesBefore = sizeWithSidecars(dbFile);

  if (action === 'delete-property') {
    const summary = storageSummary(dataDir, siteUrl).properties[0];
    if (!confirm) {
      return {
        ...base, ok: false, detail: { dbFile, bytes: bytesBefore, rows: summary },
        refused: `REFUSED — delete-property is destructive and needs confirm:true. This would permanently delete ${dbFile} (+ -wal/-shm), ${fmtBytes(bytesBefore)}: ` +
          `${summary?.searchAnalytics ?? '?'} search_analytics rows (+${summary?.searchAnalyticsSegments ?? 0} segment rows), ${summary?.pages ?? '?'} pages, ${summary?.links ?? '?'} links, ${summary?.pageSnapshots ?? '?'} snapshots, ${summary?.findings ?? '?'} findings. ` +
          `GSC history is re-syncable but slow to rebuild. Re-run with confirm:true to proceed.`,
      };
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + suffix, { force: true });
    return { ...base, ok: true, detail: { dbFile, bytesFreed: bytesBefore } };
  }

  if (action === 'vacuum') {
    const db = new Database(dbFile);
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
    } finally { db.close(); }
    const bytesAfter = sizeWithSidecars(dbFile);
    return { ...base, ok: true, detail: { bytesBefore, bytesAfter, bytesReclaimed: Math.max(bytesBefore - bytesAfter, 0) } };
  }

  // clear-crawl-history: drop page_snapshots + audit_runs/findings beyond the KEEP_RECENT
  // most recent, then VACUUM. Preview first so the refusal can name what goes.
  const db = new Database(dbFile);
  try {
    const keepRuns = (db.prepare(`SELECT run_id FROM audit_runs ORDER BY started_at DESC LIMIT ${KEEP_RECENT}`).all() as { run_id: string }[]).map(r => r.run_id);
    const keepCrawls = (db.prepare(`SELECT crawl_id FROM (SELECT crawl_id, MAX(captured_at) t FROM page_snapshots GROUP BY crawl_id) ORDER BY t DESC LIMIT ${KEEP_RECENT}`).all() as { crawl_id: string }[]).map(r => r.crawl_id);
    const ph = (n: number): string => Array.from({ length: n }, () => '?').join(',') || `''`;
    const oldRuns = (db.prepare(`SELECT COUNT(*) n FROM audit_runs WHERE run_id NOT IN (${ph(keepRuns.length)})`).get(...keepRuns) as { n: number }).n;
    const oldFindings = (db.prepare(`SELECT COUNT(*) n FROM findings WHERE run_id NOT IN (${ph(keepRuns.length)})`).get(...keepRuns) as { n: number }).n;
    const oldSnapshots = (db.prepare(`SELECT COUNT(*) n FROM page_snapshots WHERE crawl_id NOT IN (${ph(keepCrawls.length)})`).get(...keepCrawls) as { n: number }).n;
    if (!confirm) {
      db.close();
      return {
        ...base, ok: false, detail: { oldRuns, oldFindings, oldSnapshots, keepRecent: KEEP_RECENT },
        refused: `REFUSED — clear-crawl-history is destructive and needs confirm:true. This would permanently delete ${oldRuns} audit runs, ${oldFindings} findings and ${oldSnapshots} page snapshots older than the ${KEEP_RECENT} most recent (change-detection history beyond that window is lost). Re-run with confirm:true to proceed.`,
      };
    }
    db.transaction(() => {
      db.prepare(`DELETE FROM findings WHERE run_id NOT IN (${ph(keepRuns.length)})`).run(...keepRuns);
      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_error_pages'`).get()) db.prepare(`DELETE FROM audit_error_pages WHERE run_id NOT IN (${ph(keepRuns.length)})`).run(...keepRuns);
      db.prepare(`DELETE FROM audit_runs WHERE run_id NOT IN (${ph(keepRuns.length)})`).run(...keepRuns);
      db.prepare(`DELETE FROM page_snapshots WHERE crawl_id NOT IN (${ph(keepCrawls.length)})`).run(...keepCrawls);
    })();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
  } finally {
    if (db.open) db.close();
  }
  const bytesAfter = sizeWithSidecars(dbFile);
  return {
    ...base, ok: true,
    detail: { bytesBefore, bytesAfter, bytesReclaimed: Math.max(bytesBefore - bytesAfter, 0), keepRecent: KEEP_RECENT },
  };
}
