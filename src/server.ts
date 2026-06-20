import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { urlKey, hostFormForProperty } from './core/url-key.js';
import { GscClient } from './core/GscClient.js';
import { GscSync } from './core/GscSync.js';
import { UrlInspector } from './core/UrlInspector.js';
import { Crawler } from './core/Crawler.js';
import { Refresh } from './core/Refresh.js';
import { DataForSeoClient } from './core/DataForSeoClient.js';
import { JobManager } from './core/JobManager.js';
import type { FetchOptions } from './core/types.js';

const SERVER_NAME = 'seo-audit-console';
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export function dataDir(): string {
  return process.env.SAC_DATA_DIR ?? path.join(homedir(), 'seo-audits', 'seo-audit-console');
}

const CHECK_CATEGORIES = [
  'integrity', 'crawlability', 'indexation', 'onpage',
  'schema', 'performance', 'war-stories', 'agentic', 'merged',
] as const;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export function createServer(): { server: McpServer; run: () => Promise<void> } {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const jobs = new JobManager();

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const gsc = credPath ? new GscClient(credPath) : null;
  const sync = gsc ? new GscSync(gsc, dataDir()) : null;
  const inspector = gsc ? new UrlInspector(gsc, dataDir()) : null;
  const crawler = new Crawler(dataDir()); // no GSC credentials required
  const refresh = new Refresh(sync, crawler, inspector);

  const dfsUser = process.env.DATAFORSEO_USERNAME;
  const dfsPass = process.env.DATAFORSEO_PASSWORD;
  const dfsCacheDays = Number(process.env.DATAFORSEO_CACHE_DAYS) || 20;
  const dfs = dfsUser && dfsPass
    ? new DataForSeoClient(dfsUser, dfsPass, path.join(dataDir(), 'dataforseo-cache.db'), dfsCacheDays)
    : null;
  const requireGsc = <T>(v: T | null): T => {
    if (!v) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set — required for Search Console access.');
    return v;
  };
  const requireDfs = <T>(v: T | null): T => {
    if (!v) throw new Error('DATAFORSEO_USERNAME / DATAFORSEO_PASSWORD not set — required for DataForSEO.');
    return v;
  };

  // ── Introspection (no data / creds required) ────────────────────────────
  server.registerTool(
    'list_checks',
    {
      title: 'List audit checks',
      description: 'List the technical-SEO check categories this server can evaluate.',
      inputSchema: { category: z.enum(CHECK_CATEGORIES).optional() },
    },
    async ({ category }) => {
      const categories = category ? [category] : [...CHECK_CATEGORIES];
      return { content: [{ type: 'text', text: `Audit categories: ${categories.join(', ')}` }], structuredContent: { categories } };
    },
  );

  server.registerTool(
    'normalize_url',
    {
      title: 'Normalise a URL to its join key',
      description: 'Return the canonical url_key used to join GSC data to crawl data.',
      inputSchema: { url: z.string(), siteUrl: z.string().optional() },
    },
    async ({ url, siteUrl }) => {
      const hostForm = siteUrl ? hostFormForProperty(siteUrl) : 'asis';
      const key = urlKey(url, { hostForm });
      return { content: [{ type: 'text', text: key }], structuredContent: { url, key, hostForm } };
    },
  );

  // ── GSC ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_properties',
    {
      title: 'List GSC properties',
      description: 'List Google Search Console properties accessible to the service account.',
      inputSchema: {},
    },
    async () => {
      const properties = await requireGsc(gsc).listProperties();
      return {
        content: [{ type: 'text', text: `${properties.length} properties: ${properties.map(p => p.siteUrl).join(', ')}` }],
        structuredContent: { properties },
      };
    },
  );

  // refresh_property — the "sync everything" verb (GSC + crawl + inspection in one job).
  // Skip flags let the same tool do "just update X".
  server.registerTool(
    'refresh_property',
    {
      title: 'Refresh a property (sync + crawl + inspect)',
      description: 'Full refresh for a property in one async job: GSC sync → site crawl → URL inspection. Set gsc/crawl/inspect=false to run just part. Poll with check_sync_status. Use this for "sync everything"; use sync_gsc / start_crawl / inspect_urls to update just one thing.',
      inputSchema: {
        siteUrl: z.string(),
        gsc: z.boolean().optional(),
        crawl: z.boolean().optional(),
        inspect: z.boolean().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        maxPages: z.number().int().min(1).max(50000).optional(),
        inspectLimit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ siteUrl, gsc: doGsc, crawl, inspect, startDate, endDate, maxPages, inspectLimit }) => {
      const jobId = jobs.start('refresh', (update, signal) =>
        refresh.run(siteUrl, { gsc: doGsc, crawl, inspect, startDate, endDate, maxPages, inspectLimit }, update, signal),
      );
      return {
        content: [{ type: 'text', text: `Refresh started for ${siteUrl} (job ${jobId}). Poll check_sync_status.` }],
        structuredContent: { jobId, status: 'running', siteUrl },
      };
    },
  );

  server.registerTool(
    'sync_gsc',
    {
      title: 'Sync Search Console data (just GSC)',
      description: 'Update just the GSC search-analytics history (async job — poll with check_sync_status). Default range: last 90 days. For a full refresh use refresh_property.',
      inputSchema: {
        siteUrl: z.string(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        dimensions: z.array(z.string()).optional(),
        searchType: z.enum(['web', 'discover', 'googleNews', 'image', 'video']).optional(),
      },
    },
    async ({ siteUrl, startDate, endDate, dimensions, searchType }) => {
      const syncer = requireGsc(sync);
      const options: FetchOptions = {
        startDate: startDate ?? isoDaysAgo(90),
        endDate: endDate ?? isoDaysAgo(0),
        dimensions,
        searchType,
      };
      const jobId = jobs.start('sync', (update, signal) => syncer.run(siteUrl, options, update, signal));
      return {
        content: [{ type: 'text', text: `Sync started for ${siteUrl} (job ${jobId}). Poll check_sync_status.` }],
        structuredContent: { jobId, status: 'running', siteUrl, ...options },
      };
    },
  );

  server.registerTool(
    'check_sync_status',
    {
      title: 'Check sync status',
      description: 'Poll a sync job by id, or omit to list recent jobs.',
      inputSchema: { jobId: z.string().optional() },
    },
    async ({ jobId }) => {
      if (jobId) {
        const job = jobs.get(jobId);
        if (!job) return { content: [{ type: 'text', text: `No job ${jobId}` }], structuredContent: { error: 'not_found', jobId } };
        return { content: [{ type: 'text', text: `Job ${jobId}: ${job.state}` }], structuredContent: job as unknown as Record<string, unknown> };
      }
      const all = jobs.list();
      return { content: [{ type: 'text', text: `${all.length} jobs` }], structuredContent: { jobs: all } };
    },
  );

  server.registerTool(
    'inspect_urls',
    {
      title: 'Inspect URLs (just URL inspection)',
      description: 'Update just the GSC URL Inspection data (coverage, indexing, Google-vs-declared canonical, last crawl) for top URLs into url_inspection. Quota-limited — samples top pages by clicks. Async job. For a full refresh use refresh_property.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(1).max(500).optional() },
    },
    async ({ siteUrl, limit }) => {
      const insp = requireGsc(inspector);
      const jobId = jobs.start('inspect', (update, signal) => insp.run(siteUrl, { limit }, update, signal));
      return {
        content: [{ type: 'text', text: `Inspection started for ${siteUrl} (job ${jobId}). Poll check_sync_status.` }],
        structuredContent: { jobId, status: 'running', siteUrl },
      };
    },
  );

  // ── Crawl ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'start_crawl',
    {
      title: 'Crawl a site (just the crawl)',
      description: 'Update just the crawl: fetch the site into the local database (async job — poll with check_crawl_status). HTTP crawl; respects robots.txt. For a full refresh use refresh_property.',
      inputSchema: {
        siteUrl: z.string(),
        maxPages: z.number().int().min(1).max(50000).optional(),
        maxDepth: z.number().int().min(1).max(20).optional(),
        maxConcurrency: z.number().int().min(1).max(16).optional(),
        delayMs: z.number().int().min(0).max(10000).optional(),
        userAgent: z.string().optional(),
      },
    },
    async ({ siteUrl, maxPages, maxDepth, maxConcurrency, delayMs, userAgent }) => {
      const jobId = jobs.start('crawl', (update, signal) =>
        crawler.run(siteUrl, { maxPages, maxDepth, maxConcurrency, delayMs, userAgent }, update, signal),
      );
      return {
        content: [{ type: 'text', text: `Crawl started for ${siteUrl} (job ${jobId}). Poll check_crawl_status.` }],
        structuredContent: { jobId, status: 'running', siteUrl },
      };
    },
  );

  server.registerTool(
    'check_crawl_status',
    {
      title: 'Check crawl status',
      description: 'Poll a crawl job by id, or omit to list recent jobs.',
      inputSchema: { jobId: z.string().optional() },
    },
    async ({ jobId }) => {
      if (jobId) {
        const job = jobs.get(jobId);
        if (!job) return { content: [{ type: 'text', text: `No job ${jobId}` }], structuredContent: { error: 'not_found', jobId } };
        return { content: [{ type: 'text', text: `Job ${jobId}: ${job.state}` }], structuredContent: job as unknown as Record<string, unknown> };
      }
      const all = jobs.list();
      return { content: [{ type: 'text', text: `${all.length} jobs` }], structuredContent: { jobs: all } };
    },
  );

  // ── DataForSEO (cached 20 days, single-worker) ──────────────────────────
  server.registerTool(
    'keyword_volume',
    {
      title: 'Keyword search volume (DataForSEO)',
      description: 'True monthly search volume + CPC + competition for keywords (DataForSEO KEYWORDS_DATA). Served from a 20-day cache; live calls are serialised. Default location: United States (2840).',
      inputSchema: {
        keywords: z.array(z.string()).min(1).max(700),
        locationCode: z.number().int().optional(),
        languageCode: z.string().optional(),
      },
    },
    async ({ keywords, locationCode, languageCode }) => {
      const client = requireDfs(dfs);
      const r = await client.searchVolume(keywords, locationCode, languageCode);
      const items = (r.tasks[0]?.result ?? []).map((k: any) => ({
        keyword: k.keyword, searchVolume: k.search_volume, cpc: k.cpc, competition: k.competition,
      }));
      return {
        content: [{ type: 'text', text: `${items.length} keywords${r.cached ? ' (cached)' : ` (live, $${r.cost.toFixed(4)})`}` }],
        structuredContent: { keywords: items, cached: r.cached, cost: r.cost },
      };
    },
  );

  server.registerTool(
    'related_terms',
    {
      title: 'Related terms (People Also Ask + related searches)',
      description: 'People Also Ask questions and related searches for a keyword (DataForSEO SERP). Powers click-through "related terms" on the keyword charts. SERP call — cached 20 days.',
      inputSchema: { keyword: z.string(), locationCode: z.number().int().optional(), languageCode: z.string().optional() },
    },
    async ({ keyword, locationCode, languageCode }) => {
      const client = requireDfs(dfs);
      const r = await client.relatedTerms(keyword, locationCode, languageCode);
      return {
        content: [{ type: 'text', text: `PAA: ${r.peopleAlsoAsk.length}, related: ${r.relatedSearches.length}${r.cached ? ' (cached)' : ` ($${r.cost.toFixed(4)})`}` }],
        structuredContent: r as unknown as Record<string, unknown>,
      };
    },
  );

  const run = async (): Promise<void> => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (data: ${dataDir()}${credPath ? '' : ', GSC disabled — no credentials'})`);
  };

  return { server, run };
}
