// Run a backlink pull directly via the compiled Backlinks module. Usage:
//   node scripts/run-backlinks.mjs <siteUrl> [limit]
import { homedir } from 'node:os';
import path from 'node:path';
import { DataForSeoClient } from '../dist/core/DataForSeoClient.js';
import { Backlinks } from '../dist/core/Backlinks.js';

const siteUrl = process.argv[2];
const limit = Number(process.argv[3]) || 1000;
const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const user = process.env.DATAFORSEO_USERNAME, pass = process.env.DATAFORSEO_PASSWORD;
if (!user || !pass) { console.error('set DATAFORSEO_USERNAME/PASSWORD'); process.exit(1); }

const dfs = new DataForSeoClient(user, pass, path.join(dataDir, 'dataforseo-cache.db'), 20);
const bl = new Backlinks(dfs, dataDir);
const r = await bl.run(siteUrl, { limit, statusLimit: 120 }, p => process.stdout.write(`\r  ${JSON.stringify(p)}        `), new AbortController().signal);
console.log('\n', JSON.stringify(r, null, 1));
dfs.close();
