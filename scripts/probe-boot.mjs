// Headless boot test: spawn the built server over stdio, initialize, list tools.
// Run: node scripts/probe-boot.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, '..', 'dist', 'index.js');
const child = spawn('node', [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '' },
});

let out = '';
child.stdout.on('data', d => { out += d.toString(); });
child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

setTimeout(() => {
  child.kill();
  const lines = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const listResp = lines.find(l => l.id === 2);
  const tools = (listResp?.result?.tools ?? []).map(t => t.name);
  const want = ['fix_finding', 'run_audit', 'query_audit', 'get_dashboard', 'refresh_property'];
  const missing = want.filter(w => !tools.includes(w));
  console.log(`booted: ${lines.some(l => l.id === 1)} | tools: ${tools.length}`);
  console.log('tools:', tools.join(', '));
  if (missing.length) { console.log('MISSING:', missing.join(', ')); process.exit(1); }
  console.log('\nall expected tools present ✓');
  process.exit(0);
}, 2500);
