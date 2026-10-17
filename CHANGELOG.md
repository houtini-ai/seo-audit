# Changelog

All notable changes to **@houtini/seo-audit-console**. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); the check registry is the source of truth
(`list_checks` always returns the live list).

Each release is tagged `vX.Y.Z` on the release commit (tagging lapsed between 0.5.1 and 0.13.1; 0.6 to 0.13.0 have no tags). Release steps: bump
`package.json`, `server.json` (x2) and `mcpb/manifest.json`, retitle `[Unreleased]` here, commit as
`chore(release): X.Y.Z`, `git tag -a vX.Y.Z -m "X.Y.Z - <headline>"`, push the tag, `npm publish`.

## [Unreleased]

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
- **Dashboard redesign: crawl and network intelligence (#38 part 1).** Direction from a Google Stitch round (`design/stitch/`), built on the existing data contracts:
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
