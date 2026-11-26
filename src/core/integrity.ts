/**
 * Property-DB integrity check and index repair (#34). A corrupt index (e.g. "row N missing from
 * index idx_sa_q_pk_date") made every sync fail with "database disk image is malformed" while
 * reads kept working, so nothing pointed at the cause. quick_check misses that class of damage;
 * only the full integrity_check finds it. Both run in a worker thread (see integrityWorker.ts).
 */
import { Worker } from 'node:worker_threads';
import { existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { dbPathFor } from './paths.js';

export interface IntegrityReport {
  siteUrl: string;
  dbFile: string;
  mode: 'quick' | 'full';
  ok: boolean;
  problems: string[];          // integrity_check messages other than "ok" (capped at 1000)
  damagedIndexes: string[];    // index names the messages attribute damage to — REINDEX-able
  tableDamage: boolean;        // damage not attributable to an index — REINDEX can't fix it
  ms: number;
}

export interface RepairReport {
  siteUrl: string;
  dbFile: string;
  backup: string | null;
  reindexed: string[];
  before: IntegrityReport;
  after: IntegrityReport | null;
  note: string;
}

const INDEX_MSG = /(?:missing from index|wrong # of entries in index|in index)\s+([A-Za-z_][\w$]*)/i;

function runWorker(dbFile: string, mode: 'quick' | 'full', reindex: string[] = []): Promise<{ messages: string[]; ms: number; reindexed: string[] }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./integrityWorker.js', import.meta.url), { workerData: { dbFile, mode, reindex } });
    w.once('message', (m: any) => (m.ok ? resolve(m) : reject(new Error(m.error))));
    w.once('error', reject);
    w.once('exit', code => { if (code !== 0) reject(new Error(`integrity worker exited with code ${code}`)); });
  });
}

function toReport(siteUrl: string, dbFile: string, mode: 'quick' | 'full', messages: string[], ms: number): IntegrityReport {
  const problems = messages.filter(m => m !== 'ok');
  const damaged = new Set<string>();
  let tableDamage = false;
  for (const p of problems) {
    const m = p.match(INDEX_MSG);
    if (m) damaged.add(m[1]); else tableDamage = true;
  }
  return { siteUrl, dbFile, mode, ok: problems.length === 0, problems, damagedIndexes: [...damaged], tableDamage, ms };
}

export function propertyDbFile(dataDir: string, siteUrl: string): string {
  const f = dbPathFor(dataDir, siteUrl);
  if (!existsSync(f)) throw new Error(`No database for ${siteUrl} at ${f}. List properties with data_storage (no args).`);
  return f;
}

export async function checkIntegrity(dataDir: string, siteUrl: string, mode: 'quick' | 'full' = 'full'): Promise<IntegrityReport> {
  const dbFile = propertyDbFile(dataDir, siteUrl);
  const r = await runWorker(dbFile, mode);
  return toReport(siteUrl, dbFile, mode, r.messages, r.ms);
}

/**
 * Back up the DB file (SQLite's online backup: one self-contained, consistent copy), REINDEX each
 * damaged index, then re-check. Table-level damage is reported, not "fixed": REINDEX rebuilds
 * indexes from table rows and cannot recover lost table data.
 */
export async function repairIndexes(dataDir: string, siteUrl: string): Promise<RepairReport> {
  const dbFile = propertyDbFile(dataDir, siteUrl);
  const before = await checkIntegrity(dataDir, siteUrl, 'full');
  if (before.ok) return { siteUrl, dbFile, backup: null, reindexed: [], before, after: null, note: 'integrity_check is clean; nothing to repair.' };
  if (!before.damagedIndexes.length) {
    return { siteUrl, dbFile, backup: null, reindexed: [], before, after: null,
      note: 'The damage is in table data, not an index, so REINDEX cannot fix it. Restore from a backup (copy it over the database file). Deleting the property (data_storage prune delete-property) and re-syncing also works, but it removes the backups too and Search Console only returns the last 16 months.' };
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  let backup = `${dbFile}.bak-${stamp}`;
  for (let i = 1; existsSync(backup); i++) backup = `${dbFile}.bak-${stamp}-${i}`;
  // Online backup API, not a file copy (as the GSC migration does): a consistent snapshot that
  // includes the WAL, even if another connection (the dashboard) writes or checkpoints meanwhile.
  { const db = new Database(dbFile, { fileMustExist: true }); try { await db.backup(backup); } finally { db.close(); } }
  const r = await runWorker(dbFile, 'full', before.damagedIndexes);
  const after = toReport(siteUrl, dbFile, 'full', r.messages, r.ms);
  const note = after.ok
    ? `Rebuilt ${r.reindexed.length} index(es); integrity_check is now clean. Backup kept at ${backup} (${statSync(backup).size} bytes); delete it once you're satisfied.`
    : `Rebuilt ${r.reindexed.length} index(es) but integrity_check still reports problems${after.tableDamage ? ' in table data, which REINDEX cannot fix' : ''}. Backup kept at ${backup}.`;
  return { siteUrl, dbFile, backup, reindexed: r.reindexed, before, after, note };
}
