import * as cheerio from 'cheerio';

/**
 * Google News — the free, keyless source for news_discovery. Google's old News API was
 * retired long ago; the live endpoint is the Google News RSS *search* feed, which returns
 * recent articles for a query with title, source, link and publish time. No credentials,
 * no cost — so news works even without a DataForSEO key (DataForSEO's Google News SERP
 * stays the richer paid option; this is the always-available fallback / second source).
 */
export interface GoogleNewsArticle {
  title: string;
  url: string;
  source: string | null;
  timestamp: string | null; // RFC-822 pubDate as returned by the feed
}

/**
 * Fetch recent Google News results for a keyword via the RSS search feed.
 * `hl` = interface language, `gl` = country; `ceid` is derived (country:lang).
 */
export async function fetchGoogleNews(
  keyword: string,
  opts: { hl?: string; gl?: string; limit?: number } = {},
): Promise<{ articles: GoogleNewsArticle[]; source: 'google-news-rss' }> {
  const hl = opts.hl ?? 'en-US';
  const gl = opts.gl ?? 'US';
  const ceid = `${gl}:${hl.split('-')[0]}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;

  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; seo-audit-console/1.0; +https://github.com/houtini-ai/seo-audit)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Google News RSS ${res.status}`);
  const xml = await res.text();

  // RSS is well-formed XML — parse with cheerio in xmlMode (already a dependency).
  const $ = cheerio.load(xml, { xmlMode: true });
  const limit = Math.min(opts.limit ?? 20, 100);
  const articles: GoogleNewsArticle[] = [];
  $('item').each((_i, el) => {
    if (articles.length >= limit) return;
    const $el = $(el);
    const title = $el.find('title').first().text().trim();
    if (!title) return;
    // <source url="...">Publisher</source>. Google News titles are usually "Headline - Publisher";
    // prefer the explicit <source> element, fall back to the trailing " - Publisher".
    let source = $el.find('source').first().text().trim() || null;
    let headline = title;
    if (!source) {
      const m = title.match(/^(.*)\s+-\s+([^-]+)$/);
      if (m) { headline = m[1].trim(); source = m[2].trim(); }
    }
    articles.push({
      title: headline,
      url: $el.find('link').first().text().trim(),
      source,
      timestamp: $el.find('pubDate').first().text().trim() || null,
    });
  });
  return { articles, source: 'google-news-rss' };
}
