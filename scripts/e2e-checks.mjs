// E2E: run EVERY registered check against each test site and report count + any error.
// Confirms each check returns evidence-or-empty (an array) without throwing.
import { listChecks, runSingleCheck } from '../dist/audit/engine.js';
import { homedir } from 'node:os';
import path from 'node:path';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const sites = ['sc-domain:simracingcockpit.gg', 'sc-domain:ehi.com.au', 'sc-domain:directdrivewheels.com'];
const checks = listChecks();
console.log(`${checks.length} checks × ${sites.length} sites\n`);

let errors = 0, nonArray = 0;
for (const site of sites) {
  const t0 = Date.now();
  let withFindings = 0, empty = 0;
  const problems = [];
  for (const chk of checks) {
    try {
      const res = runSingleCheck(dataDir, site, chk.id, 5);
      if (!Array.isArray(res.findings)) { nonArray++; problems.push(`${chk.id}: NOT AN ARRAY`); continue; }
      // sanity: every finding must be an object with an evidence field (urlKey may be null)
      const bad = res.findings.find(f => typeof f !== 'object' || f === null || !('evidence' in f));
      if (bad) problems.push(`${chk.id}: malformed finding ${JSON.stringify(bad).slice(0, 80)}`);
      res.findings.length ? withFindings++ : empty++;
    } catch (e) { errors++; problems.push(`${chk.id}: THREW ${e.message}`); }
  }
  console.log(`${site}: ${withFindings} checks with findings, ${empty} empty  (${Date.now() - t0}ms)`);
  if (problems.length) { console.log('  PROBLEMS:'); for (const p of problems) console.log('   - ' + p); }
}
console.log(`\nTOTAL: ${errors} errors, ${nonArray} non-array returns across ${checks.length * sites.length} runs`);
