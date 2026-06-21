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
import { detectTemplates } from './audit/templates.js';
import { suggestPages } from './audit/opportunities.js';
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
import { WikidataClient } from './core/WikidataClient.js';
import { Entities } from './core/Entities.js';
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
  'crawlability', 'indexation', 'onpage', 'content', 'schema', 'security', 'performance', 'merged',
] as const;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

const SEV_ICON: Record<string, string> = { crit: '🔴', high: '🟠', med: '🟡', low: '⚪', info: '·' };
const CAT_NAME: Record<string, string> = {
  integrity: 'Integrity', crawlability: 'Crawlability', indexation: 'Indexation', onpage: 'On-page',
  content: 'Content', schema: 'Structured data', security: 'Security', 'war-stories': 'Edge cases',
  performance: 'Performance (CWV)', merged: 'Search performance', agentic: 'AI readiness',
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
  out.push('', '## Top priorities (expected clicks ÷ dev-hour)');
  (r.top ?? []).slice(0, 12).forEach((f: any, i: number) => {
    const rec = p(f.recommendation), traf = p(f.traffic_at_risk), eff = p(f.effort);
    const pth = (f.url_key || '—').replace(/^https?:\/\/[^/]+/, '') || '/';
    const tr = (traf.clicks || traf.impressions) ? ` · ${traf.clicks || 0} clicks / ${traf.impressions || 0} impr` : '';
    const yld = eff.expectedClicks != null ? ` · ~${eff.expectedClicks} clicks at stake, ~${eff.hours}h` : '';
    out.push(`${i + 1}. ${SEV_ICON[f.severity] ?? '·'} **${rec.title || f.check_id}** — \`${pth}\`${tr}${yld}`);
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

## 4. Backlinks, keywords & competitive (DataForSEO, on-demand, cached 20 days)
- **pull_backlinks** — backlink profile + per-page counts + live status → unlocks **backlinks-to-404** (recover lost equity), top-linked pages, true orphans. _"Pull backlinks for example.com"_
- **keyword_volume / related_terms** — volume/CPC, and People-Also-Ask + related searches. _"Search volume for [\\"best widgets\\"]"_
- **search_intent** — informational/navigational/commercial/transactional per keyword → spot intent mismatch behind low CTR. _"Classify intent for [\\"buy running shoes\\", \\"how to clean shoes\\"]"_
- **page_lighthouse** — lab Core Web Vitals + opportunities for one URL (~20–120s). _"Run Lighthouse on https://example.com/slow-page"_
- **competitors_domain** — domains competing for your organic keywords. _"Find competitors for example.com in the UK"_
- **page_intersection** — keywords competitor pages rank for but yours doesn’t (content gap). _"Content gap: competitorUrls [\\"https://rival.com/guide\\"], excludePages [\\"https://example.com/guide\\"]"_

## 5. Templates & opportunities
- **list_templates** — cluster pages into templates (one fix → N pages) with a representative exemplar. _"List page templates for example.com"_
- **suggest_pages** — new-page ideas grounded in real GSC demand, minus what you already cover. _"Suggest new pages for example.com"_
- **resolve_entities** — map pages to Wikidata entities → unlocks entity-internal-link-gap (judgement). _"Resolve entities for example.com"_

## 6. Reports & dashboard
- **get_dashboard** — interactive dashboard (renders in chat). _"Show the dashboard for example.com"_
- **export_report** — self-contained shareable HTML to send a client. _"Export the report for example.com"_

## 7. Utilities
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
  const entities = new Entities(new WikidataClient(path.join(dataDir(), 'wikidata-cache.db')), dataDir());
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
    'list_templates',
    {
      title: 'Detect page templates',
      description: 'Cluster the crawled pages into templates (by URL morphology + JSON-LD @type) and return each template with its page count and a representative exemplar URL. A single template-level fix corrects every page in the cluster — this is the map for per-template analysis. Needs a crawl (run refresh_property / start_crawl first).',
      inputSchema: { siteUrl: z.string(), minMembers: z.number().int().min(2).max(100).optional() },
    },
    async ({ siteUrl, minMembers }) => {
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        const clusters = detectTemplates(db.db, minMembers != null ? { minMembers } : {});
        const summary = clusters.slice(0, 20).map(c => `• ${c.morphology} [${c.schemaType}] — ${c.count} pages (e.g. ${c.exemplarUrl})`).join('\n');
        return {
          content: [{ type: 'text', text: clusters.length ? `${clusters.length} templates detected:\n${summary}` : 'No templates with ≥ the minimum members — crawl first, or lower minMembers.' }],
          structuredContent: { templates: clusters.map(({ memberKeys: _m, ...c }) => c), count: clusters.length },
        };
      } finally { db.close(); }
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
      description: 'Run the technical-SEO checks against synced data and return scored findings, ranked by expected clicks per dev-hour — Priority = (T × Y × C) / E (T = clicks at stake from real GSC data, Y = expected yield, C = certainty, E = effort hours). Crawl + GSC + URL-inspection checks. Set includeJudgement=true to include heuristic (N) checks.',
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

  server.registerTool(
    'suggest_pages',
    {
      title: 'Suggest new pages from real demand (gaps)',
      description: 'Propose NEW pages grounded in real Search Console demand: queries you already get impressions for but rank 11+ (no winning page), after subtracting demand you already satisfy (you rank ≤10, or a page already covers the query, or one URL owns it). Survivors are clustered into one proposed page per intent and scored by impressions × intent. Returns evidence + the nearest existing page to link the new page from. Computable from synced GSC + crawl — no paid calls (run search_intent siteUrl:<property> first to weight by intent).',
      inputSchema: { siteUrl: z.string(), minImpressions: z.number().int().min(1).optional(), maxProposals: z.number().int().min(1).max(200).optional() },
    },
    async ({ siteUrl, minImpressions, maxProposals }) => {
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        const r = suggestPages(db.db, { ...(minImpressions != null ? { minImpressions } : {}), ...(maxProposals != null ? { maxProposals } : {}) });
        const top = r.proposals.slice(0, 15).map(p => `• "${p.headTerm}" — ${p.totalImpressions} impr, currently pos ${p.bestPosition}${p.intent ? `, ${p.intent}` : ''} (${p.queries.length} queries)`).join('\n');
        return {
          content: [{ type: 'text', text: r.proposals.length ? `${r.proposals.length} new-page opportunities (from ${r.consideredQueries} queries, ${r.afterDedup} after dedup):\n${top}` : `No new-page gaps found (${r.consideredQueries} queries considered). Needs synced GSC data.` }],
          structuredContent: r as unknown as Record<string, unknown>,
        };
      } finally { db.close(); }
    },
  );

  server.registerTool(
    'search_intent',
    {
      title: 'Search intent classification (DataForSEO Labs)',
      description: 'Classify the search intent (informational / navigational / commercial / transactional) of keywords — primary label + probability + secondary intents. Use it to spot intent mismatch: e.g. a transactional product page ranking for an informational query (a common cause of high impressions / low CTR). Pass siteUrl to persist the intents so run_audit can surface intent-vs-pagetype-mismatch. Labs call, cached 20 days, up to 1000 keywords. Language-only (no location).',
      inputSchema: { keywords: z.array(z.string()).min(1).max(1000), languageCode: z.string().optional(), siteUrl: z.string().optional() },
    },
    async ({ keywords, languageCode, siteUrl }) => {
      const client = requireDfs(dfs);
      const r = await client.searchIntent(keywords, languageCode);
      const items = (r.tasks[0]?.result?.[0]?.items ?? []).map((it: any) => ({
        keyword: it.keyword,
        intent: it.keyword_intent?.label ?? null,
        probability: it.keyword_intent?.probability ?? null,
        secondary: (it.secondary_keyword_intents ?? []).map((s: any) => ({ intent: s.label, probability: s.probability })),
      }));
      let persisted = 0;
      if (siteUrl) {
        const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
        try {
          const up = db.db.prepare(`INSERT INTO keyword_intent (keyword,intent,probability,fetched_at) VALUES (?,?,?,datetime('now'))
            ON CONFLICT(keyword) DO UPDATE SET intent=excluded.intent, probability=excluded.probability, fetched_at=datetime('now')`);
          db.db.transaction(() => { for (const it of items) if (it.keyword && it.intent) { up.run(it.keyword.toLowerCase(), it.intent, it.probability); persisted++; } })();
        } finally { db.close(); }
      }
      return {
        content: [{ type: 'text', text: `${items.length} keywords classified${persisted ? `, ${persisted} saved for ${siteUrl}` : ''}${r.cached ? ' (cached)' : ` (live, $${r.cost.toFixed(4)})`}` }],
        structuredContent: { intents: items, persisted, cached: r.cached, cost: r.cost },
      };
    },
  );

  server.registerTool(
    'page_lighthouse',
    {
      title: 'Page Lighthouse — lab Core Web Vitals (DataForSEO On-Page)',
      description: 'Run a live Lighthouse audit for ONE url: lab Core Web Vitals (LCP, CLS, TBT, FCP, Speed Index), category scores (performance/SEO/best-practices/accessibility), and the top time-saving opportunities. Complements GSC/CrUX field data (aggregate + delayed) with on-demand lab data. Pass siteUrl to persist the CWV so run_audit can surface high-yield-cwv-fail. Paid On-Page call (~2000 credits), slow (~20–120s), cached 20 days.',
      inputSchema: { url: z.string().url(), forMobile: z.boolean().optional(), siteUrl: z.string().optional() },
    },
    async ({ url, forMobile, siteUrl }) => {
      const client = requireDfs(dfs);
      const mobile = forMobile ?? true;
      const r = await client.lighthouse(url, mobile);
      const res = r.tasks[0]?.result?.[0] ?? {};
      const audits: Record<string, any> = res.audits ?? {};
      const cwv = (id: string) => ({ score: audits[id]?.score ?? null, value: audits[id]?.displayValue ?? null });
      const numeric = (id: string): number | null => audits[id]?.numericValue ?? null;
      const cats: Record<string, any> = res.categories ?? {};
      const opportunities = Object.values(audits)
        .filter((a: any) => a?.details?.type === 'opportunity' && (a.details.overallSavingsMs ?? 0) > 0)
        .sort((a: any, b: any) => (b.details.overallSavingsMs ?? 0) - (a.details.overallSavingsMs ?? 0))
        .slice(0, 8)
        .map((a: any) => ({ id: a.id, title: a.title, savingsMs: Math.round(a.details.overallSavingsMs) }));
      const out = {
        url, forMobile: mobile,
        scores: {
          performance: cats.performance?.score ?? null,
          seo: cats.seo?.score ?? null,
          bestPractices: cats['best-practices']?.score ?? null,
          accessibility: cats.accessibility?.score ?? null,
        },
        coreWebVitals: {
          lcp: cwv('largest-contentful-paint'), cls: cwv('cumulative-layout-shift'),
          tbt: cwv('total-blocking-time'), fcp: cwv('first-contentful-paint'), speedIndex: cwv('speed-index'),
        },
        opportunities,
        cached: r.cached, cost: r.cost,
      };
      let persisted = false;
      if (siteUrl && cats.performance) {
        const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
        try {
          db.db.prepare(`INSERT INTO page_cwv (url_key,url,for_mobile,performance,lcp_ms,cls,tbt_ms,fetched_at)
            VALUES (?,?,?,?,?,?,?,datetime('now'))
            ON CONFLICT(url_key) DO UPDATE SET url=excluded.url, for_mobile=excluded.for_mobile, performance=excluded.performance,
              lcp_ms=excluded.lcp_ms, cls=excluded.cls, tbt_ms=excluded.tbt_ms, fetched_at=datetime('now')`)
            .run(urlKey(url, { hostForm: hostFormForProperty(siteUrl) }), url, mobile ? 1 : 0,
              out.scores.performance, numeric('largest-contentful-paint'), numeric('cumulative-layout-shift'), numeric('total-blocking-time'));
          persisted = true;
        } finally { db.close(); }
      }
      const perf = out.scores.performance != null ? Math.round(out.scores.performance * 100) : '?';
      return {
        content: [{ type: 'text', text: `Lighthouse ${url}: perf ${perf}/100, LCP ${out.coreWebVitals.lcp.value ?? '?'}, CLS ${out.coreWebVitals.cls.value ?? '?'}${persisted ? ` (saved for ${siteUrl})` : ''}${r.cached ? ' (cached)' : ` (live, $${r.cost.toFixed(4)})`}` }],
        structuredContent: { ...out, persisted },
      };
    },
  );

  server.registerTool(
    'competitors_domain',
    {
      title: 'Competitor domains (DataForSEO Labs)',
      description: 'Discover the domains competing with a target for the same organic keywords (ranked by keyword overlap), with intersection counts and organic traffic estimates. The seed list for content-gap analysis (feed these into page_intersection). Labs call, cached 20 days. Pass location + language for the right market.',
      inputSchema: { target: z.string(), location: z.union([z.string(), z.number()]).optional(), languageCode: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ target, location, languageCode, limit }) => {
      const client = requireDfs(dfs);
      const cleaned = target.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
      const r = await client.competitorsDomain(cleaned, location, languageCode, limit ?? 20);
      const items = (r.tasks[0]?.result?.[0]?.items ?? [])
        .filter((it: any) => it.domain && it.domain.replace(/^www\./, '') !== cleaned) // drop the target itself
        .map((it: any) => ({
        domain: it.domain,
        intersections: it.intersections ?? null,
        avgPosition: it.avg_position ?? null,
        organicKeywords: it.full_domain_metrics?.organic?.count ?? null,
        organicEtv: it.full_domain_metrics?.organic?.etv ?? null,
      }));
      return {
        content: [{ type: 'text', text: `${items.length} competitor domains for ${cleaned}${r.cached ? ' (cached)' : ` (live, $${r.cost.toFixed(4)})`}` }],
        structuredContent: { target: cleaned, competitors: items, cached: r.cached, cost: r.cost },
      };
    },
  );

  server.registerTool(
    'page_intersection',
    {
      title: 'Content gap — page intersection (DataForSEO Labs)',
      description: 'Find keywords that competitor pages rank for but your page does NOT (the content gap). Pass competitor URLs as `competitorUrls` (max 20; wildcards like https://site.com/blog/* allowed) and your own URL(s) in `excludePages` (max 10) to subtract. Returns gap keywords sorted by search volume, with each competitor’s rank. Labs call, cached 20 days. Pass location + language.',
      inputSchema: {
        competitorUrls: z.array(z.string()).min(1).max(20),
        excludePages: z.array(z.string()).max(10).optional(),
        location: z.union([z.string(), z.number()]).optional(),
        languageCode: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ competitorUrls, excludePages, location, languageCode, limit }) => {
      const client = requireDfs(dfs);
      const r = await client.pageIntersection(competitorUrls, excludePages ?? [], location, languageCode, limit ?? 100);
      const items = (r.tasks[0]?.result?.[0]?.items ?? [])
        .map((it: any) => {
          const kd = it.keyword_data ?? {}; // actual shape: item.keyword_data.{keyword,keyword_info}
          return {
            keyword: kd.keyword ?? null,
            searchVolume: kd.keyword_info?.search_volume ?? null,
            cpc: kd.keyword_info?.cpc ?? null,
            competition: kd.keyword_info?.competition ?? null,
            ranks: Object.entries(it.intersection_result ?? {}).map(([idx, v]: [string, any]) => ({
              page: Number(idx), rank: v?.rank_absolute ?? null, url: v?.url ?? null,
            })),
          };
        })
        .sort((a: any, b: any) => (b.searchVolume ?? 0) - (a.searchVolume ?? 0)); // order_by unsupported on this endpoint
      return {
        content: [{ type: 'text', text: `${items.length} gap keywords${r.cached ? ' (cached)' : ` (live, $${r.cost.toFixed(4)})`}` }],
        structuredContent: { gaps: items, cached: r.cached, cost: r.cost },
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

  server.registerTool(
    'resolve_entities',
    {
      title: 'Resolve page entities (Wikidata)',
      description: 'Heuristically resolve each top page’s primary entity (by H1, fallback title) to a Wikidata QID, and store subclass-of / part-of relationships between them. Unlocks the entity-internal-link-gap finding (suggests internal links a topical mesh implies). Heuristic — those findings are judgement (N), shown only with includeJudgement. Free (public Wikidata API), cached ~45 days, on-demand. Async job — poll check_sync_status.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(1).max(500).optional(), language: z.string().optional() },
    },
    async ({ siteUrl, limit, language }) => {
      const jobId = jobs.start('entities', (update, signal) => entities.run(siteUrl, { ...(limit != null ? { limit } : {}), ...(language ? { language } : {}) }, update, signal));
      return {
        content: [{ type: 'text', text: `Entity resolution started for ${siteUrl} (job ${jobId}). Poll check_sync_status, then run_audit includeJudgement:true for entity-internal-link-gap.` }],
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
