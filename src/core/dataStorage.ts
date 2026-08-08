/**
 * dataStorage — data-hygiene: what's on disk per property (sizes, row counts, last
 * sync/crawl), plus explicit prune actions (vacuum / clear-crawl-history /
 * delete-property). Destructive actions require confirm:true and refuse loudly,
 * naming exactly what would be deleted. Never touches a DB while a job is running.
 */
import Database from 'better-sqlite3';
import { readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dbPathFor, sanitizeProperty } from './paths.js';

/** How many recent audit runs / crawl snapshots clear-crawl-history keeps. */
export const KEEP_RECENT = 5;

const CACHE_DB_NAMES = new Set(['dataforseo-cache.db', 'wikidata-cache.db']);

export interface PropertyStorage {
  file: string;
  siteUrl: string | null;
  bytes: number;            // db + -wal + -shm
  searchAnalytics: number;
  pages: number;
  links: number;
  pageSnapshots: number;
  findings: number;
  lastSynced: string | null;
  lastCrawl: string | null;
  /** Other properties sharing this file (pre-per-form-filename databases) — their data is mixed in. */
  sharedWith?: string[];
}

export interface StorageSummary {
  dataDir: string;
  properties: PropertyStorage[];
  caches: { file: string; bytes: number }[];
  other: { file: string; bytes: number }[];
  reportsBytes: number;
  totalBytes: number;
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

export function storageSummary(dataDir: string, siteUrl?: string): StorageSummary {
  const properties: PropertyStorage[] = [];
  const caches: { file: string; bytes: number }[] = [];
  const other: { file: string; bytes: number }[] = [];
  let files: string[] = [];
  try { files = readdirSync(dataDir).filter(f => f.endsWith('.db')); } catch { /* dataDir absent */ }
  const wantStem = siteUrl ? sanitizeProperty(siteUrl) : null;

  for (const file of files.sort()) {
    const full = path.join(dataDir, file);
    const bytes = sizeWithSidecars(full);
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
      if (wantStem && file !== `${wantStem}.db`) continue;
      let lastCrawl: string | null = null;
      try {
        lastCrawl = (db.prepare(`SELECT MAX(COALESCE(finished_at, started_at)) t FROM crawl_metadata`).get() as { t: string | null }).t;
      } catch { /* no crawl table */ }
      properties.push({
        file,
        siteUrl: meta?.site_url ?? null,
        bytes,
        searchAnalytics: safeCount(db, 'search_analytics'),
        pages: safeCount(db, 'pages'),
        links: safeCount(db, 'links'),
        pageSnapshots: safeCount(db, 'page_snapshots'),
        findings: safeCount(db, 'findings'),
        lastSynced: meta?.last_synced_at ?? null,
        ...(sharedWith ? { sharedWith } : {}),
        lastCrawl,
      });
    } catch {
      other.push({ file, bytes });
    } finally {
      db?.close();
    }
  }

  const reportsBytes = dirSize(path.join(dataDir, 'reports'));
  const totalBytes = properties.reduce((s, p) => s + p.bytes, 0)
    + caches.reduce((s, c) => s + c.bytes, 0)
    + other.reduce((s, o) => s + o.bytes, 0)
    + reportsBytes;
  return { dataDir, properties, caches, other, reportsBytes, totalBytes };
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
          `${summary?.searchAnalytics ?? '?'} search_analytics rows, ${summary?.pages ?? '?'} pages, ${summary?.links ?? '?'} links, ${summary?.pageSnapshots ?? '?'} snapshots, ${summary?.findings ?? '?'} findings. ` +
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
