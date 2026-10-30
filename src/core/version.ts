import { readFileSync } from 'node:fs';

/** This package's version (from package.json, never hardcoded), or null if it can't be read.
 * Printed docker commands pin it, so a copy-pasted sidecar runs the same release as the server. */
export const PACKAGE_VERSION: string | null = ((): string | null => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? null;
  } catch { return null; }
})();

/** `@houtini/seo-audit-console@<this version>` for an npx -p argument. */
export const pinnedPackage = (version: string | null = PACKAGE_VERSION): string => `@houtini/seo-audit-console${version ? `@${version}` : ''}`;
