import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/**
 * Properties the user has hidden: a stray URL-prefix twin, a test property, a client gone. Hidden
 * means left out of the dashboard's domain dropdown and the portfolio, nothing more: the database
 * is untouched and unhiding brings it back (data_storage prune delete-property is the way to remove
 * one for good). Stored in the data dir, so the MCP, the runner and the dashboard sidecar agree.
 */
const FILE = '_dashboard.json';
const filePath = (dataDir: string): string => path.join(dataDir, FILE);

export function hiddenProperties(dataDir: string): Set<string> {
  try {
    const j = JSON.parse(readFileSync(filePath(dataDir), 'utf8')) as { hidden?: unknown };
    return new Set(Array.isArray(j.hidden) ? j.hidden.filter((s): s is string => typeof s === 'string') : []);
  } catch { return new Set(); }
}

/** Hide or unhide one property. Returns the hidden list after the change. */
export function setPropertyHidden(dataDir: string, siteUrl: string, hidden: boolean): string[] {
  const set = hiddenProperties(dataDir);
  if (hidden) set.add(siteUrl); else set.delete(siteUrl);
  const list = [...set].sort();
  // Write then rename: a reader never sees a half-written file.
  const tmp = `${filePath(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ hidden: list }, null, 2));
  renameSync(tmp, filePath(dataDir));
  return list;
}
