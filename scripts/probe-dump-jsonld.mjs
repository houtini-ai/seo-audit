// Dump raw json_ld for a given page substring. Usage: node scripts/probe-dump-jsonld.mjs <dbPath> <urlSubstr>
import Database from 'better-sqlite3';
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
const row = db.prepare(`SELECT url_key, json_ld FROM pages WHERE url_key LIKE ? AND json_ld IS NOT NULL LIMIT 1`).get(`%${process.argv[3]}%`);
if (!row) { console.log('no match'); process.exit(0); }
console.log('URL:', row.url_key, '\n');
const blocks = JSON.parse(row.json_ld);
blocks.forEach((b, i) => {
  console.log(`--- block ${i} ---`);
  try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.log('(unparseable)', b.slice(0, 200)); }
});
db.close();
