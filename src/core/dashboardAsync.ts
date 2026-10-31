import { Worker } from 'node:worker_threads';
import { getDashboardData, WINDOW_DAYS, type DashboardData } from './dashboardData.js';

/**
 * The dashboard payload, built on a worker thread. A cold build (after a sync, crawl or audit
 * changed the data) runs ~20 GROUP BY scans over search_analytics and can take a minute on a
 * multi-GB property; on the main thread it blocked the whole web server, so every other request -
 * the job status poll, the domain list, a second tab - queued behind it (the "first /api/call
 * hangs" report, 30 Oct 2026). A worker keeps the server answering.
 *
 * Identical concurrent requests share one build (a reload while the first is still running
 * doesn't start a second scan). If a worker can't start (e.g. the compiled worker file is absent
 * in an unusual bundle), it falls back to building in-thread.
 */
const inflight = new Map<string, Promise<DashboardData>>();

export function getDashboardDataAsync(dataDir: string, siteUrl: string, opts: { days?: number } = {}): Promise<DashboardData> {
  // The window the build will use (getDashboardData reads any other value as 28): keyed on the raw
  // value, days=1..30 started thirty identical full builds at once.
  const days = (WINDOW_DAYS as readonly number[]).includes(Number(opts.days)) ? Number(opts.days) : 28;
  opts = { days };
  const key = `${dataDir}|${siteUrl}|${days}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = new Promise<DashboardData>((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./dashboardWorker.js', import.meta.url), { workerData: { dataDir, siteUrl, days: opts.days } });
    } catch {
      try { resolve(getDashboardData(dataDir, siteUrl, opts)); } catch (e) { reject(e); }
      return;
    }
    // Never hold a process open on a build's account (a runner shutting down after a warm-up);
    // the servers that wait on it stay alive on their own.
    w.unref();
    w.once('message', (m: { ok: boolean; data?: DashboardData; error?: string }) => (m.ok ? resolve(m.data!) : reject(new Error(m.error))));
    w.once('error', reject);
    w.once('exit', code => { if (code !== 0) reject(new Error(`dashboard worker exited with code ${code}`)); });
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
