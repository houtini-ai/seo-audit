import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { urlKey, hostFormForProperty } from './core/url-key.js';
import { GscClient } from './core/GscClient.js';
import { GscSync } from './core/GscSync.js';
import { Crawler } from './core/Crawler.js';
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
  const crawler = new Crawler(dataDir()); // no GSC credentials required
  const requireGsc = <T>(v: T | null): T => {
    if (!v) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set — required for Search Console access.');
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

  server.registerTool(
    'sync_gsc',
    {
      title: 'Sync Search Console data',
      description: 'Fetch GSC search analytics into the local database (async job — poll with check_sync_status). Default range: last 90 days.',
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

  // ── Crawl ─────────────────────────────────────────────────────────────────
  server.registerTool(
    'start_crawl',
    {
      title: 'Crawl a site',
      description: 'Crawl a property into the local database (async job — poll with check_crawl_status). HTTP crawl; respects robots.txt.',
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

  const run = async (): Promise<void> => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (data: ${dataDir()}${credPath ? '' : ', GSC disabled — no credentials'})`);
  };

  return { server, run };
}
