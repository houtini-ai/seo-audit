import path from 'node:path';

/** Turn a GSC property identifier into a safe filename stem. */
export function sanitizeProperty(siteUrl: string): string {
  return siteUrl
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Absolute path to a property's SQLite database (one DB per property). */
export function dbPathFor(dataDir: string, siteUrl: string): string {
  return path.join(dataDir, `${sanitizeProperty(siteUrl)}.db`);
}
