// Read-only preview: run the schema validator over a live DB's real json_ld.
// Usage: node scripts/probe-live-schema.mjs <dbPath>
import Database from 'better-sqlite3';
import { validateJsonLdColumn } from '../dist/audit/schema-validate.js';
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
const rows = db.prepare(`SELECT url_key, json_ld FROM pages WHERE status_code=200 AND json_ld IS NOT NULL AND json_ld!=''`).all();

const byKind = {};
const examples = [];
for (const r of rows) {
  const issues = validateJsonLdColumn(r.json_ld);
  for (const i of issues) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  if (issues.length && examples.length < 12) examples.push({ url: r.url_key.replace('https://houtini.com',''), issues: issues.map(i => `${i.kind}:${i.type ?? ''}:${i.detail}`) });
}
console.log(`pages with json_ld: ${rows.length}`);
console.log('issues by kind:', JSON.stringify(byKind, null, 2));
console.log('\nexamples:');
for (const e of examples) { console.log(`\n  ${e.url}`); for (const i of e.issues) console.log(`    - ${i}`); }
db.close();
