import type { FirecrawlClient } from './FirecrawlClient.js';
import type { SupadataClient } from './SupadataClient.js';
import { hostOf } from './serpRecon.js';
import { extractPage } from './extract.js';

/**
 * Route a competitor URL to the right fetcher by who owns the source:
 *   YouTube/TikTok/X → Supadata (transcript)   — Firecrawl can't read video
 *   Reddit           → its own .json endpoint   — Firecrawl hard-blocks Reddit
 *   everything else  → Firecrawl (markdown, proxy:auto for bot-protected sites)
 * Each returns a uniform shape so the recon packet is easy for the research session to diff.
 */
export interface CompetitorContent {
  url: string;
  kind: 'video' | 'reddit' | 'page';
  title: string | null;
  content: string;
  cached: boolean;
  error?: string;
}

const isVideo = (host: string): boolean => /youtube|youtu\.be|tiktok|twitter\.com|x\.com/.test(host);
const isReddit = (host: string): boolean => /reddit\.com/.test(host);

/** Reddit serves clean JSON at url.json — title + selftext + top comments, no scraper needed. */
export async function fetchRedditJson(url: string, maxChars = 4000): Promise<{ title: string | null; content: string }> {
  const jsonUrl = url.split('?')[0].replace(/\/$/, '') + '.json';
  const res = await fetch(jsonUrl, {
    headers: { 'user-agent': 'seo-audit-console:recon:1.0 (+https://github.com/houtini-ai/seo-audit)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Reddit .json ${res.status}`);
  const data: any = await res.json();
  const post = data?.[0]?.data?.children?.[0]?.data ?? {};
  const comments: any[] = data?.[1]?.data?.children ?? [];
  const parts: string[] = [];
  if (post.title) parts.push(`# ${post.title}`);
  if (post.selftext) parts.push(post.selftext);
  const top = comments
    .map(c => c?.data)
    .filter(d => d && d.body && d.body !== '[deleted]')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 12)
    .map(d => `- (${d.score ?? 0}) ${d.body}`);
  if (top.length) parts.push('## Top comments', ...top);
  return { title: post.title ?? null, content: parts.join('\n\n').slice(0, maxChars) };
}

/** Free HTTP fallback for pages Firecrawl refuses (its blocklist covers major publishers).
 * Fetches with a browser-like UA and reuses our own extractor for clean main-content text. */
export async function fetchPlainPage(url: string, maxChars = 4000): Promise<{ title: string | null; content: string }> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; seo-audit-console recon; +https://github.com/houtini-ai/seo-audit)', 'accept': 'text/html' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`plain fetch ${res.status}`);
  const html = await res.text();
  const host = new URL(url).hostname.replace(/^www\./, '');
  const ex = extractPage(html, url, host, { hostForm: 'asis' }, null);
  const text = (ex.bodyChunks ?? []).map(c => `${c.heading} ${c.text}`).join('\n').trim();
  return { title: ex.title, content: text.slice(0, maxChars) };
}

export async function fetchCompetitorContent(
  url: string,
  clients: { firecrawl: FirecrawlClient | null; supadata: SupadataClient | null },
  opts: { maxChars?: number } = {},
): Promise<CompetitorContent> {
  const host = hostOf(url);
  const max = opts.maxChars ?? 4000;
  try {
    if (isVideo(host)) {
      if (!clients.supadata) return { url, kind: 'video', title: null, content: '', cached: false, error: 'SUPADATA_API_KEY not set — cannot transcribe video' };
      const t = await clients.supadata.transcript(url, { maxChars: Math.max(max, 5000) });
      return { url, kind: 'video', title: null, content: t.content, cached: t.cached };
    }
    if (isReddit(host)) {
      // .json first (Firecrawl hard-blocks Reddit); plain HTML as a long shot if that 403s.
      try { const r = await fetchRedditJson(url, max); return { url, kind: 'reddit', title: r.title, content: r.content, cached: false }; }
      catch { const r = await fetchPlainPage(url, max); return { url, kind: 'reddit', title: r.title, content: r.content, cached: false }; }
    }
    // Pages: Firecrawl first (cleaner, handles JS); fall back to a free plain fetch for the
    // sites Firecrawl refuses ("we do not support this site") or when no key is set.
    if (clients.firecrawl) {
      try { const s = await clients.firecrawl.scrape(url, { maxChars: max, proxy: 'auto' }); return { url, kind: 'page', title: s.title, content: s.markdown, cached: s.cached }; }
      catch { /* fall through to plain fetch */ }
    }
    const p = await fetchPlainPage(url, max);
    return { url, kind: 'page', title: p.title, content: p.content, cached: false };
  } catch (e) {
    const kind = isVideo(host) ? 'video' : isReddit(host) ? 'reddit' : 'page';
    return { url, kind, title: null, content: '', cached: false, error: e instanceof Error ? e.message : String(e) };
  }
}
