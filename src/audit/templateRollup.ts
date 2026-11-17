/**
 * 0.16.1: roll accessibility findings up per template. A theme's nameless icon links and buttons sit
 * on every page, so a per-page check reported the same two buttons 415 times on a 415-page site. The
 * crawl records which elements failed (pages.a11y_samples: a template-stable selector, plus the href's
 * shape for links), and this groups the elements several pages share by the exact set of pages they
 * sit on (a header's icon links appear together), much as render-blocking-head-resources groups pages
 * by their exact set of blocking files:
 *   - one finding per shared set (scope "template"): how many pages carry it, sample pages, the elements;
 *   - one finding per page for whatever it has on top of that (scope "page"), so a nameless link in
 *     one article's body still gets its own finding.
 * An element is "shared" when it appears on at least TEMPLATE_MIN_PAGES pages. Pages crawled before
 * 0.16.1 have no samples and keep one finding per page (re-crawl to group them).
 */
import { pageRowsFor } from '../core/gscPageTotals.js';
import type { CheckContext, RawFinding } from './checks.js';

export const TEMPLATE_MIN_PAGES = 3;
const ELEMENTS_SHOWN = 10;
const SAMPLE_PAGES = 10;

export interface A11yRollupSpec {
  /** Which list in pages.a11y_samples. */
  kind: 'links' | 'buttons' | 'dupIds';
  /** The pages column holding the per-page count (a11y_links_no_name, ...). */
  countCol: string;
  /** Evidence key for the count (namelessLinks, ...), unchanged from the per-page findings. */
  countKey: string;
  /** 'occurrences' when the count is elements (two nameless links with one signature count 2); 'distinct' when it is distinct values (duplicate ids). */
  unit: 'occurrences' | 'distinct';
}

const hasColumn = (c: CheckContext, table: string, col: string): boolean =>
  (c.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(r => r.name === col);

export function rollupA11y(c: CheckContext, spec: A11yRollupSpec): RawFinding[] {
  const samplesCol = hasColumn(c, 'pages', 'a11y_samples') ? 'a11y_samples' : 'NULL';
  const rows = c.db.prepare(
    `SELECT url_key k, ${spec.countCol} n, ${samplesCol} s FROM pages WHERE status_code=200 AND indexable=1 AND ${spec.countCol} > 0 ORDER BY url_key`,
  ).all() as { k: string; n: number; s: string | null }[];
  if (!rows.length) return [];

  const clicks = new Map<string, number>();
  if (c.gscMaxDate) {
    for (const r of c.db.prepare(`SELECT page_key k, SUM(clicks) n FROM ${pageRowsFor(c.db, c.gscMaxDate, 28).table} WHERE date <= ? AND date > date(?, '-28 days') AND page_key IS NOT NULL GROUP BY page_key`)
      .all(c.gscMaxDate, c.gscMaxDate) as { k: string; n: number }[]) clicks.set(r.k, r.n ?? 0);
  }
  const byClicks = (a: string, b: string): number => (clicks.get(b) ?? 0) - (clicks.get(a) ?? 0) || a.localeCompare(b);

  const parsed = rows.map(r => {
    let m: Record<string, number> | null = null;
    if (r.s) { try { m = (JSON.parse(r.s) as Record<string, Record<string, number>>)[spec.kind] ?? null; } catch { m = null; } }
    return { k: r.k, n: r.n, m };
  });

  const out: RawFinding[] = [];
  // Legacy rows (crawled before the samples existed): one finding per page, as before.
  const legacy = parsed.filter(p => !p.m);
  const sampled = parsed.filter(p => p.m) as { k: string; n: number; m: Record<string, number> }[];

  const pagesPerSig = new Map<string, number>();
  for (const p of sampled) for (const sig of Object.keys(p.m)) pagesPerSig.set(sig, (pagesPerSig.get(sig) ?? 0) + 1);
  const shared = (sig: string): boolean => (pagesPerSig.get(sig) ?? 0) >= TEMPLATE_MIN_PAGES;
  const weight = (m: Record<string, number>, sig: string): number => (spec.unit === 'occurrences' ? (m[sig] ?? 1) : 1);

  // A template part = the shared elements that sit on exactly the same pages (a header's icon links
  // all appear together). Grouping by each page's whole shared set instead split the site-wide header
  // across every combination of it with a related-posts card that only some pages carry.
  const pagesOfSig = new Map<string, string[]>();
  for (const p of sampled) for (const sig of Object.keys(p.m)) if (shared(sig)) (pagesOfSig.get(sig) ?? pagesOfSig.set(sig, []).get(sig)!).push(p.k);
  const groups = new Map<string, { sigs: string[]; pages: string[] }>();
  for (const [sig, pages] of pagesOfSig) {
    const key = pages.slice().sort().join('\n');
    const g = groups.get(key) ?? groups.set(key, { sigs: [], pages }).get(key)!;
    g.sigs.push(sig);
  }
  const mOf = new Map(sampled.map(p => [p.k, p.m]));
  const own: { k: string; n: number; sigs: string[]; inTemplate: boolean }[] = [];
  for (const p of sampled) {
    const sigs = Object.keys(p.m).sort();
    const tCount = sigs.filter(shared).reduce((a, s) => a + weight(p.m, s), 0);
    // Whatever the page has beyond the shared elements, including elements past the sample cap.
    const extra = Math.max(0, p.n - tCount);
    if (extra > 0) own.push({ k: p.k, n: extra, sigs: sigs.filter(s => !shared(s)), inTemplate: tCount > 0 });
  }

  for (const g of [...groups.values()].map(g => ({ ...g, sigs: g.sigs.sort() })).sort((a, b) => b.pages.length - a.pages.length || a.sigs[0].localeCompare(b.sigs[0]))) {
    const pages = g.pages.slice().sort(byClicks);
    const m = mOf.get(pages[0]) ?? {};
    out.push({ urlKey: pages[0], evidence: {
      scope: 'template', pages: pages.length, samplePages: pages.slice(0, SAMPLE_PAGES),
      [spec.countKey]: g.sigs.reduce((a, s) => a + weight(m, s), 0),
      elements: g.sigs.slice(0, ELEMENTS_SHOWN), elementCount: g.sigs.length,
      note: `the same ${g.sigs.length === 1 ? 'element' : 'elements'} on every page listed (a shared theme/template part): fix ${g.sigs.length === 1 ? 'it' : 'them'} once in the template`,
    } });
  }
  for (const p of own.sort((a, b) => b.n - a.n || byClicks(a.k, b.k))) {
    out.push({ urlKey: p.k, evidence: {
      scope: 'page', [spec.countKey]: p.n, elements: p.sigs.slice(0, ELEMENTS_SHOWN),
      ...(p.inTemplate ? { note: 'on top of the shared elements reported in this check\'s template findings' } : {}),
      ...(p.sigs.length === 0 ? { note: 'more elements than the crawl samples per page; query_data pages a11y_samples lists the first 25' } : {}),
    } });
  }
  for (const p of legacy.sort((a, b) => byClicks(a.k, b.k))) {
    out.push({ urlKey: p.k, evidence: { scope: 'page', [spec.countKey]: p.n, note: 'crawled before 0.16.1, which records the elements: re-crawl to group shared template elements into one finding' } });
  }
  return out;
}
