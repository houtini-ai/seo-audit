import { PAGE_TOTALS, pageTotalsRange } from './gscPageTotals.js';
import { AuditDatabase } from './AuditDatabase.js';
import { GscClient } from './GscClient.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty } from './url-key.js';

export interface InspectResult {
  siteUrl: string;
  inspected: number;
  failed: number;
  /** Set when the run stopped early: the API refused several URLs in a row (quota or permission). */
  stopped?: string;
}

/** Consecutive quota / permission refusals after which the run stops instead of retrying every URL. */
export const INSPECT_MAX_CONSECUTIVE_REFUSALS = 3;

/** 429 (quota) and 401/403 (no access to the property) fail every later URL the same way. */
function isRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  const status = Number(e?.response?.status ?? e?.status ?? e?.code);
  if (status === 429) return true;
  return /quota|rate limit/i.test(err instanceof Error ? err.message : String(err));
}

/** A 401/403: no access to the property — or just to this URL (one outside the property answers 403 too). */
function isAuthError(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  const status = Number(e?.response?.status ?? e?.status ?? e?.code);
  if (status === 401 || status === 403) return true;
  return /permission|forbidden|unauthori[sz]ed/i.test(err instanceof Error ? err.message : String(err));
}
/** Permission errors only stop the run when nothing has been inspected and this many URLs in a row
 *  were refused: a few URLs outside the property must not end a run that would otherwise work. */
const INSPECT_MAX_LEADING_AUTH_ERRORS = 10;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Sampled GSC URL Inspection pass → url_inspection table. The API is quota-limited
 * (~2k/day, ~600/min per site), so we inspect priority URLs only: top pages by GSC
 * clicks if synced, else top crawled pages by in-degree.
 */
export class UrlInspector {
  constructor(private readonly gsc: GscClient, private readonly dataDir: string) {}

  private targetUrls(db: AuditDatabase, limit: number): string[] {
    const byClicks = db.db
      .prepare(
        // Page totals when synced (#118): they include pages whose clicks are all anonymised queries.
        `SELECT page AS url FROM ${pageTotalsRange(db.db).max ? PAGE_TOTALS : 'gsc_rows'} WHERE page IS NOT NULL
         GROUP BY page ORDER BY SUM(clicks) DESC LIMIT ?`,
      )
      .all(limit) as { url: string }[];
    if (byClicks.length) return byClicks.map(r => r.url);
    const byLinks = db.db
      .prepare(`SELECT url FROM pages WHERE status_code = 200 ORDER BY inlink_count DESC LIMIT ?`)
      .all(limit) as { url: string }[];
    return byLinks.map(r => r.url);
  }

  async run(
    siteUrl: string,
    opts: { limit?: number; delayMs?: number },
    update: (p: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<InspectResult> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const delayMs = opts.delayMs ?? 200;
    const hostForm = hostFormForProperty(siteUrl);
    const db = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
    try {
      const urls = this.targetUrls(db, limit);
      const upsert = db.db.prepare(
        `INSERT INTO url_inspection
           (url_key, url, verdict, coverage_state, indexing_state, robots_txt_state, page_fetch_state,
            last_crawl_time, google_canonical, user_canonical, crawled_as, mobile_usability, rich_results, referring_urls, inspected_at)
         VALUES (@url_key,@url,@verdict,@coverage_state,@indexing_state,@robots_txt_state,@page_fetch_state,
            @last_crawl_time,@google_canonical,@user_canonical,@crawled_as,@mobile_usability,@rich_results,@referring_urls,datetime('now'))
         ON CONFLICT(url_key) DO UPDATE SET
           verdict=excluded.verdict, coverage_state=excluded.coverage_state, indexing_state=excluded.indexing_state,
           robots_txt_state=excluded.robots_txt_state, page_fetch_state=excluded.page_fetch_state,
           last_crawl_time=excluded.last_crawl_time, google_canonical=excluded.google_canonical,
           user_canonical=excluded.user_canonical, crawled_as=excluded.crawled_as,
           mobile_usability=excluded.mobile_usability, rich_results=excluded.rich_results,
           referring_urls=excluded.referring_urls, inspected_at=datetime('now')`,
      );

      let inspected = 0;
      let failed = 0;
      let refusals = 0, authErrors = 0;
      let lastError = '';
      let stopped: string | undefined;
      for (const url of urls) {
        if (signal.aborted) break;
        try {
          const r = await this.gsc.inspectUrl(siteUrl, url);
          const idx = r.indexStatusResult ?? {};
          upsert.run({
            url_key: urlKey(url, { hostForm }),
            url,
            verdict: idx.verdict ?? null,
            coverage_state: idx.coverageState ?? null,
            indexing_state: idx.indexingState ?? null,
            robots_txt_state: idx.robotsTxtState ?? null,
            page_fetch_state: idx.pageFetchState ?? null,
            last_crawl_time: idx.lastCrawlTime ?? null,
            google_canonical: idx.googleCanonical ?? null,
            user_canonical: idx.userCanonical ?? null,
            crawled_as: idx.crawledAs ?? null,
            mobile_usability: r.mobileUsabilityResult?.verdict ?? null,
            rich_results: r.richResultsResult ? JSON.stringify(r.richResultsResult) : null,
            // Sample of pages Google found linking here — external corroboration for orphan checks.
            referring_urls: Array.isArray(idx.referringUrls) && idx.referringUrls.length ? JSON.stringify(idx.referringUrls) : null,
          });
          inspected++;
          refusals = 0;
        } catch (err: unknown) {
          failed++;
          lastError = err instanceof Error ? err.message : String(err);
          console.error(`[inspect] ${url}: ${lastError}`);
          // A spent quota or a missing permission refuses every remaining URL too (each after its
          // own retries): stop, rather than spend an hour failing and then report "completed".
          refusals = isRefusal(err) ? refusals + 1 : 0;
          authErrors = isAuthError(err) && !isRefusal(err) ? authErrors + 1 : 0;
          if (inspected === 0 && authErrors >= INSPECT_MAX_LEADING_AUTH_ERRORS) {
            stopped = `stopped after the first ${authErrors} URLs were all refused with a permission error by the URL Inspection API (${lastError})`;
            break;
          }
          if (refusals >= INSPECT_MAX_CONSECUTIVE_REFUSALS) {
            stopped = `stopped after ${refusals} consecutive quota errors from the URL Inspection API (${lastError})`;
            break;
          }
        }
        if (inspected % 10 === 0) update({ siteUrl, inspected, failed });
        if (delayMs) await sleep(delayMs);
      }
      update({ siteUrl, inspected, failed, ...(stopped ? { stopped } : {}) });
      // Nothing inspected and something failed is a failed job, with the reason, not a completed one.
      if (inspected === 0 && failed > 0) {
        throw new Error(`URL Inspection failed for ${siteUrl}: ${stopped ?? `all ${failed} URL(s) failed (last error: ${lastError})`}. Nothing was inspected. The API allows about 2,000 inspections a day per property, and the service account must be a user on the property.`);
      }
      return { siteUrl, inspected, failed, ...(stopped ? { stopped } : {}) };
    } finally {
      db.close();
    }
  }
}
