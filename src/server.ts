import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { getDashboardData } from './core/dashboardData.js';
import { runAudit, runSingleCheck, listChecks } from './audit/engine.js';
import { AuditDatabase } from './core/AuditDatabase.js';
import { dbPathFor, sanitizeProperty } from './core/paths.js';
import { generateJsonLd, suggestRedirect, suggestInternalLinks } from './generators/index.js';

import { urlKey, hostFormForProperty } from './core/url-key.js';
import { GscClient } from './core/GscClient.js';
import { GscSync, FULL_DIMENSIONS } from './core/GscSync.js';
import { UrlInspector } from './core/UrlInspector.js';
import { Crawler } from './core/Crawler.js';
import { Refresh } from './core/Refresh.js';
import { DataForSeoClient } from './core/DataForSeoClient.js';
import { RankTracker } from './core/RankTracker.js';
import { Backlinks } from './core/Backlinks.js';
import { JobManager } from './core/JobManager.js';
import type { FetchOptions } from './core/types.js';

const SERVER_NAME = 'seo-audit-console';
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

// Where per-property crawl/audit DBs live. Resolution order (computed once per run):
//   SAC_DATA_DIR env  >  persisted choice (~/.seo-audit-console.json)  >  Documents default.
// The user can set the persisted choice through the `data_location` tool (no JSON editing).
const CONFIG_PATH = path.join(homedir(), '.seo-audit-console.json');
const DEFAULT_DATA_DIR = path.join(homedir(), 'Documents', 'seo-audit-console');

function readConfigDataDir(): string | undefined {
  try { return (JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { dataDir?: string }).dataDir; } catch { return undefined; }
}

let RESOLVED_DATA_DIR: string | null = null;
export function dataDir(): string {
  if (!RESOLVED_DATA_DIR) RESOLVED_DATA_DIR = process.env.SAC_DATA_DIR ?? readConfigDataDir() ?? DEFAULT_DATA_DIR;
  return RESOLVED_DATA_DIR;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_URI = 'ui://dashboard/main.html';
const SYNC_PROGRESS_URI = 'ui://sync-progress/main.html';

// Must match the categories actually used by CHECKS (src/audit/checks.ts) so category
// filters never silently return empty. (Was listing performance/agentic/integrity/war-stories
// which no check uses, and omitting content/security which checks do use.)
const CHECK_CATEGORIES = [
  'crawlability', 'indexation', 'onpage', 'content', 'schema', 'security', 'merged',
] as const;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

const SEV_ICON: Record<string, string> = { crit: '🔴', high: '🟠', med: '🟡', low: '⚪', info: '·' };
const CAT_NAME: Record<string, string> = {
  integrity: 'Integrity', crawlability: 'Crawlability', indexation: 'Indexation', onpage: 'On-page',
  content: 'Content', schema: 'Structured data', security: 'Security', 'war-stories': 'Edge cases',
  merged: 'Search performance', agentic: 'AI readiness',
};

// Concise executive markdown summary of an audit — rendered as the tool's text content so it
// shows in chat (and Claude can discuss it) without dumping the full structuredContent payload.
function auditMarkdown(r: any, siteUrl: string): string {
  const p = (s: string): any => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
  const sev = r.bySeverity ?? {};
  const out: string[] = [
    `# SEO audit — ${siteUrl.replace(/^sc-domain:/, '')}`,
    `**${r.total} findings** · 🔴 ${sev.crit ?? 0} critical · 🟠 ${sev.high ?? 0} high · 🟡 ${sev.med ?? 0} medium · ⚪ ${sev.low ?? 0} low`,
  ];
  if (!r.integrityOk) out.push('> ⚠ Crawl integrity not verified — treat findings as provisional.');
  out.push('', '## Top priorities (impact ÷ effort)');
  (r.top ?? []).slice(0, 12).forEach((f: any, i: number) => {
    const rec = p(f.recommendation), traf = p(f.traffic_at_risk);
    const pth = (f.url_key || '—').replace(/^https?:\/\/[^/]+/, '') || '/';
    const tr = (traf.clicks || traf.impressions) ? ` · ${traf.clicks || 0} clicks / ${traf.impressions || 0} impr` : '';
    out.push(`${i + 1}. ${SEV_ICON[f.severity] ?? '·'} **${rec.title || f.check_id}** — \`${pth}\`${tr}`);
    if (rec.text) out.push(`   ${rec.text}`);
  });
  const byCat: Record<string, string[]> = {};
  for (const c of r.byCheck ?? []) (byCat[c.category] ??= []).push(`${c.checkId ?? c.check_id} (${c.count})`);
  out.push('', '## All issues by category');
  for (const [cat, checks] of Object.entries(byCat)) out.push(`- **${CAT_NAME[cat] ?? cat}** — ${checks.join(', ')}`);
  out.push('', `_\`export_report siteUrl:"${siteUrl}"\` → a shareable interactive HTML dashboard._`);
  return out.join('\n');
}

const HELP_TEXT = `# SEO Audit Console — what it can do
A technical-SEO audit that fuses **Search Console + a site crawl + DataForSEO**, joined on a normalised URL, with evidence on every finding. Typical flow: **refresh → audit → fix → report**.

## 1. Sync the data
- **refresh_property** — sync everything (GSC → crawl → URL inspection → rank history). _"Refresh sc-domain:example.com"_ · add \`segments:true\` for device/country, \`maxPages\`, \`startDate\`.
- **sync_gsc / start_crawl / inspect_urls / track_ranks** — run just one part. _"Crawl example.com, 500 pages"_
- **check_sync_status / check_crawl_status** — poll a job. _"Check sync status"_
- **list_properties** — _"List my Search Console properties"_

## 2. Audit
- **run_audit** — score all checks; returns a prioritised markdown report. _"Run an SEO audit on sc-domain:example.com"_ · \`scope:full\`, \`categories\`, \`includeJudgement:true\`.
- **query_audit** — one named check with evidence. _"Show striking-distance for example.com"_
- **list_checks** — _"What does the audit check for?"_

## 3. Fix (the moat)
- **fix_finding** — paste-ready remediation from your own data: JSON-LD for missing/invalid schema, a 301 rule for broken links, iPR-ranked internal-link suggestions. _"Generate the fix for finding 12"_ or _"fix_finding check:missing-required-fields url:https://example.com/x"_

## 4. Backlinks & keywords (DataForSEO, on-demand)
- **pull_backlinks** — backlink profile + per-page counts + live status → unlocks **backlinks-to-404** (recover lost equity), top-linked pages, true orphans. _"Pull backlinks for example.com"_
- **keyword_volume / related_terms** — volume/CPC, and People-Also-Ask + related searches. _"Search volume for [\\"best widgets\\"]"_

## 5. Reports & dashboard
- **get_dashboard** — interactive dashboard (renders in chat). _"Show the dashboard for example.com"_
- **export_report** — self-contained shareable HTML to send a client. _"Export the report for example.com"_

## 6. Utilities
- **data_location** — where DBs are stored (set with a path). · **normalize_url** — the join key for a URL.

_Tip: first time on a property → \`refresh_property\` then \`run_audit\`._`;

export function createServer(): { server: McpServer; run: () => Promise<void> } {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const jobs = new JobManager();

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const gsc = credPath ? new GscClient(credPath) : null;
  const sync = gsc ? new GscSync(gsc, dataDir()) : null;
  const inspector = gsc ? new UrlInspector(gsc, dataDir()) : null;
  const crawler = new Crawler(dataDir()); // no GSC credentials required

  const dfsUser = process.env.DATAFORSEO_USERNAME;
  const dfsPass = process.env.DATAFORSEO_PASSWORD;
  const dfsCacheDays = Number(process.env.DATAFORSEO_CACHE_DAYS) || 20;
  const dfs = dfsUser && dfsPass
    ? new DataForSeoClient(dfsUser, dfsPass, path.join(dataDir(), 'dataforseo-cache.db'), dfsCacheDays)
    : null;
  const rankTracker = dfs ? new RankTracker(dfs, dataDir()) : null;
  const backlinks = dfs ? new Backlinks(dfs, dataDir()) : null;
  const refresh = new Refresh(sync, crawler, inspector, rankTracker);
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
    'seo_audit_help',
    {
      title: 'Help — what this audit can do',
      description: 'Overview of every tool/feature with an example prompt for each. Start here.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: HELP_TEXT }], structuredContent: { version: SERVER_VERSION } }),
  );

  server.registerTool(
    'list_checks',
    {
      title: 'List audit checks',
      description: 'List the technical-SEO check categories this server can evaluate.',
      inputSchema: { category: z.enum(CHECK_CATEGORIES).optional() },
    },
    async ({ category }) => {
      const all = listChecks();
      const checks = category ? all.filter(c => (c.category as string) === category) : all;
      return { content: [{ type: 'text', text: `${checks.length} checks${category ? ` in ${category}` : ''}` }], structuredContent: { checks } };
    },
  );

  server.registerTool(
    'data_location',
    {
      title: 'Get or set where audit data is stored',
      description: 'No args: report the folder where per-property crawl/audit databases are saved. With `path`: set it (persisted to ~/.seo-audit-console.json) — restart Claude Desktop to apply. Default is your Documents folder; the SAC_DATA_DIR env var overrides everything.',
      inputSchema: { path: z.string().optional() },
    },
    async ({ path: newPath }) => {
      if (newPath) {
        mkdirSync(newPath, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify({ dataDir: newPath }, null, 2));
        return {
          content: [{ type: 'text', text: `Data location set to ${newPath}. Restart Claude Desktop to apply (this session still uses ${dataDir()}). Move existing .db files there to keep your synced data.` }],
          structuredContent: { requested: newPath, active: dataDir(), restartRequired: true, configFile: CONFIG_PATH },
        };
      }
      return {
        content: [{ type: 'text', text: `Audit data is stored in: ${dataDir()}` }],
        structuredContent: { active: dataDir(), default: DEFAULT_DATA_DIR, env: process.env.SAC_DATA_DIR ?? null, configFile: CONFIG_PATH },
      };
    },
  );

  // ── Audit engine ────────────────────────────────────────────────────────
  server.registerTool(
    'run_audit',
    {
      title: 'Run SEO audit',
      description: 'Run the technical-SEO checks against synced data and return scored findings (priority = impact÷effort, using real GSC traffic-at-risk). Crawl + GSC + URL-inspection checks. Set includeJudgement=true to include heuristic (N) checks.',
      inputSchema: {
        siteUrl: z.string(),
        scope: z.enum(['core', 'full']).optional(),
        categories: z.array(z.enum(CHECK_CATEGORIES)).optional(),
        includeJudgement: z.boolean().optional(),
      },
    },
    async ({ siteUrl, scope, categories, includeJudgement }) => {
      const result = runAudit(dataDir(), siteUrl, { scope, categories, includeJudgement });
      return {
        content: [{ type: 'text', text: auditMarkdown(result, siteUrl) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'query_audit',
    {
      title: 'Run one audit check',
      description: 'Run a single named check (see list_checks) and return its affected URLs + evidence.',
      inputSchema: { siteUrl: z.string(), check: z.string(), limit: z.number().int().min(1).max(1000).optional() },
    },
    async ({ siteUrl, check, limit }) => {
      const r = runSingleCheck(dataDir(), siteUrl, check, limit);
      return {
        content: [{ type: 'text', text: `${check}: ${r.findings.length} findings` }],
        structuredContent: r as unknown as Record<string, unknown>,
      };
    },
  );

  // fix_finding — the moat: turn a finding into a concrete, paste-ready remediation.
  server.registerTool(
    'fix_finding',
    {
      title: 'Generate a fix for a finding',
      description: 'Turn an audit finding into a concrete, paste-ready remediation: JSON-LD for missing structured data, a 301 rule for broken / redirecting internal links, or internal-link suggestions for orphan / striking-distance pages. Other checks return their deterministic fix guidance. Dry-run — returns artifacts, never writes to your site. Identify the finding by findingId (from run_audit) or by check + url.',
      inputSchema: {
        siteUrl: z.string(),
        findingId: z.number().int().optional(),
        check: z.string().optional(),
        url: z.string().optional(),
        redirectFormat: z.enum(['htaccess', 'nginx', 'nextjs']).optional(),
      },
    },
    async ({ siteUrl, findingId, check, url, redirectFormat }) => {
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        // Resolve the finding → checkId, affected url_key, evidence.
        let checkId: string | undefined = check;
        let affectedKey: string | null = null;
        let evidence: Record<string, unknown> = {};
        if (findingId != null) {
          const row = db.db.prepare('SELECT check_id, url_key, evidence FROM findings WHERE id = ?').get(findingId) as
            | { check_id: string; url_key: string | null; evidence: string | null }
            | undefined;
          if (!row) {
            return { content: [{ type: 'text', text: `No finding #${findingId} for ${siteUrl}. Run run_audit first.` }], structuredContent: { error: 'not_found', findingId } };
          }
          checkId = row.check_id;
          affectedKey = row.url_key;
          evidence = row.evidence ? JSON.parse(row.evidence) : {};
        } else if (check && url) {
          const hostForm = hostFormForProperty(siteUrl) ?? 'asis';
          affectedKey = urlKey(url, { hostForm });
          const row = db.db.prepare('SELECT evidence FROM findings WHERE check_id = ? AND url_key = ? ORDER BY id DESC LIMIT 1').get(check, affectedKey) as
            | { evidence: string | null }
            | undefined;
          evidence = row?.evidence ? JSON.parse(row.evidence) : {};
        } else {
          throw new Error('Provide either findingId, or check + url.');
        }

        let kind: string;
        let fix: unknown;
        switch (checkId) {
          case 'missing-structured-data':
          case 'invalid-schema':
          case 'missing-required-fields': {
            const page = db.db
              .prepare('SELECT url, url_key, title, h1, meta_description, og_tags FROM pages WHERE url_key = ?')
              .get(affectedKey) as Record<string, unknown> | undefined;
            if (!page) {
              return { content: [{ type: 'text', text: `No crawled page for ${affectedKey} — crawl the property first.` }], structuredContent: { error: 'no_page', urlKey: affectedKey } };
            }
            kind = 'json-ld';
            fix = generateJsonLd(page);
            break;
          }
          case 'broken-internal-links':
          case 'internal-links-to-redirects':
          case 'redirect-chain': {
            const livePages = db.db
              .prepare('SELECT url FROM pages WHERE status_code = 200 AND indexable = 1')
              .all() as { url: string }[];
            kind = 'redirect';
            fix = suggestRedirect(affectedKey ?? '', livePages, redirectFormat ?? 'htaccess');
            break;
          }
          case 'orphan-with-impressions':
          case 'striking-distance': {
            const page = db.db.prepare('SELECT h1, title FROM pages WHERE url_key = ?').get(affectedKey) as
              | { h1: string | null; title: string | null }
              | undefined;
            // Prefer the GSC query as anchor, but fall back to H1/title when it's a
            // boolean/over-long search string (common on job boards) — not usable anchor text.
            const q = evidence.query as string | undefined;
            const cleanQuery = q && q.length <= 60 && !/["()]|\bor\b|\bnot\b|\s-\w/i.test(q) ? q : undefined;
            const anchor = cleanQuery ?? page?.h1 ?? page?.title ?? q ?? '';
            kind = 'internal-links';
            fix = suggestInternalLinks(db.db, affectedKey ?? '', anchor);
            break;
          }
          default: {
            const def = listChecks().find(c => c.id === checkId);
            kind = 'explanation';
            fix = { explanation: def?.fix ?? 'No automated generator for this check — apply the recommendation manually.', fixType: def?.fixType, title: def?.title };
          }
        }

        return {
          content: [{ type: 'text', text: `Fix for ${checkId} (${kind})${affectedKey ? ` on ${affectedKey}` : ''}` }],
          structuredContent: { checkId, urlKey: affectedKey, kind, fix } as Record<string, unknown>,
        };
      } finally {
        db.close();
      }
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
  registerAppTool(
    server,
    'refresh_property',
    {
      title: 'Refresh a property (sync + crawl + inspect)',
      description: 'Full refresh for a property in one async job: GSC sync → site crawl → URL inspection → DataForSEO rank history. Opens a live progress widget (phases + counts). Set gsc/crawl/inspect/ranks=false to run just part. GSC sync is "lite" (date×query×page) by default — set segments=true to also pull device/country breakdowns (much heavier on large sites). Use this for "sync everything"; use the single-purpose tools to update just one thing.',
      inputSchema: {
        siteUrl: z.string(),
        gsc: z.boolean().optional(),
        crawl: z.boolean().optional(),
        inspect: z.boolean().optional(),
        ranks: z.boolean().optional(),
        segments: z.boolean().optional(),
        location: z.union([z.string(), z.number()]).optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        maxPages: z.number().int().min(1).max(50000).optional(),
        inspectLimit: z.number().int().min(1).max(500).optional(),
      },
      _meta: { ui: { resourceUri: SYNC_PROGRESS_URI } },
    },
    async ({ siteUrl, gsc: doGsc, crawl, inspect, ranks, segments, location, startDate, endDate, maxPages, inspectLimit }) => {
      const jobId = jobs.start('refresh', (update, signal) =>
        refresh.run(siteUrl, { gsc: doGsc, crawl, inspect, ranks, segments, location, startDate, endDate, maxPages, inspectLimit }, update, signal),
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
      description: 'Update just the GSC search-analytics history (async job — poll with check_sync_status). Default range: last 90 days. Lite by default (date×query×page); set segments=true (or pass dimensions) to also pull device/country. For a full refresh use refresh_property.',
      inputSchema: {
        siteUrl: z.string(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        dimensions: z.array(z.string()).optional(),
        segments: z.boolean().optional(),
        searchType: z.enum(['web', 'discover', 'googleNews', 'image', 'video']).optional(),
      },
    },
    async ({ siteUrl, startDate, endDate, dimensions, segments, searchType }) => {
      const syncer = requireGsc(sync);
      const options: FetchOptions = {
        startDate: startDate ?? isoDaysAgo(90),
        endDate: endDate ?? isoDaysAgo(0),
        dimensions: dimensions ?? (segments ? FULL_DIMENSIONS : undefined),
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
        location: z.union([z.string(), z.number()]).optional(),
        languageCode: z.string().optional(),
      },
    },
    async ({ keywords, location, languageCode }) => {
      const client = requireDfs(dfs);
      const r = await client.searchVolume(keywords, location, languageCode);
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
      inputSchema: { keyword: z.string(), location: z.union([z.string(), z.number()]).optional(), languageCode: z.string().optional() },
    },
    async ({ keyword, location, languageCode }) => {
      const client = requireDfs(dfs);
      const r = await client.relatedTerms(keyword, location, languageCode);
      return {
        content: [{ type: 'text', text: `PAA: ${r.peopleAlsoAsk.length}, related: ${r.relatedSearches.length}${r.cached ? ' (cached)' : ` ($${r.cost.toFixed(4)})`}` }],
        structuredContent: r as unknown as Record<string, unknown>,
      };
    },
  );

  // ── Dashboard (MCP App UI — houtini design + ECharts) ───────────────────
  registerAppTool(
    server,
    'get_dashboard',
    {
      title: 'SEO dashboard',
      description: 'Interactive dashboard for a property: summary metrics, rank & clicks over time, and top-keyword performance (click a keyword for related terms). Needs synced GSC data — run refresh_property first.',
      inputSchema: { siteUrl: z.string() },
      _meta: { ui: { resourceUri: DASHBOARD_URI } },
    },
    async ({ siteUrl }) => {
      // Return only a TINY model-facing result + the siteUrl; the widget fetches the full
      // (large) dataset itself via the app-only get_dashboard_data tool, which keeps the
      // big payload OUT of the model's context/token limit (per the MCP Apps large-data pattern).
      const data = getDashboardData(dataDir(), siteUrl);
      if (data.empty) {
        return { content: [{ type: 'text', text: `No synced data for ${siteUrl} yet — run refresh_property.` }], structuredContent: { siteUrl, empty: true } };
      }
      const c = data.summary?.current;
      const summary = `Dashboard opened for ${siteUrl} — ${c?.clicks ?? 0} clicks / ${c?.impressions ?? 0} impressions (last 28d)` +
        `${data.findings ? `, ${data.findings.total} audit findings` : ''}. Interactive charts + findings render in the widget.`;
      return { content: [{ type: 'text', text: summary }], structuredContent: { siteUrl } };
    },
  );

  // App-only data tool: the dashboard widget calls this via app.callServerTool to fetch its
  // full dataset. visibility:['app'] hides it from the model; results route to the iframe,
  // bypassing the model token cap that a large model-facing result would hit.
  registerAppTool(
    server,
    'get_dashboard_data',
    {
      title: 'Dashboard data (internal)',
      description: 'Full dashboard dataset for the UI widget. App-only — not for direct use.',
      inputSchema: { siteUrl: z.string() },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ siteUrl }) => {
      const data = getDashboardData(dataDir(), siteUrl);
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: data as unknown as Record<string, unknown> };
    },
  );

  // export_report — the dependable deliverable: a self-contained interactive dashboard
  // HTML (data inlined) the user opens in any browser / emails to a client. Works
  // regardless of whether the host renders MCP-App widgets inline.
  server.registerTool(
    'export_report',
    {
      title: 'Export a shareable dashboard report (HTML)',
      description: 'Write a self-contained, interactive dashboard HTML for a property (all data + charts inlined) to the reports folder, and return the file path. Open it in any browser or send it to a client — no server, no MCP-App host support needed. Run refresh_property (+ run_audit for findings) first.',
      inputSchema: { siteUrl: z.string(), theme: z.enum(['light', 'dark']).optional() },
    },
    async ({ siteUrl, theme }) => {
      const data = getDashboardData(dataDir(), siteUrl);
      if (data.empty) {
        return { content: [{ type: 'text', text: `No synced data for ${siteUrl} — run refresh_property first.` }], structuredContent: { error: 'empty', siteUrl } };
      }
      const tpl = readFileSync(path.join(__dirname, 'src', 'ui', 'dashboard.html'), 'utf8');
      const json = JSON.stringify(data).replace(/</g, '\\u003c'); // prevent </script> breakout
      const inject = `<script>window.__DASH_FIXTURE__=${json};window.__DASH_THEME__=${JSON.stringify(theme ?? 'light')};</script>`;
      const html = tpl.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
      const dir = path.join(dataDir(), 'reports');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sanitizeProperty(siteUrl)}-dashboard.html`);
      writeFileSync(file, html);
      return {
        content: [{ type: 'text', text: `Report saved: ${file}\nOpen it in any browser for the full interactive dashboard (${data.findings?.total ?? 0} findings). Shareable — send it to a client as-is.` }],
        structuredContent: { path: file, siteUrl, findings: data.findings?.total ?? 0, bytes: html.length },
      };
    },
  );

  // pull_backlinks — on-demand backlink profile (DataForSEO, paid + 20-day cached). Powers
  // backlinks-to-404 (the big quick win), top-linked pages, and true-orphan detection.
  server.registerTool(
    'pull_backlinks',
    {
      title: 'Pull backlink profile (DataForSEO)',
      description: 'Fetch the property’s backlink profile (overall summary + per-page backlink/referring-domain counts) into page_backlinks, and resolve each backlinked page’s live HTTP status so run_audit can flag external backlinks pointing to dead (4xx/5xx) pages. Paid DataForSEO call, 20-day cached, on-demand only. Async job — poll check_sync_status.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(1).max(1000).optional(), statusLimit: z.number().int().min(0).max(1000).optional() },
    },
    async ({ siteUrl, limit, statusLimit }) => {
      const bl = requireDfs(backlinks);
      const jobId = jobs.start('backlinks', (update, signal) => bl.run(siteUrl, { limit, statusLimit }, update, signal));
      return {
        content: [{ type: 'text', text: `Backlink pull started for ${siteUrl} (job ${jobId}). Poll check_sync_status, then run_audit for backlinks-to-404.` }],
        structuredContent: { jobId, status: 'running', siteUrl },
      };
    },
  );

  registerAppResource(
    server,
    'SEO Dashboard',
    DASHBOARD_URI,
    {},
    async () => ({
      contents: [{ uri: DASHBOARD_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(path.join(__dirname, 'src', 'ui', 'dashboard.html'), 'utf-8') }],
    }),
  );

  registerAppResource(
    server,
    'Sync Progress',
    SYNC_PROGRESS_URI,
    {},
    async () => ({
      contents: [{ uri: SYNC_PROGRESS_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(path.join(__dirname, 'src', 'ui', 'sync-progress.html'), 'utf-8') }],
    }),
  );

  server.registerTool(
    'track_ranks',
    {
      title: 'Track ranks over time (DataForSEO)',
      description: 'Ingest the DataForSEO over-time sequence (monthly rank distribution + ETV) into rank_history, so rank charts have a real time axis reconciled with GSC. DataForSEO Labs call — cached 20 days. Pass location once (e.g. "Australia", "United Kingdom") — it is saved per property. Async job.',
      inputSchema: { siteUrl: z.string(), location: z.union([z.string(), z.number()]).optional() },
    },
    async ({ siteUrl, location }) => {
      const tracker = requireDfs(rankTracker);
      const jobId = jobs.start('rank_history', (update, signal) => tracker.run(siteUrl, { location }, update, signal));
      return {
        content: [{ type: 'text', text: `Rank-history ingest started for ${siteUrl} (job ${jobId}). Poll check_sync_status.` }],
        structuredContent: { jobId, status: 'running', siteUrl },
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
