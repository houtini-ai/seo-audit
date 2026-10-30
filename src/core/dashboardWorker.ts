// Builds one dashboard payload off the main thread (see dashboardAsync.ts).
import { parentPort, workerData } from 'node:worker_threads';
import { getDashboardData } from './dashboardData.js';

const { dataDir, siteUrl, days } = workerData as { dataDir: string; siteUrl: string; days?: number };
try { parentPort!.postMessage({ ok: true, data: getDashboardData(dataDir, siteUrl, { days }) }); }
catch (e) { parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
