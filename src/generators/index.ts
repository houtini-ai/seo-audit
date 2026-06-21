import type Database from 'better-sqlite3';

/**
 * Finding → fix generators. Each produces a concrete, paste-ready remediation from
 * crawl/GSC data — the differentiator over a static report. All are dry-run: they
 * return artifacts, they never write to the user's site.
 */

// schema-dts is compile-time types; at runtime we build plain objects + serialise.
// safeJsonLd escapes for safe <script> embedding (per schema-dts docs).
const safeJsonLd = (data: unknown): string =>
  JSON.stringify(data, null, 2).replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/&/g, '\\u0026').replace(/'/g, '\\u0027');

const pathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return u || '/'; } };
const pathTokens = (u: string): string[] => pathOf(u).toLowerCase().split(/[/\-_.]+/).filter(Boolean);
function tokenOverlap(a: string, b: string): number {
  const ta = new Set(pathTokens(a)), tb = new Set(pathTokens(b));
  if (!tb.size) return 0;
  let m = 0;
  for (const t of tb) if (ta.has(t)) m++;
  return m / Math.max(ta.size, tb.size);
}

// ── JSON-LD generation (for missing-structured-data) ──────────────────────
export interface JsonLdResult { type: string; jsonLd: Record<string, unknown>; scriptTag: string; filledFrom: string[]; todo: string[] }

function inferType(urlKey: string): string {
  const p = pathOf(urlKey);
  if (p === '/' || p === '') return 'Organization';
  if (/\/(articles?|blog|news|posts?|guides?)\//.test(p)) return 'Article';
  if (/\/(products?|shop|item|store)\//.test(p)) return 'Product';
  return 'WebPage';
}

// Resolve a possibly-relative URL to absolute against the page URL (Google requires
// absolute image/logo URLs — generating a relative one just reproduces the finding).
function absUrl(v: string | undefined, base: string): string | undefined {
  if (!v) return undefined;
  try { return new URL(v, base).toString(); } catch { return v; }
}

export function generateJsonLd(page: any): JsonLdResult {
  const type = inferType(page.url_key);
  const og: Record<string, string> = page.og_tags ? JSON.parse(page.og_tags) : {};
  const filledFrom: string[] = [];
  const todo: string[] = [];
  const o: Record<string, unknown> = { '@context': 'https://schema.org', '@type': type };
  const ogImage = absUrl(og['og:image'], page.url); // absolutised

  if (type === 'Organization') {
    if (page.title) { o.name = page.title; filledFrom.push('name←title'); } else todo.push('name');
    o.url = page.url; filledFrom.push('url');
    if (ogImage) { o.logo = ogImage; filledFrom.push('logo←og:image'); } else todo.push('logo');
    todo.push('sameAs (social profiles)');
  } else if (type === 'Article') {
    o.headline = page.h1 || page.title || ''; filledFrom.push('headline←h1/title');
    o.url = page.url; filledFrom.push('url');
    if (page.meta_description) { o.description = page.meta_description; filledFrom.push('description'); }
    if (ogImage) { o.image = ogImage; filledFrom.push('image←og:image'); } else todo.push('image');
    o.author = { '@type': 'Person', name: 'TODO — author name' };
    todo.push('author.name', 'datePublished', 'dateModified');
  } else if (type === 'Product') {
    if (page.title) { o.name = page.title; filledFrom.push('name←title'); } else todo.push('name');
    if (ogImage) { o.image = ogImage; filledFrom.push('image←og:image'); } else todo.push('image');
    o.offers = { '@type': 'Offer', price: 'TODO', priceCurrency: 'TODO', availability: 'https://schema.org/InStock' };
    todo.push('offers.price', 'offers.priceCurrency');
  } else {
    if (page.title) { o.name = page.title; filledFrom.push('name←title'); }
    o.url = page.url; filledFrom.push('url');
    if (page.meta_description) { o.description = page.meta_description; filledFrom.push('description'); }
  }
  return { type, jsonLd: o, scriptTag: `<script type="application/ld+json">\n${safeJsonLd(o)}\n</script>`, filledFrom, todo };
}

// ── Redirect suggestion (for broken-internal-links / 404s) ────────────────
export interface RedirectResult { brokenUrl: string; suggested: string | null; score: number; rule: string }

export function suggestRedirect(brokenUrl: string, livePages: { url: string }[], format: 'htaccess' | 'nginx' | 'nextjs' = 'htaccess'): RedirectResult {
  let best: string | null = null, bestScore = 0;
  for (const p of livePages) { const s = tokenOverlap(brokenUrl, p.url); if (s > bestScore) { bestScore = s; best = p.url; } }
  const from = pathOf(brokenUrl);
  const to = best ? pathOf(best) : '/';
  const rule = !best || bestScore < 0.34
    ? `# no confident match for ${from} — choose a target manually`
    : format === 'nginx' ? `rewrite ^${from}$ ${to} permanent;`
    : format === 'nextjs' ? `{ source: '${from}', destination: '${to}', permanent: true },`
    : `Redirect 301 ${from} ${to}`;
  return { brokenUrl, suggested: bestScore >= 0.34 ? best : null, score: Math.round(bestScore * 100) / 100, rule };
}

// ── Internal-link suggestions (for orphan / striking-distance) ────────────
export interface LinkSuggestion { donorUrl: string; ipr: number; inlinkCount: number; relevance: number }

export function suggestInternalLinks(db: Database.Database, receiverUrlKey: string, anchor: string): { anchor: string; donors: LinkSuggestion[] } {
  const alreadyLinking = new Set(
    (db.prepare('SELECT DISTINCT source_key FROM links WHERE target_key = ?').all(receiverUrlKey) as { source_key: string }[]).map(r => r.source_key),
  );
  // Prefer high-authority donors (iPR) — the "money move" is link equity flowing from
  // strong pages to the under-linked receiver; topical relevance breaks ties.
  const candidates = db.prepare(
    'SELECT url, url_key, ipr, inlink_count FROM pages WHERE status_code=200 AND indexable=1 AND url_key != ? ORDER BY ipr DESC LIMIT 80',
  ).all(receiverUrlKey) as { url: string; url_key: string; ipr: number; inlink_count: number }[];
  const donors = candidates
    .filter(c => !alreadyLinking.has(c.url_key))
    .map(c => ({ donorUrl: c.url, ipr: Math.round(c.ipr ?? 0), inlinkCount: c.inlink_count, relevance: Math.round(tokenOverlap(c.url, receiverUrlKey) * 100) / 100 }))
    .sort((a, b) => b.relevance - a.relevance || b.ipr - a.ipr)
    .slice(0, 5);
  return { anchor, donors };
}
