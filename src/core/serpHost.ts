/**
 * Which site an organic SERP result belongs to. Since at least 10 Nov 2026 DataForSEO's
 * google/organic/live/advanced returns EVERY organic item with `domain: "google.com"` and a
 * `https://google.com/goto?url=...` redirect as its `url` (verified on all 46 cached SERPs and a live
 * depth-100 call on 27 Nov 2026, scripts/fixtures/portfolio/serp_organic_depth100.json). The result's
 * own host is only in `breadcrumb` ("https://simracingcockpit.gg › best-sim-rigs..."), and for
 * platform results (videos, social posts, Q&A) the breadcrumb is "10.5K+ views · 5 months ago" and
 * the platform is the first part of `website_name` ("YouTube · Sim Tourist").
 *
 * Reading `domain` as-is attributes every result to google.com, so a site that ranks reads as absent.
 */

/** A Google redirect wrapper rather than the result's own URL. */
export const isGoogleRedirect = (url: unknown): boolean =>
  typeof url === 'string' && /^https?:\/\/(www\.)?google\.[a-z.]+\/(goto|url)\b/i.test(url);

/** website_name prefix → the platform's host. Only platforms seen in real responses (cache, Nov 2026)
 * plus a few of the same kind; anything else stays unattributed rather than guessed. */
const PLATFORM_HOSTS: Record<string, string> = {
  youtube: 'youtube.com', facebook: 'facebook.com', reddit: 'reddit.com', instagram: 'instagram.com',
  quora: 'quora.com', tiktok: 'tiktok.com', medium: 'medium.com', linkedin: 'linkedin.com',
  pinterest: 'pinterest.com', x: 'x.com', twitter: 'x.com',
};

const bareHost = (h: string): string => h.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

export interface OrganicHost {
  /** The result's host without `www.`, or null when nothing in the item names it. */
  host: string | null;
  /** Where the host came from: the item's own domain/url, its breadcrumb, or the platform label. */
  via: 'domain' | 'breadcrumb' | 'platform' | null;
  /** The result's own URL when DataForSEO gave one (never the Google redirect). */
  url: string | null;
  /** What Google showed in place of the URL (breadcrumb, else website_name): for display only. */
  shownAs: string | null;
}

export function organicHost(item: any): OrganicHost {
  const breadcrumb = typeof item?.breadcrumb === 'string' ? item.breadcrumb.trim() : '';
  const site = typeof item?.website_name === 'string' ? item.website_name.trim() : '';
  const shownAs = breadcrumb || site || null;
  const rawUrl = typeof item?.url === 'string' ? item.url : '';
  const redirect = isGoogleRedirect(rawUrl);
  const url = rawUrl && !redirect ? rawUrl : null;
  const domain = typeof item?.domain === 'string' ? bareHost(item.domain) : '';
  // A real (non-redirect) URL decides first: with resolve_goto_urls the url is the destination, and
  // `domain` may still say google.com. Then the item's own domain, unless it is the redirect's google.com.
  if (url) {
    try { return { host: bareHost(new URL(url).hostname), via: 'domain', url, shownAs }; } catch { /* fall through */ }
  }
  if (domain && !(redirect && /^google\.[a-z.]+$/.test(domain))) return { host: domain, via: 'domain', url, shownAs };
  const m = /^https?:\/\/([^\s/›]+)/i.exec(breadcrumb);
  // A host cut short by Google ("..." / "…") is not a host.
  if (m && !/\.\.\.|…/.test(m[1])) return { host: bareHost(m[1]), via: 'breadcrumb', url, shownAs };
  const platform = site.split('·')[0].trim().toLowerCase();
  if (PLATFORM_HOSTS[platform]) return { host: PLATFORM_HOSTS[platform], via: 'platform', url, shownAs };
  return { host: null, via: null, url, shownAs };
}

/** A `source` label that is itself a hostname ("SIMRACINGCOCKPIT.gg", "www.youtube.com"), not a brand name ("IGN"). */
const HOST_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * The site behind an AI Overview reference. Redirect-wrapped references (domain google.com, a goto
 * URL) still carry a `source` label: a hostname for some ("SIMRACINGCOCKPIT.gg"), a platform name
 * ("YouTube", "Reddit") or a publication name ("IGN", "NVIDIA Blog") for others. Hostnames and known
 * platforms are attributed; a publication name is not guessed (host null).
 */
export function referenceHost(ref: any): { host: string | null; url: string | null; shownAs: string | null } {
  const rawUrl = typeof ref?.url === 'string' ? ref.url : '';
  const redirect = isGoogleRedirect(rawUrl);
  const url = rawUrl && !redirect ? rawUrl : null;
  const source = typeof ref?.source === 'string' ? ref.source.trim() : '';
  const shownAs = source || null;
  const domain = typeof ref?.domain === 'string' ? bareHost(ref.domain) : '';
  if (url) { try { return { host: bareHost(new URL(url).hostname), url, shownAs }; } catch { /* fall through */ } }
  if (domain && !(redirect && /^google\.[a-z.]+$/.test(domain))) return { host: domain, url, shownAs };
  if (HOST_LIKE.test(source)) return { host: bareHost(source), url, shownAs };
  const platform = source.split('·')[0].trim().toLowerCase();
  if (PLATFORM_HOSTS[platform]) return { host: PLATFORM_HOSTS[platform], url, shownAs };
  return { host: null, url, shownAs };
}

/** Exact host or a subdomain of it, never a substring ("x.com" must not match "pimax.com"). */
export function hostMatchesDomain(host: string | null, domain: string): boolean {
  if (!host || !domain) return false;
  const h = bareHost(host), d = bareHost(domain);
  return h === d || h.endsWith(`.${d}`);
}

/** A Vertex AI grounding redirect (Gemini citations): opaque, never the source. */
export const isGroundingRedirect = (url: unknown): boolean =>
  typeof url === 'string' && /^https?:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i.test(url);

const looksLikeHost = (s: string): boolean => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(s);

export interface CitationSource {
  /** The cited source's host without `www.`, or null when nothing in the citation names it. */
  host: string | null;
  /** Where the host came from. 'title' = Gemini's title, which is the source domain when the URL is a redirect. */
  via: 'direct_url' | 'url' | 'domain' | 'title' | null;
  /** The source's own URL (never a redirect), tracking param utm_source=openai removed; null when only a redirect was given. */
  url: string | null;
}

/**
 * Which site an AI answer cites. The same redirect problem as organic results, in other shapes
 * (live captures 27 Nov 2026, scripts/fixtures/portfolio/ai_panel_*.json):
 *  - Gemini (LLM Responses): `url` is a vertexaisearch grounding-api-redirect; the source is
 *    `direct_url`, and `title` is the source domain.
 *  - ChatGPT: `url` is the source with `?utm_source=openai` appended.
 *  - Claude / Perplexity: `url` is the source.
 *  - Google AI Mode references: `domain` and `url` are the real source (no google.com/goto wrapper
 *    there, unlike organic items); handled anyway if one ever appears.
 * Anything that leaves the host unreadable stays null (counted as unattributed), never guessed.
 */
export function citationSource(c: { url?: unknown; direct_url?: unknown; domain?: unknown; title?: unknown }): CitationSource {
  const clean = (u: string): string => {
    try { const x = new URL(u); x.searchParams.delete('utm_source'); return x.toString(); } catch { return u; }
  };
  const hostOf = (u: unknown): string | null => {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u) || isGoogleRedirect(u) || isGroundingRedirect(u)) return null;
    try { return bareHost(new URL(u).hostname) || null; } catch { return null; }
  };
  const direct = hostOf(c.direct_url);
  if (direct) return { host: direct, via: 'direct_url', url: clean(c.direct_url as string) };
  const own = hostOf(c.url);
  if (own) return { host: own, via: 'url', url: clean(c.url as string) };
  const d = typeof c.domain === 'string' ? bareHost(c.domain.trim()) : '';
  if (d && looksLikeHost(d) && !/^google\.[a-z.]+$/.test(d)) return { host: d, via: 'domain', url: null };
  const t = typeof c.title === 'string' ? bareHost(c.title.trim()) : '';
  if (t && looksLikeHost(t)) return { host: t, via: 'title', url: null };
  return { host: null, via: null, url: null };
}
