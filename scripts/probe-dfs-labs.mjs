// Validate the new DataForSEO endpoints (search_intent, competitors_domain,
// page_intersection, lighthouse) against a real domain. Usage:
//   node scripts/probe-dfs-labs.mjs <domain> [url]
// Creds: env DATAFORSEO_USERNAME/PASSWORD, else read from the Claude Desktop config
// (so secrets are never typed on the command line or committed).
import { homedir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { DataForSeoClient } from '../dist/core/DataForSeoClient.js';

function creds() {
  let user = process.env.DATAFORSEO_USERNAME, pass = process.env.DATAFORSEO_PASSWORD;
  if (user && pass) return { user, pass };
  const cfg = path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json');
  const env = JSON.parse(readFileSync(cfg, 'utf-8'))?.mcpServers?.['seo-audit-console']?.env ?? {};
  return { user: env.DATAFORSEO_USERNAME, pass: env.DATAFORSEO_PASSWORD };
}

const domain = process.argv[2] ?? 'simracingcockpit.gg';
const url = process.argv[3] ?? `https://${domain}/`;
const { user, pass } = creds();
if (!user || !pass) { console.error('No DataForSEO creds (env or config).'); process.exit(1); }

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const dfs = new DataForSeoClient(user, pass, path.join(dataDir, 'dataforseo-cache.db'), 20);
const money = (r) => (r.cached ? 'cached' : `live $${r.cost.toFixed(4)}`);

try {
  console.log('\n=== search_intent ===');
  const si = await dfs.searchIntent(['buy racing wheel', 'how to set up a sim rig', 'best sim racing cockpit'], 'en');
  console.log(money(si));
  for (const it of si.tasks[0]?.result?.[0]?.items ?? [])
    console.log(`  ${it.keyword} -> ${it.keyword_intent?.label} (${it.keyword_intent?.probability})`);

  console.log('\n=== competitors_domain ===');
  const cd = await dfs.competitorsDomain(domain, 'United Kingdom', 'en', 8);
  console.log(money(cd));
  for (const it of cd.tasks[0]?.result?.[0]?.items ?? [])
    console.log(`  ${it.domain} — ${it.intersections} shared kw, ${it.full_domain_metrics?.organic?.count ?? '?'} organic kw`);

  console.log('\n=== page_intersection (vs top competitor) ===');
  const top = (cd.tasks[0]?.result?.[0]?.items ?? [])
    .map((it) => it.domain)
    .find((d) => d && d.replace(/^www\./, '') !== domain); // skip the target itself
  if (top) {
    const pi = await dfs.pageIntersection([`https://${top}/*`], [`${url}*`], 'United Kingdom', 'en', 10);
    console.log(money(pi));
    for (const it of pi.tasks[0]?.result?.[0]?.items ?? [])
      console.log(`  ${it.keyword_data?.keyword} (vol ${it.keyword_data?.keyword_info?.search_volume ?? '?'})`);
  } else console.log('  no competitor to compare');

  console.log('\n=== lighthouse ===');
  const lh = await dfs.lighthouse(url, true);
  const res = lh.tasks[0]?.result?.[0];
  if (res?.categories) {
    console.log(money(lh));
    console.log(`  performance ${Math.round((res.categories.performance?.score ?? 0) * 100)}/100`);
    console.log(`  LCP ${res.audits?.['largest-contentful-paint']?.displayValue ?? '?'}, CLS ${res.audits?.['cumulative-layout-shift']?.displayValue ?? '?'}`);
  } else {
    console.log('  lighthouse returned no categories — task:', JSON.stringify(lh.tasks[0]?.status_code, null, 0), lh.tasks[0]?.status_message);
  }
} catch (e) {
  console.error('PROBE ERROR:', e.message);
} finally {
  dfs.close();
}
