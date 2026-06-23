// Diagnose the GSC freshness cliff: show the daily clicks/impressions tail per site.
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { dbPathFor } from '../dist/core/paths.js';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const sites = ['sc-domain:simracingcockpit.gg', 'sc-domain:ehi.com.au', 'sc-domain:directdrivewheels.com'];

for (const site of sites) {
  const p = dbPathFor(dataDir, site);
  if (!existsSync(p)) { console.log(`\n${site}: NO DB (${p})`); continue; }
  const db = new Database(p, { readonly: true });
  try {
    const span = db.prepare(`SELECT MIN(date) mn, MAX(date) mx, COUNT(DISTINCT date) days FROM search_analytics`).get();
    console.log(`\n${site}: ${span.mn} → ${span.mx} (${span.days} days)`);
    const tail = db.prepare(`SELECT date, SUM(clicks) c, SUM(impressions) i FROM search_analytics WHERE date > date(?, '-9 days') GROUP BY date ORDER BY date`).all(span.mx);
    for (const r of tail) console.log(`  ${r.date}  clicks=${String(r.c).padStart(6)}  impr=${String(r.i).padStart(8)}`);
  } finally { db.close(); }
}
