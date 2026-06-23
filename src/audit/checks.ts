import type Database from 'better-sqlite3';
import type { FindingLabel, Severity } from '../core/AuditDatabase.js';
import { validateJsonLdColumn, type SchemaIssueKind } from './schema-validate.js';
import { urlKey } from '../core/url-key.js';
import { parseJsonLdNodes, nodeType } from './templates.js';
import { expectedCtr } from '../core/ctrModel.js';

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
  category: 'crawlability' | 'indexation' | 'onpage' | 'content' | 'schema' | 'security' | 'performance' | 'war-stories' | 'merged';
  severity: Severity;
  labels: FindingLabel[];
  certainty: number; // 1.0 deterministic, 0.5 judgement
  effortBase: number; // Fibonacci ≈ effort HOURS: 1 trivial, 3 small, 5 medium, 8 hard, 13 epic
  fixType: 'global' | 'per-page' | 'automated';
  yieldCoef?: number; // 6e: expected % traffic uplift from the fix (0–1). Omitted → derived from category×severity.
  title: string;
  fix: string;
  run(ctx: CheckContext): RawFinding[];
}

const rows = (ctx: CheckContext, sql: string, ...args: unknown[]): any[] => ctx.db.prepare(sql).all(...args);
// d is the finalised GSC date (partial trailing days already trimmed upstream); cap the window at
// it so checks never count unfinalised days. winPrev already caps below d, so it's unaffected.
const win = (d: string): string => `date > date('${d}', '-28 days') AND date <= '${d}'`;
// Prior 28-day window (the 28 days BEFORE the current window) — for period-over-period checks.
const winPrev = (d: string): string => `date <= date('${d}', '-28 days') AND date > date('${d}', '-56 days')`;
// Days of GSC history actually held — period-over-period checks need enough span to be meaningful.
const spanDays = (c: CheckContext): number => {
  const r = c.db.prepare(`SELECT julianday(MAX(date)) - julianday(MIN(date)) d FROM search_analytics`).get() as { d: number | null };
  return r?.d ?? 0;
};
// HTML pages only — match the MIME type before any charset parameter (mirrors isHtmlContentType).
const HTML_CT = `(LOWER(content_type) LIKE 'text/html%' OR LOWER(content_type) LIKE 'application/xhtml+xml%')`;
// Paginated archive URLs (/page/2, ?page=3, ?paged=2). They legitimately share titles/metas with
// page 1 and are intentionally absent from sitemaps, so they must NOT generate duplicate-title /
// duplicate-meta / missing-meta / not-in-sitemap false positives. Pass the column reference
// (e.g. 'url_key' or 'p.url_key') so it composes with table aliases.
const notPagination = (col = 'url_key'): string =>
  `${col} NOT GLOB '*/page/[0-9]*' AND ${col} NOT LIKE '%page=%' AND ${col} NOT LIKE '%paged=%'`;

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

// Position→expected-CTR curve lives in core/ctrModel (shared with the dashboard). Re-export it so
// existing `import { expectedCtr } from './checks.js'` call sites keep working.
export { expectedCtr };

export const CHECKS: CheckDef[] = [
  // ── On-page (crawl, deterministic) ──────────────────────────────────────
  {
    id: 'missing-title', category: 'onpage', severity: 'crit', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Missing title tag', fix: 'Add a unique, descriptive <title> (~50–60 chars).',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND ${HTML_CT} AND (title IS NULL OR TRIM(title)='')`).map(r => ({ urlKey: r.urlKey, evidence: {} })),
  },
  {
    id: 'duplicate-title', category: 'onpage', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Duplicate title tag', fix: 'Make each indexable page’s title unique.',
    run: (c) => rows(c, `SELECT url_key urlKey, title FROM pages WHERE status_code=200 AND indexable=1 AND ${notPagination()} AND title IS NOT NULL AND TRIM(title)!='' AND LOWER(TRIM(title)) IN (SELECT LOWER(TRIM(title)) FROM pages WHERE status_code=200 AND indexable=1 AND ${notPagination()} AND title IS NOT NULL GROUP BY LOWER(TRIM(title)) HAVING COUNT(*)>1)`).map(r => ({ urlKey: r.urlKey, evidence: { title: r.title } })),
  },
  {
    id: 'missing-meta-description', category: 'onpage', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Missing meta description', fix: 'Add a unique meta description (~120–155 chars).',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND indexable=1 AND ${notPagination()} AND (meta_description IS NULL OR TRIM(meta_description)='')`).map(r => ({ urlKey: r.urlKey, evidence: {} })),
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
    // RETIRED: 'canonical-mismatch' (was HIGH). A 200 page whose canonical points to a *healthy*
    // 200 indexable URL is intentional consolidation (slug variants, category merges) — normal SEO,
    // not an issue, yet it fired HIGH on every such page (pure noise). Every actionable case is
    // already covered by a higher-signal check: broken-canonical-target (unhealthy target),
    // canonical-ignored (Google ranks the non-canonical page), canonical-conflict (GSC disagrees).
    // So plain "canonical points elsewhere" has no high-confidence residual — removed.
    id: 'broken-internal-links', category: 'crawlability', severity: 'crit', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'automated',
    title: 'Internal links to 4xx/5xx', fix: 'Repoint internal links to a live, canonical URL.',
    run: (c) => rows(c, `SELECT l.target_key urlKey, p.status_code status, COUNT(DISTINCT l.source_key) sources FROM links l JOIN pages p ON p.url_key=l.target_key WHERE l.is_internal=1 AND p.status_code >= 400 AND p.status_code NOT IN (429,503) GROUP BY l.target_key`).map(r => ({ urlKey: r.urlKey, evidence: { status: r.status, linkingPages: r.sources } })),
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
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND ${HTML_CT} AND (security_headers IS NULL OR security_headers NOT LIKE '%hsts%') LIMIT 1`).map(r => ({ urlKey: r.urlKey, evidence: { note: 'representative page; HSTS is site-wide' } })),
  },
  // ── Merged GSC × crawl (the differentiator) ─────────────────────────────
  {
    id: 'noindex-with-traffic', category: 'indexation', severity: 'crit', labels: ['D', 'G'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Noindex page still getting clicks', fix: 'Remove noindex if the page should rank — it earns clicks.',
    run: (c) => c.gscMaxDate ? rows(c, `SELECT p.url_key urlKey, SUM(sa.clicks) clicks FROM pages p JOIN search_analytics sa ON sa.page_key=p.url_key WHERE p.noindex=1 AND sa.${win(c.gscMaxDate)} GROUP BY p.url_key HAVING SUM(sa.clicks)>0`).map(r => ({ urlKey: r.urlKey, evidence: { clicks: r.clicks } })) : [],
  },
  {
    id: 'orphan-with-impressions', category: 'merged', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Orphan page earning impressions', fix: 'Add internal links — Google ranks it but the site barely links to it. If it drives a large traffic share, protect it BEFORE any cleanup or migration (it is load-bearing).',
    run: (c) => {
      if (!c.gscMaxDate) return [];
      const total = (rows(c, `SELECT SUM(clicks) c FROM search_analytics WHERE ${win(c.gscMaxDate)}`)[0]?.c) || 1;
      return rows(c, `SELECT p.url_key urlKey, SUM(sa.impressions) impressions, SUM(sa.clicks) clicks FROM pages p JOIN search_analytics sa ON sa.page_key=p.url_key WHERE p.inlink_count=0 AND p.indexable=1 AND sa.${win(c.gscMaxDate)} GROUP BY p.url_key HAVING SUM(sa.impressions)>0 ORDER BY clicks DESC, impressions DESC`)
        .map(r => { const share = Math.round(r.clicks / total * 1000) / 10; return { urlKey: r.urlKey, evidence: { impressions: r.impressions, clicks: r.clicks, inlinks: 0, trafficShare: share + '%', ...(share >= 5 ? { note: `LOAD-BEARING orphan: drives ${share}% of site clicks with zero internal links — protect before any cleanup/migration` } : {}) } }; });
    },
  },
  {
    id: 'canonical-ignored', category: 'indexation', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Google may be ignoring the declared canonical', fix: 'This page declares a canonical pointing elsewhere, yet Google still ranks IT (real impressions) — Google is overriding the canonical, usually because the target is weaker or internal links favour this URL. Decide which URL you actually want indexed, then align both the canonical and the internal links to it.',
    run: (c) => c.gscMaxDate ? rows(c, `SELECT p.url_key urlKey, p.canonical_url canonical, SUM(sa.impressions) impressions, SUM(sa.clicks) clicks FROM pages p JOIN search_analytics sa ON sa.page_key=p.url_key WHERE p.canonical_key IS NOT NULL AND p.canonical_key != p.url_key AND sa.${win(c.gscMaxDate)} GROUP BY p.url_key HAVING SUM(sa.impressions) >= 50 ORDER BY impressions DESC LIMIT 40`).map(r => ({ urlKey: r.urlKey, evidence: { declaredCanonical: r.canonical, impressions: r.impressions, clicks: r.clicks, note: 'ranks despite pointing its canonical elsewhere' } })) : [],
  },
  {
    id: 'indexed-junk-url', category: 'indexation', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'Internal-search / faceted URL is indexed and ranking', fix: 'A URL whose signature is internal site-search, a faceted filter, or a tracking-param variant is earning Google impressions — it has been accidentally indexed. noindex or robots-block these and canonicalise filter URLs, so thin/duplicate pages stop bleeding index quality. (The query footprint proves it even when the DOM looks fine.)',
    run: (c) => {
      if (!c.gscMaxDate) return [];
      const junk = /[?&](q|s|search|keyword|orderby|sort_by|filter|variant|pf_|dppref|replytocom)=|\/search(-results)?\//i;
      return rows(c, `SELECT page_key urlKey, SUM(impressions) impressions, SUM(clicks) clicks FROM search_analytics WHERE page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key HAVING SUM(impressions) >= 30 ORDER BY SUM(impressions) DESC`)
        .filter(r => junk.test(r.urlKey)).slice(0, 40)
        .map(r => ({ urlKey: r.urlKey, evidence: { impressions: r.impressions, clicks: r.clicks, note: 'URL signature = internal search / facet / param — likely accidental indexation' } }));
    },
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
    // Only "no structured data" if there's no JSON-LD AND no Microdata/RDFa either — else a
    // page using valid Microdata (common on older themes) is falsely flagged.
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND indexable=1 AND (json_ld IS NULL OR json_ld='') AND COALESCE(has_microdata,0)=0 AND COALESCE(has_rdfa,0)=0`).map(r => ({ urlKey: r.urlKey, evidence: {} })),
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
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND ${HTML_CT} AND (viewport IS NULL OR viewport='')`).map(r => ({ urlKey: r.urlKey, evidence: {} })),
  },
  {
    id: 'keyword-cannibalisation', category: 'merged', severity: 'high', labels: ['G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Keyword cannibalisation', fix: 'Consolidate or differentiate — multiple URLs compete for one query.',
    // Only count URLs that actually rank for the query (impression-weighted position < 20) so a
    // page ranking #3 + a page at #85 isn't flagged; and exclude "dominance" where the two best
    // pages both sit in positions 1–2 (indented/double results are good, not cannibalisation).
    run: (c) => c.gscMaxDate ? rows(c, `
      WITH per_page AS (
        SELECT query, page_key, SUM(clicks) clicks, SUM(impressions) impressions,
               SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
        FROM search_analytics
        WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win(c.gscMaxDate)}
        GROUP BY query, page_key
        HAVING pos < 20
      )
      SELECT query, COUNT(*) urls, SUM(clicks) clicks, SUM(impressions) impressions, MIN(pos) bestPos, MAX(pos) worstPos
      FROM per_page GROUP BY query
      HAVING COUNT(*) >= 2 AND SUM(impressions) >= 50 AND NOT (MAX(pos) <= 2)
      ORDER BY impressions DESC LIMIT 40`).map(r => ({ urlKey: null, evidence: { query: r.query, competingUrls: r.urls, clicks: r.clicks, impressions: r.impressions, positions: `${Math.round(r.bestPos * 10) / 10}–${Math.round(r.worstPos * 10) / 10}` } })) : [],
  },
  {
    id: 'ctr-below-expected', category: 'merged', severity: 'high', labels: ['G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'CTR far below position-expected', fix: 'Rewrite title/meta — ranking well but under-clicked (snippet opportunity).',
    // High-confidence floor: ≥500 impressions/28d. A title/meta rewrite (HIGH, ~3h) is only
    // worth flagging where the snippet earns enough visibility for a CTR lift to pay back — a
    // 100-impression page at 1% vs 3% expected is a 2-clicks gap, not a HIGH issue.
    run: (c) => c.gscMaxDate ? rows(c, `SELECT page_key urlKey, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) position, SUM(clicks) clicks, SUM(impressions) impressions FROM search_analytics WHERE page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key HAVING SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) <= 10 AND SUM(impressions) >= 500`)
      .map(r => { const ctr = r.clicks / r.impressions; const exp = expectedCtr(r.position); return { urlKey: r.urlKey, ctr, exp, position: r.position, impressions: r.impressions }; })
      .filter(x => x.ctr < x.exp * 0.5)
      .map(x => {
        const ev: Record<string, unknown> = { position: Math.round(x.position * 10) / 10, ctr: Math.round(x.ctr * 1000) / 10 + '%', expectedCtr: Math.round(x.exp * 1000) / 10 + '%', impressions: x.impressions };
        // Extreme case: near-zero CTR at a strong position isn't a title problem — a SERP feature
        // (image/video/AI overview) or navigational intent is taking the clicks. Different fix.
        if (x.position <= 5 && x.ctr < x.exp * 0.15) ev.note = 'near-zero CTR for the position — likely a SERP feature or navigational intent taking the clicks; check the live SERP before rewriting the title/meta';
        return { urlKey: x.urlKey, evidence: ev };
      }) : [],
  },
  // ── Period-over-period (GSC history by date) — the trend questions SEOs live in ──
  {
    id: 'traffic-decay', category: 'merged', severity: 'high', labels: ['G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Page losing clicks (period-over-period)', fix: 'Refresh and expand the content, and check for lost rankings — this page’s Search Console clicks fell sharply against the previous 28 days.',
    run: (c) => (!c.gscMaxDate || spanDays(c) < 56) ? [] : rows(c, `
      WITH cur AS (SELECT page_key, SUM(clicks) c, SUM(impressions) i, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
                   FROM search_analytics WHERE page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key),
           prev AS (SELECT page_key, SUM(clicks) c FROM search_analytics WHERE page_key IS NOT NULL AND ${winPrev(c.gscMaxDate)} GROUP BY page_key)
      SELECT prev.page_key url, prev.c prevC, COALESCE(cur.c,0) curC, COALESCE(cur.i,0) curI, COALESCE(cur.pos,10) pos
      FROM prev LEFT JOIN cur ON cur.page_key=prev.page_key
      WHERE prev.c >= 30 AND COALESCE(cur.c,0) < prev.c * 0.6
      ORDER BY (prev.c - COALESCE(cur.c,0)) DESC LIMIT 40`)
      .map(r => ({ urlKey: null, evidence: { url: r.url, previousClicks: r.prevC, currentClicks: r.curC, clicksLost: r.prevC - r.curC, dropPercent: Math.round((1 - r.curC / r.prevC) * 100) + '%', clicks: r.prevC - r.curC, impressions: r.curI, position: Math.round(r.pos * 10) / 10 } })),
  },
  {
    id: 'lost-queries', category: 'merged', severity: 'med', labels: ['G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Query dropped out of rankings', fix: 'This query drove clicks last period and drives none now — find the page that ranked, check for de-indexing or lost rankings, and win it back.',
    run: (c) => (!c.gscMaxDate || spanDays(c) < 56) ? [] : rows(c, `
      WITH cur AS (SELECT query, SUM(clicks) c FROM search_analytics WHERE query IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY query),
           prev AS (SELECT query, SUM(clicks) c, SUM(impressions) i FROM search_analytics WHERE query IS NOT NULL AND ${winPrev(c.gscMaxDate)} GROUP BY query)
      SELECT prev.query query, prev.c prevC, prev.i prevI FROM prev LEFT JOIN cur ON cur.query=prev.query
      WHERE prev.c >= 10 AND COALESCE(cur.c,0)=0
      ORDER BY prev.c DESC LIMIT 40`)
      .map(r => ({ urlKey: null, evidence: { query: r.query, previousClicks: r.prevC, currentClicks: 0, clicks: r.prevC, impressions: r.prevI } })),
  },
  {
    id: 'position-slipping', category: 'merged', severity: 'high', labels: ['G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Page-1 ranking slipping', fix: 'Average position for this query worsened by 3+ spots vs the previous 28 days while it was still on page one — investigate the ranking loss before the clicks follow it down.',
    run: (c) => (!c.gscMaxDate || spanDays(c) < 56) ? [] : rows(c, `
      WITH cur AS (SELECT query, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos, SUM(impressions) i, SUM(clicks) c
                   FROM search_analytics WHERE query IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY query HAVING SUM(impressions) >= 100),
           prev AS (SELECT query, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos FROM search_analytics WHERE query IS NOT NULL AND ${winPrev(c.gscMaxDate)} GROUP BY query)
      SELECT cur.query query, prev.pos prevPos, cur.pos curPos, cur.i i, cur.c c FROM cur JOIN prev ON prev.query=cur.query
      WHERE prev.pos <= 10 AND cur.pos - prev.pos >= 3
      ORDER BY (cur.pos - prev.pos) * cur.i DESC LIMIT 40`)
      .map(r => ({ urlKey: null, evidence: { query: r.query, previousPosition: Math.round(r.prevPos * 10) / 10, currentPosition: Math.round(r.curPos * 10) / 10, slippedBy: Math.round((r.curPos - r.prevPos) * 10) / 10, impressions: r.i, clicks: r.c, position: Math.round(r.curPos * 10) / 10 } })),
  },
  {
    id: 'index-bloat', category: 'indexation', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Indexable page with no search traffic', fix: 'No impressions in 90 days despite being indexable — consolidate, improve, or noindex/prune to concentrate crawl budget and internal authority (confirm it isn’t seasonal or brand-new first).',
    run: (c) => (!c.gscMaxDate || spanDays(c) < 90) ? [] : rows(c, `SELECT url_key urlKey, ipr FROM pages WHERE status_code=200 AND indexable=1 AND ${HTML_CT} AND click_depth >= 1 AND url_key NOT IN (SELECT DISTINCT page_key FROM search_analytics WHERE page_key IS NOT NULL AND date <= '${c.gscMaxDate}' AND date > date('${c.gscMaxDate}','-90 days') AND impressions > 0) ORDER BY ipr DESC LIMIT 100`).map(r => ({ urlKey: r.urlKey, evidence: { note: 'indexable but zero impressions in 90 days', ipr: Math.round(r.ipr) } })),
  },
  // ── On-page parity (crawl-only, deterministic) ──
  {
    id: 'duplicate-meta-description', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Duplicate meta description', fix: 'Give each indexable page a unique meta description.',
    run: (c) => rows(c, `SELECT url_key urlKey, meta_description md FROM pages WHERE status_code=200 AND indexable=1 AND ${notPagination()} AND meta_description IS NOT NULL AND TRIM(meta_description)!='' AND LOWER(TRIM(meta_description)) IN (SELECT LOWER(TRIM(meta_description)) FROM pages WHERE status_code=200 AND indexable=1 AND ${notPagination()} AND meta_description IS NOT NULL AND TRIM(meta_description)!='' GROUP BY LOWER(TRIM(meta_description)) HAVING COUNT(*)>1)`).map(r => ({ urlKey: r.urlKey, evidence: { metaDescription: r.md } })),
  },
  {
    id: 'title-h1-mismatch', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Title and H1 share no significant words', fix: 'Align the <title> and <h1> — they currently have no significant words in common, which blurs the page’s topic signal.',
    run: (c) => rows(c, `SELECT url_key urlKey, title, h1 FROM pages WHERE status_code=200 AND indexable=1 AND title IS NOT NULL AND TRIM(title)!='' AND h1 IS NOT NULL AND TRIM(h1)!=''`)
      .filter(r => { const tt = terms(r.title), th = terms(r.h1); if (tt.length < 2 || th.length < 2) return false; const set = new Set(th); return !tt.some(w => set.has(w)); })
      .map(r => ({ urlKey: r.urlKey, evidence: { title: r.title, h1: r.h1 } })),
  },
  {
    id: 'rising-pages', category: 'merged', severity: 'low', labels: ['G'], certainty: 1, effortBase: 2, fixType: 'per-page',
    title: 'Page gaining clicks fast (double down)', fix: 'Clicks jumped vs the previous 28 days — reinforce it with internal links and related content while the momentum is there.',
    run: (c) => (!c.gscMaxDate || spanDays(c) < 56) ? [] : rows(c, `
      WITH cur AS (SELECT page_key, SUM(clicks) c, SUM(impressions) i, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos FROM search_analytics WHERE page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key),
           prev AS (SELECT page_key, SUM(clicks) c FROM search_analytics WHERE page_key IS NOT NULL AND ${winPrev(c.gscMaxDate)} GROUP BY page_key)
      SELECT cur.page_key url, COALESCE(prev.c,0) prevC, cur.c curC, cur.i curI, COALESCE(cur.pos,10) pos
      FROM cur LEFT JOIN prev ON prev.page_key=cur.page_key
      WHERE cur.c >= 30 AND cur.c >= COALESCE(prev.c,0) * 1.5
      ORDER BY (cur.c - COALESCE(prev.c,0)) DESC LIMIT 25`)
      .map(r => ({ urlKey: null, evidence: { url: r.url, previousClicks: r.prevC, currentClicks: r.curC, clicksGained: r.curC - r.prevC, clicks: r.curC, impressions: r.curI, position: Math.round(r.pos * 10) / 10 } })),
  },
  {
    id: 'traffic-to-dead-url', category: 'merged', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Search traffic to a dead (non-200) URL', fix: 'Google still sends clicks/impressions to this URL but the crawl returns a 4xx/5xx — recover the page or 301 it to the best live equivalent so the demand isn’t lost. (The "directive contradicts reality" join: you rank for a page that no longer works.)',
    run: (c) => c.gscMaxDate ? rows(c, `SELECT p.url_key urlKey, p.status_code st, SUM(sa.clicks) clicks, SUM(sa.impressions) impressions FROM pages p JOIN search_analytics sa ON sa.page_key=p.url_key WHERE p.status_code >= 400 AND sa.${win(c.gscMaxDate)} GROUP BY p.url_key HAVING SUM(sa.impressions) >= 10 ORDER BY clicks DESC, impressions DESC LIMIT 40`)
      .map(r => ({ urlKey: r.urlKey, evidence: { status: r.st, clicks: r.clicks, impressions: r.impressions, note: `HTTP ${r.st} but still earning search traffic` } })) : [],
  },
  {
    id: 'impressions-rising-clicks-flat', category: 'merged', severity: 'high', labels: ['G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Impressions rising but clicks flat (CTR erosion)', fix: 'Google is showing this page MORE than it used to, yet you’re not winning more clicks — a stale title/meta, or a SERP feature (AI overview, snippet, pack) is taking them. Rewrite the snippet or target the feature.',
    run: (c) => (!c.gscMaxDate || spanDays(c) < 56) ? [] : rows(c, `
      WITH cur AS (SELECT page_key, SUM(clicks) c, SUM(impressions) i, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos FROM search_analytics WHERE page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key),
           prev AS (SELECT page_key, SUM(clicks) c, SUM(impressions) i FROM search_analytics WHERE page_key IS NOT NULL AND ${winPrev(c.gscMaxDate)} GROUP BY page_key)
      SELECT cur.page_key url, prev.i prevImpr, cur.i curImpr, prev.c prevClicks, cur.c curClicks, cur.pos pos
      FROM cur JOIN prev ON prev.page_key=cur.page_key
      WHERE prev.i >= 200 AND cur.i >= prev.i * 1.3 AND cur.c <= prev.c
      ORDER BY (cur.i - prev.i) DESC LIMIT 40`)
      .map(r => ({ urlKey: null, evidence: { url: r.url, previousImpressions: r.prevImpr, currentImpressions: r.curImpr, impressionsChange: '+' + Math.round((r.curImpr / r.prevImpr - 1) * 100) + '%', previousClicks: r.prevClicks, currentClicks: r.curClicks, impressions: r.curImpr, clicks: r.curClicks, position: Math.round(r.pos * 10) / 10 } })),
  },
  {
    id: 'h1-missing-top-query', category: 'merged', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Top query missing from the H1', fix: 'Work the page’s top-performing query into the <h1> — it ranks for this term but the main heading doesn’t mention it.',
    run: (c) => {
      if (!c.gscMaxDate) return [];
      const r = rows(c, `SELECT s.page_key urlKey, s.query query, s.impr impressions, p.h1 h1 FROM
        (SELECT page_key, query, SUM(impressions) impr, ROW_NUMBER() OVER (PARTITION BY page_key ORDER BY SUM(impressions) DESC) rn
         FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key, query) s
        JOIN pages p ON p.url_key = s.page_key
        WHERE s.rn = 1 AND p.indexable = 1 AND p.h1 IS NOT NULL AND p.h1 != '' AND s.impr >= 100`);
      return r.filter(x => { const q = terms(x.query); return q.length > 0 && !q.some(w => titleHasTerm(x.h1, w)); })
        .map(x => ({ urlKey: x.urlKey, evidence: { topQuery: x.query, impressions: x.impressions, h1: x.h1 } }));
    },
  },
  {
    id: 'high-ipr-no-traffic', category: 'merged', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Internal authority wasted on a no-traffic page', fix: 'High internal link equity (iPR) and Google does rank it (it earns impressions), yet it gets zero clicks — rewrite the title/snippet or improve the page, or repoint that authority to pages that convert it. (Requires impressions, so functional pages with no search demand are excluded.)',
    run: (c) => (!c.gscMaxDate || spanDays(c) < 90) ? [] : rows(c, `SELECT p.url_key urlKey, p.ipr ipr, p.inlink_count inl, SUM(sa.impressions) impressions
      FROM pages p JOIN search_analytics sa ON sa.page_key=p.url_key
      WHERE p.indexable=1 AND p.ipr >= 50 AND p.click_depth >= 1 AND sa.date <= '${c.gscMaxDate}' AND sa.date > date('${c.gscMaxDate}','-90 days')
      GROUP BY p.url_key HAVING SUM(sa.clicks)=0 AND SUM(sa.impressions) >= 100
      ORDER BY p.ipr DESC LIMIT 50`).map(r => ({ urlKey: r.urlKey, evidence: { ipr: Math.round(r.ipr), inlinks: r.inl, impressions: r.impressions, clicks: 0, note: 'high internal authority + impressions, zero clicks in 90 days' } })),
  },
  {
    id: 'homepage-missing-org-schema', category: 'schema', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'Homepage missing Organization / WebSite schema', fix: 'Add Organization (or LocalBusiness) and WebSite JSON-LD to the homepage — it underpins the knowledge panel, logo and sitelinks search box.',
    run: (c) => {
      const hp = (rows(c, `SELECT url_key urlKey, json_ld jsonLd FROM pages WHERE status_code=200 AND click_depth=0 LIMIT 1`)[0]
        ?? rows(c, `SELECT url_key urlKey, json_ld jsonLd FROM pages WHERE status_code=200 ORDER BY inlink_count DESC LIMIT 1`)[0]);
      if (!hp) return [];
      const types = new Set(parseJsonLdNodes(hp.jsonLd).map(nodeType).filter(Boolean));
      const ok = ['Organization', 'LocalBusiness', 'Corporation', 'OnlineStore', 'WebSite'].some(t => types.has(t));
      return ok ? [] : [{ urlKey: hp.urlKey, evidence: { found: [...types].join(', ') || 'none', note: 'no Organization/WebSite node on the homepage' } }];
    },
  },
  {
    id: 'breadcrumb-schema-inconsistent', category: 'schema', severity: 'low', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Breadcrumb schema missing on some pages', fix: 'Add BreadcrumbList JSON-LD — most of the site has it, so these pages are inconsistent and miss breadcrumb rich results.',
    run: (c) => {
      const pages = rows(c, `SELECT url_key urlKey, json_ld jsonLd, click_depth cd FROM pages WHERE status_code=200 AND indexable=1`);
      let withBc = 0; const without: string[] = [];
      for (const p of pages) {
        if (parseJsonLdNodes(p.jsonLd).some(n => nodeType(n) === 'BreadcrumbList')) withBc++;
        else if ((p.cd ?? 0) >= 2) without.push(p.urlKey);
      }
      if (pages.length === 0 || withBc / pages.length < 0.4) return []; // site doesn't use breadcrumbs → design choice, not a bug
      return without.map(u => ({ urlKey: u, evidence: { note: 'site uses BreadcrumbList elsewhere; missing here' } }));
    },
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
  // NOTE: internal anchor-text checks (over-optimisation + generic/empty anchors) prototyped
  // and PULLED twice. Re-evaluated 2026-06-22 against the AgricIDaniel/claude-seo and
  // Bhanunamikaze/Agentic-SEO-Skill repos, this time using the links.placement='body' filter
  // plus excluding anchors that match the target's own title/H1. On real data (ehi.com.au) the
  // dominant survivors are still false positives: sitewide template CTAs ("home" 864/865,
  // "contact us", "apply today") and category links whose anchor IS the page title. The
  // page-level "mostly generic-anchored" variant returned 0 signal; raw empty anchors are
  // image/thumbnail-link noise (3,764/23,435 body links). Reliable detection needs an
  // editorial-vs-template link classifier we don't store (placement='body' still includes
  // in-template CTAs and product grids). Keep pulled — a wrong finding is worse than none.

  // ── Backlinks (need page_backlinks populated via pull_backlinks; gate so we never assert
  //    "no external links" without data) ──
  {
    id: 'backlinks-to-404', category: 'crawlability', severity: 'crit', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'External backlinks pointing to a dead page', fix: '301-redirect this URL to the best live equivalent — external link equity is hitting a 4xx/5xx page and being wasted.',
    run: (c) => rows(c, `SELECT url_key urlKey, backlinks, referring_domains rd, status_code st FROM page_backlinks WHERE status_code >= 400 AND backlinks > 0 ORDER BY backlinks DESC`)
      .map(r => ({ urlKey: r.urlKey, evidence: { status: r.st, backlinks: r.backlinks, referringDomains: r.rd } })),
  },
  {
    id: 'orphan-no-links', category: 'crawlability', severity: 'med', labels: ['D'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Orphan page — no internal or external links', fix: 'Add internal links (and earn external ones) — this indexable page has zero inlinks and no backlinks, so it depends on the sitemap alone.',
    run: (c) => {
      const has = (c.db.prepare('SELECT COUNT(*) n FROM page_backlinks').get() as { n: number }).n;
      if (!has) return []; // backlinks not pulled — can't credibly assert "no external links"
      return rows(c, `SELECT p.url_key urlKey FROM pages p LEFT JOIN page_backlinks b ON b.url_key=p.url_key WHERE p.status_code=200 AND p.indexable=1 AND p.inlink_count=0 AND COALESCE(b.backlinks,0)=0`)
        .map(r => ({ urlKey: r.urlKey, evidence: { inlinks: 0, backlinks: 0 } }));
    },
  },

  // ── Phase 6a — expert questions where crawl (intent) and reality diverge ──
  {
    id: 'ipr-bleed-by-status', category: 'crawlability', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'automated',
    title: 'Internal link equity flowing into dead URLs', fix: 'Repoint or 301 these internal links — they target non-200 URLs and waste the internal PageRank of the (often high-authority) pages linking to them.',
    // Sum the iPR of the SOURCE pages linking to each non-200 internal target. "Found a 404" is
    // junior; "this 404 drains the equity of N high-iPR pages" is the director-level find.
    run: (c) => rows(c, `SELECT l.target_key urlKey, COUNT(DISTINCT l.source_key) linkingPages,
        ROUND(SUM(src.ipr), 1) wastedIpr, t.status_code st
      FROM links l
      JOIN pages src ON src.url_key = l.source_key
      JOIN pages t   ON t.url_key   = l.target_key
      WHERE l.is_internal = 1 AND t.status_code >= 400 AND t.status_code NOT IN (429,503)
      GROUP BY l.target_key HAVING SUM(src.ipr) > 0
      ORDER BY wastedIpr DESC`).map(r => ({ urlKey: r.urlKey, evidence: { status: r.st, linkingPages: r.linkingPages, wastedIpr: r.wastedIpr } })),
  },
  {
    id: 'broken-canonical-target', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Canonical points to a broken or unhealthy URL', fix: 'Point the canonical at a live, indexable, self-canonical HTTPS URL — Google ignores a canonical whose target is a 4xx/5xx/redirect, noindex, itself canonicalised elsewhere (a chain/loop), or an HTTPS→HTTP downgrade.',
    // Join the declared canonical_key back to the crawl. Only flag when we crawled the target.
    // Skip self-canonicals. Covers: non-200 target, noindex target, canonical chain/loop (target
    // canonicalises onward), and HTTPS→HTTP downgrade (research: Sitebulb indexability hints).
    run: (c) => rows(c, `SELECT p.url_key urlKey, p.canonical_url canon, p.canonical_key ck, t.status_code st, t.noindex ni, t.canonical_key tck
      FROM pages p JOIN pages t ON t.url_key = p.canonical_key
      WHERE p.canonical_key IS NOT NULL AND p.canonical_key != p.url_key AND p.status_code = 200
        AND (t.status_code != 200 OR t.noindex = 1
          OR (t.canonical_key IS NOT NULL AND t.canonical_key != t.url_key)
          OR (p.url_key LIKE 'https://%' AND p.canonical_url LIKE 'http://%'))`)
      .map(r => {
        const reason = r.st !== 200 ? `target returns HTTP ${r.st}`
          : r.ni ? 'target is noindex'
          : (r.tck && r.tck !== r.ck) ? (r.tck === r.urlKey ? 'canonical loop (target points back here)' : 'canonical chain (target canonicalises onward)')
          : 'HTTPS page canonicalises to an HTTP URL';
        return { urlKey: r.urlKey, evidence: { canonical: r.canon, targetStatus: r.st, reason } };
      }),
  },
  {
    id: 'faceted-spider-trap', category: 'crawlability', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 5, fixType: 'global',
    title: 'Indexable faceted URLs burning crawl budget', fix: 'noindex (or robots-disallow / canonicalise) multi-parameter filter URLs — they are indexable but earn zero search traffic, so they only waste crawl budget and risk index bloat.',
    // Multi-parameter (>=2 params), indexable, zero GSC impressions in-window = classic facet trap.
    // Gate on GSC so "zero search value" is a real claim, not just "no data".
    run: (c) => {
      if (!c.gscMaxDate) return [];
      return rows(c, `SELECT url_key urlKey, url FROM pages
        WHERE status_code = 200 AND indexable = 1 AND url LIKE '%?%' AND url LIKE '%&%'
          AND url_key NOT IN (SELECT page_key FROM search_analytics WHERE page_key IS NOT NULL AND ${win(c.gscMaxDate)} AND impressions > 0)
        ORDER BY url`).map(r => ({ urlKey: r.urlKey, evidence: { url: r.url, params: (r.url.split('?')[1] ?? '').split('&').map((kv: string) => kv.split('=')[0]).join(', '), note: 'indexable, multi-parameter, zero GSC impressions' } }));
    },
  },
  {
    id: 'soft-404-shell', category: 'indexation', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Soft 404 — 200 OK but Google treats it as not-found', fix: 'Either populate the page with real content, or return a true 404/410 (or noindex) — it serves 200 but Google has flagged it as a soft 404.',
    // URL Inspection page-fetch-state = soft 404 while the crawler sees a 200. The crawler alone
    // would call this page fine; Google disagrees. Needs URL Inspection populated.
    run: (c) => rows(c, `SELECT i.url_key urlKey, p.word_count wc, p.bytes bytes
      FROM url_inspection i JOIN pages p ON p.url_key = i.url_key
      WHERE LOWER(i.page_fetch_state) LIKE '%soft%' AND p.status_code = 200`).map(r => ({ urlKey: r.urlKey, evidence: { pageFetchState: 'soft 404', wordCount: r.wc, bytes: r.bytes } })),
  },
  {
    id: 'broken-hreflang-target', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'hreflang points to a broken/non-indexable URL', fix: 'Point each hreflang alternate at a live, indexable URL — Google drops the whole cluster if an alternate is 4xx/5xx/redirect/noindex.',
    run: (c) => hreflangFindings(c).broken,
  },
  {
    id: 'hreflang-no-return-tag', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'hreflang missing return tag (not reciprocated)', fix: 'Add the reciprocal hreflang on the target page — Google ignores one-way hreflang annotations that don’t link back.',
    run: (c) => hreflangFindings(c).noReturn,
  },

  // ── 6a finishers — consume persisted DataForSEO enrichments (gated; need the data pulled) ──
  {
    id: 'intent-vs-pagetype-mismatch', category: 'merged', severity: 'med', labels: ['G', 'N'], certainty: 0.7, effortBase: 8, fixType: 'per-page',
    title: 'Page type mismatches its query intent', fix: 'Reformat or retarget the page — its template doesn’t match the SERP intent for its top query (e.g. a product page ranking for an informational query, or an article for a transactional one). Run search_intent siteUrl:<property> to populate intents.',
    // Join each page's top GSC query → persisted keyword_intent → page schema flavour (from json_ld).
    // Judgement (N, 0.7): intent + schema-type inference is heuristic, so it only runs with includeJudgement.
    run: (c) => {
      if (!c.gscMaxDate) return [];
      if (((c.db.prepare('SELECT COUNT(*) n FROM keyword_intent').get() as { n: number }).n) === 0) return []; // intents not pulled
      const r = rows(c, `SELECT s.page_key urlKey, s.query query, ki.intent intent, p.json_ld jsonLd FROM
        (SELECT page_key, query, ROW_NUMBER() OVER (PARTITION BY page_key ORDER BY SUM(impressions) DESC) rn
         FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key, query) s
        JOIN pages p ON p.url_key = s.page_key
        JOIN keyword_intent ki ON ki.keyword = LOWER(s.query)
        WHERE s.rn = 1 AND p.status_code = 200 AND p.json_ld IS NOT NULL AND p.json_ld != ''`);
      const out: RawFinding[] = [];
      for (const x of r) {
        const types = parseJsonLdNodes(x.jsonLd).map(n => (nodeType(n) ?? '').toLowerCase());
        const productish = types.some(t => t === 'product' || t === 'offer');
        const articleish = types.some(t => /article|blogposting|newsarticle/.test(t));
        const intent = (x.intent || '').toLowerCase();
        let mismatch: string | null = null;
        if (productish && intent === 'informational') mismatch = 'product/offer page ranking for an informational query';
        else if (articleish && intent === 'transactional') mismatch = 'article page ranking for a transactional query';
        if (mismatch) out.push({ urlKey: x.urlKey, evidence: { topQuery: x.query, queryIntent: intent, mismatch } });
      }
      return out;
    },
  },
  {
    id: 'high-yield-cwv-fail', category: 'performance', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 8, fixType: 'per-page',
    title: 'High-traffic page failing Core Web Vitals', fix: 'Prioritise CWV work here — this page earns real clicks but fails lab Core Web Vitals (LCP > 2.5s, CLS > 0.1, or performance < 50), so engineering effort has clear ROI. Run page_lighthouse siteUrl:<property> on key URLs to populate CWV.',
    run: (c) => {
      if (!c.gscMaxDate) return [];
      if (((c.db.prepare('SELECT COUNT(*) n FROM page_cwv').get() as { n: number }).n) === 0) return []; // CWV not pulled
      return rows(c, `SELECT cw.url_key urlKey, cw.lcp_ms lcp, cw.cls cls, cw.performance perf,
          (SELECT COALESCE(SUM(clicks),0) FROM search_analytics sa WHERE sa.page_key = cw.url_key AND ${win(c.gscMaxDate)}) clicks
        FROM page_cwv cw
        WHERE (cw.lcp_ms > 2500 OR cw.cls > 0.1 OR cw.performance < 0.5)`)
        .filter(r => r.clicks > 0)
        .map(r => ({ urlKey: r.urlKey, evidence: { clicks: r.clicks, lcpMs: r.lcp != null ? Math.round(r.lcp) : null, cls: r.cls != null ? Math.round(r.cls * 1000) / 1000 : null, performance: r.perf != null ? Math.round(r.perf * 100) : null } }));
    },
  },

  // ── 6b — per-template systemic issues (template-typed, deterministic) ──
  {
    id: 'pagination-canonical-to-page-1', category: 'crawlability', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'Paginated pages canonicalising away from themselves', fix: 'Make each paginated page (page 2, 3, …) self-canonical. Canonicalising page 2+ back to page 1 tells Google the deeper pages are duplicates, so products/articles linked only from page 2+ drop out of the crawl.',
    run: (c) => rows(c, `SELECT url_key urlKey, url, canonical_url canon FROM pages
        WHERE status_code=200 AND canonical_count>0 AND canonical_key IS NOT NULL AND canonical_key != url_key
          AND (rel_prev=1 OR url LIKE '%/page/%' OR url LIKE '%page=%' OR url LIKE '%?p=%' OR url LIKE '%&p=%')`)
      .filter(r => !/[?&](page|p)=1(\b|&|$)/.test(r.url) && !/\/page\/1(\/?$|\?)/.test(r.url)) // page 1 self-canonicalising to base is fine
      .map(r => ({ urlKey: r.urlKey, evidence: { url: r.url, canonical: r.canon } })),
  },
  {
    id: 'article-date-illogical', category: 'schema', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Article dateModified earlier than datePublished', fix: 'Fix the Article schema dates — dateModified must be on or after datePublished. An impossible date undermines trust in the markup and can suppress the freshness signal.',
    run: (c) => {
      const out: RawFinding[] = [];
      for (const r of rows(c, `SELECT url_key urlKey, json_ld jsonLd FROM pages WHERE status_code=200 AND json_ld LIKE '%Article%' AND json_ld LIKE '%date%'`)) {
        for (const n of parseJsonLdNodes(r.jsonLd)) {
          const t = nodeType(n);
          if (!t || !/article|blogposting|newsarticle/i.test(t)) continue;
          const pub = Date.parse(n.datePublished), mod = Date.parse(n.dateModified);
          if (!Number.isNaN(pub) && !Number.isNaN(mod) && mod < pub) { out.push({ urlKey: r.urlKey, evidence: { datePublished: n.datePublished, dateModified: n.dateModified } }); break; }
        }
      }
      return out;
    },
  },

  // ── 6d — Wikidata entity layer (heuristic H1→QID; N/judgement, gated on resolve_entities) ──
  {
    id: 'entity-internal-link-gap', category: 'crawlability', severity: 'low', labels: ['N'], certainty: 0.5, effortBase: 3, fixType: 'per-page',
    title: 'Topically related pages not internally linked', fix: 'Add an internal link from the broader page to the more specific one — Wikidata says their entities are related (subclass-of / part-of) but no internal link connects them, leaving a gap in the topical mesh. Run resolve_entities first; verify the entity match before acting (heuristic).',
    run: (c) => {
      if (((c.db.prepare('SELECT COUNT(*) n FROM page_entity').get() as { n: number }).n) === 0) return []; // not resolved
      return rows(c, `SELECT parent.url_key urlKey, child.url_key target, parent.label pl, child.label cl, ee.relation rel
        FROM entity_edge ee
        JOIN page_entity child  ON child.qid = ee.qid
        JOIN page_entity parent ON parent.qid = ee.related_qid
        WHERE parent.url_key != child.url_key
          AND NOT EXISTS (SELECT 1 FROM links l WHERE l.source_key = parent.url_key AND l.target_key = child.url_key AND l.is_internal = 1)`)
        .map(r => ({ urlKey: r.urlKey, evidence: { suggestLinkTo: r.target, parentEntity: r.pl, childEntity: r.cl, relation: r.rel } }));
    },
  },

  // ── Sitemap ↔ crawl reconciliation (gated on a sitemap having been fetched) ──
  {
    id: 'sitemap-non-indexable', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'Sitemap lists non-indexable URLs', fix: 'Remove URLs from the XML sitemap that are 4xx/5xx, redirected, noindex, canonicalised or robots-blocked — the sitemap should list only canonical, indexable pages, or Google loses trust in it.',
    run: (c) => {
      if (!sitemapHasRows(c)) return [];
      return rows(c, `SELECT s.url_key urlKey, p.indexable_reason reason, p.status_code st FROM sitemap_urls s JOIN pages p ON p.url_key = s.url_key WHERE p.indexable = 0`)
        .map(r => ({ urlKey: r.urlKey, evidence: { reason: r.reason ?? 'not-indexable', status: r.st } }));
    },
  },
  {
    id: 'indexable-not-in-sitemap', category: 'indexation', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'Indexable pages missing from the sitemap', fix: 'Add these indexable pages to the XML sitemap so Google discovers and prioritises them.',
    run: (c) => {
      if (!sitemapHasRows(c)) return [];
      return rows(c, `SELECT p.url_key urlKey FROM pages p LEFT JOIN sitemap_urls s ON s.url_key = p.url_key WHERE p.status_code = 200 AND p.indexable = 1 AND ${notPagination('p.url_key')} AND s.url_key IS NULL`)
        .map(r => ({ urlKey: r.urlKey, evidence: {} }));
    },
  },
  {
    id: 'sitemap-orphan', category: 'crawlability', severity: 'low', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Sitemap page with no internal links', fix: 'Add internal links — this page is in the sitemap but nothing links to it, so it relies on the sitemap alone for discovery and earns little internal authority.',
    run: (c) => {
      if (!sitemapHasRows(c)) return [];
      return rows(c, `SELECT p.url_key urlKey FROM pages p JOIN sitemap_urls s ON s.url_key = p.url_key WHERE p.status_code = 200 AND p.indexable = 1 AND p.inlink_count = 0`)
        .map(r => ({ urlKey: r.urlKey, evidence: { inlinks: 0, note: 'in sitemap, no internal links' } }));
    },
  },

  // ── Cheap performance proxies (from data captured at crawl time — no extra fetch) ──
  {
    id: 'slow-response', category: 'performance', severity: 'med', labels: ['D'], certainty: 1, effortBase: 5, fixType: 'global',
    title: 'Slow server response (TTFB proxy)', fix: 'Investigate slow server/TTFB — caching, CDN, or backend. Response time over ~1.5s hurts Core Web Vitals and crawl rate.',
    run: (c) => rows(c, `SELECT url_key urlKey, response_time_ms ms FROM pages WHERE status_code=200 AND ${HTML_CT} AND response_time_ms > 1500 ORDER BY response_time_ms DESC`)
      .map(r => ({ urlKey: r.urlKey, evidence: { responseMs: r.ms } })),
  },
  {
    id: 'large-html', category: 'performance', severity: 'low', labels: ['D'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Large HTML document', fix: 'Trim the HTML payload (over ~150KB) — bloated markup slows render and First Contentful Paint. Often huge inline SVG/CSS/JSON or unminified output.',
    run: (c) => rows(c, `SELECT url_key urlKey, bytes FROM pages WHERE status_code=200 AND ${HTML_CT} AND bytes > 150000 ORDER BY bytes DESC`)
      .map(r => ({ urlKey: r.urlKey, evidence: { bytes: r.bytes } })),
  },
  {
    id: 'uncompressed-html', category: 'performance', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'HTML served without compression', fix: 'Enable gzip or brotli for HTML responses — uncompressed HTML wastes bandwidth and slows load. Usually a one-line server/CDN setting.',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND ${HTML_CT} AND (content_encoding IS NULL OR content_encoding='')`)
      .map(r => ({ urlKey: r.urlKey, evidence: {} })),
  },
];

const sitemapHasRows = (c: CheckContext): boolean =>
  ((c.db.prepare('SELECT COUNT(*) n FROM sitemap_urls').get() as { n: number }).n) > 0;

// hreflang checks share parsing/normalisation: hrefs are stored RAW, so resolve each against the
// page URL then urlKey() with the property's host_form so they match pages.url_key. Computed once.
type HreflangOut = { broken: RawFinding[]; noReturn: RawFinding[] };
let _hreflangCache: { db: Database.Database; out: HreflangOut } | null = null;
function hreflangFindings(ctx: CheckContext): HreflangOut {
  if (_hreflangCache && _hreflangCache.db === ctx.db) return _hreflangCache.out;
  const hostForm = (ctx.db.prepare(`SELECT host_form h FROM property_meta LIMIT 1`).get() as { h: string } | undefined)?.h as
    | 'apex' | 'www' | 'asis' | undefined;
  const opts = { hostForm: hostForm ?? 'asis' };
  const pageRows = ctx.db.prepare(`SELECT url_key, url, status_code, noindex, hreflang FROM pages WHERE hreflang IS NOT NULL AND hreflang != ''`).all() as
    { url_key: string; url: string; status_code: number | null; noindex: number | null; hreflang: string }[];
  const status = new Map<string, { status: number | null; noindex: number | null }>();
  for (const p of ctx.db.prepare(`SELECT url_key, status_code, noindex FROM pages`).all() as { url_key: string; status_code: number | null; noindex: number | null }[])
    status.set(p.url_key, { status: p.status_code, noindex: p.noindex });

  // declared[sourceKey] = set of internal alternate targetKeys (excluding x-default + self)
  const declared = new Map<string, Set<string>>();
  const parsed: { srcKey: string; targets: { key: string; lang: string }[] }[] = [];
  for (const p of pageRows) {
    let arr: { lang: string; href: string }[];
    try { arr = JSON.parse(p.hreflang); } catch { continue; }
    const targets: { key: string; lang: string }[] = [];
    for (const { lang, href } of arr) {
      if (!href) continue;
      let key: string;
      try { key = urlKey(new URL(href, p.url).toString(), opts); } catch { continue; }
      if (key === p.url_key) continue; // self-reference
      targets.push({ key, lang: (lang || '').toLowerCase() });
    }
    parsed.push({ srcKey: p.url_key, targets });
    declared.set(p.url_key, new Set(targets.filter(t => t.lang !== 'x-default').map(t => t.key)));
  }

  const broken: RawFinding[] = [];
  const noReturn: RawFinding[] = [];
  for (const { srcKey, targets } of parsed) {
    const brokenTargets: string[] = [];
    const missingReturn: string[] = [];
    for (const t of targets) {
      const st = status.get(t.key);
      if (st && (st.status !== 200 || st.noindex === 1)) brokenTargets.push(t.key);
      // reciprocation only for internal, live (200) targets we crawled, excluding x-default
      // (a broken target is already reported by broken-hreflang-target — don't double-flag)
      if (t.lang !== 'x-default' && st && st.status === 200 && st.noindex !== 1 && !(declared.get(t.key)?.has(srcKey))) missingReturn.push(t.key);
    }
    if (brokenTargets.length) broken.push({ urlKey: srcKey, evidence: { brokenAlternates: brokenTargets.slice(0, 10), count: brokenTargets.length } });
    if (missingReturn.length) noReturn.push({ urlKey: srcKey, evidence: { missingReturnFrom: missingReturn.slice(0, 10), count: missingReturn.length } });
  }
  _hreflangCache = { db: ctx.db, out: { broken, noReturn } };
  return { broken, noReturn };
}
