// Read-only sanity check of a live DB (safe during an active write — WAL allows readers).
// Usage: node scripts/probe-live-readonly.mjs <dbPath>
import Database from 'better-sqlite3';
const dbPath = process.argv[2];
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const one = sql => db.prepare(sql).get();
const all = sql => db.prepare(sql).all();

console.log('=== pages ===');
console.log(one(`SELECT COUNT(*) total,
  SUM(status_code=200) ok,
  SUM(status_code>=400) errs,
  SUM(indexable=1) indexable,
  SUM(json_ld IS NOT NULL AND json_ld!='') has_jsonld,
  SUM(images_without_alt>0) pages_missing_alt,
  SUM(canonical_count>1) multi_canonical,
  SUM(canonical_relative=1) rel_canonical,
  SUM(image_count) total_imgs,
  SUM(images_without_alt) total_missing_alt
  FROM pages`));

console.log('\n=== sample pages (new columns) ===');
for (const r of all(`SELECT substr(url_key,1,55) url, status_code st, image_count img, images_without_alt noalt, canonical_count cc, canonical_relative cr, (json_ld IS NOT NULL) ld FROM pages ORDER BY inlink_count DESC LIMIT 8`)) {
  console.log(`  ${r.st} img=${r.img} noalt=${r.noalt} canon=${r.cc} rel=${r.cr} ld=${r.ld}  ${r.url}`);
}

console.log('\n=== GSC search_analytics ===');
console.log(one(`SELECT COUNT(*) rows, MIN(date) min_d, MAX(date) max_d, COUNT(DISTINCT page_key) pages, COUNT(DISTINCT query) queries FROM search_analytics`));

console.log('\n=== url_inspection (in progress) ===');
console.log(one(`SELECT COUNT(*) inspected FROM url_inspection`));

console.log('\n=== rank_history (DataForSEO) ===');
console.log(one(`SELECT COUNT(*) periods, MIN(period) min_p, MAX(period) max_p, SUM(keyword_count) kw FROM rank_history`));

db.close();
