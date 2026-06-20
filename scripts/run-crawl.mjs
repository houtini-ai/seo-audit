// Run a crawl directly via the compiled Crawler (bypasses the live MCP — useful for
// testing crawler changes without a Desktop restart). Usage:
//   node scripts/run-crawl.mjs <siteUrl> [maxPages]
import { homedir } from 'node:os';
import path from 'node:path';
import { Crawler } from '../dist/core/Crawler.js';

const siteUrl = process.argv[2];
const maxPages = Number(process.argv[3]) || 200;
const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'seo-audits', 'seo-audit-console');

const crawler = new Crawler(dataDir);
const ac = new AbortController();
const r = await crawler.run(siteUrl, { maxPages }, p => process.stdout.write(`\r  crawled ${p.crawled ?? 0}/${p.discovered ?? 0}   `), ac.signal);
console.log('\n', JSON.stringify(r));
