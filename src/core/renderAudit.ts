import { fetch as ufetch, Agent } from 'undici';
import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { hostFormForProperty } from './url-key.js';
import { extractPage, decodeHtmlBody, type ExtractedPage } from './extract.js';
import { renderHtml, closeRenderer, rendererAvailable } from './render.js';

const DEFAULT_UA = 'Mozilla/5.0 (compatible; seo-audit-console/0.1; +https://github.com/houtini-ai/seo-audit-console)';

export interface RenderDiff {
  rawWordCount: number;
  renderedWordCount: number;
  wordCountDelta: number;          // rendered - raw (positive = content appears only after JS)
  rawInternalLinks: number;
  renderedInternalLinks: number;
  linksOnlyRendered: number;       // distinct internal link targets present rendered but not in raw HTML
  sampleNewLinks: string[];
  titleChanged: boolean;
  rawTitle: string | null;
  renderedTitle: string | null;
  canonicalChanged: boolean;
}

/** Pure diff of the raw-HTML extract vs the rendered-DOM extract - the "Response vs Render" delta.
 * This is the testable core; no network/browser. */
export function diffRawVsRendered(raw: ExtractedPage, rendered: ExtractedPage): RenderDiff {
  const rawKeys = new Set(raw.links.filter(l => l.isInternal).map(l => l.targetKey));
  const newLinks = [...new Set(
    rendered.links.filter(l => l.isInternal && !rawKeys.has(l.targetKey)).map(l => l.targetKey),
  )];
  return {
    rawWordCount: raw.wordCount,
    renderedWordCount: rendered.wordCount,
    wordCountDelta: rendered.wordCount - raw.wordCount,
    rawInternalLinks: raw.internalLinks,
    renderedInternalLinks: rendered.internalLinks,
    linksOnlyRendered: newLinks.length,
    sampleNewLinks: newLinks.slice(0, 10),
    titleChanged: (raw.title ?? '') !== (rendered.title ?? ''),
    rawTitle: raw.title,
    renderedTitle: rendered.title,
    canonicalChanged: (raw.canonicalKey ?? '') !== (rendered.canonicalKey ?? ''),
  };
}

/** A page "depends on JS" when meaningful content or links exist only after rendering. */
export function dependsOnJsFlag(d: RenderDiff): boolean {
  return d.linksOnlyRendered > 0
    || (d.rawWordCount < 50 && d.renderedWordCount >= 100)                 // body only after render
    || (!(d.rawTitle ?? '').trim() && !!(d.renderedTitle ?? '').trim());   // title only after render
}

export interface RenderAuditResult {
  available: boolean;              // was the renderer usable
  note?: string;                   // why not, when unavailable
  audited: number;
  dependsOnJs: number;             // pages where content/links appear only after render
  rows: (RenderDiff & { urlKey: string })[];
}

/**
 * Response vs Render: for a BOUNDED, sampled set of indexable HTML pages, fetch the raw HTML (undici)
 * and the rendered DOM (headless Chromium) and diff the two extracts. Persists to `render_audit`;
 * powers the `content-only-in-rendered-dom` check. Opt-in and slow (a real browser), so it's a
 * separate pass, never part of the default crawl. Degrades gracefully when Playwright/Chromium
 * isn't installed.
 */
export async function auditRender(
  dataDir: string,
  siteUrl: string,
  opts: { limit?: number; urls?: string[]; userAgent?: string } = {},
  update: (p: Record<string, unknown>) => void = () => {},
  signal?: AbortSignal,
): Promise<RenderAuditResult> {
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    if (!(await rendererAvailable())) {
      return { available: false, note: 'Rendering needs the optional "playwright" package: run `npm i playwright && npx playwright install chromium`. The HTTP audit is unaffected.', audited: 0, dependsOnJs: 0, rows: [] };
    }
    const hostForm = hostFormForProperty(siteUrl) ?? 'asis';
    const baseHost = (() => { try { return new URL(siteUrl.replace(/^sc-domain:/, 'https://')).hostname; } catch { return siteUrl; } })();
    const keyOpts = { hostForm } as Parameters<typeof extractPage>[3];
    const limit = opts.limit ? Math.floor(opts.limit) : 10;

    const pages = opts.urls?.length
      ? opts.urls.map(u => ({ url: u })).slice(0, limit)
      : db.db.prepare(`SELECT url FROM pages WHERE status_code=200 AND indexable=1 AND url LIKE 'http%' ORDER BY word_count ASC LIMIT ${limit}`).all() as { url: string }[];

    const dispatcher = new Agent({ allowH2: true, connections: 2 });
    const ua = opts.userAgent ?? DEFAULT_UA;
    const upsert = db.db.prepare(
      `INSERT INTO render_audit (url_key, raw_word_count, rendered_word_count, raw_internal_links, rendered_internal_links,
         links_only_rendered, sample_new_links, title_changed, rendered_title, canonical_changed, rendered_at)
       VALUES (@url_key,@raw_word_count,@rendered_word_count,@raw_internal_links,@rendered_internal_links,
         @links_only_rendered,@sample_new_links,@title_changed,@rendered_title,@canonical_changed,datetime('now'))
       ON CONFLICT(url_key) DO UPDATE SET raw_word_count=excluded.raw_word_count, rendered_word_count=excluded.rendered_word_count,
         raw_internal_links=excluded.raw_internal_links, rendered_internal_links=excluded.rendered_internal_links,
         links_only_rendered=excluded.links_only_rendered, sample_new_links=excluded.sample_new_links,
         title_changed=excluded.title_changed, rendered_title=excluded.rendered_title,
         canonical_changed=excluded.canonical_changed, rendered_at=datetime('now')`,
    );

    const rows: (RenderDiff & { urlKey: string })[] = [];
    let dependsOnJs = 0;
    try {
      for (let i = 0; i < pages.length; i++) {
        if (signal?.aborted) break;
        const url = pages[i].url;
        update({ phase: 'render', done: i, total: pages.length, current: url });
        let rawHtml: string, rendered: string;
        try {
          const res = await ufetch(url, { dispatcher, headers: { 'user-agent': ua, 'accept-encoding': 'gzip, deflate, br' }, signal: AbortSignal.timeout(20000) }) as unknown as Response;
          rawHtml = decodeHtmlBody(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type'));
          rendered = await renderHtml(url, ua);
        } catch { continue; } // unreachable / render timeout - skip this URL, keep the batch going
        const rawEx = extractPage(rawHtml, url, baseHost, keyOpts);
        const renEx = extractPage(rendered, url, baseHost, keyOpts);
        const diff = diffRawVsRendered(rawEx, renEx);
        const found = db.db.prepare('SELECT url_key FROM pages WHERE url=? LIMIT 1').get(url) as { url_key?: string } | undefined;
        const key = found?.url_key ?? url;
        upsert.run({
          url_key: key, raw_word_count: diff.rawWordCount, rendered_word_count: diff.renderedWordCount,
          raw_internal_links: diff.rawInternalLinks, rendered_internal_links: diff.renderedInternalLinks,
          links_only_rendered: diff.linksOnlyRendered, sample_new_links: diff.sampleNewLinks.length ? JSON.stringify(diff.sampleNewLinks) : null,
          title_changed: diff.titleChanged ? 1 : 0, rendered_title: diff.renderedTitle, canonical_changed: diff.canonicalChanged ? 1 : 0,
        });
        rows.push({ ...diff, urlKey: key });
        if (dependsOnJsFlag(diff)) dependsOnJs++;
      }
    } finally {
      await closeRenderer();
    }
    return { available: true, audited: rows.length, dependsOnJs, rows };
  } finally {
    db.close();
  }
}
