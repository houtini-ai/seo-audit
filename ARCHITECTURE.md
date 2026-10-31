# Architecture and conventions

How seo-audit-console fits together, and the rules the code follows. This is the map for anyone reviewing or changing the code: where a thing lives, what joins to what, and the mistakes the conventions exist to prevent. The user-facing guides are in `README.md` and `manual/`; the release history is `CHANGELOG.md`.

The product in one line: **collect** (Google Search Console history, a crawl of the site, DataForSEO and a few free APIs) → **analyse** (deterministic checks, plus judgement checks behind a flag) → **recommend** in priority order, with every recommendation traceable to a finding and every finding to the bytes behind it.

## Layout

| Path | What it is |
|---|---|
| `src/index.ts`, `src/server.ts` | The MCP server (stdio). Every tool is registered in `server.ts`; `SERVER_VERSION` comes from `package.json` at runtime. The server instructions carry a one-line setup status computed at start (`src/core/setupStatus.ts`: which keys are set, local properties), and `seo_audit_help` leads with the full status; credentials errors point to it. |
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
- Shared files in the data dir: `_jobs.db` (the job registry), `_portfolio.db` (owned and watched domains), `dataforseo-cache.db`, `majestic-cache.db`, `_dashboard.json` (hidden properties) and `.dashboard-secret` (0600; proves a dashboard on the fixed port serves this data dir).
- Data dir: `SAC_DATA_DIR`, else the choice saved by `data_location`, else `~/Documents/seo-audit-console`.

## Collection

- **Search Console** (`GscClient.ts`, `GscSync.ts`): paginated, incremental (resumes from the latest stored day minus a 3-day lag buffer); `fullResync` re-pulls the window. A destructive wipe is deferred to the first successful write, so a failed sync never destroys the previous data.
- **Crawler** (`Crawler.ts`, `extract.ts`, `robots.ts`): hand-rolled fetch + cheerio, not Crawlee (Crawlee logs to stdout, which corrupts the MCP's stdio channel). Discovery is links + sitemap + GSC-known URLs. Redirects that leave the property are recorded, never followed: every hop is checked before it is requested (another host, a skip pattern or a robots-disallowed path stops the chain). robots.txt follows RFC 9309 (`robots.ts`): the group naming the crawler's product token exactly replaces `*`; patterns match path and query with `*` and `$`, longest wins, Allow wins a tie; a 4xx robots.txt means crawl everything, an unreachable one (5xx, 429, no response) stops the crawl before it writes anything. Site probes obey it too. Rate limits back off (AIMD, `rateLimit.ts`); a 429 is never stored as a page status. After the crawl: link graph (internal PageRank, click depth, in-degree, `linkGraph.ts`), the snapshot, outbound-link checks and site probes.
- **User agents** (`userAgents.ts`): the honest bot UA first; one Chrome retry only on a bot-block signature (403, 999, a WAF challenge), never on plain rate limiting. Every result records which UA produced it.
- **URL Inspection** (`UrlInspector.ts`), **CrUX** (`CruxClient.ts`), **DataForSEO** (`DataForSeoClient.ts`: serialised, cached 20 days by default), **Majestic** (`MajesticClient.ts`), **Wikidata** (`WikidataClient.ts`).
- **Live probes of the user's own site** (`probeUrls.ts`): the own-host guard applies at every redirect hop. `probe_urls` accepts only a property with local data as that own host.
- **Third-party URLs** (competitor pages from a SERP, outbound link targets, and their redirects) are fetched through `publicOnlyAgent` (`netGuard.ts`), which refuses to connect to a loopback, private, link-local or otherwise reserved address, checked on the address actually connected to (so a redirect or a DNS name can't reach 169.254.169.254 or 10.x). `render_pages` only renders URLs on the property's host. The user's own site is not guarded this way: a local or intranet property is legitimate.

## Audit

- The checks live in `src/audit/checks.ts` and `checks-*.ts`; `list_checks` returns the live registry. `engine.ts` runs them and scores each finding by expected clicks per developer-hour: `(T × Y × C) / E` (traffic at stake from real GSC data, expected yield, certainty, effort).
- **D/N:** every check is deterministic (D: cites the bytes it saw) or judgement (N: a heuristic, only run with `includeJudgement`).
- The engine self-heals a crawl whose link graph was left empty, and snapshots a crawl that was never snapshotted.
- Trend checks guard on enough history (56 days; 90 for some) and measure to the finalised GSC end date (trailing unfinalised days trimmed, `gscFreshness.ts`).

## Jobs

- Long work is a **job**: the tool returns a job id at once and the client polls `check_sync_status`. Kinds are named in `src/core/jobKinds.ts` and run from their arguments alone, so the same job can run in the MCP process or in the runner.
- `JobManager.ts` keeps a durable registry (`_jobs.db`). Every job has a `scope` (the property's database file name), so "is a crawl live for this property" can be answered. Destructive operations check `possiblyRunning()` (stored state + heartbeat), never the derived display state. One property runs one collection job at a time (crawl, refresh, sync, inspect, crux — the kinds that write the shared crawl / Search Console tables): the runner queues the second (`claimNext`), and in-process `submit()` refuses it (`COLLECTION_KINDS`, `liveForScope`), since two would wipe each other's `pages` mid-crawl. Other kinds write disjoint tables and may run alongside.
- **External runner** (`SAC_JOB_RUNNER=external`): the MCP only queues; `seo-audit-runner` claims and runs. This exists because Docker MCP gateway workers are disposable.

## Dashboard

- **One dashboard for every domain** (`src/ui/dashboard.html` + `dashboard.ts` + `shell.ts`): a domain dropdown (All domains, the user's Search Console properties, watched domains, backlink-only databases), the property tabs, a Market tab and an AI visibility tab (the DataForSEO domain overview, `portfolio-domain.ts`), and sidebar actions.
- **Two delivery surfaces, one set of handlers** (`src/core/webHandlers.ts`): the MCP serves it on `127.0.0.1` (`serve_dashboard`, auto-started after data jobs and audits), and `seo-audit-dashboard` serves the same UI as a standalone process for Docker. `webServer.ts` answers only requests addressed to localhost (a DNS-rebinding guard, not access control: bound to 0.0.0.0 it answers anyone who sends `Host: localhost`, so publish the port to 127.0.0.1 only), requires JSON and a localhost Origin for `POST /api/call`, looks handlers up as own properties only, and refuses to be framed. With `SAC_DASHBOARD_PORT` set and the port taken, the MCP adopts the dashboard already there only when it proves it serves the same data dir (`/api/identity`: an HMAC of a nonce with the data dir's `.dashboard-secret`), and re-checks it before handing the link out again.
- **Actions from the dashboard are free only**: crawl, Search Console sync, URL inspection, audit, agent readiness, a live URL check, add/remove a watched domain, hide a property, and Google News in Content research. Anything that spends DataForSEO money (related terms, search volume, the news / YouTube SERPs, Trends) starts from chat, after a quote: those handlers are not in `/api/call`. In chat (the MCP App) the same tabs call the paid tools through the host. Handlers refuse unknown properties (so no empty database is created) and a second job of a kind for the same property.
- The payload (`dashboardData.ts`) is built on a **worker thread** (`dashboardAsync.ts`) and cached for the default 28-day window; data jobs re-warm the cache when they finish.
- **In chat** the same UI is an MCP App (`get_dashboard`, `get_portfolio`). Its large data comes through app-only tools (`get_dashboard_data`, `list_findings`, `get_portfolio_data`, `get_domain_overview`), because a model-facing result is capped at roughly 60k characters.

## Conventions (the rules, and why)

- **Never write to stdout** in server code. It is the MCP JSON-RPC channel; use `console.error`.
- **Never claim a measurement that wasn't taken.** Unknown is `null`, never `false` or `0`. Every figure carries its window or scale. An AI Overview whose citations didn't load is "unknown", not "not cited". A prior period the synced history doesn't hold (it starts later, or the window is mostly gaps: `summaryData.priorHeld`) is null, never a row of zeros or a partial sum, so nothing reads as "up from none".
- **No silent caps.** Anything bounded reports what it skipped.
- **Bounded reads.** A fetched body (crawled page, sitemap, robots.txt, a competitor page) is read through `readCapped` (`src/core/cappedBody.ts`), never `arrayBuffer()` / `text()`: HTML up to 5 MB (extraction costs ~70x the size in memory), sitemaps up to 50 MB inflated, robots.txt 500 KiB. A cut body is recorded (`errors.error_type = 'body-truncated'`, `sitemaps.oversized`).
- **Host matching is exact-or-subdomain, never substring** (`hostIsOneOf`). A substring match once routed `pimax.com` pages as `x.com`.
- **DataForSEO is never called in bulk.** On-demand only; cached; location per property. Paid work is quoted before it runs.
- **Owned-site crawling only**, polite, robots-respecting.
- **A Search Console sync writes all or nothing** (`GscSync.ts`): every page is staged (a TEMP table on disk) and applied in one transaction only after the whole fetch succeeded, whether it is a wipe (another search type), a window replace, the lag-day replace or a plain upsert. A sync that fails or is cancelled part-way writes nothing and leaves `last_synced_at` alone, so it can neither destroy history nor leave days truncated behind the incremental resume point (latest stored day minus `LAG_DAYS`, 4).
- **Secrets** are read from the environment (placeholder values count as unset, `secrets.ts`); `.secrets/`, `*.db`, `.env` and credentials files are gitignored.
- ES modules with `.js` import extensions; Node 22+ (undici 8 and the Google client libraries require it; Node 20 is end-of-life).

## Testing

`npm test` builds the server and runs every probe. A probe is a plain Node script over `dist/` with `ok` / `FAIL` lines and a `N passed, M failed` summary. New behaviour gets a probe assertion that fails without the change. Probes use temporary data dirs and saved fixtures; none spends money or needs credentials.

## Releasing

Keep `package.json`, `server.json` (two fields) and `mcpb/manifest.json` on the same version, and retitle `[Unreleased]` in the changelog. npm is published by hand; the MCP registry entry is published only by the GitHub Action (`.github/workflows/publish-mcp.yml`, OIDC), never from a local login.
