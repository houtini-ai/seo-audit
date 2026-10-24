// #76: the start-up warning for npx inside a container (the Docker MCP gateway cold-start trap).
// Run: npm run build:server && node scripts/probe-startup-hints.mjs
import { npxInContainerWarning } from '../dist/core/startupHints.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };

const npxPath = '/root/.npm/_npx/9f1c2ab4e7d3/node_modules/@houtini/seo-audit-console/dist/index.js';
const npxBin = '/root/.npm/_npx/9f1c2ab4e7d3/node_modules/.bin/seo-audit-console';
const globalPath = '/usr/local/lib/node_modules/@houtini/seo-audit-console/dist/index.js';
const winNpx = 'C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\9f1c\\node_modules\\@houtini\\seo-audit-console\\dist\\index.js';

const w = npxInContainerWarning(npxPath, true);
check('npx inside a container warns', !!w, String(w));
check('...and names the fix and the README section', /preinstalled/.test(w ?? '') && /longLived: true/.test(w ?? '') && /Docker MCP gateway/.test(w ?? ''), String(w));
check('the npx .bin path warns too', !!npxInContainerWarning(npxBin, true), 'null');
check('a prebuilt image (global install) does not warn', npxInContainerWarning(globalPath, true) === null, 'warned');
check('npx outside a container does not warn (Claude Desktop, Claude Code)', npxInContainerWarning(winNpx, false) === null && npxInContainerWarning(npxPath, false) === null, 'warned');
check('a local build does not warn', npxInContainerWarning('/app/dist/index.js', true) === null, 'warned');
check('a path merely containing "npx" does not warn', npxInContainerWarning('/srv/mynpx-tools/dist/index.js', true) === null, 'warned');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
