#!/usr/bin/env node
// SSRF guards (review/14): URLs that come from third parties (competitor pages from a SERP, the
// outbound links on a crawled page, and their redirects) never reach a private or local address,
// and probe_urls only accepts one of the user's own properties as the "own host".
// Local 127.0.0.1 servers stand in for the internal service an attacker would aim at; no network.
// Run:  npm run build:server && node scripts/probe-ssrf.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPublicAddress } from '../dist/core/netGuard.js';
import { fetchCompetitorContent } from '../dist/core/reconResearch.js';
import { checkExternal } from '../dist/core/externalLinks.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// "Internal service": records every request it gets.
const hits = [];
const internal = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>Instance metadata</title></head><body>AccessKeyId AKIAEXAMPLE</body></html>'); });
await new Promise(r => internal.listen(0, '127.0.0.1', r));
const port = internal.address().port;

try {
  // ── Address classification ────────────────────────────────────────────────────────────────
  for (const [ip, want] of [['8.8.8.8', true], ['2606:4700:4700::1111', true], ['127.0.0.1', false], ['169.254.169.254', false], ['10.0.0.5', false],
    ['172.20.1.1', false], ['192.168.1.1', false], ['100.64.0.1', false], ['0.0.0.0', false], ['::1', false], ['fd00::1', false], ['fe80::1', false], ['::ffff:127.0.0.1', false]]) {
    check(`${ip} is ${want ? 'public' : 'refused'}`, isPublicAddress(ip) === want);
  }

  // ── Competitor fetch (recon scrapeCompetitors) ──────────────────────────────────────────────
  for (const u of [`http://127.0.0.1:${port}/latest/meta-data/`, `http://localhost:${port}/latest/meta-data/`, `http://[::1]:${port}/x`]) {
    const r = await fetchCompetitorContent(u, { maxChars: 500 });
    check(`a competitor URL on a local address is refused, not read (${new URL(u).host})`, r.via === 'none' && !r.content && /SSRF guard|private or local/.test(r.error ?? ''), JSON.stringify(r));
  }

  // ── Outbound link check ───────────────────────────────────────────────────────────────────
  const ext = await checkExternal(`http://127.0.0.1:${port}/latest/meta-data/iam/`, { userAgent: 'probe', timeoutMs: 3000, chromeFallback: true });
  check('an outbound link to a local address is not requested, and reads as unverifiable, not broken', ext.verdict === 'unverifiable' && /private address/.test(ext.error ?? ''), JSON.stringify(ext));

  check('the internal service received no request at all', hits.length === 0, JSON.stringify(hits));

  // ── probe_urls: siteUrl must be one of the user's properties ──────────────────────────────
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sac-ssrf-'));
  let child;
  try {
    child = spawn(process.execPath, [path.join(root, 'dist/index.js')], { env: { ...process.env, SAC_DATA_DIR: dataDir, SAC_AUTOSERVE: '0', GOOGLE_APPLICATION_CREDENTIALS: '', DATAFORSEO_USERNAME: '', DATAFORSEO_PASSWORD: '', MAJESTIC_API_KEY: '', CRUX_API_KEY: '' }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const waiters = new Map();
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch { /* not JSON */ } } });
    const rpc = (id, method, params) => new Promise((resolve, reject) => { waiters.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => reject(new Error(`${method} timed out`)), 30000); });
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const r = await rpc(2, 'tools/call', { name: 'probe_urls', arguments: { siteUrl: `http://127.0.0.1:${port}/`, urls: [`http://127.0.0.1:${port}/admin/`] } });
    const text = JSON.stringify(r.result ?? r.error ?? {});
    check('probe_urls refuses a siteUrl that is not one of the user\'s properties', (r.result?.isError === true || !!r.error) && /not a property with local data/.test(text), text.slice(0, 300));
    check('and nothing was requested from that host', hits.length === 0, JSON.stringify(hits));
    child.kill();
  } finally {
    // Wait for the killed child to release its SQLite handle before removing the temp dir;
    // on Windows a still-open handle makes rmSync throw EPERM. Retry, then ignore - it's a
    // temp dir the OS reaps anyway, and a cleanup hiccup must never read as a probe failure.
    if (child && child.exitCode === null) await new Promise(res => { child.once('exit', res); setTimeout(res, 1500); });
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* OS temp dir */ }
  }
} catch (e) {
  fail++;
  console.log(`FAIL  probe threw :: ${e?.stack ?? e}`);
} finally {
  internal.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
