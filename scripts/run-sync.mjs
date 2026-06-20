// Run a GSC sync directly via the compiled GscSync (test lite vs segments without a
// Desktop restart). Usage: node scripts/run-sync.mjs <siteUrl> [lite|full] [days]
import { homedir } from 'node:os';
import path from 'node:path';
import { GscClient } from '../dist/core/GscClient.js';
import { GscSync, FULL_DIMENSIONS } from '../dist/core/GscSync.js';

const siteUrl = process.argv[2];
const mode = process.argv[3] ?? 'lite';
const days = Number(process.argv[4]) || 30;
const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'seo-audits', 'seo-audit-console');
const cred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!cred) { console.error('set GOOGLE_APPLICATION_CREDENTIALS'); process.exit(1); }

const sync = new GscSync(new GscClient(cred), dataDir);
const opts = {
  startDate: new Date(Date.now() - days * 86400000).toISOString().slice(0, 10),
  endDate: new Date().toISOString().slice(0, 10),
  ...(mode === 'full' ? { dimensions: FULL_DIMENSIONS } : {}),
};
const r = await sync.run(siteUrl, opts, p => process.stdout.write(`\r  ${p.rowsFetched} rows  `), new AbortController().signal);
console.log('\n', mode, JSON.stringify(r));
