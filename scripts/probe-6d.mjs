// 6d: assert entity-internal-link-gap fires from seeded entities/edges/links, and smoke-test
// the live Wikidata client.  node scripts/probe-6d.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { CHECKS } from '../dist/audit/checks.js';
import { WikidataClient } from '../dist/core/WikidataClient.js';
import { urlKey } from '../dist/core/url-key.js';
const k = (u) => urlKey(u, { hostForm: 'apex' });

const dbPath = path.join(tmpdir(), `sac-6d-${Date.now()}.db`);
const adb = new AuditDatabase(dbPath);
const db = adb.db;
db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status) VALUES ('c1','https://x.com','x.com','completed')`).run();
const PARENT = 'https://x.com/seo', CHILD = 'https://x.com/technical-seo', LINKED = 'https://x.com/content-seo';
for (const u of [PARENT, CHILD, LINKED]) db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,indexable) VALUES ('c1',?,?,200,1)`).run(u, k(u));

// entities: SEO (Q-parent), Technical SEO (Q-child, subclass of parent), Content SEO (Q-child2, subclass)
const ent = db.prepare(`INSERT INTO page_entity (url_key,qid,label,source) VALUES (?,?,?,'h1')`);
ent.run(k(PARENT), 'Q1', 'SEO'); ent.run(k(CHILD), 'Q2', 'Technical SEO'); ent.run(k(LINKED), 'Q3', 'Content SEO');
const edge = db.prepare(`INSERT INTO entity_edge (qid,related_qid,relation) VALUES (?,?,?)`);
edge.run('Q2', 'Q1', 'subclass_of'); // Technical SEO subclass of SEO
edge.run('Q3', 'Q1', 'subclass_of'); // Content SEO subclass of SEO
// existing internal link parent -> LINKED (so that pair is NOT flagged); parent -> CHILD is MISSING
db.prepare(`INSERT INTO links (crawl_id,source_url,source_key,target_url,target_key,is_internal) VALUES ('c1',?,?,?,?,1)`).run(PARENT, k(PARENT), LINKED, k(LINKED));

const chk = CHECKS.find(c => c.id === 'entity-internal-link-gap');
const findings = chk.run({ db, gscMaxDate: '2026-06-20' });
let pass = 0, fail = 0;
const got = findings.map(f => `${f.urlKey} -> ${f.evidence.suggestLinkTo}`);
console.log('findings:', JSON.stringify(got));
const want = `${k(PARENT)} -> ${k(CHILD)}`;
const checks = [
  [findings.length === 1, `exactly 1 gap (got ${findings.length})`],
  [got[0] === want, `suggests parent->child missing link (got ${got[0]})`],
  [findings[0]?.evidence.relation === 'subclass_of', 'relation = subclass_of'],
  [chk.certainty === 0.5 && chk.labels.includes('N'), 'check is judgement (N, certainty 0.5, gated)'],
];
for (const [ok, label] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; }

// live Wikidata smoke test (network)
try {
  const wd = new WikidataClient(path.join(tmpdir(), `wd-cache-${Date.now()}.db`));
  const hit = await wd.searchEntity('Douglas Adams');
  const ok = !!hit?.id && /^Q\d+$/.test(hit.id); // resolution works (note: top hit is ambiguous — the very reason this is N/heuristic)
  console.log(`${ok ? 'PASS' : 'FAIL'} live Wikidata search "Douglas Adams" -> ${hit?.id} (${hit?.label})`);
  ok ? pass++ : fail++;
  wd.close();
} catch (e) { console.log(`SKIP live Wikidata (network): ${e.message}`); }

console.log(`\n${pass} passed, ${fail} failed`);
adb.close();
for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true });
