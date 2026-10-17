import type Database from 'better-sqlite3';

/**
 * Data freshness / job status for the dashboard, read from the property DB, never from the
 * in-memory JobManager: the standalone dashboard sidecar (src/dashboard.ts) runs in a separate
 * process that never sees the MCP's jobs, so the only shared truth is what the jobs wrote.
 *
 * Every query here is a cheap aggregate or a LIMIT-ed read, so this runs on every dashboard load
 * OUTSIDE the payload cache (the cache version doesn't track crawl runs that wrote no pages, or
 * a failed sync), keeping the status panel current.
 */
export interface FreshnessSource {
  kind: 'sync' | 'crawl' | 'audit' | 'inspect' | 'ranks' | 'sitemap';
  /** completed | running | failed | interrupted | cancelled | never */
  state: string;
  /** Timestamp of the last finish (or the start when still running / never finished). */
  at: string | null;
  /** One short, human line: the window or the volume covered. */
  detail: string;
  error?: string | null;
}

export interface DataFreshness {
  sources: FreshnessSource[];
  /** The last few crawl runs, newest first. */
  crawlRuns: { crawlId: string; status: string; startedAt: string | null; finishedAt: string | null; crawled: number; failed: number; durationMs: number | null }[];
  /** The crawl whose pages are on screen: the newest run that wrote pages (the crawler wipes the
   *  previous snapshot on its first write, so a failed run that wrote anything IS what's shown). */
  shownCrawl?: { crawlId: string; status: string; at: string | null; partial: boolean };
}

const fmtN = (n: number): string => n.toLocaleString('en-US');

/** One wording for every interrupted run (crawl, audit) - matches the job registry's (#9). */
const exitedBeforeFinish = (what: string): string => `The server process running this ${what} exited before it finished.`;

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

type CrawlRow = { crawl_id: string; status: string | null; finished_at: string | null; started_at: string | null; urls_crawled: number | null };
/** Which run's pages are on screen. Crawler.ensureWiped() deletes the previous snapshot on the new
 *  run's FIRST page write, so: a newest run that wrote pages is what's shown, however it ended
 *  (partial); a newest run that wrote nothing left the last completed run's pages in place. */
function shownCrawlOf(rows: CrawlRow[]): DataFreshness['shownCrawl'] {
  const latest = rows[0];
  if (!latest) return undefined;
  if (latest.status === 'completed' || (latest.urls_crawled ?? 0) > 0) {
    return { crawlId: latest.crawl_id, status: latest.status ?? 'unknown', at: latest.finished_at ?? latest.started_at, partial: latest.status !== 'completed' };
  }
  const ok = rows.find(r => r.status === 'completed');
  return ok ? { crawlId: ok.crawl_id, status: 'completed', at: ok.finished_at ?? ok.started_at, partial: false } : undefined;
}
function crawlNote(rows: CrawlRow[], shown: DataFreshness['shownCrawl']): string {
  const latest = rows[0];
  if (!latest || latest.status === 'completed' || !shown) return '';
  if (shown.crawlId === latest.crawl_id) return `; the pages on screen are this run's partial snapshot (${fmtN(latest.urls_crawled ?? 0)} URLs)`;
  const ok = rows.find(r => r.crawl_id === shown.crawlId);
  return `; this run wrote nothing, so the pages on screen are the last completed crawl (${(shown.at ?? '').slice(0, 10)}, ${fmtN(ok?.urls_crawled ?? 0)} URLs)`;
}

/**
 * `liveJobs`: job types with a live owner in the job registry (`liveJobTypes()`), or null/omitted
 * when there is no registry to ask. With it, a crawl run still marked 'running' that no live
 * crawl/refresh job owns is reported as 'interrupted': its process exited mid-crawl (#9).
 */
export function getDataFreshness(db: Database.Database, liveJobs?: Set<string> | null): DataFreshness {
  const sources: FreshnessSource[] = [];

  // GSC sync: property_meta.last_synced_at + the stored date span.
  if (tableExists(db, 'search_analytics')) {
    const meta = tableExists(db, 'property_meta')
      ? db.prepare(`SELECT last_synced_at FROM property_meta ORDER BY COALESCE(last_synced_at,'') DESC LIMIT 1`).get() as { last_synced_at: string | null } | undefined
      : undefined;
    const span = db.prepare(`SELECT MIN(date) lo, MAX(date) hi FROM search_analytics`).get() as { lo: string | null; hi: string | null };
    sources.push({
      kind: 'sync',
      state: span.hi ? 'completed' : 'never',
      at: meta?.last_synced_at ?? null,
      detail: span.hi ? `Search Console ${span.lo} to ${span.hi}` : 'No Search Console data yet - run sync_gsc',
    });
  }

  // Crawl: the latest run of any status (a running or failed crawl is exactly what to show).
  let crawlRuns: DataFreshness['crawlRuns'] = [];
  let shownCrawl: DataFreshness['shownCrawl'];
  if (tableExists(db, 'crawl_metadata')) {
    const rows = db.prepare(
      `SELECT crawl_id, status, started_at, finished_at, urls_crawled, urls_failed, duration_ms, error
       FROM crawl_metadata ORDER BY COALESCE(started_at, finished_at, '') DESC, rowid DESC LIMIT 6`,
    ).all() as (CrawlRow & { urls_failed: number | null; duration_ms: number | null; error: string | null })[];
    crawlRuns = rows.map(r => ({ crawlId: r.crawl_id, status: r.status ?? 'unknown', startedAt: r.started_at, finishedAt: r.finished_at, crawled: r.urls_crawled ?? 0, failed: r.urls_failed ?? 0, durationMs: r.duration_ms }));
    const latest = rows[0];
    shownCrawl = shownCrawlOf(rows);
    const orphaned = latest?.status === 'running' && !!liveJobs && !liveJobs.has('crawl') && !liveJobs.has('refresh');
    sources.push(latest
      ? {
        kind: 'crawl',
        state: orphaned ? 'interrupted' : latest.status ?? 'unknown',
        at: latest.finished_at ?? latest.started_at,
        detail: `${fmtN(latest.urls_crawled ?? 0)} URLs crawled${latest.urls_failed ? `, ${fmtN(latest.urls_failed)} failed` : ''}` + crawlNote(rows, shownCrawl),
        error: orphaned ? (latest.error ?? exitedBeforeFinish('crawl')) : latest.error,
      }
      : { kind: 'crawl', state: 'never', at: null, detail: 'No crawl yet - run start_crawl or refresh_property' });
  }

  // Audit: the latest run.
  if (tableExists(db, 'audit_runs')) {
    const a = db.prepare(`SELECT scope, started_at, finished_at, finding_count, status, error FROM audit_runs ORDER BY started_at DESC LIMIT 1`).get() as
      { scope: string | null; started_at: string | null; finished_at: string | null; finding_count: number | null; status: string | null; error: string | null } | undefined;
    // status is written by the engine (running / completed / failed). Rows from before it existed
    // fall back to finished_at; a run with neither that started over 30 minutes ago died with its
    // process (an audit takes seconds), so it is reported as interrupted, never as running forever.
    // 'running' gets the same age check as NULL: the engine writes it at start, so a process killed
    // mid-audit leaves it behind and it must not be taken at its word.
    const auditState = (): string => {
      if (!a) return 'never';
      if (a.status && a.status !== 'running') return a.status;
      if (a.finished_at) return 'completed';
      const started = a.started_at ? Date.parse(`${a.started_at.replace(' ', 'T')}Z`) : NaN;
      return Number.isFinite(started) && Date.now() - started > 30 * 60_000 ? 'interrupted' : 'running';
    };
    const aState = auditState();
    sources.push(a
      ? { kind: 'audit', state: aState, at: a.finished_at ?? a.started_at, detail: `${fmtN(a.finding_count ?? 0)} findings${a.scope ? `, ${a.scope} scope` : ''}`, error: a.error ?? (aState === 'interrupted' ? exitedBeforeFinish('audit') : null) }
      : { kind: 'audit', state: 'never', at: null, detail: 'No audit yet - run run_audit' });
  }

  // URL inspection: how many URLs, when last inspected.
  if (tableExists(db, 'url_inspection')) {
    const i = db.prepare(`SELECT COUNT(*) n, MAX(inspected_at) at FROM url_inspection`).get() as { n: number; at: string | null };
    sources.push(i.n
      ? { kind: 'inspect', state: 'completed', at: i.at, detail: `${fmtN(i.n)} URLs inspected` }
      : { kind: 'inspect', state: 'never', at: null, detail: 'No URL inspection yet - run inspect_urls' });
  }

  // Optional sources: only listed when present.
  if (tableExists(db, 'rank_history')) {
    const r = db.prepare(`SELECT COUNT(*) n, MIN(period) lo, MAX(period) hi, MAX(fetched_at) at FROM rank_history`).get() as { n: number; lo: string | null; hi: string | null; at: string | null };
    if (r.n) sources.push({ kind: 'ranks', state: 'completed', at: r.at, detail: `Rank history ${r.lo} to ${r.hi}` });
  }
  if (tableExists(db, 'sitemap_urls')) {
    const s = db.prepare(`SELECT COUNT(*) n, MAX(fetched_at) at FROM sitemap_urls`).get() as { n: number; at: string | null };
    if (s.n) sources.push({ kind: 'sitemap', state: 'completed', at: s.at, detail: `${fmtN(s.n)} sitemap URLs` });
  }

  return { sources, crawlRuns, ...(shownCrawl ? { shownCrawl } : {}) };
}
