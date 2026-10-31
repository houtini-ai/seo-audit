// #76: the start-up warning for npx inside a container (the Docker MCP gateway cold-start trap).
// Run: npm run build:server && node scripts/probe-startup-hints.mjs
import { npxInContainerWarning } from '../dist/core/startupHints.js';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupStatus } from '../dist/core/setupStatus.js';

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

// ── review/16: a model finds help and setup problems on its own ─────────────────────────────────
// The server instructions carry this machine's setup line and say to call seo_audit_help first and
// to open dashboardUrl in a built-in browser; seo_audit_help leads with what is configured; the
// credentials errors point to it. Spawns the real server over stdio; no network, no credentials.
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sac-context-'));
  const blank = { GOOGLE_APPLICATION_CREDENTIALS: '', DATAFORSEO_USERNAME: '', DATAFORSEO_PASSWORD: '', MAJESTIC_API_KEY: '', CRUX_API_KEY: '' };
  const session = async (env) => {
    const child = spawn(process.execPath, [path.join(root, 'dist/index.js')], { env: { ...process.env, ...blank, SAC_DATA_DIR: dataDir, SAC_AUTOSERVE: '0', ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const waiters = new Map();
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch { /* not JSON */ } } });
    let id = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => { const n = ++id; waiters.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); setTimeout(() => reject(new Error(`${method} timed out`)), 30000); });
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { init, rpc, close: () => child.kill() };
  };
  try {
    const a = await session({});
    const instr = a.init.result?.instructions ?? '';
    check('instructions carry the setup line (Search Console OFF, and why)', /SETUP AT START: Search Console OFF \(GOOGLE_APPLICATION_CREDENTIALS is not set\)/.test(instr), instr.slice(0, 400));
    check('instructions say to call seo_audit_help first and on credentials errors', /call seo_audit_help/.test(instr) && /first use/.test(instr), '');
    check('instructions tell an agent with a built-in browser to open dashboardUrl there', /built-in browser/.test(instr) && /dashboardUrl/.test(instr), '');
    check('instructions state the siteUrl format', /sc-domain:example\.com or https:\/\/example\.com\//.test(instr), '');
    const list = await a.rpc('tools/list', {});
    const size = JSON.stringify(list.result).length;
    check(`tools/list stays under 80,000 bytes (${size})`, size < 80_000, String(size));
    const tool = (n) => list.result.tools.find(t => t.name === n);
    check('seo_audit_help says when to use it and that it is free', /Start here/.test(tool('seo_audit_help')?.description ?? '') && /Free, local/.test(tool('seo_audit_help')?.description ?? ''), tool('seo_audit_help')?.description);
    check('list_checks describes the registry, not "categories"', !/check categories/.test(tool('list_checks')?.description ?? ''), tool('list_checks')?.description);
    check('refresh_property states its one paid step', /paid DataForSEO Labs rank call/.test(tool('refresh_property')?.description ?? ''), '');
    const help = await a.rpc('tools/call', { name: 'seo_audit_help', arguments: {} });
    const text = help.result?.content?.[0]?.text ?? '';
    check('seo_audit_help leads with the setup on this machine', text.startsWith('## Setup on this machine') && /\*\*Search Console: off\*\*/.test(text) && /client_email/.test(text), text.slice(0, 300));
    const lp = await a.rpc('tools/call', { name: 'list_properties', arguments: {} });
    check('a missing-credentials error points to seo_audit_help', /seo_audit_help/.test(JSON.stringify(lp)), JSON.stringify(lp).slice(0, 300));
    a.close();
    // A service-account key file (fake; never used for a call): Search Console reads as on, with its email.
    const keyFile = path.join(dataDir, 'sa.json');
    writeFileSync(keyFile, JSON.stringify({ type: 'service_account', client_email: 'audit@proj.iam.gserviceaccount.com', private_key: 'x' }));
    const b = await session({ GOOGLE_APPLICATION_CREDENTIALS: keyFile });
    check('with a service-account key the setup line reads Search Console on', /SETUP AT START: Search Console on;/.test(b.init.result?.instructions ?? ''), '');
    b.close();
    check('a placeholder key path reads as off', setupStatus(dataDir, { GOOGLE_APPLICATION_CREDENTIALS: 'C:/path/to/your-service-account.json' }).gsc.ok === false, '');
    check('a missing key file reads as off, with the path', /does not exist/.test(setupStatus(dataDir, { GOOGLE_APPLICATION_CREDENTIALS: '/nope/sa.json' }).gsc.detail), '');
  } catch (e) {
    fail++; console.log(`FAIL  context session threw :: ${e?.stack ?? e}`);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
