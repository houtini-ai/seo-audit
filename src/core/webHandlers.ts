import type { WebCallHandlers } from './webServer.js';
import { listLocalProperties } from './webServer.js';
import { getDashboardDataAsync } from './dashboardAsync.js';
import { listFindings } from './findingsQuery.js';
import { getPortfolioData, getDomainOverview } from './portfolioData.js';
import { PortfolioStore, resolveLocation } from './PortfolioStore.js';
import { targetForProperty } from './portfolioTarget.js';
import { fetchGoogleNews } from './googleNews.js';
import { liveJobTypes, runnerAlive, type JobManager, type Job } from './JobManager.js';
import { submitJob, type JobDeps } from './jobKinds.js';
import { jobScopeFor } from './paths.js';
import { runAudit } from '../audit/engine.js';
import { checkAndSaveAgentReadiness } from './agentReadinessStore.js';
import { setPropertyHidden } from './hiddenProperties.js';
import { probeUrls } from './probeUrls.js';

/**
 * The web UI's server-side call handlers (POST /api/call allowlist), factored out so BOTH
 * surfaces share one definition: the in-MCP `serve_dashboard` / auto-serve (src/server.ts) and
 * the standalone dashboard sidecar (src/dashboard.ts) used in the Docker-aware mode, where the
 * MCP runs stdio-only behind the gateway and a separate published container serves the reports.
 */
export interface WebHandlerDeps {
  dataDir: () => string;
  apiKeys: () => { dataforseo: boolean; majestic: boolean };
  /**
   * Dashboard actions (free work only: crawl, Search Console sync, URL inspection, audit, agent
   * readiness). `pick` chooses the manager for each job: the MCP passes its own; the sidecar
   * queues for the job runner when one is alive (it holds the credentials under the gateway) and
   * runs the job itself otherwise. Absent = the dashboard is read-only.
   */
  jobs?: { pick: () => JobManager; deps: JobDeps; gsc: () => boolean };
}

/** Job kinds the dashboard may start. All free: nothing here calls a paid API. */
const WEB_JOB_KINDS = ['crawl', 'sync', 'inspect'] as const;
type WebJobKind = typeof WEB_JOB_KINDS[number];
const isWebJobKind = (k: unknown): k is WebJobKind => typeof k === 'string' && (WEB_JOB_KINDS as readonly string[]).includes(k);

/** A job as the dashboard shows it: no result blob, a one-line progress summary. */
function jobView(j: Job): Record<string, unknown> {
  const p = j.progress ?? {};
  const bits: string[] = [];
  if (typeof p.stage === 'string') bits.push(p.stage.replace(/-/g, ' '));
  // "of max" only while fetching: the post-crawl stages count extra fetches past the cap.
  if (typeof p.crawled === 'number') bits.push(`${p.crawled}${p.stage === 'fetching' && typeof p.maxPages === 'number' ? ` of ${p.maxPages}` : ''} pages`);
  if (typeof p.rowsFetched === 'number') bits.push(`${p.rowsFetched} rows`);
  if (typeof p.inspected === 'number') bits.push(`${p.inspected} inspected`);
  // A share for the progress bar, only where it's a true fraction: crawl pages while fetching.
  const pct = p.stage === 'fetching' && typeof p.crawled === 'number' && typeof p.maxPages === 'number' && p.maxPages > 0
    ? Math.min(100, Math.round((p.crawled / p.maxPages) * 100)) : null;
  return {
    id: j.id, type: j.type, state: j.noRunner ? 'queued-no-runner' : j.state, pct,
    startedAt: j.startedAt, updatedAt: j.updatedAt, progress: bits.join(', '),
    error: j.error ?? null, note: j.note ?? null,
  };
}

export function buildWebCallHandlers(deps: WebHandlerDeps): WebCallHandlers {
  const { dataDir } = deps;
  const requireJobs = (): NonNullable<WebHandlerDeps['jobs']> => {
    if (!deps.jobs) throw new Error('This dashboard is read-only: start jobs from chat.');
    return deps.jobs;
  };
  // Only act on properties that exist locally: the job and audit code would otherwise CREATE an
  // empty database for any siteUrl posted at the API.
  const requireProperty = (a: Record<string, unknown>): string => {
    const want = String(a.siteUrl ?? '');
    if (!listLocalProperties(dataDir()).some(p => p.siteUrl === want)) throw new Error(`unknown property ${want}`);
    return want;
  };
  const withStore = <T>(fn: (s: PortfolioStore) => T): T => {
    const store = new PortfolioStore(dataDir());
    try { return fn(store); } finally { store.close(); }
  };
  const locationArg = (a: Record<string, unknown>): number | undefined => (typeof a.locationCode === 'number' ? a.locationCode : undefined);
  return {
    // Portfolio: free reads, and add/remove/group of WATCHED domains, which cost nothing (no API
    // call). Paid refreshes are deliberately NOT here: they start only from chat, after a quote.
    get_portfolio_data: async () => getPortfolioData(dataDir()) as unknown as Record<string, unknown>,
    // The domain dropdown: cheap (no per-property work), so every page can call it on load.
    list_domains: async () => {
      const props = listLocalProperties(dataDir());
      const watched = withStore(store => store.list().filter(d => d.kind === 'watched')
        .map(d => ({ domain: d.domain, group: d.groupLabel, locationCode: d.locationCode })));
      const shown = props.filter(p => !p.hidden);
      return { properties: shown.filter(p => p.gsc).map(p => p.siteUrl), others: shown.filter(p => !p.gsc).map(p => p.siteUrl), hidden: props.filter(p => p.hidden).map(p => p.siteUrl), watched };
    },
    get_domain_overview: async (a) => {
      // A property dashboard asks by siteUrl; the domains view asks by domain.
      const domain = a.siteUrl ? targetForProperty(String(a.siteUrl)) : String(a.domain ?? '');
      const o = getDomainOverview(dataDir(), domain, locationArg(a));
      if (!o) throw new Error(`${domain} is not in the portfolio`);
      return o as unknown as Record<string, unknown>;
    },
    portfolio_add_domain: async (a) => withStore(store => {
      const loc = a.location != null && a.location !== '' ? resolveLocation(a.location as string | number) : null;
      const group = typeof a.group === 'string' && a.group.trim() ? a.group.trim() : null;
      const d = store.addWatched(String(a.domain ?? ''), { locationCode: loc?.code, group });
      return { added: d, note: loc?.note ?? null } as unknown as Record<string, unknown>;
    }),
    portfolio_remove_domain: async (a) => withStore(store => ({ removed: store.removeWatched(String(a.domain ?? ''), locationArg(a)) })),
    portfolio_group_domain: async (a) => withStore(store => {
      const group = typeof a.group === 'string' && a.group.trim() ? a.group.trim() : null;
      return { updated: store.setGroup(String(a.domain ?? ''), group, locationArg(a)) };
    }),
    get_dashboard_data: async (a) => {
      const want = requireProperty(a);
      // Built on a worker thread: a cold build must not stall the rest of the server.
      const data = await getDashboardDataAsync(dataDir(), want, { days: typeof a.days === 'number' ? a.days : undefined });
      return { ...data, apiKeys: deps.apiKeys() } as unknown as Record<string, unknown>;
    },
    // The Issues list's filters run over every finding of the latest audit, not the payload's top 50.
    list_findings: async (a) => {
      const want = requireProperty(a);
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
      return listFindings(dataDir(), want, { severity: str(a.severity), category: str(a.category), checkId: str(a.checkId), offset: Number(a.offset) || 0, limit: Number(a.limit) || 100 }) as unknown as Record<string, unknown>;
    },

    // Hide or unhide a property: out of the dropdown and the portfolio; the database is untouched.
    set_property_hidden: async (a) => {
      const siteUrl = requireProperty(a);
      return { hidden: setPropertyHidden(dataDir(), siteUrl, a.hidden !== false) };
    },

    // Dashboard actions. Free work only; one job of a kind per property at a time.
    action_status: async (a) => {
      const jobs = deps.jobs;
      const scope = a.siteUrl ? jobScopeFor(dataDir(), String(a.siteUrl)) : null;
      const recent = jobs ? jobs.pick().list().filter(j => !scope || j.scope === scope).slice(0, 8).map(jobView) : [];
      return { enabled: !!jobs, gsc: jobs?.gsc() ?? false, runner: runnerAlive(dataDir()), jobs: recent };
    },
    start_job: async (a) => {
      const j = requireJobs();
      const siteUrl = requireProperty(a);
      const kind = a.kind;
      if (!isWebJobKind(kind)) throw new Error(`the dashboard can start ${WEB_JOB_KINDS.join(', ')} jobs, not "${String(kind)}"`);
      const manager = j.pick();
      if ((kind === 'sync' || kind === 'inspect') && !manager.external && !j.gsc()) {
        throw new Error('Search Console credentials are not set where this dashboard runs, and no job runner is running to take the job.');
      }
      const scope = jobScopeFor(dataDir(), siteUrl);
      const live = liveJobTypes(dataDir(), scope);
      // A queued job with no runner alive yet (queuedNoRunner) is still waiting to run: a second one
      // would run straight after it.
      if (live && (live.has(kind) || live.queued?.has(kind) || live.queuedNoRunner?.has(kind))) throw new Error(`A ${kind} job is already running or queued for ${siteUrl}.`);
      if (kind !== 'crawl' && live?.has('crawl')) throw new Error(`A crawl is running for ${siteUrl}: wait for it to finish.`);
      let jobId: string;
      if (kind === 'crawl') {
        const maxPages = Number(a.maxPages);
        jobId = submitJob(manager, 'crawl', { siteUrl, ...(maxPages > 0 ? { maxPages: Math.min(50000, Math.round(maxPages)) } : {}) }, j.deps, scope);
      } else if (kind === 'sync') {
        // The sync_gsc defaults: a 90-day window, resumed incrementally from the latest stored day.
        const day = (n: number): string => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
        jobId = submitJob(manager, 'sync', { siteUrl, options: { startDate: day(90), endDate: day(0) } }, j.deps, scope);
      } else {
        const limit = Number(a.limit);
        jobId = submitJob(manager, 'inspect', { siteUrl, ...(limit > 0 ? { limit: Math.min(2000, Math.round(limit)) } : {}) }, j.deps, scope);
      }
      return { jobId, kind, queued: manager.external };
    },
    cancel_job: async (a) => ({ cancelled: requireJobs().pick().cancel(String(a.id ?? '')) }),
    run_audit: async (a) => {
      requireJobs();
      const siteUrl = requireProperty(a);
      const live = liveJobTypes(dataDir(), jobScopeFor(dataDir(), siteUrl));
      if (live?.has('crawl')) throw new Error(`A crawl is running for ${siteUrl}: audit once it finishes.`);
      const r = runAudit(dataDir(), siteUrl, { includeJudgement: a.includeJudgement === true, topLimit: 1 });
      void getDashboardDataAsync(dataDir(), siteUrl).catch(() => { /* warm the next load */ });
      return { runId: r.runId, total: r.total, bySeverity: r.bySeverity };
    },
    // "Verify live URL" on a finding: one live fetch of a URL on the property's own host (the probe
    // refuses any other host, at every redirect hop). Free: it's your own server.
    verify_url: async (a) => {
      const siteUrl = requireProperty(a);
      const seed = siteUrl.startsWith('sc-domain:') ? `https://${siteUrl.slice('sc-domain:'.length)}/` : siteUrl;
      const [r] = await probeUrls([{ url: String(a.url ?? '') }], new URL(seed).hostname, { budgetMs: 20000 });
      return { url: r.url, status: r.status, finalUrl: r.finalUrl, finalStatus: r.finalStatus, redirects: r.redirectChain.length,
        canonical: r.canonical, metaRobots: r.metaRobots, xRobotsTag: r.xRobotsTag, title: r.title, ms: r.ms, fetchedAs: r.fetchedAs } as unknown as Record<string, unknown>;
    },
    check_agent_readiness: async (a) => {
      requireJobs();
      const siteUrl = requireProperty(a);
      const r = await checkAndSaveAgentReadiness(dataDir(), siteUrl);
      void getDashboardDataAsync(dataDir(), siteUrl).catch(() => { /* warm the next load */ });
      return { score: r.score, level: r.level };
    },

    // Content research: the free source only (Google News RSS). The DataForSEO lookups (related
    // terms, search volume, the news / YouTube SERPs, Google Trends) spend money, so the browser
    // can't reach them: they run from chat, where paid work is quoted first. They used to be here,
    // and any page that could POST to the dashboard could spend the user's DataForSEO credit.
    news_discovery: async (a) => {
      const kw = String(a.keyword ?? '');
      const g = await fetchGoogleNews(kw, { limit: 20 });
      return { articles: g.articles.map(x => ({ ...x, via: 'google-news' })) } as unknown as Record<string, unknown>;
    },
  };
}
