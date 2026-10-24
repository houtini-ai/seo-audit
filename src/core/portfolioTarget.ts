/**
 * The ONE property → DataForSEO target derivation (portfolio spec v1.1, blocker 3). RankTracker and
 * the portfolio both use it, so the property dashboard and the portfolio query the same target and
 * share one cached historical_rank_overview response instead of paying twice.
 *
 *   sc-domain:example.com      → example.com
 *   https://www.example.com/   → example.com   (Semrush reports root domains; www is not a separate site)
 *   https://shop.example.com/  → shop.example.com (a real subdomain property stays a subdomain)
 *   http://example.com:8080/x  → example.com
 */
export function targetForProperty(siteUrl: string): string {
  const s = siteUrl.trim();
  if (/^sc-domain:/i.test(s)) return normaliseDomain(s.replace(/^sc-domain:/i, ''));
  try { return normaliseDomain(new URL(s).hostname); } catch { return normaliseDomain(s); }
}

/** Lower-case, no scheme/path/port, no leading `www.`, no trailing dot. */
export function normaliseDomain(input: string): string {
  let d = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  return d.replace(/^www\./, '');
}

// RFC 1123 labels, at least one dot, ≤253 chars. Rejects IPs-with-ports, paths, spaces, and anything
// that isn't a hostname a user could mean as a website.
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
export function isValidDomain(d: string): boolean {
  if (!d || d.length > 253 || !d.includes('.')) return false;
  const labels = d.split('.');
  if (labels.some(l => !LABEL.test(l))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]); // a numeric TLD means an IP address
}
