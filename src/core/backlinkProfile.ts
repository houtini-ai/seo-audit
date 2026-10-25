/**
 * Backlink-profile helpers (#47): anchor classification and the monthly trend derived from
 * DataForSEO's monthly backlink history (one item per month, despite older notes saying daily). Pure functions, so the panel's numbers are testable.
 */
export type AnchorKind = 'branded' | 'keyword' | 'url' | 'generic' | 'empty';

const GENERIC = new Set([
  'click here', 'here', 'this', 'link', 'website', 'web site', 'site', 'source', 'read more', 'more', 'learn more',
  'visit website', 'visit site', 'homepage', 'home page', 'this website', 'this site', 'this page', 'this link', 'page', 'article',
  'url', 'www', 'http', 'https', 'view', 'details', 'info', 'official website', 'official site', 'continue reading', 'see more', 'go',
]);

/** Brand tokens from a property host: the registrable label(s) without the TLD, lower-case, 3+ chars. */
export function brandTokens(host: string): string[] {
  const labels = host.toLowerCase().replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.');
  // Drop the TLD (and a second-level public suffix such as co.uk / com.au).
  const body = labels.length > 2 && labels[labels.length - 2].length <= 3 ? labels.slice(0, -2) : labels.slice(0, -1);
  return body.filter(l => l.length >= 3);
}

/**
 * Classify an anchor. Order matters: an anchor that is literally a URL counts as `url` even when it
 * contains the brand; a bare brand name (or the brand inside a phrase) is `branded`; stock phrases
 * are `generic`; anything else is `keyword` (what most people mean by "exact / partial match").
 */
export function classifyAnchor(anchor: string | null | undefined, tokens: string[], host?: string): AnchorKind {
  const a = (anchor ?? '').trim();
  if (!a) return 'empty';
  const lower = a.toLowerCase();
  if (/^(https?:\/\/|www\.)/.test(lower) || (host && lower.includes(host.toLowerCase())) || /^[a-z0-9-]+\.[a-z]{2,}(\/|$)/.test(lower)) return 'url';
  if (GENERIC.has(lower)) return 'generic';
  const squashed = lower.replace(/[\s\-_.]/g, '');
  if (tokens.some(t => squashed.includes(t))) return 'branded';
  return 'keyword';
}

export interface HistoryRow { date: string; backlinks: number | null; referring_domains: number | null; new_referring_domains: number | null; lost_referring_domains: number | null; new_backlinks?: number | null; lost_backlinks?: number | null }
export interface MonthRow { month: string; newDomains: number; lostDomains: number; referringDomains: number | null; backlinks: number | null; days: number }

/** Daily history → one row per month: new/lost summed, the stock values taken from the month's last day. */
export function monthlyFromHistory(rows: HistoryRow[]): MonthRow[] {
  const byMonth = new Map<string, MonthRow>();
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const month = r.date.slice(0, 7);
    const m = byMonth.get(month) ?? { month, newDomains: 0, lostDomains: 0, referringDomains: null, backlinks: null, days: 0 };
    m.newDomains += r.new_referring_domains ?? 0;
    m.lostDomains += r.lost_referring_domains ?? 0;
    m.referringDomains = r.referring_domains ?? m.referringDomains;
    m.backlinks = r.backlinks ?? m.backlinks;
    m.days++;
    byMonth.set(month, m);
  }
  return [...byMonth.values()];
}
