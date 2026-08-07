import { Agent, fetch as ufetch } from 'undici';
import type { FirecrawlClient } from './FirecrawlClient.js';
import type { SupadataClient } from './SupadataClient.js';
import { hostOf } from './serpRecon.js';
import { extractPage } from './extract.js';

const httpAgent = new Agent({ allowH2: true, connections: 6, keepAliveTimeout: 30_000 });
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GOOGLEBOT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/131.0.0.0 Safari/537.36';

/** User-agent modes for the free HTTP fetch. 'browser' mimics a real visit arriving from Google
 * (referer + cross-site fetch metadata) — this is what gets past Reddit and the mid-tier.
 * 'googlebot' spoofs Googlebot's UA (UA-gated sites only; strict-verified Cloudflare rejects it).
 * Cloudflare *managed-challenge* sites (e.g. PCMag) reject every HTTP-only client regardless. */
export type UaMode = 'browser' | 'googlebot';

function browserHeaders(mode: UaMode): Record<string, string> {
  if (mode === 'googlebot') {
    return { 'user-agent': GOOGLEBOT_UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-encoding': 'gzip, deflate, br', 'from': 'googlebot(at)googlebot.com' };
  }
  return {
    'user-agent': CHROME_UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'referer': 'https://www.google.com/',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site', 'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  };
}

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
  via: 'supadata' | 'reddit-json' | 'firecrawl' | 'plain-fetch' | 'none';  // which fetcher actually ran
  title: string | null;
  content: string;
  cached: boolean;
  error?: string;
}

/** Hosts whose content only Supadata can read (transcripts) and hosts we read via Reddit's own JSON. */
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'tiktok.com', 'twitter.com', 'x.com', 'vimeo.com', 'dailymotion.com', 'instagram.com', 'facebook.com'];
const REDDIT_HOSTS = ['reddit.com', 'redd.it'];

/** Exact host or subdomain match — NEVER a substring test. A substring `/x\.com/` classified
 * pimax.com as video and sent every Shopify product page to the transcriber, which 400'd
 * (build lesson, 2026-08-07: that one regex is why scrapeCompetitors returned almost nothing). */
export function hostIsOneOf(host: string, domains: string[]): boolean {
  const h = hostOf(host);
  return domains.some(d => h === d || h.endsWith(`.${d}`));
}

const isVideo = (host: string): boolean => hostIsOneOf(host, VIDEO_HOSTS);
const isReddit = (host: string): boolean => hostIsOneOf(host, REDDIT_HOSTS);

/** Which fetcher a URL will be routed to — exposed so recon can report routing per URL
 * instead of leaving a silent misroute to look like an empty competitor set. */
export function routeFor(url: string): CompetitorContent['kind'] {
  const host = hostOf(url);
  return isVideo(host) ? 'video' : isReddit(host) ? 'reddit' : 'page';
}

/** Reddit serves clean JSON at url.json — title + selftext + top comments, no scraper needed.
 * Needs the browser header profile (UA + Google referer) — a bot UA gets a 403. */
export async function fetchRedditJson(url: string, maxChars = 4000, ua: UaMode = 'browser'): Promise<{ title: string | null; content: string }> {
  const jsonUrl = url.split('?')[0].replace(/\/$/, '') + '.json';
  const res = await ufetch(jsonUrl, { headers: browserHeaders(ua), dispatcher: httpAgent, signal: AbortSignal.timeout(20000) });
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
export async function fetchPlainPage(url: string, maxChars = 4000, ua: UaMode = 'browser'): Promise<{ title: string | null; content: string }> {
  const res = await ufetch(url, { headers: browserHeaders(ua), dispatcher: httpAgent, signal: AbortSignal.timeout(20000) });
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
  opts: { maxChars?: number; ua?: UaMode } = {},
): Promise<CompetitorContent> {
  const max = opts.maxChars ?? 4000;
  const ua = opts.ua ?? 'browser';
  const kind = routeFor(url);
  let firecrawlError: string | null = null;
  try {
    if (kind === 'video') {
      if (!clients.supadata) return { url, kind, via: 'none', title: null, content: '', cached: false, error: 'SUPADATA_API_KEY not set — cannot transcribe video' };
      const t = await clients.supadata.transcript(url, { maxChars: Math.max(max, 5000) });
      return { url, kind, via: 'supadata', title: null, content: t.content, cached: t.cached };
    }
    if (kind === 'reddit') {
      // .json first (cleaner structured data); HTML fallback. Both need the browser profile.
      try { const r = await fetchRedditJson(url, max, ua); return { url, kind, via: 'reddit-json', title: r.title, content: r.content, cached: false }; }
      catch { const r = await fetchPlainPage(url, max, ua); return { url, kind, via: 'plain-fetch', title: r.title, content: r.content, cached: false }; }
    }
    // Pages: Firecrawl first (cleaner, handles JS); fall back to the free browser-profile fetch
    // for sites Firecrawl refuses ("we do not support this site") or when no key is set.
    if (clients.firecrawl) {
      try { const s = await clients.firecrawl.scrape(url, { maxChars: max, proxy: 'auto' }); return { url, kind, via: 'firecrawl', title: s.title, content: s.markdown, cached: s.cached }; }
      catch (e) { firecrawlError = e instanceof Error ? e.message : String(e); /* fall through to the browser-profile fetch */ }
    }
    const p = await fetchPlainPage(url, max, ua);
    return { url, kind, via: 'plain-fetch', title: p.title, content: p.content, cached: false };
  } catch (e) {
    // Report BOTH failures when Firecrawl was tried first — "plain fetch 403" alone hides the
    // fact that the paid fetcher refused the site for a different reason.
    const msg = e instanceof Error ? e.message : String(e);
    return { url, kind, via: 'none', title: null, content: '', cached: false, error: firecrawlError ? `${msg} (firecrawl first: ${firecrawlError})` : msg };
  }
}
