# seo-audit-console

**Status:** Working MCP server (v0.1), in active build. Local dir `C:\MCP\seo-audit-mcp`; GitHub `houtini-ai/seo-audit-console` (private); npm name `@houtini/seo-audit-console`.

**Goal:** one MCP that merges Google Search Console history with site-crawl data (+ DataForSEO) into a deterministic, defensible, *prioritised* technical-SEO audit — replacing the commodity technical-audit deliverable. Consolidates `seo-crawler-mcp` + `better-search-console` (+ later parts of `geo-analyzer`).

> This repo began as a research/planning workspace (see `research/` and `plan/` — still the spec + background). It is now a code repo. The phased research framework in git history is **done**; `research/01–15` and `plan/*` remain the reference.

## The thesis (unchanged)
Collect (crawl + GSC + SERP) → analyse (deterministic checks + the merged GSC×crawl questions) → recommend in priority order with traceable evidence. The differentiator is **honesty about deterministic (D) vs judgement (N)** and **traceability: recommendation → finding → raw datapoint**.

## Architecture (built)
- `src/core/url-key.ts` — the **join key**. GSC `page` and crawl `url` both normalise to `url_key`/`page_key` (force https, unify www/apex per property, strip default ports/fragments/tracking params, sort params, trim trailing slash). Everything joins on it.
- `src/core/AuditDatabase.ts` — one SQLite DB per property: `search_analytics` (GSC), `crawl_metadata`/`pages`/`links`/`errors` (crawl), `url_inspection`, `rank_history`, `audit_runs`/`findings`. WAL + `synchronous=NORMAL` + FKs.
- `src/core/GscClient.ts` + `GscSync.ts` — GSC API + streamed sync (lifted from better-search-console), writes `page_key`.
- `src/core/UrlInspector.ts` — GSC URL Inspection (coverage, google-vs-user canonical, last-crawl) → `url_inspection`.
- `src/core/Crawler.ts` + `extract.ts` + `robots.ts` — **self-contained fetch+cheerio crawler (NOT Crawlee** — Crawlee logs to stdout and corrupts MCP stdio). Async; captures redirect chains; batched writes; robots-polite; computes in-degree.
- `src/core/DataForSeoClient.ts` — Basic-auth client (api.dataforseo.com). **Single-worker serialised** + **20-day SQLite cache**. Location per property. On-demand only.
- `src/core/RankTracker.ts` — DataForSEO `historical_rank_overview` → `rank_history` (the over-time sequence; reconciled with GSC dates in `dashboardData`).
- `src/core/JobManager.ts` — generic detached job registry (return-jobId-then-poll).
- `src/core/Refresh.ts` — orchestrates `gsc → crawl → inspect → ranks` (each skippable).
- `src/audit/checks.ts` + `engine.ts` — **37 checks** (schema-validate: invalid-schema, missing-required-fields, schema-value-errors, forbidden-schema; extractor: image-alt, canonical-relative, multiple-canonical, images-missing-dimensions/CLS, heading-hierarchy, mixed-content, meta-nofollow, missing-social-tags; merged crawl×GSC: ghost-pages, title-missing-top-query; link-graph: deep-pages (body-only click depth), underlinked-high-demand (low iPR × high GSC impressions); backlinks: backlinks-to-404, orphan-no-links — the "expert questions" that need both datasets);
- `src/core/Backlinks.ts` — on-demand DataForSEO backlink profile (summary + per-page counts → `page_backlinks` table) with live HTTP status for 404 detection. **Needs the DataForSEO *Backlinks* subscription** (separate from SERP/Keywords/Labs — a 40204 means it's not activated; surfaced clearly). `pull_backlinks` tool, 20-day cached, on-demand only.
- `src/core/linkGraph.ts` — post-crawl **internal PageRank (iPR, 0–100 log-normalised, nav/footer ×0.2)** + **body-only click_depth** from the homepage, written to `pages.ipr`/`pages.click_depth`. Powers deep-pages, underlinked-high-demand, and the iPR-ranked donor suggestions in `fix_finding`. scored `P = (severityW × certainty × log10(traffic value)) / effort`; persisted to `findings`. `src/audit/schema-validate.ts` holds the maintained Google Rich-Results required-field map. `extract.ts` is HTTP-only (no JS render — that's the deferred render tier, #7).
- `src/core/dashboardData.ts` — builds the dashboard payload (summary, rank trend, distribution, striking-distance, page-performance categorised, keyword movement, device/country, rank history + GSC↔DFS date reconciliation, latest findings).
- `src/ui/` — MCP-App dashboard (ext-apps + houtini `tokens.css` + **ECharts**, Vite single-file). Findings treemap + ranked table + 6 charts + report tables + CSV export.
- `src/server.ts` / `index.ts` — `McpServer`, stdio, `SERVER_VERSION` derived from `package.json`.

## Conventions (hard rules — learned the hard way)
- ES modules, `.js` extensions in imports. Node ≥ 20.
- **Never `console.log`** — MCP speaks JSON-RPC over stdio; use `console.error` for debug.
- **`SERVER_VERSION` is derived from `package.json` at runtime** — never hardcode (it drifted before). Keep `server.json` version in sync with `package.json`.
- **No Crawlee** (stdio corruption); the crawler is hand-rolled and stdio-safe.
- **Long ops are async jobs** (crawl, sync, inspect, ranks) — never block the MCP tool call past the ~60s ceiling. Return a jobId; poll `check_sync_status`/`check_crawl_status`.
- **DataForSEO: never bulk.** Per-keyword data is on-demand (click/explicit list); one `historical_rank_overview` per refresh. 20-day cache; location per property (`"Australia"`, `"United Kingdom"`, code). Our client calls the API directly — `ENABLED_MODULES` only gates the *official* DataForSEO MCP, not us.
- **Secrets** live in `.secrets/` (gitignored) — also `.claude/`, `*.db`, `gsc-access-*.json`, `.env`. Never commit secret values; read creds from env.
- **D/N honesty:** every finding labels D (deterministic, cite bytes) or N (judgement, gated behind `includeJudgement`).
- Owned-site crawling only; polite (≤ a few rps, respect robots, identifiable UA).

## Build / run
- `npm run build` = `build:server` (tsc → `dist/`) + `build:ui` (Vite single-file → `dist/src/ui/dashboard.html`).
- Probes (outside the MCP): `npm run probe:crawl <url>`, `npm run probe:gsc <property> <url>` — diff live API responses vs what we store.
- Env: `GOOGLE_APPLICATION_CREDENTIALS` (required), `SAC_DATA_DIR` (optional), `DATAFORSEO_USERNAME`/`PASSWORD`, `DATAFORSEO_CACHE_DAYS`. Tools degrade gracefully when a credential is absent.
- Data dir resolution: `SAC_DATA_DIR` env > persisted choice (`~/.seo-audit-console.json`, set via the `data_location` tool) > **`~/Documents/seo-audit-console`** default. Crawls/GSC always fetch fresh (no-cache); the only cache is DataForSEO (20-day, non-page data).
- Not yet registered in Claude Desktop — see `plan/roadmap.md` for the deploy step.

## Tools (current)
`refresh_property` (sync everything; `segments` opt-in for device/country) · `sync_gsc` · `start_crawl` · `inspect_urls` · `track_ranks` · `check_sync_status` · `check_crawl_status` · `list_properties` · `run_audit` · `query_audit` · `fix_finding` (finding→fix moat) · `list_checks` · `seo_audit_help` (overview + example prompts) · `data_location` (get/set data dir) · `keyword_volume` · `related_terms` · `pull_backlinks` (DataForSEO; needs Backlinks subscription) · `normalize_url` · `get_dashboard` (App UI) · `get_dashboard_data` (app-only) · `export_report` (shareable HTML).

**MCP App large-data pattern (important):** a host caps the *model-facing* tool result ("exceeds maximum allowed tokens" at ~60k chars). So `get_dashboard` returns only `{siteUrl}` + a short summary, and the widget fetches its full (~73k) dataset itself via `app.callServerTool('get_dashboard_data')` — an app-only tool (`_meta.ui.visibility:['app']`) whose result routes to the iframe, bypassing the model token cap (confirmed via ext-apps docs + Gemini). This is why an oversized `get_dashboard` previously failed to render while BSC's small one did. `sync-progress` uses the same callServerTool pattern.

## What's built vs deferred
**Built:** data layer (GSC + crawl + URL inspection + DataForSEO, located/cached/on-demand), 30-check scored engine (incl. schema-validate + extractor checks), agency-grade dashboard (findings + report sections + CSV export), date reconciliation, **finding→fix generators (the moat)** — `src/generators/` (JSON-LD / 301 redirect rules / internal-link suggestions), wired via the `fix_finding` tool. Dry-run: returns artifacts, never writes to the user's site.
**Deferred (roadmap):** robots-sitemap reconcile, register in Claude Desktop + live verify, CWV ingestion, render/JS-SEO tier, log analysis, ecommerce vertical. See `plan/roadmap.md` (feasibility-checked sequence) and `plan/open-questions.md`.

## Working principles
- Sources or it didn't happen (research/) ; cite file:line for code claims.
- Determinism is a feature — gate N behind a flag, cite evidence.
- One Gemini/Houtini-LM call at a time (parallel calls queue + stack timeouts).
- Compile → smoke-test (live where it matters) → commit → push, one slice at a time.

## Quick references
- House conventions for Houtini MCPs: `C:\MCP\CLAUDE.md` (badges, Glama, topics, naming).
- Source repos consolidated: `C:\MCP\seo-crawler-mcp\src`, `C:\MCP\better-search-console\src`.
- Owned test property: `simracingcockpit.gg`; data dir default `~/Documents/seo-audit-console`.
- Next sequence: `plan/roadmap.md`.
