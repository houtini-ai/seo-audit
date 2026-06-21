import { AuditDatabase } from './AuditDatabase.js';
import { DataForSeoClient } from './DataForSeoClient.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty } from './url-key.js';

const n = (v: unknown): number => Number(v) || 0;
const domainFromProperty = (siteUrl: string): string =>
  siteUrl.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** Live HTTP status of a backlinked URL (follow redirects → final status; null on error). */
async function statusOf(url: string, ua: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      method: 'GET', redirect: 'follow',
      headers: { 'user-agent': ua, 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(10000),
    });
    return res.status;
  } catch { return null; }
}

export interface BacklinksResult {
  siteUrl: string; target: string; pages: number; statusChecked: number;
  totalBacklinks: number; referringDomains: number; cached: boolean; cost: number;
}

/**
 * On-demand backlink profile via DataForSEO (cheap endpoints): summary/live (overall
 * profile → property_meta) + domain_pages_summary/live (per-page backlink counts →
 * page_backlinks). Then resolves each backlinked page's live HTTP status — from the
 * crawl when present, else a bounded fetch — so backlinks-to-404 is precise.
 * Never auto-run (the user's rule: backlinks are paid + on-demand); 20-day cached.
 */
export class Backlinks {
  constructor(private readonly dfs: DataForSeoClient, private readonly dataDir: string) {}

  async run(
    siteUrl: string,
    opts: { limit?: number; statusLimit?: number; userAgent?: string },
    update: (p: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<BacklinksResult> {
    const target = domainFromProperty(siteUrl);
    const hostForm = hostFormForProperty(siteUrl);
    const ua = opts.userAgent ?? 'seo-audit-console';
    const db = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
    try {
      db.upsertProperty(siteUrl, hostForm ?? 'asis');

      // 1. Profile summary → property_meta
      const sum = await this.dfs.backlinksSummary(target);
      // Surface task-level failures (the Backlinks API is a SEPARATE DataForSEO subscription —
      // a 40204 here means it isn't activated). Don't silently store 0 backlinks.
      const task = sum.tasks[0];
      if (!task || (task.status_code ?? 0) >= 40000) {
        const msg = task?.status_message ?? 'no task returned';
        throw new Error(
          `DataForSEO Backlinks unavailable: ${msg}` +
          (task?.status_code === 40204 ? ' — the Backlinks API is a separate DataForSEO subscription; activate it at app.dataforseo.com/backlinks-subscription to use pull_backlinks.' : ''),
        );
      }
      const s = task.result?.[0] ?? {};
      db.db.prepare(
        `UPDATE property_meta SET total_backlinks=?, referring_domains=?, backlinks_spam_score=?, backlinks_fetched_at=datetime('now') WHERE site_url=?`,
      ).run(n(s.backlinks), n(s.referring_domains), s.backlinks_spam_score ?? null, siteUrl);
      update({ phase: 'summary', backlinks: n(s.backlinks), referringDomains: n(s.referring_domains) });

      // 2. Per-page backlink counts → page_backlinks
      const res = await this.dfs.domainPagesSummary(target, opts.limit ?? 1000);
      const items: any[] = res.tasks[0]?.result?.[0]?.items ?? [];
      const rows = items
        .map(it => {
          const url = it.url ?? it.page_address ?? it.page ?? '';
          return {
            url,
            url_key: url ? urlKey(url, { hostForm }) : '',
            backlinks: n(it.backlinks),
            referring_domains: n(it.referring_domains ?? it.referring_main_domains),
            dofollow: n(it.dofollow ?? it.backlinks_dofollow ?? it.referring_links_types?.anchor),
          };
        })
        .filter(r => r.url && r.url_key);

      // 3. Live status — reuse crawl status where we have it; fetch the rest (bounded, by backlinks).
      const crawlStatus = new Map(
        (db.db.prepare('SELECT url_key, status_code FROM pages WHERE status_code IS NOT NULL').all() as { url_key: string; status_code: number }[])
          .map(r => [r.url_key, r.status_code]),
      );
      const toFetch = rows.filter(r => !crawlStatus.has(r.url_key)).sort((a, b) => b.backlinks - a.backlinks).slice(0, opts.statusLimit ?? 150);
      const fetched = new Map<string, number | null>();
      let i = 0;
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (i < toFetch.length && !signal.aborted) {
          const r = toFetch[i++];
          fetched.set(r.url_key, await statusOf(r.url, ua));
          update({ phase: 'status', checked: fetched.size, total: toFetch.length });
        }
      }));

      const upsert = db.db.prepare(
        `INSERT INTO page_backlinks (url_key, url, backlinks, referring_domains, dofollow, status_code, fetched_at)
         VALUES (@url_key,@url,@backlinks,@referring_domains,@dofollow,@status_code,datetime('now'))
         ON CONFLICT(url_key) DO UPDATE SET url=excluded.url, backlinks=excluded.backlinks,
           referring_domains=excluded.referring_domains, dofollow=excluded.dofollow,
           status_code=excluded.status_code, fetched_at=datetime('now')`,
      );
      db.db.transaction(() => {
        for (const r of rows) upsert.run({ ...r, status_code: crawlStatus.get(r.url_key) ?? fetched.get(r.url_key) ?? null });
      })();

      return {
        siteUrl, target, pages: rows.length, statusChecked: fetched.size,
        totalBacklinks: n(s.backlinks), referringDomains: n(s.referring_domains),
        cached: sum.cached && res.cached, cost: sum.cost + res.cost,
      };
    } finally {
      db.close();
    }
  }
}
