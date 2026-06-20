// Verify AuditDatabase.migrate() adds columns to a pre-existing DB. Run: node scripts/probe-migrate.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';

const p = path.join(tmpdir(), `sac-migrate-${process.pid}.db`);
rmSync(p, { force: true });
const need = ['image_count', 'images_without_alt', 'canonical_count', 'canonical_relative'];

// Build the CURRENT schema, then simulate an OLD DB by dropping the new columns + seeding a row.
const seed = new AuditDatabase(p);
seed.db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain) VALUES ('c1','https://x','x')`).run();
seed.db.prepare(`INSERT INTO pages (crawl_id, url, url_key, status_code) VALUES ('c1','https://x/','https://x/',200)`).run();
for (const col of need) seed.db.exec(`ALTER TABLE pages DROP COLUMN ${col}`);
seed.close();

// Reopen via AuditDatabase → migrate() should ALTER the new columns back, preserving data.
const w = new AuditDatabase(p);
const cols = w.db.prepare('PRAGMA table_info(pages)').all().map(c => c.name);
const colsOk = need.every(n => cols.includes(n));
const rowOk = w.db.prepare('SELECT COUNT(*) c FROM pages').get().c === 1;
w.close();
rmSync(p, { force: true });
console.log('migrated columns present:', colsOk, '| existing row preserved:', rowOk);
process.exit(colsOk && rowOk ? 0 : 1);
