# Changelog

All notable changes to **@houtini/seo-audit-console**. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); the check registry is the source of truth
(`list_checks` always returns the live list).

Each release is tagged `vX.Y.Z` on the release commit (tagging lapsed between 0.5.1 and 0.13.1; 0.6 to 0.13.0 have no tags). Release steps: bump
`package.json`, `server.json` (x2) and `mcpb/manifest.json`, retitle `[Unreleased]` here, commit as
`chore(release): X.Y.Z`, `git tag -a vX.Y.Z -m "X.Y.Z - <headline>"`, push the tag, `npm publish`.

## [Unreleased]

### Dependencies & packaging
- **No known vulnerabilities, and a much smaller install.** `npm audit` went from 6 findings (1 high, 5 moderate) to 0. The giant `googleapis` meta-package (clients for every Google API) is replaced by the two scoped packages Search Console actually uses, `@googleapis/searchconsole` and `google-auth-library`; `zod` moves to 4 (the high advisory's fix; the MCP SDK supports it); and `echarts` and the web fonts move to devDependencies (Vite inlines them into the dashboard HTML at build time, so the published package never installed them at runtime anyway). A production install drops from 208 packages / 862 MB to 180 / 588 MB.
- **Node 22 or newer.** `undici` 8 and the Google client libraries require it, and Node 20 reached end-of-life; `engines`, the MCPB manifest and the docs now say Node 22.

### Security (code review, PRs #87-#104)
- **The crawler never requests a redirect target off your site or in a robots-disallowed path.** It used to follow any `Location` header and check the final URL afterwards, so an open redirect could make it request an internal address.
- **Third-party URLs never reach a private or local address.** Competitor pages (content recon) and outbound link checks connect only to public addresses, checked at every redirect hop; `probe_urls` only accepts one of your properties as the own host, and `render_pages` only renders URLs on it.
- **No paid action is reachable from the browser dashboard.** Related terms, search volume, the YouTube and news SERPs and Trends were callable from the page with no quote; the browser's Content research now runs Google News (free), and the rest run from chat. The page also refuses foreign origins and framing.
- **A standing dashboard on `SAC_DASHBOARD_PORT` is adopted only when it proves it serves the same data dir** (any service answering on the port used to be adopted), and a dead one is no longer handed out.
- **Response bodies are read with a cap** (pages 5 MB, sitemaps 50 MB inflated, robots.txt 500 KiB): one huge page or gzip sitemap used to exhaust memory and take the server down.

### Changed
- **One dashboard for every domain.** The browser dashboard and the portfolio were two separate apps; they are now one. A domain dropdown at the top of the sidebar lists All domains (the domains table, and the landing page once there is more than one property), your Search Console properties, watched domains, and databases held for sites that aren't yours. A property's dashboard gains a **Market & AI** tab with its DataForSEO overview. `/portfolio` and `/portfolio/domain?d=` redirect. The sidebar carries the Houtini mark.

### Added
- **A fixed dashboard address on bare metal.** Run `seo-audit-dashboard` with `SAC_DASHBOARD_PORT` (say 8788) as a standing process and give the MCP the same `SAC_DASHBOARD_PORT`: when the port is taken by that dashboard, the MCP hands out its link instead of failing to start one, and never stops it. Every session then links to one stable URL.
- **Dashboard actions** (browser, free only): crawl, Search Console sync, URL inspection, run audit and agent readiness, with live job progress and Cancel. One job of a kind per property; unknown properties and paid job kinds are refused. The standalone dashboard queues jobs for the job runner when one is alive (it holds the credentials under the Docker gateway) and runs them itself otherwise. DataForSEO spending still starts only from chat, after a quote.
- **Watch a domain from the dashboard:** a form above the All domains table adds one (domain, group, country), and a row's Remove link stops watching it. Both are free.
- `scripts/probe-web-unified.mjs` (44 assertions): routes, the owned split, the action guards, hiding, findings paging and the worker build.
- **A working date range.** The top bar's window control (7, 28, 90 or 180 days against the same length before) drives the tiles, keyword and page tables, branded split, breakdowns and decay on every tab but the Summary, which keeps its fixed 28 days and says so. It's in the URL (`?days=90`). Only 28 days is cached.
- **AI visibility tab.** On every property: agent readiness, AI-crawler access in robots.txt and AI Overview presence (free, from your probes), beside DataForSEO LLM Mentions: mentions and AI search volume in Google AI Overviews and ChatGPT over 15 months, cited pages and co-cited sources. The overview's market half is its own **Market** tab. Perplexity, Gemini and AI Mode are labelled not measured.
- **Hide a property** (reversible, data kept): "Hide this property" in the dashboard sidebar, or `data_storage` `hide: {siteUrl}`. A hidden property leaves the dropdown and the portfolio; All domains lists it with a Show link. Stored in `_dashboard.json` in the data dir.
- **`check_sync_status` with no jobId** returns `counts` by state, `live` (running + queued) and compact `jobs[]` rows (id, type, state, scope) in structuredContent, and leads its text with the counts. A client that searched the text for "running" matched it inside an interrupted job's explanation.
- **Issues & fixes filters cover every finding.** The payload holds the top 50; a severity, area or check filter (and **Show more**) now pages through all matches via `list_findings` (an app-only tool for the in-chat widget, a web handler in the browser). Before, "High 386" listed nothing.

- **Dashboard design pass** (from a Google Stitch review of four views):
  - Sidebar actions: one primary **Run audit**, then Crawl / Sync GSC / Inspect / Agent; a live job is a card with a progress bar (a real percentage only while a crawl is fetching), finished jobs a one-line history.
  - The window is one joined control: 7d / 28d / 90d / 180d beside the end date. The Summary says "Summary: 28 days to ..."; Market and AI visibility say "Monthly DataForSEO data".
  - Menu counts: open critical issues (else high) on Issues & fixes, the agent-readiness score on AI visibility.
  - A non-zero critical chip in the Summary verdict reads as critical.
  - Issues & fixes: an expanded finding splits into **Evidence** and **Fix**, with **Copy fix** and **Verify live URL** (a free live probe of your own host, `verify_url`); by-area bars split by severity; "Show 100 more (N remaining)".
  - All domains: counts on the tabs, a totals line (measured clicks and estimated traffic, never mixed), **Sync now / Crawl now** on needs-attention reasons for owned sites, a primary Watch button.
  - AI visibility: AI crawlers as a two-column grid; co-cited sources as rows with a bar.

### Fixed
- **Docs and labels match the code:** the README intro says 143 checks (it still said 111); ETV is "estimated traffic volume", DataForSEO's own term, in the tool descriptions, manual and dashboard labels; backlink history is described as monthly everywhere (tool description, manual, dashboard hint, comments); the dashboard URL options are `&theme=` and `&redact=1` (the link already carries `?siteUrl=`); the portfolio page notes that its 0-100 Domain Rank and the Links tab's 0-1000 rank aren't comparable; `fix_finding`'s internal-link suggestions are described as they work (the five closest pages by URL tokens from the 80 with the most internal PageRank, PageRank breaking ties).
- **Printed docker commands are pinned and honest about the volume.** The `open_dashboard` container hint and the "no job runner" note now pin `@houtini/seo-audit-console@<this version>` (an unpinned npx could run a different release from the server and runner), and the dashboard hint uses `<your-data-volume>` with a note that a process inside the container can't see the volume's name, instead of a guessed `seo-audit-data`.
- **The dashboard sidecar logged every `docker stop` as an npm error.** It now exits 0 on SIGTERM / SIGINT, and its printed command adds `--init`.
- **The first dashboard load after a sync stalled the whole server.** The payload build (about 20 GROUP BY scans; 18 s cold on a 1.8 GB property) ran on the server's main thread, so every other request, the job-status poll included, queued behind it. It now runs on a worker thread (identical concurrent requests share one build), and while it runs `list_domains` answered in 34 ms. A data job, a dashboard-run audit or an agent-readiness check also rebuilds the cache in the background when it finishes, so the next load is instant, and a slow cold load now says what it's doing.
- **Sites you don't own counted as owned.** `pull_backlinks`, `link_intersect` and `track_ranks` create a database named by a bare domain (`rival.net`), and the portfolio counted every database as an owned domain, at the US location. Only Search Console property names (`sc-domain:` or a URL prefix) are owned now; the rest are listed as backlink data only.
- **Code review fixes (numbers, data and rules):** average position is impression-weighted on the dashboard (it was a plain mean); the dashboard reads the latest *completed* audit (a failed or running one read as health 100); a prior period your history doesn't cover shows "no prior" instead of a comparison with zero or a partial window, and year-on-year needs the prior-year window held; the health score counts pages past the 500 findings a check stores; a Search Console sync writes all or nothing (a failed or cancelled one used to leave days truncated, or wipe history on a search-type change); a Domain property never shares an older URL-prefix property's database file; default audits run every deterministic check (three were silently skipped); `position-slipping` compares the same page with a real baseline; robots.txt follows RFC 9309 (wildcards, query strings, exact user-agent tokens, and an unreachable robots.txt stops the crawl); a Cloudflare rate limit is no longer read as a bot wall; `scripts/probe-web-unified.mjs` is committed, so `npm test` runs on a clean clone.
- **Claude finds setup problems on its own:** the server instructions carry what's configured on this machine and say to run `seo_audit_help` first; `seo_audit_help` starts with *Setup on this machine*; credentials errors and an empty `list_properties` point to the fix.

## [0.17.0] — 2026-10-25

The portfolio: a domains table and domain overview on DataForSEO + Search Console. Also ships everything in 0.16.3, which was tagged but not published to npm.

### Added
- **The portfolio** (`manual/portfolio.md`): one table across owned properties (auto) and watched domains (competitors, prospects), plus a per-domain overview. It is the browser dashboard's landing page once there is more than one property (`/`, `/portfolio`), and `get_portfolio` in chat.
  - **Measured vs estimated is always labelled:** Search Console clicks (measured) sit beside DataForSEO estimates (organic and paid keywords and traffic for the row's country), referring domains (root), **DataForSEO Domain Rank** (0-100, never called Authority Score), **AI mentions** (Google AI Overviews + ChatGPT, monthly; ChatGPT US-only) and audit health.
  - **Change maths:** changes compare the last COMPLETE month (each series its own latest, since Labs history lags); the month in progress is hollow "to date". Empty cells name the reason. A de-noised "needs attention" rule list names its numbers.
  - **Domain overview:**
    - estimated and measured KPI blocks, and traffic share;
    - AI search per platform, with a rank x citation table and quadrant from content recon (unknown is never "no"), cited pages joined to crawl status and GSC clicks, and co-cited sources;
    - a traffic trend (estimated vs measured), five position bands, the search-results mix incl. AI Overview references, countries, backlinks new/lost;
    - top pages by traffic and by links, with our crawl status.
  - **Tools:** `portfolio` (list / add / remove / group / location, free), `refresh_portfolio` (quotes first; `confirm` runs a job and records actual spend), `schedule_portfolio_refresh` (two-step consent to a monthly budget cap; the atomic claim means two processes never run it twice; it skips with re-confirm if the cost grows 25%+), `get_portfolio` (App).
  - **DataForSEO:** new client methods for the bulk Backlinks endpoints, Labs bulk traffic / all-locations rank overview / ranked_keywords metrics, Backlinks domain_pages, and the LLM Mentions API. Request bodies were verified live and the raw responses are saved as test fixtures. Prices in the quote are the costs observed on live runs.
  - **Location:** an owned property with no saved DataForSEO location uses its country-code TLD (.com.au = Australia) before the US default.
  - **Live run (24 Oct 2026):** 8 owned domains on the weekly tier for $0.22; 2 on the monthly tier for $1.40.

### Fixed
- **RankTracker** and the portfolio share one property -> target derivation that strips `www.`, so both send the same body and share the cache. A www URL-prefix property re-fetches its rank history once.
- **`ranked_keywords`:** a code comment claimed `item_types` is rejected (40501). It is accepted, and the SERP-feature counts need it.
- **Backlinks history** is monthly, not daily (comments corrected). Its new/lost fields are referring domains, not main domains.

### Docs
- New `manual/portfolio.md`. The portfolio is now covered in the README (feature paragraph, manual index, tools table), `manual/tools.md`, `manual/dashboard.md` (the Domains landing page), `manual/dataforseo.md` (endpoints and live costs per tier), `manual/competitive.md` (the every-domain workflow), `manual/composition.md` (the `_portfolio.db` tables), `seo_audit_help`, and the server.json / .mcpb descriptions.

### Tests
- `scripts/probe-portfolio.mjs` (50 assertions, fixture-fed, no network), added to `npm test`.

## [0.16.3] — 2026-10-24

The Docker MCP gateway cold-start fix (#76) and a dependency security update.

### Fixed
- **Docker MCP gateway: every tool call took about 90 seconds (#76).** Following the README, a gateway user removed `longLived: true` once the job runner was in place and kept `npx` on `node:22-slim`. The gateway then started a fresh worker for every tool call, each one installing the package first, so even `seo_audit_help` took 88-108 s and timed out in Claude Code. The README and the getting-started manual now lead with an image that has the package preinstalled plus `longLived: true`, alongside the runner. The runner keeps jobs alive and `longLived` keeps the worker warm, so the two work together. Measured on a live gateway: 88-108 s per call before; 2 s for the first call on a connection and instant after, with a sync queued through the warm worker still claimed and finished by the runner. The doc's "a worker per client connection" was only true with `longLived`, and is corrected.
- **The server warns when it was started by `npx` inside a container.** One line on stderr at start-up, visible in the gateway's `docker logs`, pointing at the README section. It can't see the gateway's `longLived` setting, so it warns on what it can see: an `_npx` install path plus `/.dockerenv`. Claude Desktop and Claude Code (npx, no container) and a prebuilt image (global install) don't trigger it.
- The interrupted-job message no longer calls `longLived: true` an older stopgap; it says to keep it.

### Security
- `npm audit fix`: dependency advisories from 1 critical / 15 high / 4 moderate to 0 / 1 / 0 (lockfile only). The one remaining high is `zod` <4.6.6; the fix is the zod 3 → 4 major upgrade, which touches every tool schema and is left for a minor release.

### Tests
- `scripts/probe-startup-hints.mjs` (7 assertions), added to `npm test`.

## [0.16.2] — 2026-10-17

Fixes from the live 0.16.1 test on a 5.5 GB property.

### Fixed
- **Job tools reply at once.** `sync_gsc`, `start_crawl`, `sync_crux`, `refresh_property` and `data_storage check` return their job id before the job touches the database: the job body used to run in the microtask queue ahead of the tool's reply, so on the live property `sync_gsc` answered after 33.8 s and the gateway client timed out. The GSC search-type check reads the end rows of each table instead of scanning all of them (2.7 s on a warm 7.6M-row copy), and `sync_gsc`'s planned range is read on a read-only handle (two index-backed lookups). On a copy of that database the replies went from 2.7 s / 2.7 s / 1.5 s (`sync_gsc` / `refresh_property` / `sync_crux`, warm cache) to under 0.03 s.
- **`data_storage` row counts are cached** in `_storage-counts.json` beside the databases, keyed by the size and modification time of each database and its WAL, so a listing only recounts what changed (the counts were most of a 9.1 s cold first call).
- **No stale "two row shapes" banner after the GSC migration.** The Summary note about days stored in both all-country and per-country rows shows only while the storage is pending or migrating (counting the days not yet moved), never once migrated. The `nonbrand-decline-masked` evidence follows the same rule.
- **Regrouped findings are not "resolved".** A check whose finding grain changed between two audits is left out of that pair's opened / resolved / carried counts, with the note "accessibility findings regrouped in 0.16.1; not counted": the 0.16.1 accessibility roll-up had made the live Summary read "759 resolved since the last audit", 730 of them re-keyed findings. Runs record the grain in `audit_runs.check_ids` (`a11y-link-name@2`); earlier runs have it read from their findings. The verdict, the "What's broken" change column and the health chart agree.
- **"Accessibility", not "accessibility".** Every area label (Summary, Issues filters and accordions, the `run_audit` report) comes from one map, and an unlabelled category is capitalised rather than shown raw.
- **Country and device breakdowns explain an empty window.** When the 28-day window has no segment rows (per-country syncs stopped before it), the Search performance card says when the last segment sync ended and to run `sync_gsc` with `segments:true`, instead of disappearing. The payload carries `segmentsLastDate`, and the Summary's coverage footer gains a "Device & country" chip.

## [0.16.1] — 2026-10-17

Reliability fixes from the live 0.16.0 test.

### Upgrade notes
- **Re-crawl to get the accessibility roll-up.** The crawl now records which elements fail the a11y checks; pages crawled before 0.16.1 keep one finding per page until the next crawl.
- **Restart the MCP client after upgrading.** Clients cache the tool list when they connect, so new tools stay invisible until a restart.

### Fixed
- **Dashboard links under Docker.** Inside a container (Docker's `/.dockerenv`, Podman's `/run/.containerenv`, or a container cgroup) whose dashboard binds a random port without `SAC_DASHBOARD_BIND=0.0.0.0` + `SAC_DASHBOARD_PORT`, completed data jobs, `run_audit`, `open_dashboard` and `serve_dashboard` no longer present `http://127.0.0.1:<port>` as openable: they say the link only works inside the container and give the dashboard sidecar's `docker run` line, or `get_dashboard` in chat. Bare metal is unchanged.
- **`run_audit` reply size.** `top` is parsed objects (finding `id`, check, URL, priority, traffic, effort, trimmed evidence), 10 by default with a new `topLimit` argument up to 50; each check's title and fix appear once, in a `checks` map and once in the markdown; evidence lists are cut to 3 with a `<key>Total` count. On a copy of a 2,300-finding site the reply fell from 58,392 to 20,200 characters. `query_audit` is still the drill-down.
- **Priority calibration.** Asset findings (`image-oversized`, `image-legacy-format`, `static-asset-uncached`, `render-blocking-head-resources`, `broken-image`) and accessibility findings stake a tenth of the keyed page's clicks (`PAGE_EXPERIENCE_STAKE_SHARE`, recorded per finding as `effort.stakeShare`) instead of all of them, so an oversized image on the top page no longer outranks a high-severity CTR or traffic-decay finding on the same page. Ordering only; explained in [checks.md](manual/checks.md).
- **Accessibility template noise.** `a11y-link-name`, `a11y-button-name` and `a11y-duplicate-id` report one finding per set of shared elements that sit on the same pages (`scope: "template"`, with the page count, sample pages and the element selectors), plus one per page for its own extras. On the test site: 415 to 107, 415 to 1, and 13 to 13 (page-specific ids).
- **`data_storage` and backups.** Lists every `<db>.bak-*` backup per property with size and date (the GSC migration's marked), counts them in the total, and says they can be deleted once the migration or repair is confirmed; shows each property's GSC storage state (migrated, pending, migrating, or deferred with the reason, now recorded when a migration is refused for disk). The migration no longer leaves an empty `-wal` and a `-shm` beside its backup (it verified the copy on a read-only handle), and `data_storage` removes the ones 0.16.0 left.
- **Runner wording.** A cleanly stopped runner keeps its registry row, marked stopped, so a queued job's advice says "the last runner stopped at <time>" rather than "no runner has ever checked in to this data directory".
- **CrUX card alignment.** The distribution bars in the Crawl health CrUX card line up whatever the band badge says.
- The reranker no longer logs the expected `device 'dml' unavailable, falling back` off Windows.

### Docs
- README Docker section and getting-started: a fresh gateway worker waits about a minute for `npx` to install; pin `@houtini/seo-audit-console@<version>`, pre-warm a mounted npm cache once after an upgrade, or build a three-line image with the package preinstalled. Restart the MCP client after upgrading.

## [0.16.0] — 2026-10-17

### Upgrade notes
- **The first Search Console sync after upgrading migrates the GSC storage, once (#69).** Device and country rows move out of `search_analytics` into their own table, `search_analytics_segments`, on any database that held both shapes. Before it moves anything it checks free disk (room for the backup, plus half the database, plus 256 MB; without it the migration is deferred: the sync runs in the old layout with correct totals, says so, and migrates on a later sync once there's space) and writes an online backup beside the database, `<db>.bak-<stamp>`, **the same size as the database**: a 5 GB database leaves a 5 GB `.bak`. It then moves a batch of days per transaction and resumes on the next sync if interrupted; readers stay correct throughout. Afterwards run `data_storage` `prune` with `vacuum` to reclaim the freed pages (5.5 GB to 4.4 GB on the test copy), and delete the `.bak` yourself once you're satisfied. A database that only ever held one shape is marked done on first open, with no backup.
- **Docker MCP gateway users:** jobs can now run in a separate `seo-audit-runner` container (#66). Start the runner, then set `SAC_JOB_RUNNER=external` on the catalog entry and remove `longLived: true` ([README](README.md#docker-and-the-docker-mcp-gateway)). Without the variable nothing changes.
- **Placeholder keys now switch a tier off (#60).** A blank optional key, or leftover template text (`your-...`, `<...>`, `changeme`, `${...}`), counts as unset, with one line in the server log.

### Added
- **Summary tab, the new landing view (#59):** freshness, a templated verdict, headline tiles, 16 months of clicks, health per audit with opened/resolved issues, what's broken by area, "Do this first", changes since the last crawl, ranking mix, page movers, AI search and data coverage; works crawl-only, at phone width, in both themes and in redact mode.
- **Audit history (#48):** `audit_runs` stores the health score, the check set and the server version per run, past runs are backfilled where the crawl is unambiguous, and the payload carries `healthHistory` and `auditDeltas` (opened / resolved / carried between comparable audits).
- **CrUX field data, AI search bots, indexing alarm and non-brand decline (#63):** `sync_crux` (free, `CRUX_API_KEY`) stores real-user LCP, INP, CLS, FCP, TTFB, the LCP sub-parts and resource type for the origin and top pages, phone and desktop, with history; checks `crux-field-lcp` / `-inp` / `-cls`, `crux-regression`, `site-wide-indexing-alarm`, `snippet-restricted`, `ai-search-bot-blocked` and `nonbrand-decline-masked`; `refresh_property` runs CrUX when the key is set.
- **External job runner (#66):** the `seo-audit-runner` bin runs queued jobs from `_jobs.db` when the server has `SAC_JOB_RUNNER=external`, so gateway workers are disposable; a real `queued` state, no-runner advice with the `docker run` line, graceful stop, `SAC_RUNNER_CONCURRENCY`.
- **Redirect hygiene and ecommerce checks (#67):** `redirect-to-non-indexable`, `redirect-to-homepage`, `redirect-loop`, `temporary-redirect-with-equity`, `redirect-retired`, `product-gone-404` and `merchant-listing-incomplete`.
- **Cross-host canonicals, hreflang validation and asset checks (#70):** `canonical-cross-host`, four new hreflang checks, and six asset checks over the subresources every crawl now records (`page_resources`; `headResources:true` adds a header-only pass into `resource_assets`), with "not collected" reported instead of a pass when their data is missing.
- **Site probes and JS-render divergence (#71):** every crawl ends with up to five site probes (`siteProbes:false` skips them) for `soft-404-handling` and `host-variant-split`; `render_pages` records raw vs rendered canonical, title, robots and main-content words for `canonical-changed-by-js`, `title-changed-by-js`, `noindex-changed-by-js` and `hydration-content-loss`.
- **Crawl progress and the backlink profile (#53):** `check_crawl_status` reports the stage, pages vs `maxPages`, pages/sec and an ETA; `pull_backlinks` stores referring domains, anchors and daily history, shown at the top of the Links tab.
- The check registry grows from 111 checks in 0.15.0 to 143.

### Changed
- **The crawler adapts to 429 rate limits (#60):** a 429 (or 503 with `Retry-After`) halves concurrency and honours `Retry-After`, clean responses add workers back, throttled URLs are re-queued and, if still limited, stored as `rate_limited` rather than as errors; Shopify stores start at concurrency 3.
- **Segment rows get their own table (#69):** `search_analytics` holds all-country totals only, device and country rows live in `search_analytics_segments`, the sync settles each day's totals at write time, and the #64 read-time slowdown is gone (see Upgrade notes).
- **The Overview tab is retired (#59):** the Summary replaces it and its panels moved to the tabs they belong to; `?tab=overview` opens the Summary.
- **Docs (#49, #62):** README and manual brought up to the released code; the config templates list every optional key as an empty string (empty = off); a README "Opening the dashboard" section; the gateway worker model explained.

### Fixed
- **Search Console totals no longer double-count (#64):** a day stored in two row shapes is read once through the `gsc_rows` views everywhere (dashboard, Summary, audit, `query_data`, recon); brand detection matches a concatenated domain typed as separate words.
- **Code and config drift from the 0.14.1 docs pass (#53):** the dashboard sidecar honours `data_location`, the Majestic cache default matches, and tool descriptions match the code.
- **Placeholder API keys no longer switch a tier on (#60):** every optional key is read through one placeholder-safe helper in the server and the dashboard sidecar.
- **Real-data dashboard fixes from a full rehearsal (#72):** the CrUX card and tile, empty states, number formats, freshness lines, the brand on exact-match domains, truncated labels and network isolates.
- **Release pass (#68):** two-column dashboard rows size to their content instead of stretching the shorter panel; the field-CWV tile's sparkline and the CrUX distribution key no longer overflow their card; `start_crawl` exposes `siteProbes`; a finished `sync_crux` offers the dashboard link like other data jobs; the demo property carries CrUX history (with a phone INP regression) and a backlink profile, so every screenshot shows real states; docs checked against the release code.
- **End-to-end release fixes:** `render_pages` on an install without the Chromium binary (npm installs the optional `playwright` package but not its browser) now stops and says how to install it, instead of reporting a completed job that rendered nothing; per-page render failures are counted and named in the result; a failed browser launch is retried on the next call. The critical `site-wide-indexing-alarm` traffic trigger now needs more than a 40% week-on-week drop in pages earning impressions from a prior week of at least 50 (a 58 to 46 page dip on a healthy small site had raised it). A finished crawl reports its fetch rate in pages/sec, not an average diluted by the outbound-link stage. Source maps are no longer shipped in the npm package (394 to 200 files).
- **Code-review fixes on the release:** a GSC sync whose one-time storage migration is refused for lack of disk now runs in the old layout (correct totals via the views) and says the migration was deferred, instead of failing; a queued job no runner can claim stops blocking prune/repair and reads "queued (no runner)"; the runner's printed `docker run` line passes `CRUX_API_KEY`, `fts-index` jobs resolve their database in the runner's own data dir, and a cancelled job is aborted and logged once; CrUX URL picks, asset page ordering and brand totals read de-duplicated `gsc_rows`; non-ASCII branded queries match; the verdict reads "non-brand up from none"; the sync start reply states the range actually fetched; `host-variant-split` is one finding per page listing every failing twin.

## [0.15.0] — 2026-10-17

### Removed
- **The paid competitor fetchers.** `FIRECRAWL_API_KEY` and `SUPADATA_API_KEY` are no longer read; delete them from your config at leisure (they're harmless if left). Content recon's competitor fetch now needs no API key at all: competitor pages go through the browser-profile HTTP fetch, Reddit threads through their `.json`, and the ranking videos are listed for you to watch rather than transcribed. The Claude Desktop extension no longer asks for those two keys.

### Fixed
- **`probe_urls` could be walked off the property by a redirect.** Only the input URLs were host-checked; every `Location` was then followed and parsed, so an open redirect on the site (`/out?to=…`) turned a probe into a fetch of an arbitrary or internal-network URL. The own-host guard now applies at every hop: an off-property redirect is recorded (target and status, flagged `redirectsOffProperty`) and not fetched. `triage_404s`, which verifies candidates through `probe_urls`, says so in its reason.
- **`recon_targets scrapeCompetitors:true` silently did nothing without a paid-fetcher key**, including the free Reddit and plain-HTTP paths it advertised. It now always runs. Ranking videos no longer take a fetch slot; they're listed separately. Competitor pages are decoded through their declared charset.
- **Job status is per property, and destructive guards are conservative.** Every job now records which property database it works on (`scope`) from its first registry write. The dashboard asks "is a crawl live for *this* property", so a live crawl on one site no longer keeps another site's dead crawl showing as running; the crawled-but-unsynced view gets the same check. `data_storage` vacuum / delete-property / repair now refuse while any job *may* be running (stored running, heartbeat within 30 minutes), not just while one reads as live: a long synchronous step can starve the 20-second heartbeat and make a busy job look interrupted for a while, which is cosmetic on screen but must never let a prune write under it. The full-text index build is deduplicated per property from its first write, and a job's first progress update is recorded straight away.
- **An audit killed mid-run showed as "running" forever.** The engine writes `status='running'` at start, and the 30-minute "interrupted" fallback only applied to rows with no status. A `running` audit now gets the same age check.
- **The crawl-health URL flow under-counted redirects.** It counted 3xx in `pages`, but an internal redirect is stored under its final URL with the final 200, so only the few redirect-outs that leave the site showed up. Redirect buckets now come from `redirect_sources` (plus any 3xx page never followed), counting each source once.
- **Sitemap discovery reported declared sitemaps as undeclared, and re-parsed them.** Sitemaps were compared as raw strings, so a www/apex or scheme respelling of a declared index looked like a different, undeclared one, and Yoast's `/sitemap.xml` and `/wp-sitemap.xml` (both redirecting to `/sitemap_index.xml`) were parsed again and listed as undeclared. Discovery now compares by URL key and by redirect target; a spelling that fails to fetch still lets another spelling of the same sitemap be tried.
- **The DataForSEO cache had two defaults.** The MCP treated a cached response as fresh for 20 days and the dashboard sidecar for 7, on the same cache file, so the sidecar could pay to refetch what the MCP still served. One shared default now: 20 days (`DATAFORSEO_CACHE_DAYS` still overrides).
- **Full-text index on query strings, hardened.** Its content table used an implicit rowid, which SQLite reserves the right to renumber on `VACUUM`; that would leave `query_data` `match` resolving to the wrong queries. It now uses an explicit integer key (existing databases migrate and re-index on first use). Not reproducible on the SQLite currently bundled, which kept rowids in a direct test, so this is a guard against undocumented behaviour rather than a live bug.

### Docs
- A **Quick start** near the top of the README with the npm (`npx`) setup for Claude Desktop and a one-line `claude mcp add` for Claude Code. The install section and the Claude Code guide are npx-first, including the team `.mcp.json`, where a local clone path doesn't exist on teammates' machines.

### Tests
- New `scripts/probe-review-0-15.mjs` (off-property redirects, sitemap dedupe, URL-flow counts, the cache default, keyless competitor fetch, all against a local HTTP server) and new cases in `probe-jobs` and `probe-fts`. `npm test` now also runs `probe:fts` and `probe:review-0-15`.

## [0.14.1] — 2026-10-17

### Changed
- **Dashboard redesign: crawl and network intelligence (#38 part 1).** Built on the existing data contracts:
  - A sticky sidebar (property, navigation, data freshness) replaces the pill tabs, under a slim top bar. The graphite dark and cool-paper light themes share one signal-green accent.
  - The Overview is rebuilt: KPI strip, clicks / impressions / position as small multiples, findings by priority, crawl-health status mix, a site-network preview, top keywords and pages, and a jobs and data-freshness panel.
  - Crawl health gets a KPI strip and a canonical / redirect / 404 breakdown. The Network tab (formerly Architecture) leads with the full crawl graph, and Issues gets a by-area filter.
  - The two dual-axis charts (rank and clicks; DataForSEO keywords vs ETV) become small multiples.
- Docs screenshots refreshed for the redesign, from the fictional demo property. `site-health.png`, `architecture.png` and `tab-arch.png` become `crawl-health.png`, `network.png` and `tab-network.png`, and the README and manual captions follow the tab renames (Crawl health, Network).

### Added
- `npm run demo:property` (`scripts/demo-property.mjs`) builds a fully populated, fictional demo property (Larchmere Outfitters, `larchmere.example`): synthetic GSC history, a real crawl of a synthetic site, and a real audit. `npm run demo:screenshots` captures the docs screenshots from it, so no real property's data reaches the repo.
- Dashboard payload: `freshness`, read from the property database on every load (outside the cache), so the standalone dashboard sidecar shows the same job status as the MCP. Also `crawlHealth.urlFlow`, the canonical / redirect / not-found buckets with the most-linked example URL per bucket.

### Fixed
- **Dashboard (review of the redesign).** A crashed audit no longer shows as "running" forever: the engine records `audit_runs.status` (running / completed / failed, with the error), and a status-less run older than 30 minutes reads "interrupted". The crawl freshness line and the Overview crawl stamp name the crawl whose pages are actually on screen (`freshness.shownCrawl`): a failed run that wrote pages is shown as that run's partial snapshot, one that wrote nothing defers to the last completed crawl. A crawled-but-unsynced property keeps its freshness panel (the empty payload carries `freshness`). The Non-200 KPI counts HTTP statuses only, with robots-blocked and fetch-failed URLs shown separately, so it can't exceed the crawled total. "Missing canonical" excludes non-indexable pages; the temporary-redirect bucket is labelled 302/303/307. Tab switches scroll to the top only on a real click, so re-renders and cross-links keep the reader's place; the full Network force layout is drawn when its tab is first shown rather than on every render; dead CSS from the removed hub and health-score markup is gone; the severity vocabulary and percentage-change helper are shared between the two UI modules; the smoke test's freshness assertion fails cleanly instead of throwing.
- **`triage_404s` verification is explicit.** The reply says whether the live check ran and how many candidates it covered, and warns in capitals when it could not run (the stored buckets are then unverified). A URL caught by a blanket 404→homepage rule keeps its redirect bucket with a note instead of being reported as already handled; a redirect that already points at the suggested target is marked as matching. When URLs are no longer 404s live, the reply recommends a re-crawl.
- **Async jobs vanished when the server process exited, with a bare `not_found`** (#9, code side). Jobs are now also written to a small SQLite registry, `_jobs.db` in the data directory (WAL; on start, on progress at most every 2 s, on a 20 s heartbeat, on finish). `check_sync_status` / `check_crawl_status` look in memory first, then the registry, so a finished job's result survives a restart. A `running` job owned by another process whose heartbeat is over 90 s old reads as the new state `interrupted`, with an explanation that points at `longLived: true` for the Docker MCP gateway. Nothing rewrites another process's rows, so two servers can share a data directory. If the registry can't be opened the server warns once on stderr and tracks jobs in memory only. A truly unknown id still returns `not_found`, now with the per-call-container explanation. The dashboard's freshness panel reports a crawl still marked `running` with no live crawl job as `interrupted`. Keeping the work alive under the gateway is configuration, not code: README, "Docker and the Docker MCP gateway". `npm test` now also runs `probe:jobs`.
- **`triage_404s` suggested redirects for URLs that already redirect live, and let shared suffix tokens inflate matches** (#40). Redirect and review candidates are now probed live before bucketing (`verify:true` by default, up to 50 URLs, 30s): a URL that already 3xx's to a live page lands in a new `already-redirected` bucket with its live destination, so a suggestion never replaces a correct redirect; one answering 200 lands in `live-now`. Slug similarity weights tokens by how many live URLs carry them, so `stormforcegaming-buyers-guide` no longer matches `syncmesh-buyers-guide` on `buyers-guide` alone while a typo of a rare brand token still scores high. Archive targets (`/tag/`, `/category/`, `/author/`, `/page/N`) are discounted and flagged `weakTarget`.

## [0.14.0] — 2026-10-16

Fixes and features from the 0.13.1 code review and the first field test (issues #10-#37, except the Docker gateway item in #9). 107 → 111 checks.

### Added
- **`probe_urls`** (#30): fetch any URLs on your own host - including ones the model generates to test a hypothesis - and get status, the full redirect chain, canonical, meta robots / X-Robots-Tag, title, a content fingerprint and cache headers. `variantsOf` generates case, slash, `index.php`, unknown-param, scheme and www/apex variants of a URL and judges whether the site normalises each (one redirect), contains it (200 + canonical: indexing safe, but crawled and usually cache-bypassing) or serves a duplicate. Max 50 URLs a call inside a 45-second budget; `persist:true` saves to a `probes` table.
- **`triage_404s`** (#31): crawled 404s get discovery sources, clicks, impressions, last-seen date, backlinks and the closest live URL by slug similarity, bucketed redirect / review / ignore, with a paste-ready 301 map.
- **Integrity check and index repair** (#34): `data_storage {siteUrl, check:true}` runs SQLite's full `integrity_check` (or `check:"quick"`) as a background job in a worker thread and names damaged indexes; `prune {action:"repair"}` with `confirm:true` backs up the file, REINDEXes only the damaged indexes and re-checks. A failed job whose error is SQLite corruption now points at this.
- **External link checking** (#36): after each crawl every distinct outbound link target is checked - HEAD with a ranged-GET fallback when HEAD is rejected, one request at a time per host with several hosts in parallel, a per-host cap per run, cached 7 days in `external_link_status`. 401/403/429 and Cloudflare challenges are `unverifiable`, never broken. New checks **`external-broken`** (per linking page, with status or error and anchor) and **`external-redirected`** (permanent redirects; deep links now landing on a homepage flagged as likely removed). `start_crawl checkExternal:false` skips it; `externalCacheDays` tunes the cache.
- **Subresource inventory** (#37): every crawl records what each page loads in `page_resources` - CSS, JS, preloads, fonts from inline `@font-face`, images, icons - with type, first/third party, head/body position, async/defer/preload/module, crossorigin and media, from the HTML parse already happening (nothing downloaded). `start_crawl headResources:true` adds a header-only pass over CSS/JS/fonts into `resource_assets` (status, size, cache-control, pages using it).
- **FTS5 full-text search** (#35): `query_data` filter op `match` (FTS5 syntax: words, "phrases", prefix*, AND/OR/NOT, NEAR) over GSC queries (a distinct-query index, maintained per sync batch in the same transaction, ~7% insert overhead), page titles / H1s / body text and anchor text (trigger-maintained). Older databases are backfilled once on first use, never at open.
- **Chrome fallback on bot blocks**: the crawler, outbound-link checker and `probe_urls` keep their honest user agent, but a bot block (403, 999, or a Cloudflare / Akamai / DataDome challenge) is retried once as desktop Chrome with browser headers. After three pages in a row need it, the rest of the crawl runs as Chrome. `pages.fetched_as` / `external_link_status.fetched_as` / `blockedAsBot` record which identity got through, and the crawl result and status text report the blocking seen. An explicit `userAgent` or `chromeFallback:false` disables it; rate limits keep their backoff and robots.txt is always respected.
- **Dashboards offered on completion** (#38, part 2): sync, crawl and inspect jobs start the local dashboard server when they finish and carry the link in their result, as `refresh_property` already did; the completed job's status text says the dashboard is updated and gives the link (or points at `get_dashboard` where no port can be served). New **`open_dashboard {siteUrl}`** tool.
- **`duplicate-article-entities`** check (#28): more than one Article entity on one URL, e.g. an SEO plugin's graph plus a theme-embedded Article.
- **`image-empty-alt-content`** judgement check (#21): `alt=""` images inside the main content, which are often content images whose alt was never written.
- New columns: `pages.images_empty_alt` / `images_empty_alt_content` (#21, #23), `links.href_form` - absolute / protocol-relative / root-relative / relative as written (#26). New tables: `redirect_sources` (every crawled URL that redirected, with every hop of its chain), `probes`, `page_resources`, `resource_assets` and `external_link_status`, all queryable via `query_data`.

### Fixed
- **`backlinks-to-404` raised false crit findings** (#32): it used the status stored at backlink-pull time. It now takes status from the latest crawl first, judges a redirected URL by where it lands, and only falls back to the pull status (labelled with its age) when the crawl never reached the URL. The crawler seeds the top 200 backlinked URLs and records every redirect source, even when the target page was already crawled.
- **`article-no-author`** fired when one of several Article nodes lacked an author, and didn't follow an `author` given as an `@id` reference (#28). It now fires only when no Article node names an author. Article checks also no longer skip `BlogPosting`-only pages, which a `LIKE '%Article%'` prefilter silently excluded.
- **Sitemap discovery missed children of an undeclared `sitemap_index.xml`** (#25): the conventional locations are now probed on every crawl, not only when robots.txt lists none; the crawl result names undeclared sitemaps.
- **`data_storage.lastCrawl` counted crawls that never completed** (#20, #29): it's now the last completed crawl, and an incomplete latest run is listed separately.
- **Incremental GSC sync now replaces the lag days** (#22): the last 4 stored days are re-pulled into a staging table and swapped in with one bounded transaction (only the re-pulled window, only after every page arrived, never on an empty response), so a partial final day, or rows Google later drops, are corrected and a failed or historical sync loses nothing.
- **Job tools** (#19, #27, #33): job-starting tools return their JSON in the text reply too; `check_sync_status` / `check_crawl_status` are one handler whose text includes a failed job's reason and latest progress; failures are logged to stderr; `sync_gsc`'s start reply shows the range it will actually fetch (the incremental start), not the requested 90-day default.
- **`og:image`, URL-valued `og:` / `twitter:` tags and `rel=amphtml` now honour `<base href>`** (#12), completing the 0.13.1 fix.
- **Missing meta description stored as NULL** rather than 0, so it's distinguishable from an empty one (#24).
- `list_checks` / `run_audit` accept the `accessibility` category (#10); an empty `SAC_DATA_DIR` no longer resolves databases against the process cwd (#11); `recon_todos` remeasure fails loudly without DataForSEO (#13); `recon_targets` with `urls: []` no longer reports 0 pages (#14); `competitors_domain` uses the shared host cleaner (#15); `news_discovery` reports `cached` only when a source was cached (#16); the DataForSEO cache default is 20 days everywhere (#17); the mcpb manifest's check count and license are corrected and now synced from package.json at pack time (#18).

### Notes
- Re-crawl to populate the new columns and `redirect_sources`; existing rows keep working (new columns are NULL until then).
- The outbound-link pass runs after the crawl is marked completed, so a long pass never leaves a finished crawl looking unfinished. On large databases the first full-text `match` builds its index as a background job instead of stalling the call.
- Crawls now also check outbound links by default, which adds time on the first crawl of a link-heavy site; later crawls reuse the 7-day cache.
- New regression probes: `probe:jobs`, `probe:crawl-local` (end-to-end crawl against a local fixture server), `probe:checks-v2`, `probe:integrity`, `probe:probeurls`, `probe:triage404`, `probe:fts`, `probe:external`.

## [0.13.1] — 2026-10-16

### Fixed
- **Crawler honours `<base href>` when resolving relative URLs.** Links, image sources, the canonical and hreflang alternates were all resolved against the page URL, but browsers and Googlebot resolve them against the document's first `<base href>`. On a site that emits `<base href="https://example.com/">` with relative nav hrefs such as `href="buildings/x/"`, a link on `/areas/england/` was crawled as `/areas/england/buildings/x/` instead of `/buildings/x/` - on one 4,000-URL crawl that produced 3,637 phantom 404 pages and 3,635 false broken-internal-link findings, and skewed inlink counts, iPR, orphan and click-depth data for every real page. The extractor now resolves against the base URL (falling back to the page URL when there is no base or it isn't http(s)), and hreflang hrefs are stored absolute. Re-crawl affected properties to replace the bad `pages` / `links` rows. Regression test added to `npm run probe:extract`.

## [0.13.0] — 2026-10-11

### Added - desktop-crawler parity features (99 → 107 checks)
- **Accessibility audit (static axe-core subset).** A new `accessibility` category of deterministic checks decidable from raw HTML: `a11y-link-name`, `a11y-button-name`, `a11y-form-label`, `a11y-viewport-zoom-disabled`, `a11y-duplicate-id`, `a11y-positive-tabindex` (alongside the existing image-alt, heading-hierarchy and missing-lang signals). Accessible-name aware; submit/reset inputs and labelled fields aren't false-flagged. Findings flow into the dashboard by-category view automatically.
- **Semantic near-duplicate detection.** `find_duplicates` embeds each indexable page's title+body with a local sentence model (all-MiniLM-L6-v2, transformers.js/ONNX, GPU with CPU fallback, no Python, no API cost), flags pairs above a cosine threshold (default 0.9), and persists them; `run_audit` reports `near-duplicate-content` (judgement, gated behind `includeJudgement`). The content-similarity / cannibalisation signal the desktop crawlers surface - done locally, with no API cost.
- **JavaScript render tier (Response vs Render).** `render_pages` renders a bounded, sampled set of pages in headless Chromium and diffs the rendered DOM against the raw HTML, surfacing content and internal links that exist only after JavaScript (`content-only-in-rendered-dom`). Opt-in: Playwright is an optional dependency and the render pass is a separate async job, never part of the normal HTTP crawl; it degrades with a clear install hint when the browser isn't present. Install once with `npm i playwright && npx playwright install chromium`.

### Notes
- Each feature ships with a regression test (`npm run probe:a11y` / `probe:neardup` / `probe:render`) and was live-verified. The render tier and the embedding model are both opt-in / downloaded-on-first-use, so a default install is unchanged in size and behaviour.

## [0.12.2] — 2026-10-11

### Fixed
- **Crawled titles / meta descriptions / H1s now whitespace-normalised.** A multi-line `<title>` in the source (e.g. Shopify's `…2500kg\n – EHI.com.au`) was stored with the embedded newline intact - the title read with a stray gap in reports and its `title_length` over-counted by a character or two (which could tip the >60-char check). Title, meta description and H1 are now collapsed to single spaces and trimmed, the way a browser renders them, so every length / duplicate / keyword-in-title measurement is computed on the clean string.
- **Crawler honours the response charset (decode once).** HTML bodies were read with `res.text()`, which always decodes UTF-8 regardless of the declared charset - correct for a UTF-8 site but mojibake for a page served as ISO-8859-1 / Windows-1252. Bodies are now decoded once via the declared charset (Content-Type → `<meta charset>` → UTF-8 fallback, invalid label → UTF-8), so non-UTF-8 pages no longer corrupt. New regression test: `npm run probe:charset`.
- **Shopify 429 back-off now pauses the whole crawl, not just the one request.** A 429/503 retry backed off only the request that hit it while the other workers kept hammering the rate-limited host, so pages could still be recorded as 429 (56 of them on a recent ehi.com.au crawl, including top content pages). A shared throttle gate now makes every worker respect the cooldown after any 429/503, the retry budget is raised (4 → 6) and `Retry-After` is honoured up to 30s. Only the final status after retries is recorded.

### Notes
- **No data-migration is run, by design.** The mojibake reported against stored titles (`â\x80\x93` for "–") was a *display* artifact of the viewer, not the stored bytes: direct inspection of the crawl database showed the en dash stored correctly as UTF-8 (`E2 80 93`) in 2,099 titles and **zero** Latin-1-mojibake rows. A Latin-1→UTF-8 "repair" would therefore have corrupted correct data. Existing rows are repaired simply by re-crawling (the crawler replaces the `pages` snapshot), which also recovers the pages that had been recorded as 429.

## [0.12.1] — 2026-10-06

### Fixed
- **`domain_visibility` ignored its `months` window.** The tool accepted `months` (1-24) but never translated it to a `date_from`, so the DataForSEO endpoint fell back to its default previous-six-months window - `months: 24` silently returned 6. It now sends `date_from` for the requested window (via a shared `historicalDateFrom` helper, computed in UTC on the first of the month so the cache key is stable, clamped to the 2020-10-01 data floor), reports `requestedMonths` alongside the returned `months`, and adds an honest shortfall note when a young domain or the data floor returns fewer months than asked. Live-verified: `months: 24` → 24 points, `months: 6` → 6.
- **Paid-tool cost/cached now match between text and JSON.** `market_sizing` and `serp_features` reported the spend and cache state in the markdown but omitted both from `structuredContent`; `link_intersect` reported the combined `totalCost` (intersect + any competitor-derivation call) in text but exposed only the intersect cost in JSON, understating the spend when competitors were auto-derived. All three now carry the same facts in both surfaces (`link_intersect` adds an `intersectCost`/`deriveCost` breakdown), matching the shape `keyword_volume`, `topic_trend` and `search_intent` already use.

## [0.12.0] — 2026-10-06

### Added
- **Content architecture (topic clusters)** view on the Opportunities tab: your Search Console demand grouped into topic clusters - a pillar topic with supporting sub-topics - each classified covered / thin / gap, with a coverage score, a funnel read (where `keyword_intent` exists), the concrete gaps, and pillar-to-member internal-link suggestions. GSC-first, grounded in your own demand, no paid calls.

### Fixed
- **Historical rank overview returned only ~6 months.** The DataForSEO `historical_rank_overview` call never sent `date_from`, so the endpoint returned its default previous-six-months window - the rank-history / visibility-over-time chart silently showed only ~6 months. Now sends `date_from` (2020-10-01, the endpoint's earliest data) for the full history. Live-verified: 6 → 72 months.

## [0.11.1] — 2026-10-06

### Added
- `?theme=dark|light` deep-link for the served dashboard, so a shared link or a headless capture opens in the chosen theme.

### Fixed
- Redact mode (`?redact=1`) now fully de-identifies a public screenshot: it also blurs the property name (header + switcher) and the highest-impact-fix slugs, and suppresses the crawl-structure-map node labels (canvas text CSS can't blur).

## [0.11.0] — 2026-10-06

### Added - dashboard redesign + new views
- **Houtini house design language** across the whole dashboard and every chart: Schibsted Grotesk + JetBrains Mono, Houtini green as the one accent, warm paper, flat hairline surfaces, with a house-derived warm dark mode. Re-themed via a token remap, so it flows through every ECharts chart.
- **Crawl-structure map** (Architecture) - a force-directed graph of the internal link skeleton, node size = internal PageRank, coloured by health (green indexable / amber non-indexable / red broken). Drag, scroll-zoom, and click a node to open the page. The equity-vs-reality scatter is now click + zoom too.
- **Site Health Score** on Overview (0-100, banded, honest definition: share of crawled internal pages with no critical/high finding), and **coverage %** per issue in the by-category view.
- **Eight new thematic views**, each built from data already collected and hidden when its data is absent: Security / HTTPS header coverage, Structured-data (JSON-LD @type) coverage, GSC index coverage (URL Inspection), Redirect chains, Core Web Vitals, Hreflang / international, Entity & topic graph (Wikidata), and **AI answerability** (local cross-encoder max-passage score per ranking page - the GEO moat).

### Fixed
- A code-review pass fixed: the Security view read the wrong header key (`referrer` vs `referrerPolicy`, always 0%); the Health Score / coverage % counted findings on non-crawled URLs (understated the score, coverage could exceed 100%); structured-data coverage dropped top-level-array JSON-LD; and the structure-map edge selection was made robust when the iPR threshold is 0.

## [0.10.0] — 2026-09-29

### Added
- **Google Trends category support** (following DataForSEO's Sep 2026 category-only filtering). `topic_trend` now takes keywords, a `categoryCode`, or both:
  - keywords alone search every category (unchanged);
  - keywords + `categoryCode` narrow a term to one industry (e.g. "jaguar" inside Autos);
  - `categoryCode` alone returns interest across a whole market, no keyword needed.
  - `related: true` (at most one keyword) adds the top and rising related topics and queries — with a category on its own, this is how you see what's breaking out across a market.
- **`trend_categories`** (free, **52 tools total**) — searches the Google Trends category tree (~1,400 categories) by name for the codes `topic_trend` takes, each with its parent so you pick the right level.
- Verified against the live DataForSEO API: category-only graphs return one value per point and an empty `keywords` array (the series is labelled `category:<code>`); category + `related` returns breakout topics/queries as percentage rises.

## [0.9.1] — 2026-09-24

### Fixed
- Stripped comments from the published build (`removeComments`) so no source comments ship in the npm tarball.

## [0.9.0] — 2026-09-21

### Added
- **Google Discover readiness checks** — 6 new checks (**99 total**) that audit article/news pages for Google Discover, gated so product/listing pages are never flagged:
  - **`discover-max-image-preview`** (flagship) — article pages missing `max-image-preview:large`, the tag that unlocks the large, high-CTR Discover image card. Ships a paste-ready fix.
  - **`discover-missing-og`** — article pages missing `og:title`/`og:image` (Discover builds cards from Open Graph).
  - **`discover-image-schema`** — Article schema that declares no `image`.
  - **`discover-generic-article-type`** — generic `Article` where a more specific `@type` (`NewsArticle`/`LiveBlogPosting`/`ProfilePage`) fits.
  - **`discover-slow-response`** — article response over ~600ms.
  - **`discover-crawl-waste`** — site-level: crawl budget spent on redirects / non-indexable URLs.

### Fixed
- A **Fable 5.1 code audit** of the new cluster caught two evidence-accuracy bugs, fixed before release:
  - Array `@type` handling — `["Article","BlogPosting"]` is no longer misread as generic `Article` (removed 337 false positives on a test site).
  - `discover-image-schema` now requires a real article node (an empty-array `.some()` had flagged pages with no article schema at all).
- Eligibility now treats typed JSON-LD as authoritative over a blanket `og:type=article`, so listing/product pages aren't matched.

### Changed
- `discover-slow-response` labelled judgement (`N`) with an honest `wallTimeMs` note — it's whole-fetch wall time, not a measured TTFB.

### Docs & repo
- Check count corrected to **99**; DataForSEO cache TTL fixed **20→7 days**, Majestic **20→30 days**; dashboard tab count six→eight.
- De-identified the test property across docs, comments and scripts; all 8 dashboard screenshots replaced.
- Source license headers aligned to **Apache-2.0** (matching the LICENSE).

## [0.8.0] — 2026-08-21

### Added
- **Auto-served dashboard** — `refresh_property` and `run_audit` now start the local dashboard server and return its URL, so a populated property always has a one-click browser link.
- **Docker-aware dashboard sidecar** — a separate publishable entrypoint (`seo-audit-dashboard`) that mounts the shared data volume and serves the identical dashboard on a fixed port, for setups where the MCP runs behind the Docker MCP gateway (which can't publish the server container's ports).
- `serve_dashboard` bind is env-configurable (`SAC_DASHBOARD_BIND`/`SAC_DASHBOARD_PORT`/`SAC_DASHBOARD_URL_HOST`); auto-serve is opt-out via `SAC_AUTOSERVE=0`.

### Changed
- Web dashboard call-handlers factored into one shared module used by both the in-MCP server and the sidecar.

## [0.7.8] — 2026-08-17

### Added
- **Link intersect** (`link_intersect`) — one DataForSEO `domain_intersection` call over a competitor set → the domains linking to your rivals but not you, sorted followed-first by domain trust. Optional **Majestic Trust Flow / Topical Trust Flow** re-sort surfaces genuinely on-topic authority and sinks directory noise.
- **Content recon** (`recon_targets` / `save_recon_todo` / `recon_todos`) — pulls the live Google SERP for a losing page, reads whether the **AI Overview** cites you, and returns a verdict (rank-but-not-cited = a freshness/accuracy fix, not a rewrite). Fetches the ranking competitors + video transcripts and writes gaps to a trackable to-do ledger.
- **Content research** — `news_discovery` (free Google News + DataForSEO), `youtube_discovery`, `topic_trend`.
- **Trapped Authority** report — pages the web trusts (referring domains + Majestic Trust Flow) buried deep in your architecture, where the equity never reaches your money pages.
- **Dashboard redesign** — eight tabs, a report hub, a light/dark toggle, and a shareable self-contained HTML export.

### Changed
- Cache TTLs: DataForSEO 7 days, Majestic 30 days. Results persisted to SQLite so repeat lookups are free.

## [0.6.0] — 2026-08-16 and earlier

Foundation of the tool:
- Merges **Google Search Console** history, a **first-party crawl**, and on-demand **DataForSEO** into one prioritised technical-SEO audit inside Claude, joined on a shared URL key.
- The scored **check engine** — findings ranked by expected clicks per developer-hour, with **D/N honesty** (deterministic findings cite the bytes; judgement checks gated behind a flag) and full traceability from recommendation → finding → datapoint.
- **Finding→fix generators** (`fix_finding`) — paste-ready JSON-LD, 301 rules, internal-link suggestions.
- Hand-rolled, stdio-safe crawler seeding discovery from links + sitemap + GSC-known URLs; post-crawl internal PageRank, click-depth and in-degree.
- Incremental GSC sync, change-detection (`detect_changes`), sitemap reconciliation, and the **AI-search layer** — a local cross-encoder passage-scorer (no Python, cannot hallucinate) plus agent-readiness scoring.

[0.9.0]: https://www.npmjs.com/package/@houtini/seo-audit-console/v/0.9.0
[0.8.0]: https://www.npmjs.com/package/@houtini/seo-audit-console/v/0.8.0
[0.7.8]: https://www.npmjs.com/package/@houtini/seo-audit-console/v/0.7.8
[0.6.0]: https://www.npmjs.com/package/@houtini/seo-audit-console/v/0.6.0
