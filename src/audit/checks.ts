import type Database from 'better-sqlite3';
import type { FindingLabel, Severity } from '../core/AuditDatabase.js';
import { validateJsonLdColumn, type SchemaIssueKind } from './schema-validate.js';

/**
 * Check registry. Each check is a pure read over the AuditDatabase (crawl + GSC +
 * url_inspection, joined on url_key/page_key) returning affected items with evidence.
 * Scoring + persistence happen in engine.ts. Grounded in research/01 (master checklist),
 * research/05 (merged GSC×crawl) and research/02 (war-stories); taxonomy cross-checked
 * against SEOmator's MIT 251-rule set.
 */
export interface CheckContext {
  db: Database.Database;
  gscMaxDate: string | null; // null = no GSC data; G-checks skip
}
export interface RawFinding {
  urlKey?: string | null;
  evidence: Record<string, unknown>;
}
export interface CheckDef {
  id: string;
  category: 'crawlability' | 'indexation' | 'onpage' | 'content' | 'schema' | 'security' | 'war-stories' | 'merged';
  severity: Severity;
  labels: FindingLabel[];
  certainty: number; // 1.0 deterministic, 0.5 judgement
  effortBase: number; // Fibonacci: 1 trivial, 3 small, 5 medium, 8 hard, 13 epic
  fixType: 'global' | 'per-page' | 'automated';
  title: string;
  fix: string;
  run(ctx: CheckContext): RawFinding[];
}

const rows = (ctx: CheckContext, sql: string, ...args: unknown[]): any[] => ctx.db.prepare(sql).all(...args);
const win = (d: string): string => `date > date('${d}', '-28 days')`;

// Significant query terms (drop stopwords; keep ≥2 chars so "vr"/"pc"/"ai" count).
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'your', 'you', 'is', 'are', 'best', 'how', 'what', 'vs', 'why', 'can']);
const terms = (s: string): string[] =>
  (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t.length >= 2 && !STOP.has(t));
// A query term is "present" in the title if a TITLE WORD matches it (exact, or a
// plural/stem prefix either way for ≥4-char tokens), or the space-collapsed title
// contains it (for multi-word brands like "sync mesh" ≈ "syncmesh", ≥5 chars).
// Word-level avoids substring false-matches (e.g. "art" inside "smart").
const titleHasTerm = (title: string, term: string): boolean => {
  const t = title.toLowerCase();
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(w => w === term || (term.length >= 4 && w.startsWith(term)) || (w.length >= 4 && term.startsWith(w)))) return true;
  return term.length >= 5 && t.replace(/[^a-z0-9]+/g, '').includes(term);
};

// Validate captured JSON-LD per page, keeping findings whose issue-kinds match `kinds`.
function schemaFindings(ctx: CheckContext, kinds: SchemaIssueKind[]): RawFinding[] {
  const set = new Set(kinds);
  const out: RawFinding[] = [];
  for (const r of rows(ctx, `SELECT url_key urlKey, json_ld jsonLd FROM pages WHERE status_code=200 AND json_ld IS NOT NULL AND json_ld != ''`)) {
    const hits = validateJsonLdColumn(r.jsonLd).filter(i => set.has(i.kind));
    if (hits.length) out.push({ urlKey: r.urlKey, evidence: { issues: hits.map(h => ({ type: h.type, detail: h.detail, fields: h.fields })) } });
  }
  return out;
}

// Rough position→expected-CTR curve (desktop+mobile blended) for the CTR-gap check.
const CTR_CURVE: Record<number, number> = { 1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.06, 6: 0.05, 7: 0.04, 8: 0.032, 9: 0.028, 10: 0.025 };
const expectedCtr = (pos: number): number => CTR_CURVE[Math.max(1, Math.min(10, Math.round(pos)))] ?? 0.02;

export const CHECKS: CheckDef[] = [
  // ── On-page (crawl, deterministic) ──────────────────────────────────────
  {
    id: 'missing-title', category: 'onpage', severity: 'crit', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Missing title tag', fix: 'Add a unique, descriptive <title> (~50–60 chars).',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND (title IS NULL OR TRIM(title)='')`).map(r => ({ urlKey: r.urlKey, evidence: {} })),
  },
  {
    id: 'duplicate-title', category: 'onpage', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Duplicate title tag', fix: 'Make each indexable page’s title unique.',
    run: (c) => rows(c, `SELECT url_key urlKey, title FROM pages WHERE status_code=200 AND indexable=1 AND title IS NOT NULL AND TRIM(title)!='' AND LOWER(TRIM(title)) IN (SELECT LOWER(TRIM(title)) FROM pages WHERE status_code=200 AND indexable=1 AND title IS NOT NULL GROUP BY LOWER(TRIM(title)) HAVING COUNT(*)>1)`).map(r => ({ urlKey: r.urlKey, evidence: { title: r.title } })),
  },
  {
    id: 'missing-meta-description', category: 'onpage', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Missing meta description', fix: 'Add a unique meta description (~120–155 chars).',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND indexable=1 AND (meta_description IS NULL OR TRIM(meta_description)='')`).map(r => ({ urlKey: r.urlKey, evidence: {} })),
  },
  {
    id: 'missing-h1', category: 'onpage', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Missing H1', fix: 'Add a single descriptive <h1>.',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND indexable=1 AND (h1_count IS NULL OR h1_count=0)`).map(r => ({ urlKey: r.urlKey, evidence: {} })),
  },
  {
    id: 'multiple-h1', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Multiple H1s', fix: 'Use one H1 per page.',
    run: (c) => rows(c, `SELECT url_key urlKey, h1_count FROM pages WHERE status_code=200 AND h1_count>1`).map(r => ({ urlKey: r.urlKey, evidence: { h1Count: r.h1_count } })),
  },
  {
    id: 'thin-content', category: 'content', severity: 'med', labels: ['D', 'N'], certainty: 0.6, effortBase: 5, fixType: 'per-page',
    title: 'Thin content', fix: 'Expand or consolidate — under ~200 words of body text.',
    run: (c) => rows(c, `SELECT url_key urlKey, word_count FROM pages WHERE status_code=200 AND indexable=1 AND word_count < 200`).map(r => ({ urlKey: r.urlKey, evidence: { wordCount: r.word_count } })),
  },
  // ── Indexation / crawlability ───────────────────────────────────────────
  {
    id: 'canonical-mismatch', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Canonical points elsewhere', fix: 'Confirm the declared canonical is intentional; self-canonical by default.',
    run: (c) => rows(c, `SELECT url_key urlKey, canonical_url FROM pages WHERE status_code=200 AND canonical_key IS NOT NULL AND canonical_key != url_key`).map(r => ({ urlKey: r.urlKey, evidence: { canonical: r.canonical_url } })),
  },
  {
    id: 'broken-internal-links', category: 'crawlability', severity: 'crit', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'automated',
    title: 'Internal links to 4xx/5xx', fix: 'Repoint internal links to a live, canonical URL.',
    run: (c) => rows(c, `SELECT l.target_key urlKey, p.status_code status, COUNT(DISTINCT l.source_key) sources FROM links l JOIN pages p ON p.url_key=l.target_key WHERE l.is_internal=1 AND p.status_code >= 400 GROUP BY l.target_key`).map(r => ({ urlKey: r.urlKey, evidence: { status: r.status, linkingPages: r.sources } })),
  },
  // ── Extractor-dependent (images + canonical shape) ──────────────────────
  {
    id: 'image-alt', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Images missing alt text', fix: 'Add descriptive alt text to content images (alt="" only for decorative).',
    run: (c) => rows(c, `SELECT url_key urlKey, images_without_alt missing, image_count total FROM pages WHERE status_code=200 AND indexable=1 AND images_without_alt > 0`).map(r => ({ urlKey: r.urlKey, evidence: { missing: r.missing, total: r.total } })),
  },
  {
    id: 'canonical-relative', category: 'indexation', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Canonical declared as a relative URL', fix: 'Use an absolute https URL in rel=canonical — relative canonicals are error-prone.',
    run: (c) => rows(c, `SELECT url_key urlKey, canonical_url canonical FROM pages WHERE status_code=200 AND canonical_relative=1`).map(r => ({ urlKey: r.urlKey, evidence: { canonical: r.canonical } })),
  },
  {
    id: 'multiple-canonical', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Multiple canonical tags', fix: 'Keep exactly one rel=canonical — conflicting canonicals let Google pick (or ignore) one.',
    run: (c) => rows(c, `SELECT url_key urlKey, canonical_count cnt FROM pages WHERE status_code=200 AND canonical_count > 1`).map(r => ({ urlKey: r.urlKey, evidence: { canonicalCount: r.cnt } })),
  },
  // ── Extractor additions (CLS, headings, mixed content, directives, social) ───
  {
    id: 'images-missing-dimensions', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Images without width/height (CLS)', fix: 'Set width & height (or CSS aspect-ratio) on <img> so the browser reserves space — avoids layout shift.',
    run: (c) => rows(c, `SELECT url_key urlKey, images_missing_dimensions n, image_count total FROM pages WHERE status_code=200 AND indexable=1 AND images_missing_dimensions > 0`).map(r => ({ urlKey: r.urlKey, evidence: { missingDimensions: r.n, total: r.total } })),
  },
  {
    id: 'heading-hierarchy', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Skipped heading levels', fix: 'Use headings in order (don’t jump e.g. h1→h3) — keeps the document outline accessible and parseable.',
    run: (c) => rows(c, `SELECT url_key urlKey, heading_skips n FROM pages WHERE status_code=200 AND indexable=1 AND heading_skips > 0`).map(r => ({ urlKey: r.urlKey, evidence: { skippedLevels: r.n } })),
  },
  {
    id: 'mixed-content', category: 'security', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Mixed content (http on https)', fix: 'Serve every subresource over https — browsers block or warn on insecure resources.',
    run: (c) => rows(c, `SELECT url_key urlKey, mixed_content_count n FROM pages WHERE status_code=200 AND url LIKE 'https://%' AND mixed_content_count > 0`).map(r => ({ urlKey: r.urlKey, evidence: { insecureResources: r.n } })),
  },
  {
    id: 'meta-nofollow', category: 'crawlability', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Meta robots nofollow', fix: 'Remove nofollow from meta robots unless you intend to drop all link equity from this page.',
    run: (c) => rows(c, `SELECT url_key urlKey, robots FROM pages WHERE status_code=200 AND indexable=1 AND robots LIKE '%nofollow%'`).map(r => ({ urlKey: r.urlKey, evidence: { robots: r.robots } })),
  },
  {
    id: 'missing-social-tags', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'No social share tags', fix: 'Add Open Graph (og:title/og:image) and/or Twitter Card tags so shared links render a rich preview.',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND indexable=1 AND (og_tags IS NULL OR og_tags='') AND (twitter_tags IS NULL OR twitter_tags='')`).map(r => ({ urlKey: r.urlKey, evidence: {} })),
  },
  // ── Security / war-stories (headers now captured) ───────────────────────
  {
    id: 'missing-hsts', category: 'security', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'Missing HSTS header', fix: 'Add Strict-Transport-Security with a sensible max-age.',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND (security_headers IS NULL OR security_headers NOT LIKE '%hsts%') LIMIT 1`).map(r => ({ urlKey: r.urlKey, evidence: { note: 'representative page; HSTS is site-wide' } })),
  },
  // ── Merged GSC × crawl (the differentiator) ─────────────────────────────
  {
    id: 'noindex-with-traffic', category: 'indexation', severity: 'crit', labels: ['D', 'G'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Noindex page still getting clicks', fix: 'Remove noindex if the page should rank — it earns clicks.',
    run: (c) => c.gscMaxDate ? rows(c, `SELECT p.url_key urlKey, SUM(sa.clicks) clicks FROM pages p JOIN search_analytics sa ON sa.page_key=p.url_key WHERE p.noindex=1 AND sa.${win(c.gscMaxDate)} GROUP BY p.url_key HAVING SUM(sa.clicks)>0`).map(r => ({ urlKey: r.urlKey, evidence: { clicks: r.clicks } })) : [],
  },
  {
    id: 'orphan-with-impressions', category: 'merged', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Orphan page earning impressions', fix: 'Add internal links — Google ranks it but the site barely links to it.',
    run: (c) => c.gscMaxDate ? rows(c, `SELECT p.url_key urlKey, SUM(sa.impressions) impressions FROM pages p JOIN search_analytics sa ON sa.page_key=p.url_key WHERE p.inlink_count=0 AND p.indexable=1 AND sa.${win(c.gscMaxDate)} GROUP BY p.url_key HAVING SUM(sa.impressions)>0 ORDER BY impressions DESC`).map(r => ({ urlKey: r.urlKey, evidence: { impressions: r.impressions, inlinks: 0 } })) : [],
  },
  {
    id: 'coverage-not-indexed', category: 'indexation', severity: 'high', labels: ['G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Crawled but not indexed', fix: 'Investigate quality/duplication — Google crawled it and chose not to index.',
    run: (c) => rows(c, `SELECT url_key urlKey, coverage_state state FROM url_inspection WHERE coverage_state LIKE '%not indexed%'`).map(r => ({ urlKey: r.urlKey, evidence: { coverageState: r.state } })),
  },
  {
    id: 'canonical-conflict', category: 'indexation', severity: 'high', labels: ['G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Google chose a different canonical', fix: 'Align your declared canonical with the page Google actually indexes.',
    run: (c) => rows(c, `SELECT url_key urlKey, google_canonical g, user_canonical u FROM url_inspection WHERE user_canonical IS NOT NULL AND google_canonical IS NOT NULL AND google_canonical != user_canonical`).map(r => ({ urlKey: r.urlKey, evidence: { googleCanonical: r.g, userCanonical: r.u } })),
  },
  {
    id: 'striking-distance', category: 'merged', severity: 'high', labels: ['G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Striking-distance query (page 2)', fix: 'Small on-page + internal-link push could reach page 1.',
    run: (c) => c.gscMaxDate ? rows(c, `SELECT page_key urlKey, query, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) position, SUM(impressions) impressions FROM search_analytics WHERE query IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY query, page_key HAVING SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0)>10 AND SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0)<=20 AND SUM(impressions)>=20 ORDER BY impressions DESC LIMIT 50`).map(r => ({ urlKey: r.urlKey, evidence: { query: r.query, position: Math.round(r.position * 10) / 10, impressions: r.impressions } })) : [],
  },
  // ── Additions from Moz / MarketMuse / Whitehat checklists (buildable on current data) ──
  {
    id: 'title-too-long', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Title over ~60 chars', fix: 'Trim the title so the primary keyword sits within ~60 chars.',
    run: (c) => rows(c, `SELECT url_key urlKey, title_length len FROM pages WHERE status_code=200 AND indexable=1 AND title_length > 60`).map(r => ({ urlKey: r.urlKey, evidence: { titleLength: r.len } })),
  },
  {
    id: 'meta-description-length', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Meta description over ~160 chars', fix: 'Tighten to ~150–160 chars so it isn’t truncated.',
    run: (c) => rows(c, `SELECT url_key urlKey, meta_description_length len FROM pages WHERE status_code=200 AND indexable=1 AND meta_description_length > 160`).map(r => ({ urlKey: r.urlKey, evidence: { length: r.len } })),
  },
  {
    id: 'non-https', category: 'security', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'Page served over HTTP', fix: 'Serve over HTTPS and 301 the HTTP version.',
    run: (c) => rows(c, `SELECT url_key urlKey, url FROM pages WHERE status_code=200 AND url LIKE 'http://%'`).map(r => ({ urlKey: r.urlKey, evidence: { url: r.url } })),
  },
  {
    id: 'redirect-chain', category: 'crawlability', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'automated',
    title: 'Redirect chain (2+ hops)', fix: 'Collapse to a single hop to the final URL.',
    run: (c) => rows(c, `SELECT url_key urlKey, redirects FROM pages WHERE redirects IS NOT NULL`)
      .map(r => ({ urlKey: r.urlKey, hops: (JSON.parse(r.redirects) as unknown[]).length }))
      .filter(x => x.hops >= 2)
      .map(x => ({ urlKey: x.urlKey, evidence: { hops: x.hops } })),
  },
  {
    id: 'internal-links-to-redirects', category: 'crawlability', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'automated',
    title: 'Internal links pointing through redirects', fix: 'Repoint internal links to the final URL (saves crawl + equity).',
    run: (c) => rows(c, `SELECT l.target_key urlKey, COUNT(DISTINCT l.source_key) sources FROM links l JOIN pages p ON p.url_key=l.target_key WHERE l.is_internal=1 AND p.redirects IS NOT NULL GROUP BY l.target_key`).map(r => ({ urlKey: r.urlKey, evidence: { linkingPages: r.sources } })),
  },
  {
    id: 'missing-structured-data', category: 'schema', severity: 'low', labels: ['D'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'No structured data', fix: 'Add relevant JSON-LD (Article, Product, Organization…).',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND indexable=1 AND (json_ld IS NULL OR json_ld='')`).map(r => ({ urlKey: r.urlKey, evidence: {} })),
  },
  // ── Schema validation (validate captured json_ld vs maintained Rich-Results map) ──
  {
    id: 'invalid-schema', category: 'schema', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Invalid structured data', fix: 'Fix the JSON-LD so each block parses and carries @context (https://schema.org) + a valid @type.',
    run: (c) => schemaFindings(c, ['parse', 'context', 'type']),
  },
  {
    id: 'missing-required-fields', category: 'schema', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Structured data missing required fields', fix: 'Add the Google-required properties for the detected schema type (cited per finding).',
    run: (c) => schemaFindings(c, ['required']),
  },
  {
    id: 'schema-value-errors', category: 'schema', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Structured-data value errors', fix: 'Use absolute, indexable image/URL values and ISO-8601 dates in JSON-LD.',
    run: (c) => schemaFindings(c, ['value']),
  },
  {
    id: 'forbidden-schema', category: 'schema', severity: 'high', labels: ['D', 'N'], certainty: 0.7, effortBase: 1, fixType: 'per-page',
    title: 'Restricted schema type in use', fix: 'Remove FAQPage/HowTo markup unless the page qualifies for the narrow remaining eligibility — it risks no benefit or a manual action.',
    run: (c) => schemaFindings(c, ['forbidden']),
  },
  {
    id: 'missing-viewport', category: 'onpage', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'Missing viewport meta (mobile)', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND (viewport IS NULL OR viewport='')`).map(r => ({ urlKey: r.urlKey, evidence: {} })),
  },
  {
    id: 'keyword-cannibalisation', category: 'merged', severity: 'high', labels: ['G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Keyword cannibalisation', fix: 'Consolidate or differentiate — multiple URLs compete for one query.',
    run: (c) => c.gscMaxDate ? rows(c, `SELECT query, COUNT(DISTINCT page_key) urls, SUM(clicks) clicks, SUM(impressions) impressions FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY query HAVING COUNT(DISTINCT page_key) >= 2 AND SUM(impressions) >= 50 ORDER BY impressions DESC LIMIT 40`).map(r => ({ urlKey: null, evidence: { query: r.query, competingUrls: r.urls, clicks: r.clicks, impressions: r.impressions } })) : [],
  },
  {
    id: 'ctr-below-expected', category: 'merged', severity: 'high', labels: ['G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'CTR far below position-expected', fix: 'Rewrite title/meta — ranking well but under-clicked (snippet opportunity).',
    run: (c) => c.gscMaxDate ? rows(c, `SELECT page_key urlKey, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) position, SUM(clicks) clicks, SUM(impressions) impressions FROM search_analytics WHERE page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key HAVING SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) <= 10 AND SUM(impressions) >= 100`)
      .map(r => { const ctr = r.clicks / r.impressions; const exp = expectedCtr(r.position); return { urlKey: r.urlKey, ctr, exp, position: r.position, impressions: r.impressions }; })
      .filter(x => x.ctr < x.exp * 0.5)
      .map(x => ({ urlKey: x.urlKey, evidence: { position: Math.round(x.position * 10) / 10, ctr: Math.round(x.ctr * 1000) / 10 + '%', expectedCtr: Math.round(x.exp * 1000) / 10 + '%', impressions: x.impressions } })) : [],
  },
  // ── Merged crawl × Search Console — the "expert questions" that need both datasets ──
  {
    id: 'ghost-pages', category: 'merged', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Ranking page the crawl can’t reach', fix: 'Google sends impressions/clicks to this URL but the site crawl never reached it — add internal links so it’s discoverable (or confirm it should exist and isn’t blocked).',
    run: (c) => {
      if (!c.gscMaxDate) return [];
      // Only meaningful on a COMPLETE crawl — if the crawl hit its maxPages cap, "absent
      // from crawl" is unreliable. Tie the guard to the crawl that produced the CURRENT
      // pages (not the latest crawl_metadata row, which may be a later failed crawl).
      const m = c.db.prepare('SELECT urls_crawled c, max_pages m FROM crawl_metadata WHERE crawl_id = (SELECT crawl_id FROM pages LIMIT 1)').get() as { c: number; m: number } | undefined;
      if (!m || m.c === 0 || m.c >= m.m) return [];
      return rows(c, `SELECT page_key urlKey, SUM(clicks) clicks, SUM(impressions) impressions FROM search_analytics
        WHERE page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key
        HAVING SUM(impressions) >= 50 AND page_key NOT IN (SELECT url_key FROM pages)
        ORDER BY impressions DESC`).map(r => ({ urlKey: r.urlKey, evidence: { clicks: r.clicks, impressions: r.impressions, note: 'earns GSC traffic but absent from the crawl' } }));
    },
  },
  {
    id: 'title-missing-top-query', category: 'merged', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Top query missing from the title', fix: 'Work the page’s top-performing query into the <title> — it already ranks for this term but the title doesn’t mention it.',
    run: (c) => {
      if (!c.gscMaxDate) return [];
      const r = rows(c, `SELECT s.page_key urlKey, s.query query, s.impr impressions, p.title title FROM
        (SELECT page_key, query, SUM(impressions) impr, ROW_NUMBER() OVER (PARTITION BY page_key ORDER BY SUM(impressions) DESC) rn
         FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key, query) s
        JOIN pages p ON p.url_key = s.page_key
        WHERE s.rn = 1 AND p.indexable = 1 AND p.title IS NOT NULL AND p.title != '' AND s.impr >= 100`);
      return r
        .filter(x => { const q = terms(x.query); return q.length > 0 && !q.some(w => titleHasTerm(x.title, w)); })
        .map(x => ({ urlKey: x.urlKey, evidence: { topQuery: x.query, impressions: x.impressions, title: x.title } }));
    },
  },
  // ── Internal link graph (iPR + click-depth + anchor text, from the crawl `links` table) ──
  {
    id: 'deep-pages', category: 'crawlability', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Page buried deep in the structure', fix: 'Add in-content (body) links from higher-level pages — this page is 4+ clicks from the homepage via body links.',
    run: (c) => rows(c, `SELECT url_key urlKey, click_depth d FROM pages WHERE status_code=200 AND indexable=1 AND click_depth >= 4 ORDER BY click_depth DESC`).map(r => ({ urlKey: r.urlKey, evidence: { clickDepth: r.d } })),
  },
  {
    id: 'underlinked-high-demand', category: 'merged', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'High search demand, low internal authority', fix: 'Add internal links from high-authority (high-iPR) pages — this earns impressions but the site gives it little internal link equity.',
    run: (c) => c.gscMaxDate ? rows(c, `SELECT p.url_key urlKey, p.ipr ipr, p.inlink_count inl, SUM(sa.impressions) impressions FROM pages p JOIN search_analytics sa ON sa.page_key=p.url_key WHERE p.indexable=1 AND p.ipr < 30 AND p.inlink_count BETWEEN 1 AND 3 AND sa.${win(c.gscMaxDate)} GROUP BY p.url_key HAVING SUM(sa.impressions) >= 300 ORDER BY impressions DESC`).map(r => ({ urlKey: r.urlKey, evidence: { impressions: r.impressions, ipr: Math.round(r.ipr), inlinks: r.inl } })) : [],
  },
  // NOTE: internal anchor-text over-optimisation was prototyped but pulled — on real content
  // sites article-card/nav/brand anchors dominate naturally and produce false positives.
  // Needs a better heuristic (short exact-match keyword anchors across many distinct sources,
  // excluding card/title text) before it can carry evidence credibly. See roadmap #12.
];
