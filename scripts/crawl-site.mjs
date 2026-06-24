// Crawl a site with the freshly-built local Crawler (populates body_chunks, which the running
// MCP server's older build doesn't). Usage: node scripts/crawl-site.mjs <siteUrl>
import { Crawler } from '../dist/core/Crawler.js';
import { homedir } from 'node:os';
import path from 'node:path';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const site = process.argv[2] ?? 'sc-domain:directdrivewheels.com';
const c = new Crawler(dataDir);
const t0 = Date.now();
const res = await c.run(site, {}, p => process.stdout.write(`\r  ${p.crawled}/${p.discovered}   `), new AbortController().signal);
console.log(`\ndone in ${Date.now() - t0}ms:`, JSON.stringify(res));
