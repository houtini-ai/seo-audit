// Verify the pagination exclusion: no /page/N URLs should remain in the affected checks.
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import path from 'node:path';
import { dbPathFor } from '../dist/core/paths.js';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const db = new Database(dbPathFor(dataDir, 'https://simracingcockpit.gg/'), { readonly: true });
const run = db.prepare(`SELECT run_id FROM audit_runs ORDER BY started_at DESC LIMIT 1`).get();
const checks = ['duplicate-title', 'duplicate-meta-description', 'missing-meta-description', 'indexable-not-in-sitemap'];
for (const c of checks) {
  const total = db.prepare(`SELECT COUNT(*) n FROM findings WHERE run_id=? AND check_id=?`).get(run.run_id, c).n;
  const paged = db.prepare(`SELECT COUNT(*) n FROM findings WHERE run_id=? AND check_id=? AND (url_key GLOB '*/page/[0-9]*' OR url_key LIKE '%page=%' OR url_key LIKE '%paged=%')`).get(run.run_id, c).n;
  console.log(`${c}: total=${total} pagination=${paged}`);
}
db.close();
