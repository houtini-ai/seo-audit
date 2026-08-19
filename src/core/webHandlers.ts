import type { WebCallHandlers } from './webServer.js';
import { listLocalProperties } from './webServer.js';
import { getDashboardData } from './dashboardData.js';
import { fetchGoogleNews } from './googleNews.js';
import type { DataForSeoClient } from './DataForSeoClient.js';

/**
 * The web UI's server-side call handlers (POST /api/call allowlist), factored out so BOTH
 * surfaces share one definition: the in-MCP `serve_dashboard` / auto-serve (src/server.ts) and
 * the standalone dashboard sidecar (src/dashboard.ts) used in the Docker-aware mode, where the
 * MCP runs stdio-only behind the gateway and a separate published container serves the reports.
 */
export interface WebHandlerDeps {
  dataDir: () => string;
  dfs: DataForSeoClient | null;
  apiKeys: () => { dataforseo: boolean; majestic: boolean; firecrawl: boolean; supadata: boolean };
}

export function buildWebCallHandlers(deps: WebHandlerDeps): WebCallHandlers {
  const { dataDir } = deps;
  const requireDfs = (): DataForSeoClient => {
    if (!deps.dfs) throw new Error('DataForSEO not configured (DATAFORSEO_USERNAME / DATAFORSEO_PASSWORD)');
    return deps.dfs;
  };
  return {
    get_dashboard_data: async (a) => {
      const want = String(a.siteUrl ?? '');
      // Only serve properties that actually exist locally — getDashboardData would otherwise
      // CREATE an empty DB file for any bogus siteUrl posted at the API.
      if (!listLocalProperties(dataDir()).some(p => p.siteUrl === want)) throw new Error(`unknown property ${want}`);
      return { ...getDashboardData(dataDir(), want), apiKeys: deps.apiKeys() } as unknown as Record<string, unknown>;
    },
    related_terms: async (a) => {
      const r = await requireDfs().relatedTerms(String(a.keyword ?? ''), a.location as string | number | undefined, a.languageCode as string | undefined);
      return r as unknown as Record<string, unknown>;
    },
    // Content research (on-demand) — News (free Google News + paid DFS) / Videos / Trends.
    news_discovery: async (a) => {
      const kw = String(a.keyword ?? '');
      const seen = new Set<string>(); const articles: any[] = [];
      const add = (x: any): void => { const k = String(x.url || x.title || '').toLowerCase(); if (k && !seen.has(k)) { seen.add(k); articles.push(x); } };
      try { const g = await fetchGoogleNews(kw, { limit: 20 }); for (const x of g.articles) add({ ...x, via: 'google-news' }); } catch { /* free source optional */ }
      if (deps.dfs) { try { const r = await deps.dfs.serpNews(kw, a.location as string | number | undefined, a.languageCode as string | undefined); for (const x of r.articles) add({ ...x, via: 'dataforseo' }); } catch { /* paid optional */ } }
      return { articles } as unknown as Record<string, unknown>;
    },
    youtube_discovery: async (a) => {
      const r = await requireDfs().serpYoutube(String(a.keyword ?? ''), a.location as string | number | undefined, a.languageCode as string | undefined, a.blockDepth as number | undefined);
      return r as unknown as Record<string, unknown>;
    },
    topic_trend: async (a) => {
      const kws = Array.isArray(a.keywords) ? (a.keywords as string[]) : [String(a.keyword ?? '')].filter(Boolean);
      const r = await requireDfs().googleTrends(kws, a.location as string | number | undefined, a.languageCode as string | undefined, {});
      return r as unknown as Record<string, unknown>;
    },
    keyword_volume: async (a) => {
      const r = await requireDfs().searchVolume((a.keywords as string[]) ?? [], a.location as string | number | undefined, a.languageCode as string | undefined);
      const items = (r.tasks[0]?.result ?? []).map((k: any) => ({
        keyword: k.keyword, searchVolume: k.search_volume, cpc: k.cpc, competition: k.competition,
      }));
      return { keywords: items, cached: r.cached, cost: r.cost };
    },
  };
}
