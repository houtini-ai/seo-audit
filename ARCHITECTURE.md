# Architecture and conventions

How seo-audit-console fits together, and the rules the code follows. This is the map for anyone reviewing or changing the code: where a thing lives, what joins to what, and the mistakes the conventions exist to prevent. The user-facing guides are in `README.md` and `manual/`; the release history is `CHANGELOG.md`.

The product in one line: **collect** (Google Search Console history, a crawl of the site, DataForSEO and a few free APIs) → **analyse** (deterministic checks, plus judgement checks behind a flag) → **recommend** in priority order, with every recommendation traceable to a finding and every finding to the bytes behind it.

## Layout

| Path | What it is |
|---|---|
| `src/index.ts`, `src/server.ts` | The MCP server (stdio). Every tool is registered in `server.ts`; `SERVER_VERSION` comes from `package.json` at runtime. |
| `src/runner.ts` | `seo-audit-runner`: the job runner, for the Docker MCP gateway (see Jobs). |
| `src/dashboard.ts` | `seo-audit-dashboard`: the standalone dashboard server (see Dashboard). |
| `src/core/` | Data collection, storage, clients, jobs, the web server and the dashboard payloads. |
| `src/audit/` | The checks, the audit engine, templates, opportunities, drift, schema validation. |
| `src/generators/` | Paste-ready fixes for findings (JSON-LD, redirect rules, internal links): `fix_finding`. |
| `src/ui/` | The dashboard UI: plain TypeScript + ECharts, built by Vite into single-file HTML under `dist/src/ui/`. |
| `scripts/probe-*.mjs` | The test suite: probes that exercise the compiled code (`dist/`) against fixtures, run by `npm test`. |
| `scripts/fixtures/` | Saved API responses (DataForSEO, portfolio) the probes replay. No probe calls a paid API. |

Compiled layout: `dist/core/…`, `dist/audit/…` from `tsc`; `dist/src/ui/*.html` from Vite.

## Storage

- **One SQLite database per property** (`src/core/AuditDatabase.ts`), WAL mode. `src/core/paths.ts` maps a property to its file: `sc-domain:x.com` and `https://x.com/` are different Search Console properties and get different files (URL-prefix properties carry their scheme in the file name). Legacy files that predate that rule are grandfathered when they name exactly one property; since the old URL-prefix name (`x.com.db`) is also the `sc-domain:x.com` stem, a Domain property never opens a file that names other properties and not it (it gets `x.com_domain.db`). Anything that needs a property's file (data_storage, delete-property) asks `dbPathFor`, never rebuilds the name.
- **The join key** is `url_key` (`src/core/url-key.ts`): GSC `page` and crawl `url` both normalise to it (https, www/apex unified per property, default ports, fragments and tracking parameters stripped, parameters sorted, trailing slash trimmed). Every cross-source question joins on it.
- **Search Console rows** have two shapes: totals in `search_analytics`, device/country segments in `search_analytics_segments`. Every reader goes through the views in `src/core/gscRows.ts`; mixing the shapes double-counts.
- `pages` keeps **only the latest crawl** (unique on `url_key`); history across crawls is `page_snapshots`, written by the crawler at the end of every crawl (`src/audit/drift.ts`).
- Shared files in the data dir: `_jobs.db` (the job registry), `_portfolio.db` (owned and watched domains), `dataforseo-cache.db`, `majestic-cache.db`, and `_dashboard.json` (hidden properties).
- Data dir: `SAC_DATA_DIR`, else the choice saved by `data_location`, else `~/Documents/seo-audit-console`.

## Collection

- **Search Console** (`GscClient.ts`, `GscSync.ts`): paginated, incremental (resumes from the latest stored day minus a 3-day lag buffer); `fullResync` re-pulls the window. A destructive wipe is deferred to the first successful write, so a failed sync never destroys the previous data.
- **Crawler** (`Crawler.ts`, `extract.ts`, `robots.ts`): hand-rolled fetch + cheerio, not Crawlee (Crawlee logs to stdout, which corrupts the MCP's stdio channel). Discovery is links + sitemap + GSC-known URLs. Redirects that leave the property are recorded, never followed into off-site pages. robots.txt follows RFC 9309 (the most specific user-agent group replaces `*`). Rate limits back off (AIMD, `rateLimit.ts`); a 429 is never stored as a page status. After the crawl: link graph (internal PageRank, click depth, in-degree, `linkGraph.ts`), the snapshot, outbound-link checks and site probes.
- **User agents** (`userAgents.ts`): the honest bot UA first; one Chrome retry only on a bot-block signature (403, 999, a WAF challenge), never on plain rate limiting. Every result records which UA produced it.
- **URL Inspection** (`UrlInspector.ts`), **CrUX** (`CruxClient.ts`), **DataForSEO** (`DataForSeoClient.ts`: serialised, cached 20 days by default), **Majestic** (`MajesticClient.ts`), **Wikidata** (`WikidataClient.ts`).
- **Live probes of the user's own site** (`probeUrls.ts`): the own-host guard applies at every redirect hop.

## Audit

- The checks live in `src/audit/checks.ts` and `checks-*.ts`; `list_checks` returns the live registry. `engine.ts` runs them and scores each finding by expected clicks per developer-hour: `(T × Y × C) / E` (traffic at stake from real GSC data, expected yield, certainty, effort).
- **D/N:** every check is deterministic (D: cites the bytes it saw) or judgement (N: a heuristic, only run with `includeJudgement`).
- The engine self-heals a crawl whose link graph was left empty, and snapshots a crawl that was never snapshotted.
- Trend checks guard on enough history (56 days; 90 for some) and measure to the finalised GSC end date (trailing unfinalised days trimmed, `gscFreshness.ts`).

## Jobs

- Long work is a **job**: the tool returns a job id at once and the client polls `check_sync_status`. Kinds are named in `src/core/jobKinds.ts` and run from their arguments alone, so the same job can run in the MCP process or in the runner.
- `JobManager.ts` keeps a durable registry (`_jobs.db`). Every job has a `scope` (the property's database file name), so "is a crawl live for this property" can be answered. Destructive operations check `possiblyRunning()` (stored state + heartbeat), never the derived display state.
- **External runner** (`SAC_JOB_RUNNER=external`): the MCP only queues; `seo-audit-runner` claims and runs. This exists because Docker MCP gateway workers are disposable.

## Dashboard

- **One dashboard for every domain** (`src/ui/dashboard.html` + `dashboard.ts` + `shell.ts`): a domain dropdown (All domains, the user's Search Console properties, watched domains, backlink-only databases), the property tabs, a Market tab and an AI visibility tab (the DataForSEO domain overview, `portfolio-domain.ts`), and sidebar actions.
- **Two delivery surfaces, one set of handlers** (`src/core/webHandlers.ts`): the MCP serves it on `127.0.0.1` (`serve_dashboard`, auto-started after data jobs and audits), and `seo-audit-dashboard` serves the same UI as a standalone process for Docker. `webServer.ts` answers only requests addressed to localhost and requires JSON for `POST /api/call`.
- **Actions from the dashboard are free only**: crawl, Search Console sync, URL inspection, audit, agent readiness, a live URL check, add/remove a watched domain, hide a property. Anything that spends DataForSEO money starts from chat, after a quote. Handlers refuse unknown properties (so no empty database is created) and a second job of a kind for the same property.
- The payload (`dashboardData.ts`) is built on a **worker thread** (`dashboardAsync.ts`) and cached for the default 28-day window; data jobs re-warm the cache when they finish.
- **In chat** the same UI is an MCP App (`get_dashboard`, `get_portfolio`). Its large data comes through app-only tools (`get_dashboard_data`, `list_findings`, `get_portfolio_data`, `get_domain_overview`), because a model-facing result is capped at roughly 60k characters.

## Conventions (the rules, and why)

- **Never write to stdout** in server code. It is the MCP JSON-RPC channel; use `console.error`.
- **Never claim a measurement that wasn't taken.** Unknown is `null`, never `false` or `0`. Every figure carries its window or scale. An AI Overview whose citations didn't load is "unknown", not "not cited".
- **No silent caps.** Anything bounded reports what it skipped.
- **Host matching is exact-or-subdomain, never substring** (`hostIsOneOf`). A substring match once routed `pimax.com` pages as `x.com`.
- **DataForSEO is never called in bulk.** On-demand only; cached; location per property. Paid work is quoted before it runs.
- **Owned-site crawling only**, polite, robots-respecting.
- **Secrets** are read from the environment (placeholder values count as unset, `secrets.ts`); `.secrets/`, `*.db`, `.env` and credentials files are gitignored.
- ES modules with `.js` import extensions; Node 20+.

## Testing

`npm test` builds the server and runs every probe. A probe is a plain Node script over `dist/` with `ok` / `FAIL` lines and a `N passed, M failed` summary. New behaviour gets a probe assertion that fails without the change. Probes use temporary data dirs and saved fixtures; none spends money or needs credentials.

## Releasing

Keep `package.json`, `server.json` (two fields) and `mcpb/manifest.json` on the same version, and retitle `[Unreleased]` in the changelog. npm is published by hand; the MCP registry entry is published only by the GitHub Action (`.github/workflows/publish-mcp.yml`, OIDC), never from a local login.
