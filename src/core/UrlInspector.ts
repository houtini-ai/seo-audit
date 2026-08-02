import { AuditDatabase } from './AuditDatabase.js';
import { GscClient } from './GscClient.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty } from './url-key.js';

export interface InspectResult {
  siteUrl: string;
  inspected: number;
  failed: number;
}

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
        `SELECT page AS url FROM search_analytics WHERE page IS NOT NULL
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
        } catch (err: unknown) {
          failed++;
          console.error(`[inspect] ${url}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (inspected % 10 === 0) update({ siteUrl, inspected, failed });
        if (delayMs) await sleep(delayMs);
      }
      update({ siteUrl, inspected, failed });
      return { siteUrl, inspected, failed };
    } finally {
      db.close();
    }
  }
}
