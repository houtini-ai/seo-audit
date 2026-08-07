import { extractPage } from './extract.js';

/**
 * Owned-page access path for content recon: fetch one of OUR pages live and run the
 * crawler's own extractor. Owned content goes through the crawler (this), never a
 * third-party scraper — that stays for competitor pages (FirecrawlClient).
 */
export interface OwnPageView {
  url: string;
  status: number;
  title: string | null;
  h1: string | null;
  wordCount: number;
  headings: { level: number; heading: string; chars: number }[];
  fulltextLower: string;                 // headings + body joined, lowercased (for coverage probes)
  jsonLdTypes: string[];
  hasProductOrReview: boolean;
  dateModified: string | null;
  datePublished: string | null;
}

export async function fetchOwnPage(url: string, hostForm: 'apex' | 'www' | 'asis' = 'asis', timeoutMs = 20000): Promise<OwnPageView> {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const res = await fetch(url, {
    headers: { 'user-agent': 'seo-audit-console recon (+https://github.com/houtini-ai/seo-audit)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await res.text();
  const ex = extractPage(html, url, host, { hostForm }, res.headers.get('x-robots-tag'));

  const chunks = ex.bodyChunks ?? [];
  const fulltextLower = chunks.map(c => `${c.heading} ${c.text}`).join(' ').toLowerCase();

  // jsonLd is a JSON *string* (array of raw blocks) — parse ONCE, then each block (itself a
  // JSON string or object) may carry an @graph. (Build lesson: don't iterate the raw string.)
  const types = new Set<string>();
  let dateModified: string | null = null, datePublished: string | null = null;
  try {
    const blocks = ex.jsonLd ? JSON.parse(ex.jsonLd) : [];
    for (const block of blocks) {
      const obj = typeof block === 'string' ? JSON.parse(block) : block;
      for (const node of (obj['@graph'] ?? [obj])) {
        const t = node['@type'];
        (Array.isArray(t) ? t : [t]).forEach((x: string) => x && types.add(x));
        if (node.dateModified && !dateModified) dateModified = String(node.dateModified).slice(0, 10);
        if (node.datePublished && !datePublished) datePublished = String(node.datePublished).slice(0, 10);
      }
    }
  } catch { /* malformed JSON-LD — leave types empty rather than throw */ }

  return {
    url,
    status: res.status,
    title: ex.title,
    h1: ex.h1,
    wordCount: ex.wordCount ?? fulltextLower.split(/\s+/).length,
    headings: chunks.filter(c => c.heading).map(c => ({ level: c.level, heading: c.heading, chars: c.text.length })),
    fulltextLower,
    jsonLdTypes: [...types],
    hasProductOrReview: types.has('Product') || types.has('Review') || types.has('AggregateRating'),
    dateModified,
    datePublished,
  };
}

/** Which of these terms does the page text actually contain? Powers the coverage-gap probe. */
export function coverageProbe(fulltextLower: string, terms: string[]): { term: string; present: boolean }[] {
  return terms.map(t => ({ term: t, present: fulltextLower.includes(t.toLowerCase()) }));
}
