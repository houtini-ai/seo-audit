// Run the full audit against the already-synced ehi database and print the
// prioritised findings, flagging the new checks.  node scripts/run-ehi-audit.mjs
import { runAudit } from '../dist/audit/engine.js';

const dataDir = 'C:\\Users\\Richard Baxter\\Documents\\seo-audit-console';
const site = 'sc-domain:ehi.com.au';
const NEW = new Set(['traffic-decay', 'lost-queries', 'position-slipping', 'index-bloat', 'duplicate-meta-description', 'title-h1-mismatch']);

const t0 = Date.now();
const res = runAudit(dataDir, site, { scope: 'full', includeJudgement: true });
console.log(`run ${res.runId}: ${res.total} findings in ${Date.now() - t0}ms\n`);

console.log('=== Findings by check (★ = new) ===');
for (const c of res.byCheck) {
  const star = NEW.has(c.checkId) ? '★' : ' ';
  console.log(`${star} ${String(c.checkId).padEnd(28)} ${String(c.count).padStart(5)}  ${c.category.padEnd(13)} ${c.severity.padEnd(4)} avgPrio=${c.priority.toFixed(1)}`);
}

console.log('\n=== Top 20 by priority (expected clicks / dev-hour) ===');
for (const f of res.top.slice(0, 20)) {
  const e = JSON.parse(f.effort ?? '{}');
  const ev = JSON.parse(f.evidence ?? '{}');
  const who = f.url_key ?? (ev.url || ev.query || '(site-wide)');
  console.log(`${f.priority.toFixed(1).padStart(9)} ${NEW.has(f.check_id) ? '★' : ' '} ${f.severity.padEnd(4)} ${String(f.check_id).padEnd(26)} T=${String(e.expectedClicks).padStart(7)} hrs=${String(e.hours).padStart(4)}  ${String(who).slice(0, 60)}`);
}

console.log('\n=== Sample evidence from the NEW checks ===');
for (const id of NEW) {
  const hits = res.top.filter(f => f.check_id === id).slice(0, 3);
  const all = res.byCheck.find(c => c.checkId === id);
  console.log(`\n★ ${id}  (${all ? all.count : 0} findings total)`);
  for (const f of hits) console.log(`   ${JSON.stringify(JSON.parse(f.evidence ?? '{}'))}`);
}
