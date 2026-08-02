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
import { buildAuditMarkdown } from './audit/report.js';
import { diffLatest, buildDriftMarkdown } from './audit/drift.js';
import { checkAgentReadiness, buildAgentReadinessMarkdown } from './core/agentReadiness.js';
import { detectTemplates } from './audit/templates.js';
import { suggestPages } from './audit/opportunities.js';
import { computeTopicGaps, type GapKeywordRow } from './audit/topicGaps.js';
import { AuditDatabase } from './core/AuditDatabase.js';
import { dbPathFor, sanitizeProperty } from './core/paths.js';
import { scoreSitePassages } from './core/passageScore.js';
import { buildDraftBrief } from './core/draftBrief.js';
import { generateJsonLd, suggestRedirect, suggestInternalLinks, collapseChainRules } from './generators/index.js';

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


// Server-level instructions (MCP `initialize` result): teach the assistant how the data
// sources JOIN so it can COMPOSE bespoke multi-source analyses, not just run presets.
const SERVER_INSTRUCTIONS = `SEO Audit Console fuses four data sources into one SQLite database per property: Google Search Console history, a first-party site crawl, GSC URL Inspection, and on-demand DataForSEO (SERP/Labs/Backlinks). Its real power is COMPOSITION — joining sources to answer questions no single tool answers.

JOIN KEYS (memorise these):
- url_key — one normalised URL form (https, unified www/apex, sorted params, no tracking params/fragments). Joins the crawl (pages, links) ↔ GSC (search_analytics.page_key) ↔ url_inspection ↔ page_backlinks ↔ page_cwv ↔ page_entity. normalize_url shows the key for any URL.
- query — the literal search term. Joins GSC search_analytics ↔ DataForSEO keyword tools (keyword_volume, search_intent, ranked_keywords rows) ↔ keyword_intent.
- domain — a bare host (no scheme, no www). Joins the Labs tools (ranked_keywords, domain_visibility, top_pages, competitors_domain, topic_gaps) ↔ backlinks summary.

GRAIN (one line per source):
- search_analytics: date × query × page (plus device/country when synced with segments). Rows are additive; position must be impression-weighted when aggregated.
- pages / links: the LATEST crawl only, one row per url_key (history lives in page_snapshots, diffed by detect_changes). Carries title/H1/meta, canonical, schema (json_ld), body_chunks, iPR, click_depth, inlink_count.
- url_inspection: one row per inspected URL — Google's own view (coverage_state, google_canonical vs user_canonical, last_crawl_time, crawled_as, rich_results).
- rank_history: month × domain (DataForSEO rank distribution + ETV).
- page_backlinks: one row per backlinked URL (counts + live HTTP status).
- Labs tools: keyword × target, or month × target; cached 20 days; each call costs money — never loop them in bulk.

ARCHETYPE CHAINS (compose along these lines):
1. Demand → reality: a GSC query with impressions but weak rank → the ranking page's crawl fields (title/H1/body_chunks) → does the page actually say what the query asks? → fix on-page or draft content.
2. Authority → waste: iPR / backlinks flowing into non-200, redirected, or orphaned URLs → recover the equity with 301s or internal links (fix_finding generates them).
3. Competitor → gap: competitor keyword footprints (ranked_keywords / topic_gaps) minus our GSC + crawled-page footprint → topics to cover, each tied to the nearest existing page.

Before planning ANY complex multi-source question, call composition_cookbook — it returns the full data-surface map and worked recipes using these exact tool and table names.`;

const COOKBOOK_TEXT = `# Composition cookbook — the data surface and how to join it

This server's value is composition: joining Search Console, the crawl, URL Inspection and DataForSEO to answer questions no preset check covers. This page is static (no API calls) — use it to PLAN, then run the tools.

## The data surface

| Source (table) | Grain | Key dimensions | Join keys | Freshness | Cost |
|---|---|---|---|---|---|
| search_analytics (GSC) | date × query × page (+device/country with segments) | clicks, impressions, ctr, position | page_key (url_key), query, date | sync_gsc / refresh_property — incremental, GSC lags ~2–3 days | free |
| pages + links (crawl) | one row per url_key, LATEST crawl | status, title, H1, meta, canonical_key, robots, json_ld, hreflang, redirects, body_chunks, word_count, ipr, click_depth, inlink_count, conditional_304 | url_key | start_crawl / refresh_property (on demand) | free |
| page_snapshots (drift) | url_key × crawl | field-level SEO snapshot per crawl | url_key, captured_at | every crawl, automatically | free |
| url_inspection | one row per inspected URL (top pages by clicks, quota-limited) | coverage_state, page_fetch_state, google_canonical, user_canonical, last_crawl_time, crawled_as, rich_results | url_key | inspect_urls | free (GSC quota) |
| sitemap_urls | one row per sitemap URL | lastmod | url_key | captured at crawl time | free |
| rank_history | month × domain | rank distribution (1–3/4–10/11–20/21–100), ETV | period | track_ranks | paid, 20-day cache |
| page_backlinks | one row per backlinked URL | backlinks, referring_domains, live status_code | url_key, domain | pull_backlinks (needs the DataForSEO Backlinks subscription) | paid, 20-day cache |
| keyword_intent | one row per keyword | intent + probability | query | search_intent (pass siteUrl to persist) | paid (cheap), cached |
| page_cwv | one row per audited URL | performance, LCP, CLS, TBT | url_key | page_lighthouse (pass siteUrl to persist) | paid, cached |
| page_entity + entity_edge | one row per page / edge per relation | QID, label, subclass-of / part-of | url_key, qid | resolve_entities (free Wikidata) | free |
| Labs (ranked_keywords, domain_visibility, top_pages, competitors_domain, page_intersection, topic_gaps) | keyword × target, or month × target | volume, ETV, position, KD, intent, SERP features, AIO citations | domain, query | on demand | paid, 20-day cache |
| findings (audit_runs) | finding per check × URL | priority, evidence JSON | url_key, check_id | run_audit | free |

Raw access: query_audit runs any single check with full evidence; every table above lives in one SQLite file per property (path via data_location) if you need direct SQL.

## Worked recipes

1. **AI Overview citation loss.** ranked_keywords target:<your domain> aioOnly:true → the keywords where you are cited as an AIO source. For each cited keyword's ranking page, pull its per-day clicks from search_analytics (page_key × date). Pages whose clicks fell while the AIO citation appeared = you are feeding the answer without earning the visit.
2. **Striking distance without body coverage.** query_audit check:striking-distance (GSC rank 11–20) → for each page, check pages.body_chunks for the query's terms. The automated versions: body-missing-top-query, rag-answer-gap, and score_passages for the dense-answer test. Pages ranking 11–20 that never answer the query in one passage are the highest-yield rewrites.
3. **Not indexed + no equity.** url_inspection.coverage_state ~ 'not indexed' joined to pages.ipr + inlink_count. Low-iPR unindexed pages need internal links, not resubmission; high-iPR unindexed pages are the real anomalies. (Checks: coverage-not-indexed, underlinked-high-demand.)
4. **Cannibalisation with semantic overlap.** run_audit → keyword-cannibalisation evidence lists the competing URLs per query → compare those pages' body_chunks: heavy chunk overlap = consolidate (301 the loser); light overlap = differentiate the titles/H1s and interlink with distinct anchors.
5. **Stable rank, falling CTR → SERP feature shift.** In search_analytics find queries where weekly position is flat but ctr declines → related_terms / ranked_keywords serpFeatures for that keyword shows what now sits above you (AIO, featured snippet, shopping). ctr-below-expected is the deterministic starting list.
6. **Schema vs rich-result reality.** pages.json_ld (declared @types) joined to url_inspection.rich_results (what Google actually detected + issues). The rich-result-issues check automates the per-URL diff; the composition question is per-TEMPLATE (list_templates): which template's schema never earns its rich result?
7. **Migration signal transfer.** pages.redirects (recorded chains) → url_inspection.google_canonical of the target (has Google accepted the move?) → search_analytics clicks by page_key before/after the migration date. Equity that didn't follow the 301 shows up as a target with no canonical adoption and no click recovery.
8. **404s with backlinks.** pages.status_code = 404 joined to page_backlinks.backlinks (run pull_backlinks first) → run_audit surfaces backlinks-to-404; fix_finding generates the 301 that recovers the equity.
9. **Competitor topic gap.** topic_gaps (bounded + cached: competitor ranked_keywords minus your GSC queries and page titles/H1s, clustered and scored) — or do it manually with ranked_keywords per competitor when you want the raw rows.

## Novel combinations (nothing else surfaces these)

- **Crawl budget vs equity:** url_inspection.last_crawl_time × pages.ipr — your highest-iPR pages should be recrawled often; a high-iPR page Google rarely revisits is a freshness/priority problem (and vice versa: junk crawled daily = wasted budget).
- **AIO text vs your content:** the ai_overview items in a SERP call (related_terms' underlying serpOrganic) × pages.body_chunks — is the text Google quotes actually on your page, and in one extractable chunk?
- **Crawl-to-first-impression latency:** url_inspection.last_crawl_time vs the first date a page appears in search_analytics — how fast does Google turn a crawl into impressions, per template? Slow templates have an indexing-pipeline problem.
- **Crawled-as vs response times:** url_inspection.crawled_as (mobile/desktop agent) × pages.response_time_ms — slow responses specifically on the agent Google uses against you.

Plan the join first (url_key / query / domain), state the grain of each side, then run the fewest paid calls that answer it.`;

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
- **detect_changes** — what changed since the last crawl (status, canonical, noindex, title, schema), severity-ranked — the regression monitor. _"Detect changes on example.com"_
- **check_agent_readiness** — is your site ready for AI agents? Scores llms.txt / agents.md / AI-bot rules / Content Signals / MCP server card / Agent Skills / API Catalog / OAuth signals (0–100 + level) with copy-paste fixes. _"Check agent readiness for example.com"_

## 4. Backlinks, keywords & competitive (DataForSEO, on-demand, cached 20 days)
- **pull_backlinks** — backlink profile + per-page counts + live status → unlocks **backlinks-to-404** (recover lost equity), top-linked pages, true orphans. _"Pull backlinks for example.com"_
- **keyword_volume / related_terms** — volume/CPC, and People-Also-Ask + related searches. _"Search volume for [\\"best widgets\\"]"_
- **search_intent** — informational/navigational/commercial/transactional per keyword → spot intent mismatch behind low CTR. _"Classify intent for [\\"buy running shoes\\", \\"how to clean shoes\\"]"_
- **page_lighthouse** — lab Core Web Vitals + opportunities for one URL (~20–120s). _"Run Lighthouse on https://example.com/slow-page"_
- **competitors_domain** — domains competing for your organic keywords. _"Find competitors for example.com in the UK"_
- **page_intersection** — keywords competitor pages rank for but yours doesn’t (content gap). _"Content gap: competitorUrls [\\"https://rival.com/guide\\"], excludePages [\\"https://example.com/guide\\"]"_
- **domain_visibility** — monthly ranking-keyword distribution + ETV trend for ANY domain/subdomain (Semrush-style organic overview). _"Show visibility over time for competitor.com"_
- **top_pages** — a domain's top organic pages by estimated traffic. _"Top pages on competitor.com"_
- **ranked_keywords** — keywords a domain / subdomain / URL / subfolder ranks for (+ difficulty, intent, SERP features). _"What does competitor.com/blog/ rank for?"_ · \`scope:url|folder\` · \`aioOnly:true\` = keywords where the target is cited in AI Overviews
- **topic_gaps** — what related topics should this site cover to be expert in its space: competitor keyword footprints minus everything you already rank or have a page for, clustered into ranked topics with volumes, the owning competitor and your nearest existing page. _"What topics should example.com cover? Compare against rival.com"_

## 5. Templates & opportunities
- **list_templates** — cluster pages into templates (one fix → N pages) with a representative exemplar. _"List page templates for example.com"_
- **suggest_pages** — new-page ideas grounded in real GSC demand, minus what you already cover. _"Suggest new pages for example.com"_
- **resolve_entities** — map pages to Wikidata entities → unlocks entity-internal-link-gap (judgement). _"Resolve entities for example.com"_

## 6. Reports & dashboard
- **get_dashboard** — interactive dashboard (renders in chat). _"Show the dashboard for example.com"_
- **export_report** — self-contained shareable HTML to send a client. _"Export the report for example.com"_

## 7. Utilities
- **data_location** — where DBs are stored (set with a path). · **normalize_url** — the join key for a URL.

_Tip: first time on a property → \`refresh_property\` then \`run_audit\`._
_Composing your own analysis? Call \`composition_cookbook\` first — the data-surface map (grain + join keys per source) and worked multi-source recipes._`;

export function createServer(): { server: McpServer; run: () => Promise<void> } {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
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
    'composition_cookbook',
    {
      title: 'Composition cookbook (data-surface map + recipes)',
      description: 'The full data-surface map (every source: grain, dimensions, join keys, freshness, cost) plus worked multi-source recipes and novel combinations, in this server\'s actual tool and table names. Static — no API calls, no cost. Call this BEFORE planning any complex question that spans more than one data source.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: COOKBOOK_TEXT }], structuredContent: { version: SERVER_VERSION } }),
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
        // Persist an ABSOLUTE path — a relative one resolves against the host process's
        // cwd, which differs across Claude Desktop launches, so DBs would "disappear".
        newPath = path.resolve(newPath);
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
        content: [{ type: 'text', text: buildAuditMarkdown(result, siteUrl) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'query_audit',
    {
      title: 'Run one audit check',
      description: 'Run a single named check (see list_checks) and return its affected URLs + evidence. Grain: finding per URL with evidence JSON. Joins: url_key across all sources.',
      inputSchema: { siteUrl: z.string(), check: z.string(), limit: z.number().int().min(1).max(1000).optional() },
    },
    async ({ siteUrl, check, limit }) => {
      const r = runSingleCheck(dataDir(), siteUrl, check, limit);
      // Hosts cap the model-facing result (~60k chars). On evidence-heavy checks a large
      // `limit` can blow that ceiling and error the whole call — trim findings (keeping the
      // true total) instead of failing. Same guard pattern as detect_changes.
      let sc: Record<string, unknown> = { ...r, findingsTotal: r.findings.length };
      let findings = r.findings;
      while (findings.length > 25 && JSON.stringify({ ...sc, findings }).length > 45000) {
        findings = findings.slice(0, Math.floor(findings.length / 2));
      }
      sc = { ...sc, findings, findingsReturned: findings.length };
      return {
        content: [{ type: 'text', text: `${check}: ${r.findings.length} findings${findings.length < r.findings.length ? ` (${findings.length} returned — result trimmed to fit the token cap; use a smaller limit for paging)` : ''}` }],
        structuredContent: sc,
      };
    },
  );

  server.registerTool(
    'score_passages',
    {
      title: 'Score passage relevance (AI-search readiness)',
      description: 'Run a local cross-encoder reranker (ms-marco-MiniLM-L-6-v2, downloaded once to a cache, no Python) over each ranking page\'s heading chunks against its top Search Console query, and persist the single best-passage relevance score. It SCORES relevance (a classifier — it cannot hallucinate). Powers the `weak-passage-answer` check — the "RAG snippetability" test: does any passage confidently answer the query, the way AI/passage search re-ranks? On-demand + ML-heavy (~0.6s/page), bounded to pages that already rank. `limit` caps pages (highest-impression first); `minImpressions` sets the floor (default 50). First run downloads ~25MB. Re-run after a re-crawl.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(1).max(2000).optional(), minImpressions: z.number().int().min(0).optional() },
    },
    async ({ siteUrl, limit, minImpressions }) => {
      const r = await scoreSitePassages(dataDir(), siteUrl, { limit, minImpressions });
      const lines = r.weakest.slice(0, 15).map(w => `  ${w.score}  ${w.url.replace(/^https?:\/\/[^/]+/, '')} · "${w.query}"`).join('\n');
      return {
        content: [{ type: 'text', text: `Scored ${r.scored} ranking pages; ${r.flagged} have no strongly-relevant passage (score < 3) — run_audit surfaces them as weak-passage-answer.${lines ? `\n\nWeakest:\n${lines}` : ''}` }],
        structuredContent: r as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'draft_content',
    {
      title: 'Draft a grounded fix in the author\'s own voice',
      description: 'Assemble a GROUNDED writing brief for a page so YOU (the assistant) can draft the fix — no bundled LLM. Returns the ranking-query gap, the page\'s OWN passages as voice exemplars (match tone/pace/lexicon), and the most query-relevant existing passages (selected by the reranker) as facts to ground in. Use it on a weak-passage-answer / not-front-loaded page to write a self-contained answer passage in the site\'s voice, inventing nothing. Omit urlKey to target the weakest-scoring page. Needs body_chunks (+ score_passages for the gap).',
      inputSchema: { siteUrl: z.string(), urlKey: z.string().optional() },
    },
    async ({ siteUrl, urlKey }) => {
      const r = await buildDraftBrief(dataDir(), siteUrl, urlKey);
      if ('error' in r) return { content: [{ type: 'text', text: r.error }], structuredContent: r };
      const voice = r.voice.map((v, i) => `  [V${i + 1}${v.heading ? ` · ${v.heading}` : ''}] ${v.text}`).join('\n');
      const facts = r.facts.map((f, i) => `  [F${i + 1} · rel ${f.relevance}${f.heading ? ` · ${f.heading}` : ''}] ${f.text}`).join('\n');
      const text = `WRITING BRIEF — ${r.url}\nTarget query: “${r.topQuery ?? '(unknown)'}”\nGap: ${r.gap}\n\nTASK\n${r.brief}\n\nVOICE (match this — the page's own writing):\n${voice || '  (no substantial passages)'}\n\nFACTS (ground in these — the page's most query-relevant content; invent nothing beyond them):\n${facts || '  (none)'}`;
      return { content: [{ type: 'text', text }], structuredContent: r as unknown as Record<string, unknown> };
    },
  );

  // detect_changes — change-detection / drift: what changed on the site since the last crawl.
  server.registerTool(
    'detect_changes',
    {
      title: 'Detect changes since the last crawl',
      description: 'Compare the two most recent crawls and report what changed per URL — status code, indexability, canonical, robots/noindex, title, meta, H1, schema, large content swings — each classified by severity (critical → info). This is the monitor: run refresh_property on different days to build history, then this surfaces regressions (a page that went noindex, a canonical that flipped, a 200 that became a 404). Needs at least two crawls.',
      inputSchema: { siteUrl: z.string(), limit: z.number().int().min(1).max(500).optional() },
    },
    async ({ siteUrl, limit }) => {
      const adb = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        const d = diffLatest(adb.db);
        // Cap the changes array in structuredContent to `limit` — the full diff can be tens of
        // thousands of rows (e.g. a crawl-methodology change) and blow the MCP token ceiling. The
        // summary keeps the TRUE totals; markdown is already limited.
        const lim = limit ?? 50;
        const sc = { ...d, changes: d.changes.slice(0, lim), changesReturned: Math.min(lim, d.changes.length), changesTotal: d.changes.length };
        return {
          content: [{ type: 'text', text: buildDriftMarkdown(d, siteUrl, lim) }],
          structuredContent: sc as unknown as Record<string, unknown>,
        };
      } finally { adb.close(); }
    },
  );

  // check_agent_readiness — is the site ready for AI agents? (the agentic-SEO / GEO frontier)
  server.registerTool(
    'check_agent_readiness',
    {
      title: 'Check agent readiness (AI-agent / GEO signals)',
      description: 'Probe a site for AI-agent readiness — the signals agents use to discover and use it: robots.txt AI-bot rules + Content Signals, sitemap, Link headers, llms.txt, agents.md, Markdown content negotiation, Web Bot Auth, MCP server card, Agent Skills, API Catalog, OAuth discovery. Returns a 0–100 score, a level (Basic web presence → Agent-native), and a per-check checklist with copy-paste fixes. Live HTTP probes of the property origin (no crawl/GSC needed). Modelled on Cloudflare\'s isitagentready.com.',
      inputSchema: { siteUrl: z.string() },
    },
    async ({ siteUrl }) => {
      const r = await checkAgentReadiness(siteUrl);
      // Persist so the dashboard/export can show it (live probe, not crawl-derived).
      try {
        const adb = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
        try {
          adb.db.prepare(`INSERT INTO agent_readiness (origin,score,level,checks,by_category,checked_at) VALUES (?,?,?,?,?,datetime('now'))
            ON CONFLICT(origin) DO UPDATE SET score=excluded.score, level=excluded.level, checks=excluded.checks, by_category=excluded.by_category, checked_at=excluded.checked_at`)
            .run(r.origin, r.score, r.level, JSON.stringify(r.checks), JSON.stringify(r.byCategory));
        } finally { adb.close(); }
      } catch { /* persistence is best-effort */ }
      return {
        content: [{ type: 'text', text: buildAgentReadinessMarkdown(r) }],
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
          case 'redirect-chain': {
            // The finding's url_key IS the chain's final page — its row holds the recorded
            // hops. Collapse each hop straight to the final URL; never fuzzy-match here.
            const page = db.db.prepare('SELECT url, redirects FROM pages WHERE url_key = ?').get(affectedKey) as
              | { url: string; redirects: string | null } | undefined;
            let hops: { from: string; to: string }[] = [];
            try { hops = page?.redirects ? JSON.parse(page.redirects) : []; } catch { /* malformed chain */ }
            kind = 'redirect';
            fix = page && hops.length
              ? { ...collapseChainRules(page.url, hops, redirectFormat ?? 'htaccess'), chain: hops }
              : { explanation: 'Redirect chain no longer present in the latest crawl — re-crawl and re-audit.' };
            break;
          }
          case 'internal-links-to-redirects': {
            // The flagged key is a redirect SOURCE; the crawler recorded where it actually
            // goes — find the chain containing it and use that real destination.
            const hostForm = hostFormForProperty(siteUrl) ?? 'asis';
            let knownTarget: string | null = null;
            for (const row of db.db.prepare(`SELECT url, redirects FROM pages WHERE redirects IS NOT NULL AND redirects <> ''`).iterate() as IterableIterator<{ url: string; redirects: string }>) {
              try {
                const hops = JSON.parse(row.redirects) as { from?: string }[];
                if (hops.some(h => h.from && urlKey(String(h.from), { hostForm }) === affectedKey)) { knownTarget = row.url; break; }
              } catch { /* skip malformed */ }
            }
            kind = 'redirect';
            fix = suggestRedirect(affectedKey ?? '', [], redirectFormat ?? 'htaccess', knownTarget);
            break;
          }
          case 'broken-internal-links': {
            // Genuinely dead target (4xx/5xx) — no recorded destination exists, so fall back
            // to token-overlap fuzzy matching against live pages.
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
            // Never fall back to the raw q — it was just rejected as unusable anchor text.
            const anchor = cleanQuery ?? page?.h1 ?? page?.title ?? '';
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
      description: 'Full refresh for a property in one async job: GSC sync → site crawl → URL inspection → DataForSEO rank history. Opens a live progress widget (phases + counts). Set gsc/crawl/inspect/ranks=false to run just part. GSC sync is "lite" (date×query×page) by default — set segments=true to also pull device/country breakdowns (much heavier on large sites). GSC sync is INCREMENTAL: the first sync pulls the window (default last 90 days; pass startDate to go deeper), later syncs only fetch new days — set full=true to force a full re-pull. Use this for "sync everything"; use the single-purpose tools to update just one thing.',
      inputSchema: {
        siteUrl: z.string(),
        gsc: z.boolean().optional(),
        crawl: z.boolean().optional(),
        inspect: z.boolean().optional(),
        ranks: z.boolean().optional(),
        segments: z.boolean().optional(),
        full: z.boolean().optional(),
        location: z.union([z.string(), z.number()]).optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        maxPages: z.number().int().min(1).max(50000).optional(),
        inspectLimit: z.number().int().min(1).max(500).optional(),
      },
      _meta: { ui: { resourceUri: SYNC_PROGRESS_URI } },
    },
    async ({ siteUrl, gsc: doGsc, crawl, inspect, ranks, segments, full, location, startDate, endDate, maxPages, inspectLimit }) => {
      const jobId = jobs.start('refresh', (update, signal) =>
        refresh.run(siteUrl, { gsc: doGsc, crawl, inspect, ranks, segments, full, location, startDate, endDate, maxPages, inspectLimit }, update, signal),
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
      description: 'Update just the GSC search-analytics history (async job — poll with check_sync_status). Incremental: the first sync pulls the range (default last 90 days; pass startDate to go deeper), later syncs only fetch new days — set full=true to force a full re-pull. Lite by default (date×query×page); set segments=true (or pass dimensions) to also pull device/country. For a full refresh use refresh_property. Grain: date × query × page. Joins: page_key (url_key) → crawl/inspection/backlinks; query → DataForSEO keyword tools.',
      inputSchema: {
        siteUrl: z.string(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        dimensions: z.array(z.string()).optional(),
        segments: z.boolean().optional(),
        full: z.boolean().optional(),
        searchType: z.enum(['web', 'discover', 'googleNews', 'image', 'video']).optional(),
      },
    },
    async ({ siteUrl, startDate, endDate, dimensions, segments, full, searchType }) => {
      const syncer = requireGsc(sync);
      const options: FetchOptions = {
        startDate: startDate ?? isoDaysAgo(90),
        endDate: endDate ?? isoDaysAgo(0),
        dimensions: dimensions ?? (segments ? FULL_DIMENSIONS : undefined),
        fullResync: full,
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
      description: 'Update just the GSC URL Inspection data (coverage, indexing, Google-vs-declared canonical, last crawl) for top URLs into url_inspection. Quota-limited — samples top pages by clicks. Async job. For a full refresh use refresh_property. Grain: one row per inspected URL. Joins: url_key → pages/GSC.',
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
      description: 'Update just the crawl: fetch the site into the local database (async job — poll with check_crawl_status). HTTP crawl; respects robots.txt; asset file-types are HEAD-only (no body download); internal-search / cart / wp-json / builder junk URLs are skipped by default. For a full refresh use refresh_property. excludePatterns adds extra URL regexes to skip (e.g. ["/author/","/tag/","/page/"]) to keep big crawls light. Grain: one row per url_key, latest crawl. Joins: url_key → GSC/inspection/backlinks.',
      inputSchema: {
        siteUrl: z.string(),
        maxPages: z.number().int().min(1).max(50000).optional(),
        maxDepth: z.number().int().min(1).max(20).optional(),
        maxConcurrency: z.number().int().min(1).max(16).optional(),
        delayMs: z.number().int().min(0).max(10000).optional(),
        userAgent: z.string().optional(),
        excludePatterns: z.array(z.string()).optional(),
      },
    },
    async ({ siteUrl, maxPages, maxDepth, maxConcurrency, delayMs, userAgent, excludePatterns }) => {
      const jobId = jobs.start('crawl', (update, signal) =>
        crawler.run(siteUrl, { maxPages, maxDepth, maxConcurrency, delayMs, userAgent, excludePatterns }, update, signal),
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
        const intentTip = r.proposals.length && r.proposals.every(p => !p.intent) ? `\n\nTip: run \`search_intent\` for this property first to rank these by search intent (currently unweighted).` : '';
        return {
          content: [{ type: 'text', text: r.proposals.length ? `${r.proposals.length} new-page opportunities (from ${r.consideredQueries} queries, ${r.afterDedup} after dedup):\n${top}${intentTip}` : `No new-page gaps found (${r.consideredQueries} queries considered). Needs synced GSC data.` }],
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

  // Strip any scheme/sc-domain:/path down to a bare host for Labs domain targets.
  // Always strips leading www. — Labs treats www.example.com as a subdomain, not the domain.
  const dfsHost = (t: string): string =>
    t.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').trim();
  // Cap a markdown table well under the ~40k model-facing ceiling: keep whole rows, note the rest.
  const capMdRows = (header: string, rows: string[], footer = '', maxChars = 30000): string => {
    let out = header;
    let used = 0;
    for (; used < rows.length; used++) {
      if (out.length + rows[used].length + 1 + footer.length > maxChars) break;
      out += '\n' + rows[used];
    }
    if (used < rows.length) out += `\n\n_+${rows.length - used} more rows (truncated for length — lower the limit or use structuredContent)._`;
    return out + footer;
  };
  const fmtNum = (v: unknown): string => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—';
  };

  server.registerTool(
    'domain_visibility',
    {
      title: 'Domain visibility over time (DataForSEO Labs)',
      description: 'Monthly organic visibility for ANY domain or subdomain — no Search Console access needed: ranking-keyword totals, position distribution (1–3 / 4–10 / 11–20 / 21–100) and estimated traffic value (ETV) per month, plus a trend verdict. The Semrush-style "organic overview / visibility over time" for you or a competitor. Labs call, cached 20 days. Pass location (name or code) for the right market. Grain: month × domain. Joins: domain → Labs/backlinks tools; period → rank_history.',
      inputSchema: {
        target: z.string().describe('Domain or subdomain, no scheme (e.g. example.com or blog.example.com)'),
        location: z.union([z.string(), z.number()]).optional(),
        languageName: z.string().optional(),
        months: z.number().int().min(1).max(24).optional(),
      },
    },
    async ({ target, location, languageName, months }) => {
      const client = requireDfs(dfs);
      const cleaned = dfsHost(target);
      const r = await client.historicalRankOverview(cleaned, location, 'en', languageName);
      const items: any[] = r.tasks[0]?.result?.[0]?.items ?? [];
      const n = (v: unknown): number => Number(v) || 0;
      // Guard year/month — a malformed item would emit an "undefined-NaN" period row.
      const series = items
        .filter((it: any) => Number.isInteger(it?.year) && Number.isInteger(it?.month))
        .map((it: any) => {
          const o = it.metrics?.organic ?? {};
          const pos_1_3 = n(o.pos_1) + n(o.pos_2_3);
          const pos_4_10 = n(o.pos_4_10);
          const pos_11_20 = n(o.pos_11_20);
          const pos_21_100 =
            n(o.pos_21_30) + n(o.pos_31_40) + n(o.pos_41_50) + n(o.pos_51_60) +
            n(o.pos_61_70) + n(o.pos_71_80) + n(o.pos_81_90) + n(o.pos_91_100);
          return {
            period: `${it.year}-${String(it.month).padStart(2, '0')}`,
            keywords: n(o.count) || (pos_1_3 + pos_4_10 + pos_11_20 + pos_21_100),
            pos_1_3, pos_4_10, pos_11_20, pos_21_100,
            etv: Math.round(n(o.etv) * 100) / 100,
            isNew: n(o.is_new), isLost: n(o.is_lost), isUp: n(o.is_up), isDown: n(o.is_down),
          };
        })
        .sort((a, b) => (a.period < b.period ? -1 : 1))
        .slice(-(months ?? 12));
      if (!series.length) {
        return {
          content: [{ type: 'text', text: `No historical rank data for ${cleaned} — check the target (bare domain/subdomain) and location.` }],
          structuredContent: { target: cleaned, series: [], cached: r.cached, cost: r.cost },
        };
      }
      const first = series[0];
      const last = series[series.length - 1];
      const delta = first.etv > 0 ? ((last.etv - first.etv) / first.etv) * 100 : (last.etv > 0 ? 100 : 0);
      const verdict =
        Math.abs(delta) < 10
          ? `flat (ETV ${fmtNum(first.etv)} → ${fmtNum(last.etv)}, ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% ${first.period} → ${last.period})`
          : `${delta > 0 ? 'rising' : 'declining'} (ETV ${fmtNum(first.etv)} → ${fmtNum(last.etv)}, ${delta > 0 ? '+' : ''}${delta.toFixed(0)}% ${first.period} → ${last.period})`;
      const header = `**${cleaned}** — organic visibility, last ${series.length} months. Trend: ${verdict}\n\n` +
        `| Period | Keywords | Pos 1–3 | Pos 4–10 | Pos 11–20 | Pos 21–100 | New | Lost | ETV |\n|---|---|---|---|---|---|---|---|---|`;
      const rows = series.map(s =>
        `| ${s.period} | ${fmtNum(s.keywords)} | ${fmtNum(s.pos_1_3)} | ${fmtNum(s.pos_4_10)} | ${fmtNum(s.pos_11_20)} | ${fmtNum(s.pos_21_100)} | ${fmtNum(s.isNew)} | ${fmtNum(s.isLost)} | ${fmtNum(s.etv)} |`,
      );
      const md = capMdRows(header, rows, `\n\n${r.cached ? 'Cached.' : `Live ($${r.cost.toFixed(4)}).`}`);
      return {
        content: [{ type: 'text', text: md }],
        structuredContent: { target: cleaned, months: series.length, verdict, series, cached: r.cached, cost: r.cost },
      };
    },
  );

  server.registerTool(
    'top_pages',
    {
      title: 'Top ranking pages on a domain (DataForSEO Labs)',
      description: 'The top organic pages of ANY domain or subdomain, ranked by estimated traffic value (ETV): page, ranking-keyword count, ETV and top-3 / top-10 keyword counts. The Semrush-style "top pages" view — works on competitors, no crawl or GSC needed. Labs call, cached 20 days. Pass location for the right market. Grain: page × domain. Joins: domain → Labs tools; URL → pages.url_key on your own property.',
      inputSchema: {
        target: z.string().describe('Domain or subdomain, no scheme'),
        location: z.union([z.string(), z.number()]).optional(),
        languageCode: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ target, location, languageCode, limit }) => {
      const client = requireDfs(dfs);
      const cleaned = dfsHost(target);
      const r = await client.relevantPages(cleaned, location, languageCode ?? 'en', limit ?? 25);
      const items: any[] = r.tasks[0]?.result?.[0]?.items ?? [];
      const n = (v: unknown): number => Number(v) || 0;
      const pages = items
        .map((it: any) => {
          const page = it.page_address ?? it.relative_url ?? null;
          if (!page) return null; // skip malformed rows
          const o = it.metrics?.organic ?? {};
          const top3 = n(o.pos_1) + n(o.pos_2_3);
          return {
            page,
            keywords: n(o.count),
            etv: Math.round(n(o.etv) * 100) / 100,
            top3,
            top10: top3 + n(o.pos_4_10),
          };
        })
        .filter((p): p is NonNullable<typeof p> => p != null)
        .sort((a, b) => b.etv - a.etv);
      if (!pages.length) {
        return {
          content: [{ type: 'text', text: `No ranking pages found for ${cleaned} — check the target and location.` }],
          structuredContent: { target: cleaned, pages: [], cached: r.cached, cost: r.cost },
        };
      }
      const header = `**${cleaned}** — top ${pages.length} pages by estimated organic traffic\n\n` +
        `| # | Page | Keywords | ETV | Top 3 | Top 10 |\n|---|---|---|---|---|---|`;
      const rows = pages.map((p, i) =>
        `| ${i + 1} | ${String(p.page).replace(/\|/g, '\\|')} | ${fmtNum(p.keywords)} | ${fmtNum(p.etv)} | ${fmtNum(p.top3)} | ${fmtNum(p.top10)} |`,
      );
      const md = capMdRows(header, rows, `\n\n${r.cached ? 'Cached.' : `Live ($${r.cost.toFixed(4)}).`}`);
      return {
        content: [{ type: 'text', text: md }],
        structuredContent: { target: cleaned, rowsTotal: pages.length, pages: pages.slice(0, 100), cached: r.cached, cost: r.cost },
      };
    },
  );

  server.registerTool(
    'ranked_keywords',
    {
      title: 'Ranked keywords for a domain / URL / folder (DataForSEO Labs)',
      description: 'Every keyword a target ranks for in Google organic — scope it to a whole domain, a subdomain, ONE page (scope:url with the full URL), or a subfolder (scope:folder + folder:"/blog/"). Returns keyword, position, search volume, ETV, the ranking URL, plus keyword difficulty, search intent and SERP features where the response carries them. Set aioOnly:true to list only keywords where the target is CITED as a source in Google AI Overviews (the "which keywords cite us in AIO" view). The Semrush-style "keywords a page or site ranks for" view — works on any site. Labs call, cached 20 days. Pass location for the right market. Grain: keyword × target. Joins: keyword → GSC search_analytics.query; URL → pages.url_key.',
      inputSchema: {
        target: z.string().describe('Domain, subdomain, or full URL (full URL required for scope:url)'),
        scope: z.enum(['domain', 'subdomain', 'url', 'folder']).optional(),
        folder: z.string().optional().describe('Required when scope is folder, e.g. "/blog/"'),
        location: z.union([z.string(), z.number()]).optional(),
        languageCode: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        orderBy: z.enum(['etv', 'volume', 'position']).optional(),
        aioOnly: z.boolean().optional().describe('Only keywords where the target is cited as an AI Overview source (Labs item_types:["ai_overview"])'),
      },
    },
    async ({ target, scope, folder, location, languageCode, limit, orderBy, aioOnly }) => {
      const client = requireDfs(dfs);
      const mode = scope ?? 'domain';
      if (mode === 'folder' && !folder?.trim()) throw new Error('scope:"folder" requires the `folder` input (e.g. "/blog/").');
      const dfsTarget = mode === 'url'
        ? (/^https?:\/\//i.test(target) ? target : `https://${target}`)
        : dfsHost(target);
      const order = orderBy === 'volume'
        ? 'keyword_data.keyword_info.search_volume,desc'
        : orderBy === 'position'
          ? 'ranked_serp_element.serp_item.rank_absolute,asc'
          : 'ranked_serp_element.serp_item.etv,desc';
      const folderPath = mode === 'folder'
        ? (folder!.trim().startsWith('/') ? folder!.trim() : '/' + folder!.trim())
        : null;
      const filters = folderPath
        ? [['ranked_serp_element.serp_item.relative_url', 'like', `${folderPath}%`]]
        : undefined;
      // aioOnly: Labs returns only rows where the target appears as an ai_overview_reference —
      // i.e. keywords where the domain is CITED as a source in the AI Overview (plan/data-utilisation.md 1a route 2).
      const itemTypes = aioOnly ? ['ai_overview'] : undefined;
      const r = await client.rankedKeywords(dfsTarget, location, languageCode ?? 'en', limit ?? 50, order, filters as unknown[] | undefined, itemTypes);
      const result = r.tasks[0]?.result?.[0] ?? {};
      const items: any[] = result.items ?? [];
      const kws = items
        .map((it: any) => {
          const kd = it.keyword_data ?? {};
          const serp = it.ranked_serp_element?.serp_item ?? {};
          if (!kd.keyword) return null; // skip malformed rows
          const serpFeatures: string[] | null = Array.isArray(kd.serp_info?.serp_item_types) ? kd.serp_info.serp_item_types : null;
          return {
            keyword: kd.keyword as string,
            position: Number(serp.rank_absolute) || null,
            searchVolume: kd.keyword_info?.search_volume ?? null,
            etv: serp.etv != null ? Math.round(Number(serp.etv) * 100) / 100 : null,
            url: serp.relative_url ?? serp.url ?? null,
            // Fields we already pay for but previously dropped (plan/data-utilisation.md Part 2 §4):
            keywordDifficulty: kd.keyword_properties?.keyword_difficulty ?? null,
            intent: kd.search_intent_info?.main_intent ?? null,
            serpFeatures,
            isFeaturedSnippet: serp.is_featured_snippet === true ? true : null,
          };
        })
        .filter((k): k is NonNullable<typeof k> => k != null);
      const scopeLabel = folderPath ? `${dfsTarget}${folderPath}*` : dfsTarget;
      if (!kws.length) {
        return {
          content: [{ type: 'text', text: aioOnly
            ? `No AI Overview citations found for ${scopeLabel} (scope: ${mode}) — the target isn't cited as an AIO source for any tracked keyword in this market.`
            : `No ranked keywords found for ${scopeLabel} (scope: ${mode}) — check the target, scope and location.` }],
          structuredContent: { target: dfsTarget, scope: mode, aioOnly: aioOnly ?? false, keywords: [], cached: r.cached, cost: r.cost },
        };
      }
      const totalCount = Number(result.total_count) || kws.length;
      const sumEtv = kws.reduce((s, k) => s + (k.etv ?? 0), 0);
      // Optional columns — only where the response actually carries the field (older cache entries won't).
      const hasKd = kws.some(k => k.keywordDifficulty != null);
      const hasIntent = kws.some(k => k.intent != null);
      const hasFeatures = kws.some(k => (k.serpFeatures && k.serpFeatures.length) || k.isFeaturedSnippet);
      const optHead = `${hasKd ? ' KD |' : ''}${hasIntent ? ' Intent |' : ''}${hasFeatures ? ' SERP features |' : ''}`;
      const optSep = `${hasKd ? '---|' : ''}${hasIntent ? '---|' : ''}${hasFeatures ? '---|' : ''}`;
      const header = `**${scopeLabel}** (scope: ${mode})${aioOnly ? ' — AI Overview citations only' : ''} — ${kws.length} of ${fmtNum(totalCount)} ${aioOnly ? 'citing keywords' : 'ranked keywords'}, ordered by ${orderBy ?? 'etv'}\n\n` +
        `| Keyword | Pos | Volume | ETV |${optHead} URL |\n|---|---|---|---|${optSep}---|`;
      const featCell = (k: typeof kws[number]): string => {
        const f = (k.serpFeatures ?? []).map(t => (t === 'featured_snippet' && k.isFeaturedSnippet ? 'featured_snippet (owned)' : t));
        if (k.isFeaturedSnippet && !f.some(t => t.startsWith('featured_snippet'))) f.unshift('featured_snippet (owned)');
        return f.length ? f.join(', ') : '—';
      };
      const rows = kws.map(k =>
        `| ${k.keyword.replace(/\|/g, '\\|')} | ${k.position ?? '—'} | ${fmtNum(k.searchVolume)} | ${fmtNum(k.etv)} |` +
        `${hasKd ? ` ${k.keywordDifficulty ?? '—'} |` : ''}${hasIntent ? ` ${k.intent ?? '—'} |` : ''}${hasFeatures ? ` ${featCell(k).replace(/\|/g, '\\|')} |` : ''}` +
        ` ${k.url ? String(k.url).replace(/\|/g, '\\|') : '—'} |`,
      );
      const md = capMdRows(header, rows,
        `\n\nTotals: ${fmtNum(totalCount)} keywords ${aioOnly ? 'citing the target in AI Overviews' : 'ranked'}, listed rows sum ${fmtNum(sumEtv)} ETV. ${r.cached ? 'Cached.' : `Live ($${r.cost.toFixed(4)}).`}`);
      return {
        content: [{ type: 'text', text: md }],
        structuredContent: { target: dfsTarget, scope: mode, aioOnly: aioOnly ?? false, totalCount, rowsTotal: kws.length, keywords: kws.slice(0, 100), cached: r.cached, cost: r.cost },
      };
    },
  );

  server.registerTool(
    'topic_gaps',
    {
      title: 'Topic gaps — what to cover to be expert in your space (Labs + GSC)',
      description: 'What related topics should this site cover to be seen as expert in its space? Pulls competitor keyword footprints (DataForSEO Labs ranked_keywords, ≤4 bounded + 20-day-cached calls), subtracts everything YOU already surface for (every GSC query with impressions) or already have a page about (title/H1/slug near-match), clusters the surviving gap keywords lexically, and scores each topic by summed search volume × how many competitors rank there. Each topic names the owning competitor with an example URL, your nearest existing page to build from, and (when resolve_entities has run) whether it sits beside entities you already cover. Pass competitors explicitly (max 3) or let it derive the top 2 from ranking overlap. Needs synced GSC data + DataForSEO credentials.',
      inputSchema: {
        siteUrl: z.string(),
        competitors: z.array(z.string()).max(3).optional().describe('Competitor domains (max 3, e.g. ["rival.com"]). Omitted → derived via competitors_domain'),
        location: z.union([z.string(), z.number()]).optional(),
        limit: z.number().int().min(1).max(50).optional().describe('Topics to return (default 15)'),
      },
    },
    async ({ siteUrl, competitors, location, limit }) => {
      if (!dfs) {
        return {
          content: [{ type: 'text', text: 'topic_gaps needs DataForSEO credentials (set DATAFORSEO_USERNAME / DATAFORSEO_PASSWORD in your MCP config). The rest of the audit works without them — this tool compares competitor keyword footprints, which requires DataForSEO Labs.' }],
          structuredContent: { error: 'no_dataforseo_credentials' },
        };
      }
      const db = new AuditDatabase(dbPathFor(dataDir(), siteUrl));
      try {
        const gscRows = (db.db.prepare('SELECT COUNT(*) n FROM search_analytics').get() as { n: number }).n;
        if (!gscRows) {
          return {
            content: [{ type: 'text', text: `No synced Search Console data for ${siteUrl} — run refresh_property (or sync_gsc) first. topic_gaps subtracts your real GSC footprint; without it every competitor keyword would look like a gap.` }],
            structuredContent: { error: 'no_gsc_data', siteUrl },
          };
        }
        const loc = location ?? db.getDfsLocation(siteUrl) ?? undefined;
        const ourHost = dfsHost(siteUrl);
        let totalCost = 0, liveCalls = 0, cachedCalls = 0;
        const tally = (r: { cached: boolean; cost: number }): void => { totalCost += r.cost; r.cached ? cachedCalls++ : liveCalls++; };

        // Competitors: explicit (≤3) or derived top-2 by keyword overlap. Total Labs
        // budget stays ≤4 calls: at most 1 discovery + at most 3 footprint pulls.
        let comps = [...new Set((competitors ?? []).map(dfsHost).filter(c => c && c !== ourHost))].slice(0, 3);
        let derived = false;
        if (!comps.length) {
          const r = await dfs.competitorsDomain(ourHost, loc, 'en', 10);
          tally(r);
          const items: any[] = r.tasks[0]?.result?.[0]?.items ?? [];
          comps = items
            .map((it: any) => String(it.domain ?? '').replace(/^www\./, ''))
            .filter(d => d && d !== ourHost)
            .slice(0, 2);
          derived = true;
          if (!comps.length) {
            return {
              content: [{ type: 'text', text: `No competitor domains derivable for ${ourHost} in this market — pass competitors explicitly (e.g. competitors:["rival.com"]).` }],
              structuredContent: { error: 'no_competitors', target: ourHost, cost: totalCost },
            };
          }
        }

        // One ranked_keywords pull per competitor (top 1000 rows by ETV — their money keywords).
        const rows: GapKeywordRow[] = [];
        const perCompetitor: Record<string, number> = {};
        for (const c of comps) {
          const r = await dfs.rankedKeywords(c, loc, 'en', 1000, 'ranked_serp_element.serp_item.etv,desc');
          tally(r);
          const items: any[] = r.tasks[0]?.result?.[0]?.items ?? [];
          for (const it of items) {
            const kd = it.keyword_data ?? {};
            const serp = it.ranked_serp_element?.serp_item ?? {};
            if (!kd.keyword) continue;
            rows.push({
              keyword: String(kd.keyword),
              searchVolume: kd.keyword_info?.search_volume ?? null,
              etv: serp.etv != null ? Number(serp.etv) : null,
              position: Number(serp.rank_absolute) || null,
              url: serp.url ?? (serp.relative_url ? `https://${c}${serp.relative_url}` : null),
              competitor: c,
            });
          }
          perCompetitor[c] = items.length;
        }

        const res = computeTopicGaps(db.db, rows, { limit: limit ?? 15 });
        const costLine = `Labs calls: ${liveCalls} live ($${totalCost.toFixed(4)}) + ${cachedCalls} cached${derived ? ' (competitors derived via competitors_domain)' : ''}.`;
        if (!res.clusters.length) {
          return {
            content: [{ type: 'text', text: `No topic gaps found: ${res.competitorKeywords} competitor keywords (${comps.join(', ')}) all fell inside your existing footprint (${res.ourQueryCount} GSC queries + page titles/H1s). Either you genuinely cover the space, or try different competitors. ${costLine}` }],
            structuredContent: { target: ourHost, competitors: comps, clustersTotal: 0, clusters: [], competitorKeywords: res.competitorKeywords, ourQueryCount: res.ourQueryCount, afterSubtraction: res.afterSubtraction, cost: totalCost, liveCalls, cachedCalls },
          };
        }

        const fmtVol = (v: number): string => v.toLocaleString('en-US');
        const sections = res.clusters.map((c, i) => {
          const shown = c.keywords.slice(0, 6);
          const more = c.keywords.length - shown.length;
          const kwLine = shown.map(k => `\`${k.keyword}\`${k.searchVolume ? ` (${fmtVol(k.searchVolume)})` : ''}`).join(', ') + (more > 0 ? ` — +${more} more keywords in this cluster` : '');
          return [
            `### ${i + 1}. ${c.headTerm} — ~${fmtVol(c.totalVolume)}/mo · ${c.competitorCoverage} competitor${c.competitorCoverage === 1 ? '' : 's'} · owned by ${c.ownedBy}`,
            `- Why: ${c.why}`,
            `- Keywords: ${kwLine}`,
            c.exampleUrl ? `- Competitor example: ${c.exampleUrl}` : null,
            c.nearestExistingPage ? `- Your nearest page: ${c.nearestExistingPage.title ?? '(untitled)'} — ${c.nearestExistingPage.url}` : `- Your nearest page: none found — this is greenfield for you`,
            c.entityNote ? `- Entity graph: ${c.entityNote}` : null,
          ].filter(Boolean).join('\n');
        });
        const md = `## Topic gaps for ${ourHost} vs ${comps.join(' + ')}\n\n` +
          `${res.competitorKeywords} distinct competitor keywords → ${res.afterSubtraction} survive subtraction of your footprint (${fmtVol(res.ourQueryCount)} GSC queries + page titles/H1s) → top ${res.clusters.length} topic clusters by volume × competitor coverage.\n\n` +
          sections.join('\n\n') +
          `\n\n_${costLine} Competitor rows: ${comps.map(c => `${c} ${perCompetitor[c] ?? 0}`).join(', ')}._`;

        // structuredContent: keyword lists capped at 10 per cluster with explicit totals
        // (host ~60k model-facing ceiling) — the counts always state the true size.
        const scClusters = res.clusters.map(c => ({
          ...c,
          keywords: c.keywords.slice(0, 10),
          keywordsTotal: c.keywords.length,
        }));
        return {
          content: [{ type: 'text', text: md }],
          structuredContent: {
            target: ourHost, competitors: comps, derivedCompetitors: derived,
            clustersTotal: res.clusters.length, clusters: scClusters,
            competitorKeywords: res.competitorKeywords, ourQueryCount: res.ourQueryCount, afterSubtraction: res.afterSubtraction,
            cost: totalCost, liveCalls, cachedCalls,
          },
        };
      } finally { db.close(); }
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
      description: 'Fetch the property’s backlink profile (overall summary — total backlinks, referring domains, Domain Rank, broken backlinks/pages, nofollow share — plus per-page backlink/referring-domain counts) into page_backlinks, and resolve each backlinked page’s live HTTP status so run_audit can flag external backlinks pointing to dead (4xx/5xx) pages. Paid DataForSEO call, 20-day cached, on-demand only. Async job — poll check_sync_status. Grain: one row per backlinked URL. Joins: url_key → pages/GSC; domain → Labs tools.',
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
