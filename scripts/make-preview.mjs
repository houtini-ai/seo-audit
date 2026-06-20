// Build standalone preview HTML(s) from the dashboard bundle + a real data payload.
// Usage: node scripts/make-preview.mjs <payload.json> [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(dir, '..', 'dist', 'src', 'ui', 'dashboard.html');
const payloadPath = process.argv[2];
const outDir = process.argv[3] ?? path.join(dir, '..', 'dist');

let html = fs.readFileSync(htmlPath, 'utf8');
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
// the saved tool-result is the structuredContent (the dashboard data) directly
const data = payload.structuredContent ?? payload;

const out = [];
for (const theme of ['light', 'dark']) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c'); // prevent </script> breakout
  const trap = `<script>addEventListener('error',e=>document.documentElement.setAttribute('data-jserror',(e.message||'')+' @ '+(e.filename||'')+':'+(e.lineno||'')));addEventListener('unhandledrejection',e=>document.documentElement.setAttribute('data-jsreject',String(e.reason&&e.reason.message||e.reason)));</script>`;
  const inject = `${trap}<script>window.__DASH_FIXTURE__=${json};window.__DASH_THEME__=${JSON.stringify(theme)};</script>`;
  // Inject right after <head> — the first <head occurrence is the genuine tag (before
  // any minified bundle), whereas the first <body substring can appear inside a JS string.
  const themed = html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  const f = path.join(outDir, `preview-${theme}.html`);
  fs.writeFileSync(f, themed);
  out.push(f);
  console.log('wrote', f);
}
