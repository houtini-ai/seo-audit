import Database from 'better-sqlite3';
import { runSingleCheck } from '../dist/audit/engine.js';
import { dbPathFor } from '../dist/core/paths.js';
import { homedir } from 'node:os';
import path from 'node:path';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const site = process.argv[2] ?? 'sc-domain:directdrivewheels.com';

const db = new Database(dbPathFor(dataDir, site), { readonly: true });
const total = db.prepare('SELECT COUNT(*) c FROM pages').get().c;
const withChunks = db.prepare('SELECT COUNT(*) c FROM pages WHERE body_chunks IS NOT NULL').get().c;
const sample = db.prepare("SELECT url_key, body_chunks bc FROM pages WHERE body_chunks IS NOT NULL ORDER BY length(body_chunks) DESC LIMIT 1").get();
console.log(`pages=${total}, with body_chunks=${withChunks}`);
if (sample) {
  const ch = JSON.parse(sample.bc);
  console.log(`sample: ${sample.url_key} → ${ch.length} chunks`);
  console.log('  chunk[0]:', JSON.stringify(ch[0]).slice(0, 260));
  console.log('  chunk[1]:', JSON.stringify(ch[1] ?? {}).slice(0, 260));
}
db.close();

for (const id of ['body-missing-top-query', 'poor-chunkability', 'rag-answer-gap', 'low-extractability']) {
  const r = runSingleCheck(dataDir, site, id, 4);
  console.log(`\n${id}: ${r.findings.length} findings`);
  for (const f of r.findings.slice(0, 3)) console.log('  ', (f.urlKey || '(site)').replace(/^https?:\/\/[^/]+/, '') || '/', '·', JSON.stringify(f.evidence).slice(0, 160));
}
