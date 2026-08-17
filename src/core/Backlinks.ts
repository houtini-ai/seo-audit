import { AuditDatabase } from './AuditDatabase.js';
import { DataForSeoClient } from './DataForSeoClient.js';
import { MajesticClient } from './MajesticClient.js';
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
  totalBacklinks: number; referringDomains: number;
  domainRank: number | null;          // DataForSEO Domain Rank (0–1000)
  brokenBacklinks: number; brokenPages: number;
  nofollowPct: number | null;         // share of referring links marked nofollow (0–1)
  majesticEnriched: number;           // per-URL pages given Majestic Trust Flow (0 = tier off)
  cached: boolean; cost: number;
}

/**
 * On-demand backlink profile via DataForSEO (cheap endpoints): summary/live (overall
 * profile → property_meta) + domain_pages_summary/live (per-page backlink counts →
 * page_backlinks). Then resolves each backlinked page's live HTTP status — from the
 * crawl when present, else a bounded fetch — so backlinks-to-404 is precise.
 * Never auto-run (the user's rule: backlinks are paid + on-demand); 20-day cached.
 */
export class Backlinks {
  constructor(private readonly dfs: DataForSeoClient, private readonly dataDir: string, private readonly majestic: MajesticClient | null = null) {}

  async run(
    siteUrl: string,
    opts: { limit?: number; statusLimit?: number; userAgent?: string; majesticLimit?: number },
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
      // Summary extras previously dropped from the same paid response: Domain Rank (the authority
      // number), broken backlinks/pages (equity leaks Google's link graph sees), nofollow share.
      const nofollowPct = n(s.backlinks) > 0 ? n(s.referring_links_attributes?.nofollow) / n(s.backlinks) : null;
      db.db.prepare(
        `UPDATE property_meta SET total_backlinks=?, referring_domains=?, backlinks_spam_score=?,
           backlinks_rank=?, broken_backlinks=?, broken_pages=?, backlinks_nofollow_pct=?,
           backlinks_fetched_at=datetime('now') WHERE site_url=?`,
      ).run(
        n(s.backlinks), n(s.referring_domains), s.backlinks_spam_score ?? null,
        s.rank != null ? n(s.rank) : null, n(s.broken_backlinks), n(s.broken_pages), nofollowPct,
        siteUrl,
      );
      update({ phase: 'summary', backlinks: n(s.backlinks), referringDomains: n(s.referring_domains), rank: s.rank ?? null });

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

      // Majestic per-URL Trust Flow (trapped-authority v2). GetIndexItemInfo batches ≤100 items
      // per call and MajesticClient slices internally, so this is ceil(N/100) calls, not N. Bounded
      // to the most-backlinked URLs, only when a Majestic key is set, and never fails the pull.
      let majesticEnriched = 0;
      if (this.majestic && rows.length && !signal.aborted) {
        // Enrich a BROAD set, not just the most-linked: trapped-authority pages are deep pages
        // with only a few referring domains, so a top-N-by-backlinks slice misses exactly the
        // pages that matter. Cap high (batched ≤100/call, cached 30d); sort only decides which
        // survive the cap on very large sites.
        const cand = [...rows].sort((a, b) => b.backlinks - a.backlinks).slice(0, Math.min(rows.length, opts.majesticLimit ?? 500));
        const byUrl = new Map(cand.map(r => [r.url, r.url_key]));
        try {
          update({ phase: 'majestic', total: cand.length });
          const metrics = await this.majestic.getIndexItemInfo(cand.map(c => c.url), { datasource: 'historic', desiredTopics: 5 });
          const upd = db.db.prepare(
            `UPDATE page_backlinks SET trust_flow=?, citation_flow=?, topical_trust_flow=?, majestic_at=datetime('now') WHERE url_key=?`,
          );
          db.db.transaction(() => {
            for (const m of metrics) {
              const uk = byUrl.get(m.item);
              if (!uk) continue;
              upd.run(m.trustFlow ?? null, m.citationFlow ?? null, m.topicalTrustFlow.length ? JSON.stringify(m.topicalTrustFlow) : null, uk);
              majesticEnriched++;
            }
          })();
        } catch { /* Majestic optional — never fail the backlink pull on it */ }
      }

      return {
        siteUrl, target, pages: rows.length, statusChecked: fetched.size,
        totalBacklinks: n(s.backlinks), referringDomains: n(s.referring_domains),
        domainRank: s.rank != null ? n(s.rank) : null,
        brokenBacklinks: n(s.broken_backlinks), brokenPages: n(s.broken_pages),
        nofollowPct: nofollowPct != null ? Math.round(nofollowPct * 1000) / 1000 : null,
        majesticEnriched,
        cached: sum.cached && res.cached, cost: sum.cost + res.cost,
      };
    } finally {
      db.close();
    }
  }
}
