#!/usr/bin/env node
// Copyright (c) 2026 Richard Baxter / Houtini — Apache-2.0 (see LICENSE)
//
// Capture the README / manual dashboard screenshots from the fictional demo property.
//
//   npm run build
//   npm run demo:property -- --out <dir>
//   node scripts/demo-screenshots.mjs --data <dir> [--out assets] [--theme light|dark] [--only name,name]
//
// Serves the built dashboard in-process against <dir> (which must hold ONLY the demo database),
// drives it with Playwright at 1440px wide, and writes palette-optimised PNGs into assets/.
// Needs `playwright` (npx playwright install chromium) or a local Chrome; `sharp` for optimisation.
//
// The Content research tab makes live lookups (Google News / DataForSEO). Those handlers are
// replaced here with fictional fixtures so a capture never pulls real third-party content.
import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(arg('--data') ?? path.join(os.tmpdir(), 'sac-demo'));
const OUT = path.resolve(arg('--out') ?? path.join(root, 'assets'));
const THEME = arg('--theme') ?? 'light';
const ONLY = arg('--only')?.split(',');
const WIDTH = 1440;

const dbs = readdirSync(DATA).filter(f => f.endsWith('.db') && !/cache/.test(f));
if (dbs.length !== 1 || !/larchmere/.test(dbs[0])) {
  console.error(`[shots] ${DATA} must hold only the demo property database (found: ${dbs.join(', ') || 'none'})`);
  process.exit(1);
}

const { startDashboardServer } = await import('../dist/core/webServer.js');
const { buildWebCallHandlers } = await import('../dist/core/webHandlers.js');

// Fictional research fixtures (sources and URLs are invented, on reserved .example domains).
const NEWS = [
  ['Autumn storms: how to choose a waterproof that actually keeps you dry', 'Trail Notes', '2 days ago'],
  ['Mountain rescue teams urge walkers to pack a spare layer this autumn', 'Fellwalkers Weekly', '3 days ago'],
  ['PFC-free waterproofs tested: do the new fabrics hold up?', 'Gear Lab UK', '5 days ago'],
  ['The 3-layer vs 2.5-layer debate, settled on a wet weekend in Snowdonia', 'Ridge & River', '1 week ago'],
  ['Reproofing explained: wash-in vs spray-on treatments', 'Outdoor Weekly', '1 week ago'],
  ['Packable jackets for commuters who also walk at weekends', 'Coastal Paths', '2 weeks ago'],
  ['Why hydrostatic head figures are only half the story', 'Kit List Central', '2 weeks ago'],
  ['Repair, not replace: the brands offering free jacket repairs', 'Weekend Wanderers', '3 weeks ago'],
];
const fixtures = {
  news_discovery: async () => ({ articles: NEWS.map(([title, source, timestamp], i) => ({ title, source, timestamp, url: `https://news${i + 1}.example/article`, via: 'fixture' })) }),
  youtube_discovery: async () => ({ videos: NEWS.slice(0, 6).map(([title, channel], i) => ({ title, channel, views: 18_000 - i * 2400, published: `${i + 1} weeks ago`, url: `https://video${i + 1}.example/watch` })) }),
  topic_trend: async (a) => { const kw = (a.keywords ?? [])[0] ?? 'topic'; return { series: Array.from({ length: 52 }, (_, i) => ({ date: `w${i}`, values: { [kw]: Math.round(35 + 40 * Math.max(0, Math.sin((i - 20) / 9))) } })) }; },
  related_terms: async () => ({ peopleAlsoAsk: ['What is the most waterproof jacket?', 'Is 10,000mm waterproof enough for the UK?'], relatedSearches: ['waterproof jacket mens', 'lightweight waterproof jacket'] }),
  keyword_volume: async () => ({ keywords: [{ keyword: 'waterproof jackets', searchVolume: 40500, cpc: 0.62, competition: 1 }] }),
};

const base = buildWebCallHandlers({ dataDir: () => DATA, dfs: null, apiKeys: () => ({ dataforseo: true, majestic: true }) });
const uiHtml = () => readFileSync(path.join(root, 'dist', 'src', 'ui', 'dashboard.html'), 'utf8');
const { url } = await startDashboardServer({ dataDir: () => DATA, uiHtml, call: { ...base, ...fixtures } });
const siteUrl = 'sc-domain:larchmere.example';
const pageUrl = `${url}/dashboard?siteUrl=${encodeURIComponent(siteUrl)}&theme=${THEME}`;
console.error(`[shots] serving ${pageUrl}`);

let chromium;
try { ({ chromium } = await import('playwright')); } catch { console.error('[shots] playwright is not installed: npm i -D playwright (or npx playwright install chromium)'); process.exit(1); }
const browser = await chromium.launch({ channel: process.env.SHOTS_CHANNEL ?? 'chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 1000 }, deviceScaleFactor: 1, colorScheme: THEME });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error' && !/favicon\.ico/.test(m.location()?.url ?? '')) consoleErrors.push(`${m.text()} ${m.location()?.url ?? ''}`); });
page.on('pageerror', e => consoleErrors.push(String(e)));
page.on('response', r => { if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.url()}`); });

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { console.error('[shots] sharp not available - writing unoptimised PNGs'); }

async function open(tab, height) {
  // The sidebar is viewport-tall and sticky, so size the viewport to the capture rather than
  // stitching a full-page screenshot (which would leave the sidebar short).
  await page.setViewportSize({ width: WIDTH, height });
  await page.goto(pageUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('#ovTrendChart canvas', { timeout: 30_000 });
  if (tab !== 'overview') await page.click(`.nav-item[data-panel="${tab}"]`);
  await page.waitForTimeout(tab === 'architecture' ? 6000 : 2200); // force-layout graphs need to settle
}

// shot: { name, tab, height, selector?, extend? (visible sibling cards to include), cap?, before? }
const SHOTS = [
  { name: 'dashboard-overview', tab: 'overview', height: 1500 },
  { name: 'tab-issues', tab: 'issues', height: 1400 },
  { name: 'crawl-health', tab: 'health', height: 1300 },
  { name: 'network', tab: 'architecture', height: 1700 },
  { name: 'tab-network', tab: 'architecture', height: 1000, selector: '[data-panel="architecture"] .chart-card:has(#scatterChart)', extend: 1 },
  { name: 'search-performance', tab: 'search', height: 1250 },
  { name: 'tab-opps', tab: 'opportunities', height: 1000, selector: '[data-panel="opportunities"] .chart-card:has(#quickWinsChart)', extend: 3, cap: 1900 },
  { name: 'content-architecture', tab: 'opportunities', height: 1000, selector: '#topicClustersCard', cap: 1150 },
  { name: 'links', tab: 'links', height: 1210 },
  { name: 'research', tab: 'research', height: 640, before: async () => {
    await page.fill('#researchKw', 'waterproof jackets');
    await page.click('[data-research="news"]');
    await page.waitForSelector('#researchOut table', { timeout: 10_000 });
  } },
];

mkdirSync(OUT, { recursive: true });
const report = [];
for (const s of SHOTS) {
  if (ONLY && !ONLY.includes(s.name)) continue;
  await open(s.tab, s.height);
  if (s.before) await s.before();
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  let clip;
  if (s.selector) {
    const el = page.locator(s.selector).first();
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    // Document coordinates of the card (plus `extend` following visible sibling cards).
    const r = await el.evaluate((n, extend) => {
      let last = n, seen = 0;
      for (let x = n.nextElementSibling; x && seen < (extend ?? 0); x = x.nextElementSibling) if (x.getClientRects().length) { last = x; seen++; }
      const a = n.getBoundingClientRect(), b = last.getBoundingClientRect();
      return { x: a.left, y: a.top + window.scrollY, width: a.width, height: b.bottom - a.top };
    }, s.extend);
    await page.evaluate(() => window.scrollTo(0, 0)); // keep the sticky top bar off the card
    await page.waitForTimeout(300);
    const pad = 16;
    clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: Math.min(r.height + pad * 2, s.cap ?? Infinity) };
  } else {
    clip = { x: 0, y: 0, width: WIDTH, height: s.height };
  }
  let buf = await page.screenshot({ fullPage: !!s.selector, clip });
  if (sharp) buf = await sharp(buf).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toBuffer();
  const file = path.join(OUT, `${s.name}${THEME === 'dark' ? '-dark' : ''}.png`);
  writeFileSync(file, buf);
  report.push({ file: path.relative(root, file), kb: Math.round(buf.length / 1024), overflowX });
}
await browser.close();
console.table(report);
if (consoleErrors.length) { console.error('[shots] console errors:'); for (const e of [...new Set(consoleErrors)]) console.error('  ' + e); }
process.exit(consoleErrors.length ? 2 : 0);
