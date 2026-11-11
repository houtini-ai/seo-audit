// Affiliate tracking links (myminingrig dev channel, OBS-4). A link through an affiliate network
// redirects BY DESIGN: the hop is how the network records the click, so "update the link to its
// final URL" would break attribution. external-redirected leaves these out (and says so in its
// fix text). Host matching is exact-or-subdomain, never substring (see CLAUDE.md: x.com/pimax.com).

/** Affiliate-network redirect hosts. A link on one of these (or a subdomain) is a tracking link. */
export const AFFILIATE_HOSTS = [
  'sjv.io', 'pxf.io', 'ojrq.net', 'evyy.net', '7eer.net', 'r2ef.net',   // Impact
  'go.skimresources.com', 'go.redirectingat.com',                       // Skimlinks
  'click.linksynergy.com', 'linksynergy.com',                            // Rakuten
  'awin1.com',                                                           // Awin
  'shareasale.com', 'shareasale-analytics.com',                          // ShareASale
  'anrdoezrs.net', 'jdoqocy.com', 'tkqlhce.com', 'dpbolvw.net', 'kqzyfj.com', 'qksrv.net', // CJ
  'prf.hn',                                                              // Partnerize
  'amzn.to', 'amzn.eu',                                                  // Amazon Associates short links
  'tradedoubler.com', 'webgains.com', 'avantlink.com', 'pntra.com', 'pjtra.com', 'pjatr.com', 'gopjn.com',
  'howl.me', 'geni.us',
];

const hostMatch = (host: string, domains: string[]): boolean => {
  const h = host.toLowerCase().replace(/^www\./, '');
  return domains.some(d => h === d || h.endsWith(`.${d}`));
};

const DEST_PARAMS = ['u', 'url', 'murl', 'dest', 'destination', 'ued', 'redirect', 'redirect_url'];
const bareHost = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '');
const hostPath = (u: URL) => bareHost(u) + u.pathname.replace(/\/+$/, '');

/**
 * True when an outbound redirect is an affiliate tracking hop, judged from bytes we hold:
 * the target is on a known affiliate-network host; or it has an /aff/ or /go/ path and lands on
 * another site; or it carries its destination in a query parameter (u=, url=, ...) naming the
 * same page it finally lands on.
 */
export function isAffiliateRedirect(target: string, finalUrl: string | null): boolean {
  let t: URL;
  try { t = new URL(target); } catch { return false; }
  if (hostMatch(t.hostname, AFFILIATE_HOSTS)) return true;
  let f: URL | null = null;
  try { f = finalUrl ? new URL(finalUrl) : null; } catch { /* unparseable */ }
  if (!f) return false;
  if (/\/(aff|affiliate|go)\//i.test(t.pathname) && bareHost(f) !== bareHost(t)) return true;
  for (const p of DEST_PARAMS) {
    const v = t.searchParams.get(p);
    if (!v) continue;
    try { if (hostPath(new URL(v)) === hostPath(f)) return true; } catch { /* not a URL */ }
  }
  return false;
}
