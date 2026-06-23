// Verify calibration: canonical-mismatch retired; ctr-below-expected all ≥500 impressions.
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import path from 'node:path';
import { dbPathFor } from '../dist/core/paths.js';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const db = new Database(dbPathFor(dataDir, 'https://simracingcockpit.gg/'), { readonly: true });
const run = db.prepare(`SELECT run_id FROM audit_runs ORDER BY started_at DESC LIMIT 1`).get();

const cm = db.prepare(`SELECT COUNT(*) n FROM findings WHERE run_id=? AND check_id='canonical-mismatch'`).get(run.run_id).n;
console.log('canonical-mismatch findings (expect 0):', cm);

const ctr = db.prepare(`SELECT traffic_at_risk FROM findings WHERE run_id=? AND check_id='ctr-below-expected'`).all(run.run_id);
const imprs = ctr.map(r => { try { return JSON.parse(r.traffic_at_risk).impressions || 0; } catch { return 0; } });
console.log('ctr-below-expected: count', imprs.length, 'min impr', Math.min(...imprs), 'below-500', imprs.filter(i => i < 500).length);
db.close();
