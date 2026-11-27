/**
 * #55 summary slice 4, group E, item 9: JS-render divergence, from the render tier (render_pages ->
 * render_audit: the raw HTML and the headless-Chromium DOM of a bounded sample of pages, diffed).
 *   - canonical-changed-by-js   the rel=canonical after JS differs from the raw HTML's (added, removed or changed)
 *   - title-changed-by-js       the <title> after JS differs from a non-empty raw title (or JS removed it)
 *   - noindex-changed-by-js     noindex in one version and not the other, either direction
 *   - hydration-content-loss    the rendered main content is much shorter than the raw main content
 *   - schema-only-rendered      JSON-LD types that exist only after JS (or that JS removes)
 *
 * Google's JavaScript SEO basics say a raw-HTML noindex can stop rendering altogether, and advise
 * against changing the canonical or the robots meta tag with JavaScript:
 * https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
 *
 * Same contract as checks.ts: a pure read, thresholds stated, collected() says "not collected" when
 * render_pages has never run (Playwright is optional), or when the rows predate the columns a check
 * needs. A title only present after JS, or body/links only after JS, are content-only-in-rendered-dom's.
 */
import type { CheckContext, CheckDef, RawFinding } from './checks.js';
import { equityLookup, equityWeight, EQUITY_RULE, type Equity } from './checks-redirects.js';

const rows = (c: CheckContext, sql: string, ...args: unknown[]): any[] => c.db.prepare(sql).all(...args);
const one = (c: CheckContext, sql: string, ...args: unknown[]): any => c.db.prepare(sql).get(...args);
const cols = (c: CheckContext): Set<string> => new Set((rows(c, `PRAGMA table_info(render_audit)`) as { name: string }[]).map(x => x.name));
const blank = (s: unknown): boolean => !String(s ?? '').trim();

// ── Thresholds, stated ──────────────────────────────────────────────────────────────────────
/** hydration-content-loss needs at least this many raw main-content words: below it a drop is noise (a short page, a listing)... */
export const HYDRATION_MIN_RAW_WORDS = 200;
/** ...and fires when the rendered main content keeps at most this share of them. Ours, not Google's
 * (Google publishes no threshold): half the copy gone is past a template difference such as a hidden
 * accordion. Flagged for review. */
export const HYDRATION_MAX_RATIO = 0.5;

// ── "Not collected" notes ────────────────────────────────────────────────────────────────────
const NO_RENDER = 'not collected: render_audit is empty. Run render_pages (a bounded sample in headless Chromium; needs the optional Playwright: `npm i playwright && npx playwright install chromium`).';
const OLD_ROWS = 'not collected: every render_audit row predates 0.16.0, which started recording the robots meta tag and main-content words on both sides. Re-run render_pages.';
const renderCount = (c: CheckContext): number => one(c, `SELECT COUNT(*) n FROM render_audit`)?.n ?? 0;
function renderNote(c: CheckContext): string | null { return renderCount(c) > 0 ? null : NO_RENDER; }
const OLD_SCHEMA_ROWS = 'not collected: every render_audit row predates 1.0.8, which started recording the JSON-LD types on both sides. Re-run render_pages.';
function schemaNote(c: CheckContext): string | null {
  if (!renderCount(c)) return NO_RENDER;
  return cols(c).has('raw_schema_types') && (one(c, `SELECT COUNT(*) n FROM render_audit WHERE raw_schema_types IS NOT NULL`)?.n ?? 0) > 0 ? null : OLD_SCHEMA_ROWS;
}
function robotsNote(c: CheckContext): string | null {
  if (!renderCount(c)) return NO_RENDER;
  return cols(c).has('raw_noindex') && (one(c, `SELECT COUNT(*) n FROM render_audit WHERE raw_noindex IS NOT NULL`)?.n ?? 0) > 0 ? null : OLD_ROWS;
}

/** Findings with the page's equity attached, highest equity first (the rule from checks-redirects). */
function withEquity(c: CheckContext, list: RawFinding[]): RawFinding[] {
  const equity = equityLookup(c);
  return list.map(f => { const eq: Equity = equity(f.urlKey!); return { eq, f: { urlKey: f.urlKey, evidence: { ...f.evidence, equity: eq, rule: EQUITY_RULE } } }; })
    .sort((a, b) => equityWeight(b.eq) - equityWeight(a.eq))
    .map(x => x.f);
}

// ── canonical-changed-by-js ──────────────────────────────────────────────────────────────────
function canonicalChangedByJs(c: CheckContext): RawFinding[] {
  const has = cols(c).has('raw_canonical');
  const out = rows(c, `SELECT url_key k, rendered_at at ${has ? ', raw_canonical rc, rendered_canonical dc, raw_noindex rn' : ''} FROM render_audit WHERE canonical_changed = 1`)
    .map(r => {
      const known = has && r.rn != null; // rows rendered since 0.16.0 carry both canonicals (NULL = none on that side)
      const kind = !known ? 'changed (rendered before 0.16.0: re-run render_pages for both values)' : r.rc == null ? 'added-by-js' : r.dc == null ? 'removed-by-js' : 'changed-by-js';
      return { urlKey: r.k, evidence: {
        kind, ...(known ? { rawCanonical: r.rc, renderedCanonical: r.dc } : {}), renderedAt: r.at,
        note: kind === 'added-by-js' ? 'the raw HTML has no canonical; JS adds one, which Google only sees after rendering'
          : kind === 'removed-by-js' ? 'JS removes the raw canonical, so the raw and rendered pages disagree'
          : 'JS rewrites the canonical: Google may use either value',
      } };
    });
  return withEquity(c, out);
}

// ── title-changed-by-js ──────────────────────────────────────────────────────────────────────
function titleChangedByJs(c: CheckContext): RawFinding[] {
  const out = rows(c, `SELECT url_key k, raw_title rt, rendered_title dt, rendered_at at FROM render_audit WHERE title_changed = 1`)
    .filter(r => !blank(r.rt)) // raw empty, title only after JS: content-only-in-rendered-dom reports it
    .map(r => ({ urlKey: r.k, evidence: {
      kind: blank(r.dt) ? 'removed-by-js' : 'changed-by-js', rawTitle: r.rt, renderedTitle: r.dt || null, renderedAt: r.at,
      note: blank(r.dt) ? 'JS empties the title the server sent' : 'JS replaces the title the server sent; Google usually shows the rendered one, so the raw title is not what searchers see',
    } }));
  return withEquity(c, out);
}

// ── noindex-changed-by-js ────────────────────────────────────────────────────────────────────
function noindexChangedByJs(c: CheckContext): RawFinding[] {
  if (!cols(c).has('robots_changed')) return [];
  const out = rows(c, `SELECT url_key k, raw_noindex rn, rendered_noindex dn, raw_robots rr, rendered_robots dr, x_robots_tag xrt, rendered_at at
      FROM render_audit WHERE robots_changed = 1`)
    .map(r => ({ urlKey: r.k, evidence: {
      kind: r.rn ? 'noindex-removed-by-js' : 'noindex-added-by-js', rawRobots: r.rr, renderedRobots: r.dr, xRobotsTag: r.xrt, renderedAt: r.at,
      note: r.rn
        ? 'the raw HTML says noindex and JS removes it: Google can skip rendering a page whose raw HTML is noindex, so the page stays out of the index'
        : 'the raw HTML is indexable and JS adds noindex: Google can drop the page once it renders it',
    } }));
  return withEquity(c, out);
}

// ── hydration-content-loss ───────────────────────────────────────────────────────────────────
/** Main-content words where recorded (since 0.16.0); whole-body words for older rows, labelled. */
function hydrationContentLoss(c: CheckContext): RawFinding[] {
  const hasMain = cols(c).has('raw_main_words');
  const out: RawFinding[] = [];
  for (const r of rows(c, `SELECT url_key k, raw_word_count rw, rendered_word_count dw, rendered_at at ${hasMain ? ', raw_main_words rm, rendered_main_words dm' : ''} FROM render_audit`)) {
    const main = hasMain && r.rm != null && r.dm != null;
    const raw = main ? r.rm : r.rw, ren = main ? r.dm : r.dw;
    if (raw == null || ren == null || raw < HYDRATION_MIN_RAW_WORDS || ren > raw * HYDRATION_MAX_RATIO) continue;
    out.push({ urlKey: r.k, evidence: {
      basis: main ? 'main content' : 'whole body (rendered before 0.16.0)', rawWords: raw, renderedWords: ren, lostPct: Math.round((1 - ren / raw) * 100),
      threshold: `raw >= ${HYDRATION_MIN_RAW_WORDS} words and rendered <= ${HYDRATION_MAX_RATIO * 100}% of raw`, renderedAt: r.at,
      note: 'the server sends the copy, then JavaScript removes most of it (a failed hydration, a client fetch that errored, or a route that re-renders empty): what Google renders is the short version',
    } });
  }
  return withEquity(c, out);
}

// ── schema-only-rendered ─────────────────────────────────────────────────────────────────────
/** Types Google can turn into a rich result or that feed its entity understanding: these get named in the note. */
const RICH_TYPES = new Set(['product', 'productgroup', 'offer', 'aggregateoffer', 'aggregaterating', 'review', 'recipe', 'jobposting',
  'event', 'faqpage', 'qapage', 'howto', 'article', 'newsarticle', 'blogposting', 'breadcrumblist', 'videoobject', 'course',
  'softwareapplication', 'localbusiness', 'organization', 'dataset', 'book', 'movie', 'itemlist', 'discussionforumposting', 'profilepage']);
const parseTypes = (s: unknown): string[] | null => { try { const v = JSON.parse(String(s)); return Array.isArray(v) ? v.map(String) : null; } catch { return null; } };

function schemaOnlyRendered(c: CheckContext): RawFinding[] {
  if (!cols(c).has('raw_schema_types')) return [];
  const out: RawFinding[] = [];
  // Only a raw fetch that returned 200: a 403/5xx or a bot-challenge page has no JSON-LD while the
  // browser renders the real page, which would read as "added by JS".
  for (const r of rows(c, `SELECT url_key k, raw_schema_types rs, rendered_schema_types ds, rendered_at at FROM render_audit
      WHERE raw_schema_types IS NOT NULL AND rendered_schema_types IS NOT NULL AND raw_status = 200`)) {
    const raw = parseTypes(r.rs), ren = parseTypes(r.ds);
    if (!raw || !ren) continue;
    const added = ren.filter(t => !raw.includes(t)), removed = raw.filter(t => !ren.includes(t));
    if (!added.length && !removed.length) continue;
    const kind = added.length && removed.length ? 'changed-by-js' : added.length ? 'added-by-js' : 'removed-by-js';
    out.push({ urlKey: r.k, evidence: {
      kind, onlyAfterJs: added, removedByJs: removed, rawTypes: raw, renderedTypes: ren,
      richResultTypes: [...added, ...removed].filter(t => RICH_TYPES.has(t)), renderedAt: r.at,
      note: removed.length
        ? 'JS removes structured data the server sent: Google reads the rendered page, so those types are lost to it'
        : 'the structured data exists only after JS: Google can read it once it renders the page, but rendering is a later, separate step, and Google warns that JS-generated Product markup makes Shopping crawls less frequent and less reliable',
    } });
  }
  return withEquity(c, out);
}

export const RENDER_CHECKS: CheckDef[] = [
  {
    id: 'canonical-changed-by-js', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'JavaScript changes the canonical',
    fix: 'The rel=canonical after JavaScript differs from the one in the raw HTML (JS added, removed or rewrote it), so Google may use either. Put the final canonical in the server HTML and stop client code (a router, an SEO plugin, a tag manager) from touching it; Google advises against setting the canonical with JS (https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics). Compared as normalised URLs, so a trailing slash alone does not count. Needs render_pages.',
    run: canonicalChangedByJs, collected: renderNote,
  },
  {
    id: 'title-changed-by-js', category: 'onpage', severity: 'med', labels: ['D'], certainty: 1, effortBase: 2, fixType: 'global',
    title: 'JavaScript changes the title',
    fix: 'The <title> after JavaScript differs from the non-empty title in the raw HTML (or JS empties it). Google usually uses the rendered title, so the title written server-side is not the one searchers see, and tools that read raw HTML disagree with Google. Render the final title on the server; if the client must set it, make it set the same text. A title that only exists after JS is content-only-in-rendered-dom. Needs render_pages.',
    run: titleChangedByJs, collected: renderNote,
  },
  {
    id: 'noindex-changed-by-js', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 2, fixType: 'per-page',
    title: 'JavaScript adds or removes noindex',
    fix: 'The page is noindex in one version (raw HTML or rendered DOM) and indexable in the other. Removing a raw noindex with JS does not work: Google can skip rendering a page whose raw HTML says noindex, so it stays out of the index. Adding noindex with JS deindexes a page the server says is indexable. Decide which you want and put it in the server HTML (or the X-Robots-Tag header), with no client-side change (https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics). Needs render_pages (rows rendered since 0.16.0).',
    run: noindexChangedByJs, collected: robotsNote,
  },
  {
    id: 'hydration-content-loss', category: 'content', severity: 'med', labels: ['D'], certainty: 1, effortBase: 5, fixType: 'global',
    title: 'JavaScript removes most of the server-rendered content',
    fix: `The rendered main content keeps at most ${HYDRATION_MAX_RATIO * 100}% of the words the raw HTML's main content had (raw at least ${HYDRATION_MIN_RAW_WORDS} words): the server sends the copy, then the client removes it. Usually a hydration mismatch that re-renders empty, a client-side data fetch that fails for the renderer, or a consent or paywall script that replaces the content. Google indexes the rendered version. Fix the client so it keeps the server's content (check the console for hydration errors). Main content = <main> or [role=main], else the body without nav/header/footer/aside; older rows use whole-body words. The threshold is ours (Google publishes none). Needs render_pages.`,
    run: hydrationContentLoss, collected: renderNote,
  },
  {
    id: 'schema-only-rendered', category: 'schema', severity: 'med', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'global',
    title: 'Structured data only exists after JavaScript',
    fix: 'JSON-LD @types differ between the raw HTML and the rendered DOM: a tag manager, plugin or client component adds the markup (onlyAfterJs) or removes what the server sent (removedByJs). Google can process structured data that JavaScript injects, but only after it renders the page, and for Product markup it warns that generating it with JavaScript makes Shopping crawls less frequent and less reliable (https://developers.google.com/search/docs/appearance/structured-data/generate-structured-data-with-javascript). Crawlers that do not run JavaScript never see it. Output the JSON-LD in the server HTML; if JS must touch it, make it leave the server copy in place. Compares types (top-level, @graph and the edges a page uses for its own entities), not values. Pages whose raw fetch did not return 200 are skipped. Needs render_pages (rows rendered since 1.0.8).',
    run: schemaOnlyRendered, collected: schemaNote,
  },
];
