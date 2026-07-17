import { google } from 'googleapis';
import type { GscProperty, GscApiRow, FetchOptions } from './types.js';

const ROW_LIMIT = 25000; // GSC API max per request
const DEFAULT_DIMENSIONS = ['query', 'page', 'date', 'device', 'country'];
const MAX_RETRIES = 3;
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503];
// Node network errors carry a string code, not an HTTP status — a mid-sync connection
// blip should be retried, not fail the whole multi-page sync job.
const RETRYABLE_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'UND_ERR_SOCKET']);

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.code || err?.response?.status || err?.status;
      const isRetryable = RETRYABLE_STATUS_CODES.includes(Number(status))
        || RETRYABLE_NET_CODES.has(String(status))
        || RETRYABLE_NET_CODES.has(String(err?.cause?.code));
      if (!isRetryable || attempt === retries) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      console.error(`[GSC] Retryable error (${status}), attempt ${attempt + 1}/${retries}, waiting ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unreachable');
}

export interface PageResult {
  rows: GscApiRow[];
  totalSoFar: number;
  startRow: number;
}

/** Thin googleapis wrapper for Search Console (ported from better-search-console). */
export class GscClient {
  private auth: any;
  private searchconsole: any;

  constructor(credentialsPath: string) {
    this.auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
    this.searchconsole = google.searchconsole({ version: 'v1', auth: this.auth });
  }

  async listProperties(): Promise<GscProperty[]> {
    const response: any = await withRetry(() => this.searchconsole.sites.list());
    const sites = response.data.siteEntry || [];
    return sites.map((site: any) => ({ siteUrl: site.siteUrl, permissionLevel: site.permissionLevel }));
  }

  /** URL Inspection API — authoritative per-URL index status. Quota-limited (~2k/day). */
  async inspectUrl(siteUrl: string, inspectionUrl: string): Promise<any> {
    const res: any = await withRetry(() =>
      this.searchconsole.urlInspection.index.inspect({ requestBody: { inspectionUrl, siteUrl } }),
    );
    return res.data.inspectionResult ?? {};
  }

  /**
   * Fetch search analytics, streaming each 25k-row page to `onPage` so callers
   * commit to the DB immediately instead of buffering everything in memory.
   * Returns the total row count.
   */
  async fetchSearchAnalytics(
    siteUrl: string,
    options: FetchOptions,
    signal?: AbortSignal,
    onPage?: (page: PageResult) => void,
  ): Promise<number> {
    const dimensions = options.dimensions || DEFAULT_DIMENSIONS;
    let totalRows = 0;
    let startRow = 0;

    while (true) {
      if (signal?.aborted) {
        console.error(`[GSC] Sync aborted after ${totalRows} rows`);
        break;
      }

      const response: any = await withRetry(() =>
        this.searchconsole.searchanalytics.query({
          siteUrl,
          requestBody: {
            startDate: options.startDate,
            endDate: options.endDate,
            dimensions,
            rowLimit: options.rowLimit || ROW_LIMIT,
            startRow,
            dataState: options.dataState || 'all',
            ...(options.searchType ? { type: options.searchType } : {}),
          },
        }),
      );

      const rows: GscApiRow[] = (response.data.rows || []).map((row: any) => ({
        keys: row.keys,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      }));

      totalRows += rows.length;
      if (onPage && rows.length > 0) onPage({ rows, totalSoFar: totalRows, startRow });

      if (rows.length < (options.rowLimit || ROW_LIMIT)) break;
      startRow += rows.length;
      console.error(`[GSC] Fetched ${totalRows} rows so far (startRow=${startRow})...`);
    }

    return totalRows;
  }
}
