// Probe (0.16.1): dashboard links under Docker. Inside a container whose dashboard binds a random,
// unpublished port, the advertised http://127.0.0.1:<port> is unreachable from the host, so the
// server must not present it as openable; on bare metal nothing changes.
// Run: node scripts/probe-dashboard-container.mjs   (after npm run build:server). No network.
import { readFileSync } from 'node:fs';
import { inContainer, dashboardReachable, containerDashboardNote, dashboardSidecarCmd, VOLUME_PLACEHOLDER } from '../dist/core/webServer.js';

const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };

/** A fake filesystem + env: `files` maps path -> contents (null = exists but unreadable). */
const probe = (env = {}, files = {}) => ({
  env,
  exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
  read: (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null),
});

// ── Detection ──
check('bare metal: not a container', !inContainer(probe({ SAC_DATA_DIR: 'C:\\Users\\me\\.seo-audit' })), 'detected a container');
check('bare metal: reachable', dashboardReachable(probe()), 'bare metal marked unreachable');
check('/.dockerenv => container', inContainer(probe({}, { '/.dockerenv': '' })), 'missed /.dockerenv');
check('docker cgroup => container', inContainer(probe({}, { '/proc/1/cgroup': '0::/docker/abc123\n' })), 'missed docker cgroup');
check('plain host cgroup => not a container', !inContainer(probe({}, { '/proc/1/cgroup': '0::/init.scope\n' })), 'host cgroup read as container');
check('podman /run/.containerenv => container', inContainer(probe({}, { '/run/.containerenv': '' })), 'missed podman');
check('bare-metal Linux with SAC_DATA_DIR=/data => NOT a container', !inContainer(probe({ SAC_DATA_DIR: '/data' })), 'a /data data dir alone must not hide a working link');

// ── Reachability inside a container ──
const docker = { '/.dockerenv': '' };
check('gateway worker (random port): unreachable', !dashboardReachable(probe({ SAC_DATA_DIR: '/data' }, docker)), 'random port marked reachable');
check('published fixed port: reachable', dashboardReachable(probe({ SAC_DASHBOARD_BIND: '0.0.0.0', SAC_DASHBOARD_PORT: '8788' }, docker)), 'sidecar marked unreachable');
check('port without 0.0.0.0 bind: unreachable', !dashboardReachable(probe({ SAC_DASHBOARD_PORT: '8788' }, docker)), 'loopback-only bind marked reachable');
check('bind without port: unreachable', !dashboardReachable(probe({ SAC_DASHBOARD_BIND: '0.0.0.0' }, docker)), 'random port marked reachable');
check('explicit SAC_DASHBOARD_URL_HOST: reachable', dashboardReachable(probe({ SAC_DASHBOARD_URL_HOST: 'host.example' }, docker)), 'operator override ignored');

// ── The message ──
const note = containerDashboardNote('sc-domain:example.com', 'http://127.0.0.1:40123/dashboard?siteUrl=sc-domain%3Aexample.com');
check('note says it only works inside the container', /only works inside it/.test(note), note);
check('note carries the sidecar docker run', note.includes(dashboardSidecarCmd()) && /node:22-slim npx -y -p @houtini\/seo-audit-console@\d+\.\d+\.\d+ seo-audit-dashboard/.test(note), note);
check('the sidecar is pinned to this package version', dashboardSidecarCmd().includes(`@houtini/seo-audit-console@${pkgVersion} `), dashboardSidecarCmd());
check('the volume is a named placeholder, never a guessed name', note.includes(`-v ${VOLUME_PLACEHOLDER}:/data`) && !note.includes('seo-audit-data:/data') && /can't see its name/.test(note), note);
check('note offers get_dashboard', /get_dashboard for sc-domain:example\.com/.test(note), note);
check('note gives the sidecar URL for the property', note.includes('http://127.0.0.1:8788/dashboard?siteUrl=sc-domain%3Aexample.com'), note);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
