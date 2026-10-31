/**
 * User agents and bot-block detection, shared by the crawler, the outbound-link checker and
 * probe_urls. Requests go out first under the crawler's own honest user agent. When a response
 * looks like a bot block (not a real error), the request is retried ONCE as a current desktop
 * Chrome, and the result records which user agent got through — so every crawl measures how much
 * blocking actually happens. An explicit userAgent from the user disables the fallback.
 */
export const BOT_UA = 'Mozilla/5.0 (compatible; seo-audit-console/0.1; +https://github.com/houtini-ai/seo-audit)';
export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** Headers a real Chrome navigation sends alongside its user agent; WAFs check the set, not just the UA. */
export const CHROME_HEADERS: Record<string, string> = {
  'user-agent': CHROME_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-GB,en;q=0.9',
  'upgrade-insecure-requests': '1',
  'sec-ch-ua': '"Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

export type FetchedAs = 'bot' | 'chrome';

/**
 * Does this response look like a bot block rather than a genuine status? 403 and LinkedIn's 999
 * always qualify (a cheap single retry settles it); 429/503 only with a WAF challenge marker,
 * since plain rate limiting is handled by backoff, not by changing identity.
 *
 * The `server` header is NOT a challenge marker: Shopify and most CDN-fronted sites send
 * `server: cloudflare` on every response, ordinary rate-limit 429s included, so treating it as one
 * retried every rate-limited URL at once as Chrome (no backoff) and switched whole crawls to Chrome.
 * It only counts for a 503 that is not a rate limit (no Retry-After): the old interstitial pages.
 */
export function looksBotBlocked(status: number, header: (name: string) => string | null): boolean {
  if (status === 403 || status === 999) return true;
  const server = (header('server') ?? '').toLowerCase();
  const marker = header('cf-mitigated') === 'challenge' || !!header('x-datadome') || !!header('x-px-block');
  if (marker) return true;
  return status === 503 && !header('retry-after') && (server.includes('cloudflare') || server.includes('akamaighost'));
}
