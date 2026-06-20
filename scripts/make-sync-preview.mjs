// Build standalone preview HTMLs of the sync-progress widget for a few phase states.
// Usage: node scripts/make-sync-preview.mjs [theme]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(dir, '..', 'dist', 'src', 'ui', 'sync-progress.html');
const outDir = path.join(dir, '..', 'dist');
const theme = process.argv[2] ?? 'light';
const html = fs.readFileSync(htmlPath, 'utf8');
const ago = s => new Date(Date.now() - s * 1000).toISOString();

const site = 'sc-domain:simracingcockpit.gg';
const fixtures = {
  gsc: { id: 'a1b2c3', state: 'running', startedAt: ago(95), siteUrl: site, progress: { phase: 'gsc', siteUrl: site, rowsFetched: 725000 } },
  crawl: { id: 'a1b2c3', state: 'running', startedAt: ago(240), siteUrl: site, progress: { phase: 'crawl', siteUrl: site, rowsFetched: 912000, crawled: 240, discovered: 400, failed: 2 } },
  inspect: { id: 'a1b2c3', state: 'running', startedAt: ago(300), siteUrl: site, progress: { phase: 'inspect', siteUrl: site, inspected: 22 } },
  done: { id: 'a1b2c3', state: 'completed', startedAt: ago(380), siteUrl: site, progress: { phase: 'done', siteUrl: site }, result: { gsc: { rowsFetched: 912000, startDate: '2026-03-22', endDate: '2026-06-20' }, crawl: { crawled: 400, failed: 2 }, inspect: { inspected: 50 }, ranks: { periods: 6, cost: 0.106 } } },
};

for (const [name, fx] of Object.entries(fixtures)) {
  const json = JSON.stringify(fx).replace(/</g, '\\u003c');
  const inject = `<script>window.__SYNC_FIXTURE__=${json};window.__SYNC_THEME__=${JSON.stringify(theme)};</script>`;
  const out = html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  const f = path.join(outDir, `sync-${name}-${theme}.html`);
  fs.writeFileSync(f, out);
  console.log('wrote', path.basename(f));
}
