/**
 * SQLite's datetime('now') writes 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker, and
 * Date.parse reads a zone-less date-time as LOCAL time: a cache age or "N days ago" computed from
 * it was off by the host's UTC offset. Parse every stored timestamp through this instead.
 * Accepts a SQLite datetime (UTC), an ISO string (its own zone wins) or a bare date. NaN if absent.
 */
export function parseSqliteUtc(at: string | null | undefined): number {
  if (!at) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return Date.parse(`${at}T00:00:00Z`);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(' ', 'T')}Z`);
}
