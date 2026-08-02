import type Database from 'better-sqlite3';
import type { FindingLabel, Severity } from '../core/AuditDatabase.js';
import { validateJsonLdColumn, type SchemaIssueKind } from './schema-validate.js';
import { urlKey } from '../core/url-key.js';
import { parseJsonLdNodes, nodeType } from './templates.js';
import { expectedCtr } from '../core/ctrModel.js';
import { latestTwoCrawls } from './drift.js';
import { HTML_CT } from '../core/sql.js';

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
  brand?: string | null;     // registrable brand label (alnum), for excluding branded queries; null = unknown
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
// Streaming variant — yields one row at a time instead of materialising the whole result set. Use for
// checks that scan a large/fat column (e.g. body_chunks) and only need independent per-row work, so a
// big content site doesn't load every page's body text into one array.
const iterRows = (ctx: CheckContext, sql: string, ...args: unknown[]): IterableIterator<any> => ctx.db.prepare(sql).iterate(...args) as IterableIterator<any>;
// d is the finalised GSC date (partial trailing days already trimmed upstream); cap the window at
// it so checks never count unfinalised days. winPrev already caps below d, so it's unaffected.
const win = (d: string): string => `date > date('${d}', '-28 days') AND date <= '${d}'`;
// Prior 28-day window (the 28 days BEFORE the current window) — for period-over-period checks.
const winPrev = (d: string): string => `date <= date('${d}', '-28 days') AND date > date('${d}', '-56 days')`;
// SQL clause to drop branded queries (whole-token match). Branded multi-URL ranking is sitelinks,
// not cannibalisation; branded top-queries aren't anchor targets. The brand is re-sanitised to
// alnum HERE (not trusting the caller) so inlining it into SQL is unconditionally injection-safe.
const brandExcl = (c: CheckContext): string => {
  const b = (c.brand ?? '').replace(/[^a-z0-9]/g, '');
  return b ? `AND (' ' || LOWER(query) || ' ') NOT LIKE '% ${b} %'` : '';
};
// Days of GSC history actually held — period-over-period checks need enough span to be meaningful.
const spanDays = (c: CheckContext): number => {
  // Span must be measured up to the FINALISED max date the windows actually key off
  // (gscMaxDate is trimmed ~3 days below raw MAX(date)) — measuring the raw span lets the
  // ≥56-day guard pass while the previous-28d window still reaches before MIN(date),
  // undercounting the prior period (rising-pages FPs, traffic-decay FNs).
  const r = c.db.prepare(`SELECT julianday(?) - julianday(MIN(date)) d FROM search_analytics`).get(c.gscMaxDate ?? null) as { d: number | null };
  return r?.d ?? 0;
};
// Newest dateModified/datePublished anywhere in a page's JSON-LD (recurses @graph/arrays) — the
// effective "last meaningfully updated" date. json_ld is a JSON array of raw block strings.
const newestSchemaDate = (jl: string | null): string | null => {
  if (!jl) return null;
  let best = -Infinity, bestStr: string | null = null;
  const scan = (o: any): void => {
    if (!o || typeof o !== 'object') return;
    for (const key of ['dateModified', 'datePublished']) {
      const v = o[key];
      if (typeof v === 'string') { const t = Date.parse(v); if (!isNaN(t) && t > best) { best = t; bestStr = v; } }
    }
    for (const k in o) if (o[k] && typeof o[k] === 'object') scan(o[k]);
  };
  try { for (const block of JSON.parse(jl) as string[]) { try { scan(JSON.parse(block)); } catch { /* skip block */ } } } catch { /* skip */ }
  return bestStr;
};
// Paginated archive URLs (/page/2, ?page=3, ?paged=2). They legitimately share titles/metas with
// page 1 and are intentionally absent from sitemaps, so they must NOT generate duplicate-title /
// duplicate-meta / missing-meta / not-in-sitemap false positives. Pass the column reference
// (e.g. 'url_key' or 'p.url_key') so it composes with table aliases.
const notPagination = (col = 'url_key'): string =>
  // Anchor the param name to ?/& — a bare LIKE '%page=%' also matches per_page=/on_page=/
  // homepage=, wrongly exempting those URLs from duplicate-title/meta/sitemap checks.
  `${col} NOT GLOB '*/page/[0-9]*' AND ${col} NOT GLOB '*[?&]page=[0-9]*' AND ${col} NOT GLOB '*[?&]paged=[0-9]*'`;

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
    // Lint, NOT a measured Core Web Vital. Missing width/height attributes only cause CLS if the
    // CSS doesn't already reserve space — modern themes using aspect-ratio / fixed boxes have ~0
    // measured CLS despite missing attributes. So we report it as a hygiene lint and explicitly say
    // it's not a confirmed CWV issue; escalate only against field CLS (high-yield-cwv-fail does that).
    title: 'Images missing width/height attributes', fix: 'Add width & height (or rely on CSS aspect-ratio) so the browser reserves space. NOTE: this is a lint — if your CSS already reserves space (aspect-ratio / fixed box) measured CLS is likely ~0 and there is nothing to fix. Confirm with field CLS before prioritising.',
    run: (c) => rows(c, `SELECT url_key urlKey, images_missing_dimensions n, image_count total FROM pages WHERE status_code=200 AND indexable=1 AND images_missing_dimensions > 0`).map(r => ({ urlKey: r.urlKey, evidence: { missingDimensions: r.n, total: r.total, note: 'lint only — no measured CLS impact unless field data shows layout shift' } })),
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
  // ── Additions from industry checklist review (buildable on current data) ──
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
    // Count hops in SQL (json_array_length, guarded by json_valid) and filter to >=2 there — so we
    // never pull every redirect-bearing page into JS just to count + drop most of them.
    run: (c) => rows(c, `SELECT url_key urlKey, json_array_length(redirects) hops FROM pages
      WHERE redirects IS NOT NULL AND json_valid(redirects) AND json_array_length(redirects) >= 2`)
      .map(r => ({ urlKey: r.urlKey, evidence: { hops: r.hops } })),
  },
  {
    id: 'internal-links-to-redirects', category: 'crawlability', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'automated',
    title: 'Internal links pointing through redirects', fix: 'Repoint internal links to the final URL (saves crawl + equity).',
    // Flag a link ONLY if the raw href it uses is itself a redirect source — i.e. that exact URL
    // appears as a `from` hop in some redirect chain. The old query flagged any link whose target
    // page merely HAD a `redirects` entry, which fired site-wide on www-canonical properties: every
    // page records the seed apex→www hop, yet the actual hrefs already use the final (www) URL and
    // never redirect. Matching the href (fragment-stripped) against the real redirect-source set is
    // robust to that artefact. Kept entirely in SQL (json_each over pages.redirects) so we never
    // materialise the whole links table in JS — the links table is the largest in the DB.
    run: (c) => {
      return rows(c, `
        WITH redir_src AS (
          -- Feed json_each a CASE that yields '[]' for any null/invalid value, so it never receives
          -- malformed JSON regardless of how SQLite orders the scan vs the WHERE (a plain WHERE
          -- json_valid() guard gets defeated by subquery flattening). Mirrors the old JS try/catch.
          SELECT DISTINCT json_extract(j.value, '$.from') src
          FROM pages, json_each(CASE WHEN json_valid(pages.redirects) THEN pages.redirects ELSE '[]' END) j
          WHERE pages.redirects IS NOT NULL AND pages.redirects <> '[]' AND j.type = 'object'
        )
        SELECT l.target_key urlKey, COUNT(DISTINCT l.source_key) sources
        FROM links l
        JOIN redir_src r ON r.src = (CASE WHEN instr(l.target_url, '#') > 0
                                          THEN substr(l.target_url, 1, instr(l.target_url, '#') - 1)
                                          ELSE l.target_url END)
        WHERE l.is_internal = 1
        GROUP BY l.target_key`).map(r => ({ urlKey: r.urlKey, evidence: { linkingPages: r.sources } }));
    },
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
    // A URL only "competes" if it ranks for the query (impression-weighted pos < 20) AND holds a
    // non-trivial share of the leader's impressions — ≥10% of the leader OR ≥500 impressions in its
    // own right, and ≥10 impressions minimum. Without that floor, incidental long-tail appearances
    // (a page picking up 1–7 impressions for the query) counted as competitors: e.g. "best vr headset"
    // reported 10 URLs when ONE page held 59,570 impressions at pos 1.1 and the other nine had 1–7
    // each — not cannibalisation, Google had decided. The absolute ≥500 backstop keeps a genuine
    // mid-volume rival under a dominant leader (e.g. 60k leader + a real 4k second page = 6.7%, below
    // the 10% bar) from being silently dropped. We also exclude "dominance" where the best pages both
    // sit at pos 1–2 (indented/double results are good). Branded queries are dropped via brandExcl.
    run: (c) => {
      if (!c.gscMaxDate) return [];
      const flagged = rows(c, `
        WITH per_page AS (
          SELECT query, page_key, SUM(clicks) clicks, SUM(impressions) impressions,
                 SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
          FROM search_analytics
          WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win(c.gscMaxDate)} ${brandExcl(c)}
          GROUP BY query, page_key
          HAVING pos < 20 AND SUM(impressions) >= 10
        ),
        ranked AS (SELECT *, MAX(impressions) OVER (PARTITION BY query) topImpr FROM per_page),
        competing AS (SELECT * FROM ranked WHERE impressions >= topImpr * 0.1 OR impressions >= 500)
        SELECT query, COUNT(*) urls, SUM(clicks) clicks, SUM(impressions) impressions, MIN(pos) bestPos, MAX(pos) worstPos,
               GROUP_CONCAT(page_key, char(31)) pk, GROUP_CONCAT(CAST(ROUND(impressions) AS INT), char(31)) im, GROUP_CONCAT(ROUND(pos,1), char(31)) ps
        FROM competing GROUP BY query
        HAVING COUNT(*) >= 2 AND SUM(impressions) >= 50 AND NOT (MAX(pos) <= 2)
        ORDER BY impressions DESC LIMIT 40`);
      const titleOf = c.db.prepare('SELECT title FROM pages WHERE url_key = ?');
      return flagged.map(r => {
        const keys = String(r.pk || '').split('\x1f'), imps = String(r.im || '').split('\x1f'), poss = String(r.ps || '').split('\x1f');
        const items = keys.map((u, i) => ({ url: u, impressions: Number(imps[i]) || 0, position: Number(poss[i]) || 0, title: (titleOf.get(u) as { title?: string } | undefined)?.title ?? null }))
          .sort((a, b) => b.impressions - a.impressions);
        // Differentiation signal: do the top-2 competing pages share significant title terms beyond the
        // query itself? If not (and both are titled), they're likely intentionally distinct pages (e.g.
        // pairwise comparisons), not true duplicates competing for one intent — annotate, don't suppress.
        const q = new Set(terms(r.query));
        const sig = items.slice(0, 2).map(it => terms(it.title ?? '').filter((w: string) => !q.has(w)));
        const differentiated = sig.length === 2 && items[0].title != null && items[1].title != null
          && sig[0].filter((w: string) => sig[1].includes(w)).length < 2;
        const ev: Record<string, unknown> = {
          query: r.query, competingUrls: r.urls, clicks: r.clicks, impressions: r.impressions,
          positions: `${Math.round(r.bestPos * 10) / 10}–${Math.round(r.worstPos * 10) / 10}`,
          urls: items.slice(0, 4).map(it => ({ url: it.url, impressions: it.impressions, position: it.position, title: it.title })),
        };
        if (differentiated) ev.note = 'competing URLs have distinct titles — likely intentional differentiation (e.g. pairwise comparisons), not true cannibalisation; verify before consolidating';
        return { urlKey: null, evidence: ev };
      });
    },
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
    run: (c) => (!c.gscMaxDate || spanDays(c) < 90) ? [] : rows(c, `SELECT url_key urlKey, ipr FROM pages WHERE status_code=200 AND indexable=1 AND ${HTML_CT} AND COALESCE(click_depth, 999) >= 1 AND url_key NOT IN (SELECT DISTINCT page_key FROM search_analytics WHERE page_key IS NOT NULL AND date <= '${c.gscMaxDate}' AND date > date('${c.gscMaxDate}','-90 days') AND impressions > 0) ORDER BY ipr DESC LIMIT 100`).map(r => ({ urlKey: r.urlKey, evidence: { note: 'indexable but zero impressions in 90 days', ipr: Math.round(r.ipr) } })),
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
  // ── Content cluster (AI-era / RAG layer): exploit the chunked body text captured at crawl ──
  {
    id: 'body-missing-top-query', category: 'merged', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Top query missing from the page body', fix: 'The page ranks for this query yet its terms appear nowhere — not the title, H1, or body copy. Add a section that actually covers the topic; if it can’t, the page is too thin to hold the ranking and a stronger page should target it.',
    run: (c) => {
      if (!c.gscMaxDate) return [];
      const r = rows(c, `SELECT s.page_key urlKey, s.query query, s.impr impressions, p.title title, p.h1 h1, p.body_chunks bc FROM
        (SELECT page_key, query, SUM(impressions) impr, ROW_NUMBER() OVER (PARTITION BY page_key ORDER BY SUM(impressions) DESC) rn
         FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key, query) s
        JOIN pages p ON p.url_key = s.page_key
        WHERE s.rn = 1 AND p.indexable = 1 AND p.body_chunks IS NOT NULL AND s.impr >= 100`);
      return r.filter(x => {
        const q = terms(x.query); if (!q.length) return false;
        let body = `${x.title || ''} ${x.h1 || ''}`;
        try { for (const ch of JSON.parse(x.bc)) body += ` ${ch.heading || ''} ${ch.text || ''}`; } catch { /* skip */ }
        return !q.some((w: string) => titleHasTerm(body, w)); // none of the query's terms appear on the page
      }).map(x => ({ urlKey: x.urlKey, evidence: { topQuery: x.query, impressions: x.impressions, note: 'query terms absent from title, H1 and body' } }));
    },
  },
  {
    id: 'poor-chunkability', category: 'content', severity: 'low', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Content has no heading structure (poor RAG boundaries)', fix: 'Break the copy into headed sections (h2/h3). AI search and featured snippets lift self-contained, headed passages — a wall of text with no subheadings gives them no clean chunk to quote.',
    run: (c) => {
      const out: RawFinding[] = [];
      for (const x of iterRows(c, `SELECT url_key urlKey, word_count wc, body_chunks bc FROM pages WHERE status_code=200 AND indexable=1 AND ${HTML_CT} AND word_count >= 400 AND body_chunks IS NOT NULL`)) {
        let headed: number; try { headed = (JSON.parse(x.bc) as any[]).filter((k: any) => k.heading && k.level >= 2).length; } catch { continue; }
        if (headed <= 1) out.push({ urlKey: x.urlKey, evidence: { wordCount: x.wc, note: '400+ words with ≤1 subheading — one undifferentiated block' } });
      }
      return out;
    },
  },
  {
    id: 'rag-answer-gap', category: 'merged', severity: 'med', labels: ['G', 'N'], certainty: 0.6, effortBase: 5, fixType: 'per-page',
    title: 'No single passage answers the ranking query (RAG gap)', fix: 'The page contains the query’s terms but scattered across sections — no one chunk (heading + paragraph) holds them together. AI answers lift a single self-contained passage, so add one that directly answers the query in ~50 words. (Heuristic — confirm the query’s intent first.)',
    run: (c) => {
      if (!c.gscMaxDate) return [];
      const r = rows(c, `SELECT s.page_key urlKey, s.query query, s.impr impressions, p.title title, p.body_chunks bc FROM
        (SELECT page_key, query, SUM(impressions) impr, ROW_NUMBER() OVER (PARTITION BY page_key ORDER BY SUM(impressions) DESC) rn
         FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key, query) s
        JOIN pages p ON p.url_key = s.page_key
        WHERE s.rn = 1 AND p.indexable = 1 AND p.body_chunks IS NOT NULL AND s.impr >= 200`);
      return r.filter(x => {
        const q = terms(x.query); if (q.length < 2) return false; // only multi-term queries can be "scattered"
        let chunks: any[]; try { chunks = JSON.parse(x.bc); } catch { return false; }
        const whole = `${x.title || ''} ${chunks.map(ch => `${ch.heading || ''} ${ch.text || ''}`).join(' ')}`;
        if (!q.every((w: string) => titleHasTerm(whole, w))) return false;             // page must contain all terms (else it's body-missing)
        return !chunks.some(ch => { const h = `${ch.heading || ''} ${ch.text || ''}`; return q.every((w: string) => titleHasTerm(h, w)); }); // but no single chunk does
      }).map(x => ({ urlKey: x.urlKey, evidence: { topQuery: x.query, impressions: x.impressions, note: 'terms present but never together in one passage' } }));
    },
  },
  {
    id: 'low-extractability', category: 'content', severity: 'low', labels: ['D', 'N'], certainty: 0.5, effortBase: 3, fixType: 'per-page',
    title: 'Passages depend on context (low answer-extractability)', fix: 'Half or more of this page’s sections open with “it / this / they / there…” or never name the subject — lifted out of the page by an LLM they read as meaningless. Open key sections by naming the entity. (Heuristic.)',
    run: (c) => {
      const out: { urlKey: string | null; evidence: Record<string, unknown> }[] = [];
      const PRON = /^(it|this|that|these|those|they|he|she|there|here|such|one)\b/i;
      for (const x of iterRows(c, `SELECT url_key urlKey, body_chunks bc FROM pages WHERE status_code=200 AND indexable=1 AND word_count >= 400 AND body_chunks IS NOT NULL`)) {
        let chunks: any[]; try { chunks = JSON.parse(x.bc); } catch { continue; }
        const bodied = chunks.filter((k: any) => k.text && k.text.length > 60);
        if (bodied.length < 3) continue;
        const dep = bodied.filter((k: any) => PRON.test(String(k.text).trim())).length;
        if (dep / bodied.length >= 0.5) out.push({ urlKey: x.urlKey, evidence: { dependentSections: dep, totalSections: bodied.length, note: `${Math.round(dep / bodied.length * 100)}% of sections open context-dependent` } });
      }
      return out;
    },
  },
  {
    // Hobo "Signal Coherence" / Goldmine; leak: anchor_mismatch. Google leans on internal anchors to
    // understand a page's topic — if the IN-CONTENT inbound anchors never mention the query the page
    // actually ranks for, that's an incoherent internal signal. Guard against boilerplate FPs by using
    // ONLY placement='body' anchors (nav/footer/aside excluded) and requiring ≥3 of them.
    id: 'anchor-text-incoherent', category: 'merged', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Internal anchors don’t mention the page’s top query', fix: 'The in-content internal links pointing at this page never use its top-ranking query in their anchor text — and Google leans on internal anchors to understand what a page is about. Re-anchor the key internal links with descriptive, query-relevant text instead of generic “read more” / brand-only labels.',
    run: (c) => {
      if (!c.gscMaxDate) return [];
      const top = rows(c, `SELECT s.page_key urlKey, s.query query, s.impr impressions FROM
        (SELECT page_key, query, SUM(impressions) impr, ROW_NUMBER() OVER (PARTITION BY page_key ORDER BY SUM(impressions) DESC) rn
         FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win(c.gscMaxDate)} ${brandExcl(c)} GROUP BY page_key, query) s
        JOIN pages p ON p.url_key = s.page_key
        WHERE s.rn = 1 AND p.indexable = 1 AND s.impr >= 100`);
      // Pool only GENUINE editorial anchors. "Chrome" (nav/footer/breadcrumb/CTA) is detected
      // STRUCTURALLY, not via an English word-list: an anchor text reused across a large share of
      // the site's pages is templated boilerplate — e.g. the EHI homepage's 2,940 inbound "Home"
      // breadcrumb links — and that holds in any language ("Startseite", "Accueil"…). We also drop
      // self-links and anchors with no letters ("(0)", page numbers, arrows). Editorial in-content
      // anchors recur on only a handful of pages, so they survive.
      const anchors = new Map<string, { pool: string; n: number }>();
      for (const a of rows(c, `
        WITH body_anchors AS (
          SELECT target_key, anchor_text, source_key, LOWER(TRIM(anchor_text)) atext
          FROM links
          WHERE is_internal = 1 AND placement = 'body' AND source_key <> target_key
            AND anchor_text IS NOT NULL AND TRIM(anchor_text) != '' AND LOWER(TRIM(anchor_text)) GLOB '*[a-z]*'
        ),
        templated AS (
          SELECT atext FROM body_anchors GROUP BY atext
          HAVING COUNT(DISTINCT source_key) > MAX(20, (SELECT COUNT(*) FROM pages WHERE status_code = 200 AND ${HTML_CT}) * 0.15)
        )
        SELECT target_key tk, GROUP_CONCAT(anchor_text, ' ') pool, COUNT(*) n
        FROM body_anchors
        WHERE atext NOT IN (SELECT atext FROM templated)
        GROUP BY target_key`)) anchors.set(a.tk, { pool: a.pool, n: a.n });
      return top.filter(x => {
        const a = anchors.get(x.urlKey); if (!a || a.n < 3) return false;     // need enough genuine in-content inbound links to judge
        const q = terms(x.query); return q.length > 0 && !q.some((w: string) => titleHasTerm(a.pool, w));
      }).map(x => { const a = anchors.get(x.urlKey)!; return { urlKey: x.urlKey, evidence: { topQuery: x.query, impressions: x.impressions, inboundInContentLinks: a.n } }; });
    },
  },
  {
    // The "RAG snippetability" test. A local cross-encoder (the kind AI search uses to re-rank) scored
    // every chunk against the page's top query; we persisted the single best-passage score. A low max
    // means no dense, extractable answer anywhere on the page — it will lose in AI/passage search even
    // if it keyword-matches. Model-derived (not deterministic truth) → N label, includeJudgement-gated.
    // Requires `score_passages` to have run (like CWV needs page_lighthouse).
    id: 'weak-passage-answer', category: 'merged', severity: 'high', labels: ['G', 'N'], certainty: 0.8, effortBase: 5, fixType: 'per-page',
    title: 'No passage strongly answers the ranking query (AI-search risk)', fix: 'A local neural reranker found no single passage on this page that confidently answers its top query — the page covers the topic loosely but offers no dense, extractable answer, so AI/passage search will prefer a clearer source. Add a focused, self-contained passage: a heading that states the question + a direct ~50-word answer up top. Run `score_passages` to (re)populate.',
    run: (c) => rows(c, `SELECT url_key urlKey, max_passage_score mps, max_passage_query q, max_passage_impr impr FROM pages
      WHERE indexable=1 AND max_passage_score IS NOT NULL AND max_passage_score < 3`)
      .map(x => ({ urlKey: x.urlKey, evidence: { topQuery: x.q, maxPassageScore: x.mps, impressions: x.impr ?? 0, note: 'best passage scores below the reranker confidence threshold' } })),
  },
  {
    // Dejan: search weights the opening heavily and AI answers front-load. If the ranking query's
    // terms are present LATER in the page but absent from the opening (~first 2 chunks / ~200 words),
    // the answer is buried. (body-missing-top-query handles total absence; this is the buried case.)
    // Informational intent only — front-loading matters less for navigational/transactional queries.
    id: 'answer-not-front-loaded', category: 'merged', severity: 'med', labels: ['G', 'N'], certainty: 0.6, effortBase: 3, fixType: 'per-page',
    title: 'Answer to the ranking query is buried, not front-loaded', fix: 'The page covers its top query but the terms don’t appear up top (the intro / first section). Google weights the opening heavily and AI answers front-load — move a direct ~50–100-word answer to the first section. (Heuristic — informational queries.)',
    run: (c) => {
      if (!c.gscMaxDate) return [];
      const INFO = /\b(how|what|why|when|which|who|guide|tutorial|best|vs|versus|is|are|does|do|can|should|tips|ideas|examples|meaning|definition|setup|settings)\b/i;
      const r = rows(c, `SELECT s.page_key urlKey, s.query query, s.impr impressions, p.title title, p.body_chunks bc FROM
        (SELECT page_key, query, SUM(impressions) impr, ROW_NUMBER() OVER (PARTITION BY page_key ORDER BY SUM(impressions) DESC) rn
         FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${win(c.gscMaxDate)} GROUP BY page_key, query) s
        JOIN pages p ON p.url_key = s.page_key
        WHERE s.rn = 1 AND p.indexable = 1 AND p.body_chunks IS NOT NULL AND p.word_count >= 800 AND s.impr >= 100`);
      return r.filter(x => {
        if (!INFO.test(x.query)) return false;
        const q = terms(x.query); if (!q.length) return false;
        let chunks: any[]; try { chunks = JSON.parse(x.bc); } catch { return false; }
        const front = `${x.title || ''} ${chunks.slice(0, 2).map((k: any) => `${k.heading || ''} ${k.text || ''}`).join(' ')}`.slice(0, 1200);
        const whole = `${x.title || ''} ${chunks.map((k: any) => `${k.heading || ''} ${k.text || ''}`).join(' ')}`;
        return q.some((w: string) => titleHasTerm(whole, w)) && !q.some((w: string) => titleHasTerm(front, w));
      }).map(x => ({ urlKey: x.urlKey, evidence: { topQuery: x.query, impressions: x.impressions, note: 'query terms appear later in the page but not in the opening' } }));
    },
  },
  {
    // Dejan "density beats length": AI grounds ~370 words/page, diminishing past ~1,500. A very long
    // page with an over-long unbroken section grounds poorly — split it into focused, headed passages.
    id: 'content-bloat', category: 'content', severity: 'low', labels: ['D', 'N'], certainty: 0.6, effortBase: 5, fixType: 'per-page',
    title: 'Over-long section dilutes AI-grounding (density beats length)', fix: 'This page has a very long unbroken section. AI search grounds only ~370 words per page with sharp diminishing returns past ~1,500 — break the long section into focused, headed passages (or tighten it) so each answers one thing cleanly.',
    run: (c) => {
      const out: { urlKey: string | null; evidence: Record<string, unknown> }[] = [];
      // Use the real (uncapped) word_count ÷ number of headed sections — chunk TEXT is capped at
      // extraction, so we infer over-long sections from words-per-heading, not from chunk length.
      for (const x of iterRows(c, `SELECT url_key urlKey, word_count wc, body_chunks bc FROM pages WHERE status_code=200 AND indexable=1 AND ${HTML_CT} AND word_count >= 2500 AND body_chunks IS NOT NULL`)) {
        let chunks: any[]; try { chunks = JSON.parse(x.bc); } catch { continue; }
        const headed = chunks.filter((k: any) => k.heading && k.level >= 2).length;
        const wordsPerSection = Math.round(x.wc / Math.max(1, headed));
        if (wordsPerSection > 500) out.push({ urlKey: x.urlKey, evidence: { wordCount: x.wc, headedSections: headed, wordsPerSection, note: 'long page with sparse headings — sections average >500 words, too large to ground cleanly' } });
      }
      return out;
    },
  },
  {
    // Hobo Level 3 freshness / lastSignificantUpdate. Gemini guard: YoY windows (negate seasonality
    // + zero-click-SERP CTR loss). Flag when the page hasn't been meaningfully re-dated in >12 months
    // AND clicks are down >25% YoY AND impressions down >15% YoY (impressions confirm ranking decay,
    // not just CTR). Needs ~13 months of GSC — guarded by spanDays so it stays silent on shallow syncs.
    id: 'stale-content', category: 'merged', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Stale page declining year-on-year', fix: 'This page hasn’t been meaningfully updated in over a year and its Search Console clicks are down sharply versus the same period last year — refresh and expand the content (and honestly re-date it) to rebuild the freshness signal Google rewards.',
    run: (c) => {
      if (!c.gscMaxDate || spanDays(c) < 455) return []; // YoY window reaches back 455 days — anything less truncates the prior-year period
      const d = c.gscMaxDate;
      const out: { urlKey: string | null; evidence: Record<string, unknown> }[] = [];
      const rs = rows(c, `
        WITH cur AS (SELECT page_key, SUM(clicks) c, SUM(impressions) i FROM search_analytics WHERE page_key IS NOT NULL AND date <= '${d}' AND date > date('${d}','-90 days') GROUP BY page_key),
             py AS (SELECT page_key, SUM(clicks) c, SUM(impressions) i FROM search_analytics WHERE page_key IS NOT NULL AND date <= date('${d}','-365 days') AND date > date('${d}','-455 days') GROUP BY page_key)
        SELECT cur.page_key url, cur.c curC, cur.i curI, py.c pyC, py.i pyI, p.json_ld jl
        FROM cur JOIN py ON py.page_key = cur.page_key JOIN pages p ON p.url_key = cur.page_key
        WHERE p.indexable = 1 AND py.c >= 50 AND cur.c < py.c * 0.75 AND cur.i < py.i * 0.85
        ORDER BY (py.c - cur.c) DESC LIMIT 40`);
      for (const x of rs) {
        const dm = newestSchemaDate(x.jl); if (!dm) continue;
        const ageDays = (Date.parse(d) - Date.parse(dm)) / 86400000;
        if (!(ageDays >= 365)) continue; // only genuinely stale pages (>12 months since last schema date)
        out.push({ urlKey: null, evidence: { url: x.url, dateModified: dm.slice(0, 10), clicksYoY: `${x.pyC}→${x.curC} (-${Math.round((1 - x.curC / x.pyC) * 100)}%)`, impressionsYoY: `${x.pyI}→${x.curI}`, clicks: x.pyC - x.curC, impressions: x.pyI } });
      }
      return out;
    },
  },
  {
    id: 'high-ipr-no-traffic', category: 'merged', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 5, fixType: 'per-page',
    title: 'Internal authority wasted on a no-traffic page', fix: 'High internal link equity (iPR) and Google does rank it (it earns impressions), yet it gets zero clicks — rewrite the title/snippet or improve the page, or repoint that authority to pages that convert it. (Requires impressions, so functional pages with no search demand are excluded.)',
    run: (c) => (!c.gscMaxDate || spanDays(c) < 90) ? [] : rows(c, `SELECT p.url_key urlKey, p.ipr ipr, p.inlink_count inl, SUM(sa.impressions) impressions
      FROM pages p JOIN search_analytics sa ON sa.page_key=p.url_key
      WHERE p.indexable=1 AND p.ipr >= 50 AND COALESCE(p.click_depth, 999) >= 1 AND sa.date <= '${c.gscMaxDate}' AND sa.date > date('${c.gscMaxDate}','-90 days')
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
      // max_pages is nullable (NULL = no cap = complete crawl) — `c >= null` coerces to
      // `c >= 0`, which would silently disable the check forever on capless crawls.
      if (!m || m.c === 0 || (m.m != null && m.c >= m.m)) return [];
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
  {
    // The tier BETWEEN "orphan" (0 inlinks) and "fine": pages reached almost only via nav/footer.
    // inlink_count counts ALL internal links, so a page sitting in the global nav looks well-linked
    // even with zero EDITORIAL links — yet Google leans on in-content links for topic + equity. We
    // count distinct in-content (placement='body') inbound sources; ≤2 + real demand = under-linked.
    id: 'underlinked-editorial', category: 'merged', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'High demand, almost no in-content internal links', fix: 'This page earns real impressions but is reached mainly via nav/footer — add descriptive in-content links to it from related articles. Editorial body links pass more topical context and equity than templated nav links.',
    run: (c) => c.gscMaxDate ? rows(c, `
      SELECT p.url_key urlKey, SUM(sa.impressions) impressions,
             (SELECT COUNT(DISTINCT l.source_key) FROM links l WHERE l.target_key = p.url_key AND l.is_internal = 1 AND l.placement = 'body' AND l.source_key <> p.url_key) bodyLinks
      FROM pages p JOIN search_analytics sa ON sa.page_key = p.url_key
      WHERE p.indexable = 1 AND sa.${win(c.gscMaxDate)}
      GROUP BY p.url_key
      HAVING SUM(sa.impressions) >= 300 AND bodyLinks <= 2
      ORDER BY impressions DESC LIMIT 40`).map(r => ({ urlKey: r.urlKey, evidence: { impressions: r.impressions, inContentLinks: r.bodyLinks, note: 'reached mainly via nav/footer — thin on editorial (in-content) links' } })) : [],
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
    id: 'rich-result-issues', category: 'schema', severity: 'med', labels: ['D', 'G'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Google-verified rich result issues (URL Inspection)', fix: 'Fix the structured-data issues Google itself reports for this page — these come from the URL Inspection API (Google’s own validation), not our local validator, so they are authoritative. Address the listed issue messages per rich-result type.',
    // Parses the stored richResultsResult JSON (url_inspection.rich_results) that inspect_urls
    // already captures: detectedItems[].items[].issues[] carries Google's severity + message.
    // Needs URL Inspection populated (run inspect_urls). Zero API cost — data is already in the DB.
    run: (c) => {
      const out: RawFinding[] = [];
      for (const r of iterRows(c, `SELECT url_key urlKey, rich_results rr FROM url_inspection WHERE rich_results IS NOT NULL AND rich_results != ''`)) {
        let parsed: any;
        try { parsed = JSON.parse(r.rr); } catch { continue; }
        // Dedup per (type, severity, message) with a count — a listicle repeats the same
        // "Missing field review" warning per product item; keep one sample item per group.
        const groups = new Map<string, { richResultType: string; severity: string | null; message: string; count: number; sampleItem: string | null }>();
        for (const det of parsed?.detectedItems ?? []) {
          for (const item of det?.items ?? []) {
            for (const iss of item?.issues ?? []) {
              if (!iss?.issueMessage) continue;
              const key = `${det.richResultType ?? 'unknown'}|${iss.severity ?? ''}|${iss.issueMessage}`;
              const g = groups.get(key);
              if (g) g.count++;
              else groups.set(key, { richResultType: det.richResultType ?? 'unknown', severity: iss.severity ?? null, message: iss.issueMessage, count: 1, sampleItem: item.name ?? null });
            }
          }
        }
        if (groups.size) out.push({ urlKey: r.urlKey, evidence: { verdict: parsed?.verdict ?? null, issues: [...groups.values()] } });
      }
      return out;
    },
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
          AND (rel_prev=1 OR url LIKE '%/page/%' OR url GLOB '*[?&]page=[0-9]*' OR url GLOB '*[?&]paged=[0-9]*' OR url GLOB '*[?&]p=[0-9]*')`)
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
    title: 'Large HTML document (transferred)', fix: 'Trim the HTML payload — bloated markup slows render and First Contentful Paint (often huge inline SVG/CSS/JSON or unminified output). Judged on TRANSFERRED bytes, not raw: behind a compressing CDN (brotli/gzip) raw size matters far less.',
    // Severity is on what the browser actually downloads, not raw bytes: a 200KB page served brotli
    // is ~45KB over the wire and is NOT a real perf problem. We estimate transfer size (raw × ~0.22
    // for br/gzip, else raw) and only flag pages whose ESTIMATED transferred HTML exceeds ~60KB.
    // Prefilter at the 60KB threshold itself, not higher — an UNCOMPRESSED 60–150KB page
    // (est = raw) is exactly the case that matters most and must reach the est filter.
    run: (c) => rows(c, `SELECT url_key urlKey, bytes, content_encoding enc FROM pages WHERE status_code=200 AND ${HTML_CT} AND bytes > 60000 ORDER BY bytes DESC`)
      .map(r => { const compressed = /br|gzip|deflate|zstd/i.test(r.enc || ''); const est = compressed ? Math.round(r.bytes * 0.22) : r.bytes; return { urlKey: r.urlKey, est, compressed, raw: r.bytes }; })
      .filter(x => x.est > 60000)
      .map(x => ({ urlKey: x.urlKey, evidence: { rawBytes: x.raw, estTransferBytes: x.est, compressed: x.compressed, note: x.compressed ? 'raw HTML; estimated transferred size after CDN compression' : 'served UNCOMPRESSED — enable brotli/gzip' } })),
  },
  {
    id: 'uncompressed-html', category: 'performance', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'HTML served without compression', fix: 'Enable gzip or brotli for HTML responses — uncompressed HTML wastes bandwidth and slows load. Usually a one-line server/CDN setting.',
    run: (c) => rows(c, `SELECT url_key urlKey FROM pages WHERE status_code=200 AND ${HTML_CT} AND (content_encoding IS NULL OR content_encoding='')`)
      .map(r => ({ urlKey: r.urlKey, evidence: {} })),
  },
  // ── Checklist-coverage additions (2026-07-20 — see plan/checklist-coverage.md) ──
  {
    id: 'robots-blocked-with-traffic', category: 'crawlability', severity: 'high', labels: ['D', 'G'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Robots-blocked page still earning search traffic', fix: 'This URL is disallowed in robots.txt yet Google still shows it (usually as a bare "no information" result) and users still land on it. Either unblock it so it can be crawled and ranked properly, or — if it genuinely shouldn\'t be found — unblock it AND add noindex (a robots-blocked page can never see the noindex).',
    run: (c) => !c.gscMaxDate ? [] : rows(c, `SELECT p.url_key urlKey, SUM(sa.clicks) clicks, SUM(sa.impressions) impressions
      FROM pages p JOIN search_analytics sa ON sa.page_key = p.url_key
      WHERE p.indexable_reason='robots-disallowed' AND ${win(c.gscMaxDate)}
      GROUP BY p.url_key HAVING SUM(sa.impressions) >= 10
      ORDER BY SUM(sa.impressions) DESC LIMIT 50`)
      .map(r => ({ urlKey: r.urlKey, evidence: { clicks: r.clicks, impressions: r.impressions, note: 'disallowed in robots.txt yet earning impressions' } })),
  },
  {
    id: 'missing-lang', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'Pages missing an html lang attribute', fix: 'Declare the page language on the <html> element (e.g. lang="en-GB") — it helps search engines, screen readers and translation systems know what language they\'re reading. Usually one template edit.',
    run: (c) => {
      const n = (c.db.prepare(`SELECT COUNT(*) n FROM pages WHERE status_code=200 AND indexable=1 AND ${HTML_CT} AND (lang IS NULL OR TRIM(lang)='')`).get() as { n: number }).n;
      return n > 0 ? [{ urlKey: null, evidence: { pages: n, note: 'indexable pages with no lang attribute' } }] : [];
    },
  },
  {
    id: 'image-preview-restricted', category: 'indexation', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'max-image-preview restricted below large', fix: 'The robots meta tag caps image previews at none/standard. Google Discover strongly favours large image previews — set max-image-preview:large (or remove the restriction) unless there\'s a licensing reason not to.',
    run: (c) => rows(c, `SELECT url_key urlKey, robots FROM pages WHERE status_code=200 AND indexable=1
        AND (LOWER(REPLACE(robots,' ','')) LIKE '%max-image-preview:none%' OR LOWER(REPLACE(robots,' ','')) LIKE '%max-image-preview:standard%') LIMIT 50`)
      .map(r => ({ urlKey: r.urlKey, evidence: { robots: r.robots } })),
  },
  {
    id: 'excessive-links', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Excessive number of links on the page', fix: 'Hundreds of links on one page dilute the equity each one passes and drown the ones that matter. Trim boilerplate link blocks (mega-menus, tag clouds, footer sprawl) so the important links stand out.',
    run: (c) => rows(c, `SELECT url_key urlKey, internal_links il, external_links el FROM pages
        WHERE status_code=200 AND indexable=1 AND (internal_links + external_links) > 300
        ORDER BY (internal_links + external_links) DESC LIMIT 30`)
      .map(r => ({ urlKey: r.urlKey, evidence: { internalLinks: r.il, externalLinks: r.el, total: r.il + r.el } })),
  },
  {
    id: 'favicon-missing', category: 'onpage', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'No favicon declared', fix: 'Add a favicon (<link rel="icon" …>) — Google shows it next to your result on mobile, and a missing one costs a little trust/recognition on every SERP appearance. One line in the template.',
    // Gated on the column being populated (has_favicon is NULL on crawls from before this
    // was captured) — never flag from a pre-feature crawl.
    run: (c) => {
      const hp = c.db.prepare(`SELECT url_key, has_favicon hf FROM pages WHERE status_code=200 AND has_favicon IS NOT NULL ORDER BY (click_depth=0) DESC, inlink_count DESC LIMIT 1`).get() as { url_key: string; hf: number } | undefined;
      return hp && hp.hf === 0 ? [{ urlKey: hp.url_key, evidence: { note: 'no <link rel="icon"> on the homepage' } }] : [];
    },
  },
  {
    id: 'sitemap-lastmod-untrustworthy', category: 'indexation', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'Sitemap lastmod dates are not trustworthy', fix: 'Google uses <lastmod> to prioritise recrawling — but only while it stays honest; a sitemap that stamps everything with the generation date (or future dates) teaches Google to ignore yours. Make lastmod reflect the last genuine content change, or drop it entirely.',
    run: (c) => {
      const all = c.db.prepare(`SELECT url_key, lastmod FROM sitemap_urls WHERE lastmod IS NOT NULL AND lastmod <> ''`).all() as { url_key: string; lastmod: string }[];
      if (all.length < 20) return []; // too few dated URLs to judge the pattern
      const ev: Record<string, unknown> = { urlsWithLastmod: all.length };
      let tripped = false;
      // Tell 1: a generator stamping every URL with "now" — >90% share one date, and that date is recent.
      const byDay = new Map<string, number>();
      for (const r of all) byDay.set(r.lastmod.slice(0, 10), (byDay.get(r.lastmod.slice(0, 10)) ?? 0) + 1);
      const [topDay, topN] = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
      const ageDays = (Date.now() - Date.parse(topDay)) / 86400000;
      if (topN / all.length > 0.9 && Number.isFinite(ageDays) && ageDays < 35) {
        tripped = true;
        ev.sharedStamp = `${Math.round(topN / all.length * 100)}% of URLs claim ${topDay} — a generation timestamp, not a change date`;
      }
      // Tell 2: dates in the future.
      const future = all.filter(r => Date.parse(r.lastmod) > Date.now() + 86400000).length;
      if (future > 0) { tripped = true; ev.futureDates = future; }
      // Tell 3: lastmod claims a change between our two most recent crawls, yet none of the
      // tracked page fields (status, title, meta, H1, word count, schema types) changed.
      const crawls = latestTwoCrawls(c.db);
      if (crawls.length === 2) {
        // Compare DATE prefixes on both sides — lastmod is stored verbatim and often a full
        // timestamp; compared raw against a 10-char date, same-day stamps sort "after" the
        // boundary and are silently excluded (exactly the stamp-everything-today pattern).
        const phantom = c.db.prepare(
          `SELECT s.url_key FROM sitemap_urls s
           JOIN page_snapshots n ON n.url_key = s.url_key AND n.crawl_id = ?
           JOIN page_snapshots o ON o.url_key = s.url_key AND o.crawl_id = ?
           WHERE substr(s.lastmod,1,10) > substr(?,1,10) AND substr(s.lastmod,1,10) <= substr(?,1,10)
             AND n.status_code IS o.status_code AND n.title IS o.title AND n.meta_description IS o.meta_description
             AND n.h1 IS o.h1 AND n.word_count IS o.word_count AND n.schema_types IS o.schema_types
           LIMIT 200`,
        ).all(crawls[0].crawl_id, crawls[1].crawl_id, crawls[1].at, crawls[0].at) as { url_key: string }[];
        if (phantom.length >= 5) {
          tripped = true;
          ev.phantomChanges = phantom.length;
          ev.phantomExamples = phantom.slice(0, 5).map(p => p.url_key);
        }
      }
      return tripped ? [{ urlKey: null, evidence: ev }] : [];
    },
  },
  {
    id: 'no-304-revalidation', category: 'performance', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'Server ignores conditional requests (no 304)', fix: 'Pages advertise Last-Modified/ETag but the server re-serves a full 200 when asked "has this changed?" (If-Modified-Since / If-None-Match). A properly configured server answers 304 Not Modified — it saves bandwidth on every revalidating crawler and cache, and signals stability to Googlebot. Usually a server/CDN setting.',
    // Populated by the crawler's post-crawl probe (pages.conditional_304); NULL-gated so
    // pre-feature crawls never flag. Fires only when NO probed page honoured the request.
    run: (c) => {
      const r = c.db.prepare(`SELECT COUNT(*) probed, COALESCE(SUM(conditional_304),0) ok FROM pages WHERE conditional_304 IS NOT NULL`).get() as { probed: number; ok: number };
      if (r.probed < 5 || r.ok > 0) return [];
      const noValidators = (c.db.prepare(`SELECT COUNT(*) n FROM pages WHERE status_code=200 AND ${HTML_CT} AND last_modified IS NULL AND etag IS NULL`).get() as { n: number }).n;
      return [{ urlKey: null, evidence: { probed: r.probed, honoured304: 0, pagesWithoutValidators: noValidators, note: 'every conditional re-request returned a full 200' } }];
    },
  },
  {
    id: 'analytics-missing', category: 'onpage', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'No client-side analytics detected', fix: 'No analytics or tag-manager snippet was found on any crawled page (GA4, GTM, Plausible, Matomo, Fathom, Clarity…). If you measure server-side, ignore this; otherwise you\'re flying blind — install an analytics package before making SEO decisions.',
    // Fires only when EVERY populated page lacks a snippet — one page with analytics = installed.
    run: (c) => {
      const r = c.db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(has_analytics),0) withA FROM pages WHERE status_code=200 AND ${HTML_CT} AND has_analytics IS NOT NULL`).get() as { total: number; withA: number };
      return r.total >= 3 && r.withA === 0 ? [{ urlKey: null, evidence: { pagesChecked: r.total, note: 'no known analytics snippet on any crawled page (server-side measurement is invisible to a crawl)' } }] : [];
    },
  },

  // ── Google "AI features / succeeding in AI search" guide (developers.google.com/search/docs/
  // fundamentals/ai-optimization-guide, read 2026-08-02) — principle → check mapping:
  //   • Unique/compelling/non-commodity, people-first content .... thin-content, content-bloat,
  //     ai-slop-signals (NEW below — mechanical/templated prose is the anti-signal of "unique take")
  //   • Unique point of view / first-hand experience .............. article-no-author (NEW below —
  //     unattributed articles are the deterministically checkable slice), stale-content
  //   • Clear organisation (paragraphs/sections/headings) ......... poor-chunkability, content-bloat,
  //     heading-hierarchy; answer coverage: body-missing-top-query, rag-answer-gap,
  //     answer-not-front-loaded, weak-passage-answer, low-extractability
  //   • Indexed + snippet-eligible / technical requirements ....... indexation family (noindex,
  //     canonical, robots-blocked-with-traffic), soft-404-shell, sitemap reconciliation
  //   • Crawlable public content .................................. crawlability family, broken links,
  //     redirect chains; freshness-honesty (sitemap-lastmod-untrustworthy, no-304-revalidation)
  //   • Semantic HTML / parseable ................................. heading-hierarchy, missing-h1,
  //     multiple-h1, missing-lang
  //   • Reduce duplicate content .................................. duplicate-title/meta, canonical
  //     family, faceted-spider-trap, keyword-cannibalisation
  //   • Images/video supporting text .............................. image-alt, images-missing-dimensions
  //   • Page experience / latency ................................. performance proxies, high-yield-cwv-fail
  //   • Structured data honesty (not required, but keep it valid) . schema-validate family,
  //     article-date-illogical
  //   • Don't chunk artificially / rewrite for AI ................. covered by NOT having such checks;
  //     our chunk checks reward structure for humans, not tiny AI fragments
  //   • "Don't create llms.txt" ................................... tension with agent-readiness probes,
  //     which score llms.txt for *agent* (not Google AI-search) consumption — left as-is, different audience
  //   • Merchant Center / Business Profile / GenAI report ......... out of scope (not crawl/GSC data)
  {
    // Anti-signal of the guide's "unique, non-commodity, people-first content": prose that reads
    // machine-generated. Three heuristics over body_chunks — slop-lexicon density, sentence-length
    // uniformity (low variance = mechanical), repeated chunk openers (page-internal boilerplate).
    // Precision over recall: absolute floors on every signal, ≥2 signals required, AND the composite
    // score must sit in the top decile of pages showing any signal. Judgement-gated — a human wrote
    // "delve" long before LLMs did.
    id: 'ai-slop-signals', category: 'content', severity: 'low', labels: ['N'], certainty: 0.5, effortBase: 5, fixType: 'per-page',
    title: 'Prose shows machine-generated (slop) signals', fix: 'This page’s copy trips several statistical tells of generic AI-generated text: stock filler phrases, unusually uniform sentence lengths, and/or sections that all open the same way. Google’s AI-search guidance rewards unique, people-first content with a first-hand point of view — rewrite the flagged sections with specifics only you can supply (real experience, real numbers, real opinions) and cut the filler. (Heuristic — verify by reading the page; competent human writing can trip these tells.)',
    run: (c) => {
      const PHRASES = [
        'in today’s fast-paced world', "in today's fast-paced world", 'in today’s digital age', "in today's digital age",
        'it’s important to note', "it's important to note", 'it is important to note', 'in conclusion',
        'harness the power', 'unlock the potential', 'look no further', 'in the realm of', 'navigate the complexities',
        'a testament to', 'plays a crucial role', 'a wide range of', 'when it comes to', 'at the end of the day',
        'whether you’re a', "whether you're a", 'let’s dive', "let's dive", 'dive into the world of',
        'elevate your', 'take your * to the next level', 'game-changer', 'game changer', 'cutting-edge', 'ever-evolving',
        'treasure trove', 'rich tapestry', 'delve', 'delving', 'seamlessly', 'revolutionize', 'revolutionise', 'unleash',
      ].filter(p => !p.includes('*'));
      type M = { urlKey: string; score: number; signals: number; hits: Map<string, number>; density: number; cv: number | null; opener: { text: string; n: number } | null; sentences: number };
      const metrics: M[] = [];
      for (const x of iterRows(c, `SELECT url_key urlKey, word_count wc, body_chunks bc FROM pages WHERE status_code=200 AND indexable=1 AND ${HTML_CT} AND word_count >= 300 AND body_chunks IS NOT NULL`)) {
        let chunks: any[]; try { chunks = JSON.parse(x.bc); } catch { continue; }
        const texts = chunks.map((k: any) => String(k.text || '')).filter(t => t.length > 0);
        if (!texts.length) continue;
        const body = texts.join(' ').toLowerCase();
        const bodyWords = body.split(/\s+/).filter(Boolean).length;
        if (bodyWords < 250) continue;
        // (i) slop-lexicon density (hits per 1000 words, ≥3 distinct terms required)
        const hits = new Map<string, number>();
        for (const p of PHRASES) {
          let n = 0, i = -1;
          while ((i = body.indexOf(p, i + 1)) !== -1) n++;
          if (n) hits.set(p, n);
        }
        const totalHits = [...hits.values()].reduce((a, b) => a + b, 0);
        const density = totalHits / bodyWords * 1000;
        const lexSignal = hits.size >= 3 && density >= 2.5;
        // (ii) sentence-length uniformity — coefficient of variation over sentence word-counts
        const sentences = body.split(/[.!?]+\s/).map(s => s.split(/\s+/).filter(Boolean).length).filter(n => n >= 5 && n <= 60);
        let cv: number | null = null;
        if (sentences.length >= 12) {
          const mean = sentences.reduce((a, b) => a + b, 0) / sentences.length;
          cv = Math.sqrt(sentences.reduce((a, b) => a + (b - mean) ** 2, 0) / sentences.length) / mean;
        }
        const uniformSignal = cv !== null && cv < 0.28;
        // (iii) repeated openers across the page's own chunks (first 3 words, ≥3 chunks sharing one)
        const openers = new Map<string, number>();
        if (texts.length >= 5) for (const t of texts) {
          // Letters only — numeric/UI-chrome openers ("Show 10 20…") are widget text, not prose.
          const o = t.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2).slice(0, 3).join(' ');
          if (o.split(' ').length === 3) openers.set(o, (openers.get(o) ?? 0) + 1);
        }
        const topOpener = [...openers.entries()].sort((a, b) => b[1] - a[1])[0];
        const boilerSignal = !!topOpener && topOpener[1] >= 3;
        const signals = (lexSignal ? 1 : 0) + (uniformSignal ? 1 : 0) + (boilerSignal ? 1 : 0);
        if (signals === 0) continue;
        const score = density + (uniformSignal ? 3 : 0) + (boilerSignal ? 2 : 0);
        metrics.push({ urlKey: x.urlKey, score, signals, hits, density, cv, opener: boilerSignal ? { text: topOpener![0], n: topOpener![1] } : null, sentences: sentences.length });
      }
      if (!metrics.length) return [];
      // Outliers only: the LEXICON signal is mandatory (uniform sentences + repeated openers
      // without a single slop phrase is template chrome, not slop — live-verified on simracing),
      // plus ≥1 corroborating signal, AND composite score in the top decile of pages that showed
      // any signal at all.
      const sorted = metrics.map(m => m.score).sort((a, b) => a - b);
      const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
      return metrics
        .filter(m => m.signals >= 2 && m.hits.size >= 3 && m.density >= 2.5 && m.score >= p90)
        .sort((a, b) => b.score - a.score).slice(0, 30)
        .map(m => ({ urlKey: m.urlKey, evidence: {
          slopPhrases: [...m.hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, n]) => `${p} ×${n}`),
          lexDensityPer1000: Math.round(m.density * 10) / 10,
          sentenceLengthCV: m.cv !== null ? Math.round(m.cv * 100) / 100 : null,
          repeatedOpener: m.opener ? `"${m.opener.text}…" opens ${m.opener.n} sections` : null,
          sentencesMeasured: m.sentences,
          note: 'multiple statistical slop signals — verify by reading before rewriting',
        } }));
    },
  },
  {
    // The guide's "unique point of view based on personal experience or expertise", cut down to its
    // deterministically checkable slice: an Article/BlogPosting that carries schema yet names no
    // author. Attribution is the machine-readable experience/expertise signal; a byline-less article
    // is the commodity-content default. Only fires where Article schema EXISTS (no schema at all is
    // schema-opportunity territory, not this check).
    id: 'article-no-author', category: 'schema', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'Article schema with no author attribution', fix: 'This page marks itself up as an Article/BlogPosting but declares no author. Google’s AI-search guidance rewards content with a demonstrable first-hand point of view — add `author` (a Person with a real name, ideally linking to an author page) to the Article schema and a visible byline to match.',
    run: (c) => {
      const out: RawFinding[] = [];
      for (const r of rows(c, `SELECT url_key urlKey, json_ld jsonLd FROM pages WHERE status_code=200 AND indexable=1 AND json_ld LIKE '%Article%'`)) {
        for (const n of parseJsonLdNodes(r.jsonLd)) {
          const t = nodeType(n);
          if (!t || !/^(article|blogposting|newsarticle|techarticle|scholarlyarticle)$/i.test(t)) continue;
          const a = (n as any).author;
          const named = (v: any): boolean => !!v && (typeof v === 'string' ? v.trim().length > 0
            : Array.isArray(v) ? v.some(named) : typeof v === 'object' && typeof v.name === 'string' && v.name.trim().length > 0);
          if (!named(a)) { out.push({ urlKey: r.urlKey, evidence: { schemaType: t, author: a ?? null, note: 'Article markup present, author absent or unnamed' } }); break; }
        }
      }
      return out;
    },
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

  // declared[sourceKey] = set of internal alternate targetKeys (excluding self)
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
    // A return link via x-default is a VALID return tag (common when x-default is the
    // homepage) — include all targets here; x-default is only excluded as a reciprocation
    // *requirement* in the loop below, never as a way of satisfying one.
    declared.set(p.url_key, new Set(targets.map(t => t.key)));
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
