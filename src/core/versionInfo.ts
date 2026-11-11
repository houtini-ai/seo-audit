import { readFileSync, statSync } from 'node:fs';

// The "which code am I actually running?" line for seo_audit_help (myminingrig dev channel, BUG-4).
// A process keeps the code it started with, so after a rebuild (or an npm update) the running
// version and the one on disk can differ, and nothing else in a tool result says so. We compare
// what this process loaded at start with what is on disk NOW: a newer package.json version, or a
// build file modified after the process started, means a restart is needed to load it.

export interface VersionInfo {
  running: string;           // version this process loaded at start
  onDisk: string | null;     // version in package.json right now (null if unreadable)
  builtAt: string | null;    // ISO mtime of the build file this process loaded from
  startedAt: string;         // ISO process start
  restartNeeded: boolean;    // a newer build is on disk than the code this process runs
}

export function versionInfo(running: string, packageJsonUrl: URL, buildFileUrl: URL, now = Date.now()): VersionInfo {
  const startedMs = now - process.uptime() * 1000;
  let onDisk: string | null = null;
  try { onDisk = (JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as { version?: string }).version ?? null; } catch { /* unreadable */ }
  let builtMs: number | null = null;
  try { builtMs = statSync(buildFileUrl).mtimeMs; } catch { /* unreadable */ }
  // 60 s of slack: the build file is written just before a process that starts straight after it.
  const rebuiltSinceStart = builtMs !== null && builtMs > startedMs + 60_000;
  return {
    running,
    onDisk,
    builtAt: builtMs !== null ? new Date(builtMs).toISOString() : null,
    startedAt: new Date(startedMs).toISOString(),
    restartNeeded: (onDisk !== null && onDisk !== running) || rebuiltSinceStart,
  };
}

const minute = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown');

export function versionLine(v: VersionInfo): string {
  const base = `Version: ${v.running} (build ${minute(v.builtAt)}; this process started ${minute(v.startedAt)})`;
  if (!v.restartNeeded) return base;
  const what = v.onDisk && v.onDisk !== v.running ? `version ${v.onDisk}` : 'a newer build';
  return `${base}\nRESTART NEEDED: ${what} is on disk, but this process is still running the code it started with. Restart the MCP client (or start a new session) to load it.`;
}
