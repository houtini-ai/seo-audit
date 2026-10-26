# Tool reference

Every tool the server exposes, grouped by job. Each entry gives you what it does, the inputs that matter, the data grain and join keys where they're relevant, and a prompt you can copy. You never call these by name unless you want to - *"run an SEO audit on mysite.com"* routes to the right tool on its own - but knowing what exists is how you get the most out of it.

Most DataForSEO tools also take `location` (a market name or code; US unless the tool or the property says otherwise), `languageCode` and a `limit`, and the reply states which it used. They're left out of the entries below unless they change the answer.

DataForSEO-backed tools are marked **[paid]**. They cost real money per live call (fractions of a cent to a few cents), are cached for 20 days, and only ever run when you ask - never in bulk behind your back. Setup and honest cost notes: [competitive.md](competitive.md). One tool, `link_intersect`, has a second optional service behind it - **Majestic**, billed in its own resource units - which switches on when `MAJESTIC_API_KEY` is set and stays entirely out of the way when it isn't.

## The data pipeline

These fill the local database. Long operations run as background jobs - you get a job id back and poll it (or just carry on; Claude checks for you).

### `list_properties`
Lists the Search Console properties the service account can see. Your connectivity check.
> List my Search Console properties

### `refresh_property`
The "sync everything" verb: GSC sync → site crawl → URL inspection → rank history → CrUX field data (when `CRUX_API_KEY` is set), one background job with a live progress panel. GSC sync is **incremental** - the first run pulls the window (default last 90 days; pass `startDate` to go deeper), later runs fetch only the new days; `endDate` stops the window early. Set `segments:true` to also pull device/country breakdowns (heavier on large sites), `full:true` to force a complete re-pull, or turn individual phases off (`gsc`, `crawl`, `inspect`, `ranks`, `crux` - e.g. `crawl:false`). `maxPages` caps the crawl, `inspectLimit` the URL Inspection sample, and `location` sets the rank-history market.
> Refresh sc-domain:mysite.com
> Refresh mysite.com but skip the crawl

### `sync_gsc`
Just the Search Console history. Grain: date × query × page (plus device/country with `segments:true`). Joins to everything else on `page_key` (the normalised URL) and `query`. Same incremental behaviour as above (`startDate` / `endDate` set the window, `full:true` re-pulls it whole); `searchType` is `web` (default), `discover`, `googleNews`, `image` or `video`; `dimensions` names the dimensions outright and overrides `segments` (a sync without `date`, `query` and `page` is refused). Async job - poll `check_sync_status`.

**Where the rows go (0.16.0).** All-country totals live in `search_analytics`; the device and country rows a `segments:true` sync adds live in their own table, `search_analytics_segments`, so a total is never counted twice. The first sync after upgrading from 0.15 or earlier migrates a database that held both shapes in one table, once: it checks free disk, backs the file up, moves the rows a batch of days at a time and resumes if interrupted. Details, and what to do with the backup, under [Upgrading to 0.16.0](../README.md#upgrading-to-0160).
> Sync Search Console data for mysite.com back to 2024-01-01

### `start_crawl`
Just the crawl. Fetches the site into the local database: status, titles, H1s, metas, canonicals, robots, structured data, hreflang, redirect chains, body text by section, then computes internal PageRank, click depth and in-degree. Discovery is links + sitemaps + every URL Google already knows about from GSC. Respects robots.txt; assets are checked without downloading their bytes; search/cart/login junk is skipped. `excludePatterns` adds your own skip regexes, `maxPages` caps it, and `maxDepth` (default 10, up to 20), `maxConcurrency` (up to 16) and `delayMs` tune how deep and how hard it goes. Async job - poll `check_crawl_status`. Each page's subresources (stylesheets, scripts, fonts, images: first or third party, head or body, async/defer/preload) are recorded without being downloaded; `headResources:true` adds a header-only size-and-caching pass over the CSS, JS and fonts. After the crawl every distinct outbound link is checked - politely, one request at a time per host, cached for a week - so the audit can report broken and permanently redirected external links; bot walls count as unverifiable, never broken. `checkExternal:false` skips that, and `externalCacheDays` (default 7, `0` re-checks everything) sets how long a result is reused.

**Site probes.** Every crawl ends with at most five requests it would never make on its own, one at a time with the crawl's user agent and delay: two random URLs that can't exist (one at the root, one under the busiest section), and the http/https and www/apex twins of the homepage and of the most-linked deep page. They're stored in `probes` with `source = 'site-probe'` and feed `soft-404-handling` and `host-variant-split`. A probe that was rate limited, timed out or didn't resolve is recorded as unknown, with the reason. `siteProbes:false` skips them.

**Bot protection.** The crawler identifies itself honestly (`seo-audit-console/0.1`). When a site answers that with a bot block - a 403, LinkedIn's 999, or a Cloudflare / Akamai / DataDome challenge - the request is retried once as desktop Chrome; once at least three pages have only got through as Chrome, and they're at least half the pages tried under the crawler's own user agent, the rest of the crawl runs as Chrome. Each page records which one fetched it (`pages.fetched_as`), and the finished crawl reports how much blocking it met, which is worth knowing in itself: protection that walls this crawler may also wall AI crawlers or tools you rely on. The outbound-link checker and `probe_urls` retry the same way. Setting your own `userAgent` turns the fallback off, as does `chromeFallback:false`. Robots.txt is respected either way. Grain: one row per `url_key`, latest crawl only (history lives in snapshots, see `detect_changes`).
> Crawl mysite.com, 500 pages max
> Crawl mysite.com but exclude /author/ and /tag/

**Large crawls (10,000 pages).** `maxPages` goes up to 50,000 (default 4,000). Pages and links stream to SQLite in batches, so the crawl loop itself scales; the cost is in link rows (a dense site carries 150-300 links per page, so 10k pages is 1.5-3M link rows) and in the post-crawl stages that read them (link graph, snapshot, then the audit and the dashboard build). A sensible recipe: `maxPages: 10000`, the default `maxConcurrency` (8) and `delayMs` (250) for a host that is not yours to overload, higher only when you own the server and it is idle, `excludePatterns` for facet, filter and pagination URLs you do not need, and `check_crawl_status` every 60-120 s. Expect 20-40 minutes for the fetch stage at a few pages per second; the status line gives the live rate and ETA. If the crawl stops short of the cap it ran out of crawlable URLs, which is a valid result.

**Rate limits (429s).** `maxConcurrency` is a ceiling, not a fixed rate. When the host answers 429 (or 503 with `Retry-After`), the crawl halves its concurrency, pauses the pool for the `Retry-After` it was given (capped at 30 s) and puts the URL at the back of the queue for up to two more tries; every 20 clean responses add one worker back, up to `maxConcurrency`. A URL that is still rate limited after that is stored with `fetch_state = 'rate_limited'` and no status code: the audit treats it as unknown, never as a broken page, and `check_crawl_status` says so ("rate limited by the host: concurrency reduced to 2; 37 URLs retried, 3 not fetched"). Shopify stores are recognised from their response headers and start at concurrency 3 unless you set `maxConcurrency` yourself. If a crawl reports URLs not fetched, re-crawl with `maxConcurrency: 2` to fill them in.
> Crawl mysite.com with maxPages 10000, excluding /collections/ filter URLs, and check progress every two minutes

### `inspect_urls`
Just the GSC URL Inspection data: Google's own view of coverage, indexing, its chosen canonical versus yours, and the last crawl time. Quota-limited, so it samples your top pages by clicks (`limit`, default 50, max 500). Async job. Grain: one row per inspected URL.
> Inspect the top 100 URLs on mysite.com

### `track_ranks` [paid]
Ingests the DataForSEO monthly rank distribution and estimated traffic volume into `rank_history`, so rank charts get a real time axis reconciled with your GSC dates. One call per refresh, cached 20 days, run as a background job. Pass `location` once ("United Kingdom", "Australia", or a code) - it's saved per property.
> Track ranks for mysite.com in the UK

### `sync_crux`
Real-user Core Web Vitals from the Chrome UX Report API: p75 and the good / needs-improvement / poor shares for **LCP, INP and CLS**, plus FCP, TTFB, round-trip time, the four LCP sub-parts (TTFB, resource load delay, load duration, render delay), the LCP resource type and the navigation-type mix (back/forward-cache share). It collects the origin and your top 50 URLs by GSC clicks over the last 28 days (`limit`, 0-500, changes that, and `0` means the origin only; `urls`, up to 500, replaces the list), each on phone and desktop. A target's first pull backfills about 25 weekly 28-day windows of history; after that each run adds the newest window, at most once a week per target (`force:true` overrides). A URL without enough Chrome traffic answers "not found"; that's recorded as `insufficient_data`, not an error, and re-asked after 28 days. Free, but needs `CRUX_API_KEY` (see [getting-started.md](getting-started.md#crux-key-optional)); calls are throttled under the API's 150 a minute, so a first full pull takes a minute or two. `refresh_property` runs it too once the key is set. Feeds `crux-field-lcp` / `-inp` / `-cls` and `crux-regression`, and the dashboard payload's `cwvField`. Grain: target × form factor × metric × 28-day window in `crux_metrics` (plus `crux_fractions`, and `crux_targets` for which targets have data). The windows overlap, a week apart, so read them as a trend and never add them up. Joins: `target` is the `url_key` for URL rows.
> Pull CrUX field data for mysite.com
> Get Core Web Vitals field data for these three URLs

### `check_sync_status` / `check_crawl_status`
Poll any job by id, or list recent jobs - the two names are the same tool. A job is `queued`, `running`, `completed`, `failed`, `cancelled` or `interrupted`. A failed job's reason is in the reply text, with a repair pointer when it's database corruption. Every job-starting tool also returns its `jobId` as JSON in the text, so clients that only read text can poll it. A running crawl reports its **stage** (`fetching`, then `writing-links`, `image-weights`, `resource-headers`, `link-graph`, `revalidation-probe`, `snapshot`, `site-probes`, `external-links`), pages crawled against `maxPages`, the queue, pages/sec and an ETA for the fetch stage, so a 20-40 minute crawl never looks stalled. The ETA covers fetching only; the post-crawl stages are named instead of timed. When the host rate limits the crawl, or it is a Shopify store, the line says so and gives the current concurrency, the URLs retried and any not fetched (`progress.rateLimited` / `result.rateLimited`: `events`, `currentConcurrency`, `minConcurrency`, `maxConcurrency`, `retried`, `unfetched`). Poll every 60-120 s.

Jobs are also recorded in `_jobs.db` in the data directory, so a finished job's result can still be read after the server restarts. A job whose server process exited before it finished reads as `interrupted` rather than vanishing; under the Docker MCP gateway that usually means the container was removed between calls (see [Docker and the Docker MCP gateway](../README.md#docker-and-the-docker-mcp-gateway)). A completed sync, crawl, inspection, CrUX pull or refresh starts the local dashboard server and gives you the link to the updated dashboard (when the job ran in the server's own process; see the next paragraph).

**With the external job runner** (`SAC_JOB_RUNNER=external`, for the Docker MCP gateway) the server doesn't run the job. It writes it to `_jobs.db` as `queued` (its kind and arguments), and the separate `seo-audit-runner` process claims it, runs it and writes the result, so a gateway worker can be replaced mid-crawl without losing the crawl. Until a runner claims it, the status reads `queued: waiting for the job runner`; if it has waited over a minute with no runner checking in, the status says no runner seems to be running, when the last one stopped (or last checked in, if it died), and gives the `docker run` line to start one. The runner does one job at a time (`SAC_RUNNER_CONCURRENCY` on the runner raises that) and never two for the same property. A runner that's stopped marks its running jobs `interrupted` with the reason; start them again. The async tools that run as runner jobs: `sync_gsc`, `start_crawl`, `inspect_urls`, `refresh_property`, `track_ranks`, `pull_backlinks`, `resolve_entities`, `render_pages`, `find_duplicates`, `sync_crux`, `recon_targets`, `data_storage` integrity checks and repairs, and the full-text index build behind `query_data` `match`. `run_audit` is never a job. A runner job doesn't start the dashboard: use `open_dashboard`. Setup: [Running under the Docker MCP gateway](getting-started.md#running-under-the-docker-mcp-gateway).
> Check the crawl status

### `probe_urls`
Fetch any URLs on your own host, including ones you make up to test a hypothesis, and see the status, the full redirect chain, canonical, robots directives, title, a content fingerprint (same hash, same page) and cache headers. `variantsOf` (up to 6 URLs) generates uppercase, title-case, slash, `index.php`, unknown-parameter, `http` and www/apex variants of each URL and says for each whether the site normalises it with one redirect, contains it with a canonical (safe for indexing, but every variant is crawled and usually skips the page cache), or serves a duplicate. Up to 50 URLs a call, 4 at a time, inside a 45-second budget (anything unfinished is marked, not dropped). Every URL must be on the property's own host (apex or www): an off-host URL is refused, and a redirect that leaves the host is recorded (target and status, `redirectsOffProperty`) but not followed; `followRedirects:false` reports only the first response; `persist:true` keeps the results in a `probes` table for `query_data`. A bot-blocked URL is retried once as desktop Chrome, as in the crawl (`chromeFallback:false` turns that off). Free - it only calls your own server.
> Does mysite.com serve the same page at different capitalisations?
> Probe these five old URLs and show me where they redirect

### `triage_404s`
Turns the crawl's 404 and 410 list into a short redirect map. Each dead URL gets where it was found (internal link, sitemap, GSC, backlink), its clicks, impressions and last-seen date, its backlinks, and the closest live URL by slug similarity. Then it's bucketed: **redirect** (real value and a confident match), **ignore** (mangled or stray URLs with no value) or **review** (everything else, such as 404s you still link to internally). Before bucketing, the redirect and review candidates are checked live: a URL that already redirects to a live page is listed as **already redirected** with its real destination, and one that answers 200 today as **live now**, so a stale crawl never produces a wrong 301. Slug matching weights rare tokens (a brand, a model) over ones the whole site shares (buyers-guide, review), and archive targets like `/tag/` are discounted and flagged. The reply says whether that live check ran and how many URLs it covered (up to 50, inside 30 seconds), and warns plainly when it couldn't, because the buckets are then unverified; `verify:false` skips it. It ends with a paste-ready from/to 301 map. Tuning: `minImpressions` (what counts as real value, default 50), `minScore` (slug similarity needed for a confident target, default 0.6), `limit` (404s triaged, default 500). Check a target with `probe_urls` before shipping it.
> Triage the 404s on mysite.com

## The audit

### `run_audit`
Runs the full check registry over the joined data and returns scored findings ranked by expected clicks per developer-hour: priority = (traffic at stake × yield × certainty) / effort. `categories` filters (crawlability, indexation, onpage, content, schema, security, performance, accessibility, merged); `includeJudgement:true` adds the heuristic (N) checks, which are off by default. A check whose source data was never collected (the asset checks before a `headResources:true` crawl, say) is listed under *Not collected* with how to collect it, rather than reading as passed.

The reply is a headline, kept small on purpose (about 22k characters on a 2,300-finding site): the counts (`byCheck`, `bySeverity`, `byCategory`, `notCollected`), and the `top` findings by priority as plain objects - 10 by default, `topLimit` up to 50. Each has its finding `id` (for `fix_finding`), check, URL, priority, traffic, effort and a trimmed copy of its evidence (lists cut to 3 items with a `<key>Total` count, long text cut at 200 characters). Each check's title and fix appear once, in `checks`, rather than on every finding. For every finding of one check with its full evidence, use `query_audit`.
> Run an SEO audit on mysite.com
> Run an SEO audit on mysite.com, indexation and schema only, with judgement findings

### `query_audit`
One named check, with every affected URL and its full evidence. The drill-down after `run_audit` shows you a headline. `limit` defaults to 100 (max 1,000). For big result sets: `columns` narrows the evidence to just the keys you name, long values are truncated at 120 characters (with a visible ellipsis), and `offset` + `limit` page through the rest - the response always states *showing X-Y of TOTAL* so nothing is silently dropped.
> Show me striking-distance for mysite.com
> Run the keyword-cannibalisation check on mysite.com with evidence

### `list_checks`
The whole check catalogue - all 143, with categories and labels; `category` narrows it to one. The same list, annotated, is [checks.md](checks.md).
> What does the audit check for?

### `list_templates`
Clusters crawled pages into templates by URL shape and schema type, each with a page count and a representative example. Most technical issues live at the template level - one fix corrects every page in the cluster - so this is the map for working on anything bigger than a few hundred URLs. `minMembers` hides smaller clusters.
> List the page templates on mysite.com

## Raw data

### `query_data`
Direct, read-only access to the property database, built around one principle: **aggregate in the database and return answers, not rows**. The default mode groups by the columns you name and returns counts, percentages and sum/avg/min/max metrics - "status codes by folder", "clicks by page", "coverage states by verdict" - each as one small table with an honest total line, however many rows sit underneath. Tables: `pages`, `links`, `search_analytics`, `url_inspection`, `sitemap_urls`, `findings`, `image_assets`, `page_backlinks`, `referring_domains`, `backlink_anchors`, `backlink_history`, `redirect_sources`, `probes`, `page_resources`, `resource_assets`, `external_link_status`. The arguments: `table`, `groupBy` (up to 4 columns), `metrics` (up to 6, each `sum`/`avg`/`min`/`max` of a column), `filters` (up to 8: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `in`, `match`), `orderBy` / `orderDir`, `limit` (default 25 groups or 50 rows, max 500), `offset`, and `columns` for row mode. Filters (equals, ranges, like, in, match) are always parameterised; `match` is full-text search (words, "phrases", prefix\*, AND/OR/NOT, NEAR) over GSC queries, page titles/H1s/body text and anchor text, and is far faster than `like` on big tables. Every column name is validated against the live schema - there's no way to smuggle SQL in. `mode:rows` returns raw rows when you genuinely need them, with a curated default column set, 120-character cells and a *showing X-Y of TOTAL; next offset N* footer.
> How do status codes break down on mysite.com?
> Top 10 pages by total clicks from the raw GSC data
> Show me the 404 rows with their inlink counts
> Total clicks for every query that mentions "crystal" near "light"
> Which third-party scripts load on the most pages?

## Fixes

### `fix_finding`
The finding-to-fix step. Give it a finding id from `run_audit` (`findingId`, or `check` + `url`) and it returns a paste-ready artefact built from your own data: a complete JSON-LD block for missing or invalid schema, an exact-match 301 rule (`redirectFormat`: `htaccess`, the default, `nginx` or `nextjs`) - to the destination the crawler recorded for a redirect chain or a link to a redirect, and to the closest live page by URL tokens for a broken internal link, so check that one before shipping it - or internal-link suggestions: from the 80 indexable pages with the most internal PageRank, the five closest to the receiver by URL tokens, PageRank breaking ties. Redirect chains get collapsed to single hops. Everything is dry-run: it returns artefacts, it never writes to your site.
> Generate the fix for finding 12
> Write the redirect rule for /old-page in nginx format

Checks without a generator return their deterministic fix guidance instead, so the tool always answers.

## Growth and content

### `suggest_pages`
Proposes new pages from demand Google has already shown you: queries where you get impressions at rank 11+ with no winning page, after subtracting everything you already cover. Survivors are clustered into one proposed page per intent, scored by impressions × intent, each with the nearest existing page to link the new one from so nothing launches as an orphan. Works entirely from your synced data - no paid calls. (Run `search_intent` with your `siteUrl` first if you want the intent weighting.)
> Suggest new pages for mysite.com

### `resolve_entities`
Maps each top page's primary topic (from its H1, falling back to the title) to a Wikidata entity, and stores the relationships between them. Unlocks the entity-internal-link-gap finding: pages whose topics are related but which never link to each other. Free (public Wikidata API), cached about 45 days, runs as a background job (poll `check_sync_status`), and honest about being a heuristic - its findings are judgement-labelled and gated behind `includeJudgement`.
> Resolve entities for mysite.com

## AI-search readiness

### `score_passages`
The flagship AI-search check. A small local relevance model (a cross-encoder reranker, ~25MB one-time download, no Python, runs on your machine) reads each ranking page's sections against its top query and scores whether any single passage densely answers it. It's a classifier, not a generator - it scores relevance and cannot hallucinate. Pages that rank on demand they never answer become `weak-passage-answer` findings in the next audit. About 0.6s per page; `limit` and `minImpressions` bound the run. Re-run after a re-crawl.
> Score the passages on mysite.com

### `draft_content`
The follow-through. Builds a grounded writing brief for a weak page: the query gap, the page's own paragraphs as voice exemplars, and its most query-relevant passages as the only permitted facts. Claude then drafts the missing answer in *your site's* voice, told to invent nothing. Pass the page as `urlKey` (any URL form); omit it and it targets the weakest-scoring page.
> Draft the missing content for /best-running-shoes

### `find_duplicates`
Semantic near-duplicate detection, run locally. A small sentence-embedding model (all-MiniLM-L6-v2, ~25MB one-time download, no Python, no API cost) maps each indexable page's title+body to a vector, and cosine similarity flags pairs that say the same thing above a threshold (default 0.9). Catches templated/boilerplate variants and thin pages that merely reword each other. `limit` caps the pages compared (default 500, highest word-count first) and `threshold` (0.5 to 1) sets the bar. Pairs persist to `near_duplicates`; the next audit reports `near-duplicate-content` (judgement - ask for the judgement findings). Async job - poll `check_crawl_status`. The model reads ~the first 200 words, so verify a pair before consolidating. Re-run after a re-crawl.
> Find near-duplicate pages on mysite.com

### `render_pages`
The *Response vs Render* check: render a bounded, sampled set of pages in headless Chromium and diff the rendered DOM against the raw HTML the crawler fetched, surfacing content and internal links that exist **only** after JavaScript (what a first-pass crawl, and Google before it renders, can miss) as `content-only-in-rendered-dom`, and what JavaScript changes: the canonical (`canonical-changed-by-js`), the title (`title-changed-by-js`), noindex in either direction (`noindex-changed-by-js`), and main content it removes (`hydration-content-loss`). Each row records both canonicals, both robots meta values, the X-Robots-Tag header, main-content words on both sides and the raw status. Opt-in: it needs the optional browser (`npm i playwright && npx playwright install chromium`), runs as a separate async job (never part of the normal crawl - poll `check_crawl_status`), and degrades with a clear install hint when the browser isn't present. `limit` caps pages (default 10, up to 200, likeliest JS-dependent first) and `urls` names them instead; the HTTP audit is unaffected either way.
> Render the top pages on mysite.com and show what only appears after JavaScript

### `check_agent_readiness`
Is your site ready for AI agents? Live HTTP probes of your origin scoring four categories - discoverability (robots rules, sitemap, Link headers), content (`llms.txt`, `agents.md`, Markdown negotiation), bot access control (AI-bot rules, Content Signals, Web Bot Auth) and capabilities (MCP server card, Agent Skills, API catalogue, OAuth discovery). Returns 0-100, a level, and copy-paste fixes for everything missing. No crawl or GSC data needed, and it isn't fooled by a catch-all route that returns 200 for everything.
> Check agent readiness for mysite.com

## The portfolio

Every domain you look after on one page: owned properties automatically, plus watched domains. The full picture is in [portfolio.md](portfolio.md).

### `portfolio`
List and edit the portfolio. Free: it never calls DataForSEO.
- The list shows Search Console clicks (measured) beside DataForSEO estimates: organic keywords and traffic, referring domains, Domain Rank (DataForSEO's, not an Authority Score), AI mentions (AI Overviews + ChatGPT) and audit health.
- Each row carries its "needs attention" reasons. Changes compare the last complete month.
- `action`: `add` (with `location`, `group`), `remove`, `group` or `location`.
> Add rival.com to my portfolio as a competitor in the UK

### `refresh_portfolio` [paid]
Fetch the portfolio data.
- **Quotes first:** calls and cost per endpoint family, nothing spent. With `confirm: true` it runs as a job and records actual spend.
- **`tier`:** `weekly` (bulk: estimates, Domain Rank, links, search-results mix; cents for the portfolio), `monthly` (per domain: history, countries, top pages, AI mentions and citations; about $0.68 each) or `all`.
- **Budget:** a manual run counts toward any scheduled budget, and is refused over the cap unless `overBudget: true`.
> Refresh my SEO Console portfolio

### `schedule_portfolio_refresh` [paid]
Weekly and monthly refreshes under a monthly budget cap, set up in two steps: a preview, then `confirm: true`.
- Runs in the MCP process, or in the job runner under the Docker gateway. Two processes never run it twice.
- A run whose cost grew more than 25% since you agreed is skipped until you re-confirm.
- `enabled: false` turns scheduling off.
> Schedule a weekly portfolio refresh with a $10 a month budget

### `get_portfolio`
The portfolio dashboard in chat. Give it a `domain` to open that domain's overview. Free: stored data only.
> Show me the portfolio overview for ehi.com.au

## Competitive and keyword data (DataForSEO)

All **[paid]** except `trend_categories` and the free Google News source in `news_discovery`; all cached 20 days, all on-demand. Full workflows in [competitive.md](competitive.md).

### `keyword_volume`
True monthly search volume, CPC and competition for up to 700 keywords. How you size an opportunity before writing a word.
> What's the search volume for "standing desk" and "sit stand desk"?

### `related_terms`
People Also Ask questions and related searches for a keyword, from a live SERP call.
> Related terms for "ergonomic chair"

### `search_intent`
Classifies keywords as informational / navigational / commercial / transactional, with probabilities. Pass your `siteUrl` to persist the intents - that's what unlocks the intent-vs-pagetype-mismatch check (a product page ranking for a how-to query, and the reverse).
> Classify the intent of my top 50 queries and save them for mysite.com

### `youtube_discovery`
The YouTube videos ranking for a keyword, from a live DataForSEO YouTube SERP: title, channel, views, publish date, duration and shorts/live flags, in rank order. The video-research step - find what's winning, then watch the top few to see what they actually cover.
> Which YouTube videos rank for "sim racing cockpit setup"?

### `news_discovery`
Recent news articles for a keyword: title, source, publish time and URL. Two sources: Google News (the free, keyless RSS search feed) and the paid DataForSEO Google News SERP. The default, `source:"both"`, merges and de-duplicates them (without DataForSEO credentials it's Google News alone); `source:"google"` is free and needs no key, `source:"dataforseo"` uses the paid SERP only. `depth` sets how many results (default 20). Answers "what's been published on this since {date}" - the freshness / what-changed check before an update.
> What news is there on "direct drive wheelbase" this month?

### `topic_trend`
Google Trends relative interest (0-100) over time, with a rising / falling / flat read. Give up to five keywords, a `categoryCode` (find it with `trend_categories`), or both: keywords alone search every category; keywords plus a category narrow a term to one industry (for example "jaguar" inside Autos); a category on its own returns interest across the whole market, no keyword needed. Set `related: true` (at most one keyword) to add the top and rising related topics and queries - the category-only form is how you see what is breaking out across a market. Answers "is this topic growing or fading, and is it seasonal" - whether a page is worth updating now, and when to publish. timeRange presets run from past_7_days to 2004_present; type can be web, news, youtube, images or froogle.
> Is interest in "sim racing" rising or falling over the last 5 years?
> Is the Software category rising in the UK, and what's breaking out in it?

### `trend_categories`
Free (a no-charge DataForSEO endpoint), but it needs DataForSEO credentials. Search the Google Trends category tree (~1,400 categories) by name and get the codes `topic_trend` takes, each with its parent so you can pick the right level. Omit the query to list the top-level categories.
> What's the Google Trends category code for software?

### `page_lighthouse`
A live Lighthouse run for one URL: lab Core Web Vitals, category scores and the top time-saving opportunities. Slow (20-120s) and one of the pricier calls, so it's strictly per-URL on request. Pass `siteUrl` to persist the CWV, which unlocks the high-yield-cwv-fail check.
> Run Lighthouse on https://mysite.com/slow-page and save it for mysite.com

### `competitors_domain`
Who you measurably compete with - domains ranked by keyword overlap with yours, not by who you assume. The seed list for gap analysis.
> Find competitors for mysite.com in the UK

### `page_intersection`
The page-level content gap: keywords competitor pages rank for that yours doesn't. Competitor URLs support wildcards (`https://rival.com/blog/*`).
> Content gap between rival.com/guide and my /guide page

### `domain_visibility`
Monthly ranking-keyword distribution and estimated traffic volume for **any** domain or subdomain - no Search Console access needed. The organic overview, with a trend verdict. `months` sets the history (default 12, up to 24; longer windows cost more). It takes `languageName` (e.g. "English") rather than `languageCode`. Grain: month × domain.
> Show visibility over time for competitor.com

### `top_pages`
Any domain's top organic pages by estimated traffic, with keyword counts and top-3/top-10 splits. Works on competitors.
> Top pages on competitor.com

### `ranked_keywords`
Every keyword a target ranks for - scoped to a whole domain, a subdomain, one URL (`scope:url`), or a subfolder (`scope:folder`, `folder:"/blog/"`). Rows carry position, volume, ETV, the ranking URL, keyword difficulty, intent and SERP features. `aioOnly:true` narrows it to keywords where the target ranks **and the SERP shows a Google AI Overview** - your AI Overview exposure list, which as far as I know almost nothing else surfaces. It's exposure, not citation: the Labs data doesn't say whether the target is quoted in the Overview. Checking that is a SERP call per keyword (the SERP recipe in [composition.md](composition.md), or `recon_targets`). Joins to your GSC data on the keyword.
> What does competitor.com/blog/ rank for?
> Which of mysite.com's keywords show an AI Overview?

### `topic_gaps`
The bigger question: what should this site cover to be seen as expert in its space? Pulls competitor keyword footprints (at most 4 bounded, cached Labs calls), subtracts every query you already appear for and every topic your pages already cover, clusters what survives, and ranks the topics by volume × competitor coverage - each with the owning competitor, an example of their winning page, and your nearest page to build from. Name competitors yourself (max 3) or let it derive the top two from ranking overlap. Needs synced GSC data.
> What topics should mysite.com cover? Compare against rival.com

### `pull_backlinks`
Your backlink profile - summary metrics plus per-page backlink and referring-domain counts - with a live HTTP status check on each linked page, so backlinks pointing at 404s get caught (`backlinks-to-404` in the next audit). It also fills the dashboard's Links tab: the referring domains (live and lost, with DataForSEO rank, spam score and first-seen date) go to `referring_domains`, every anchor text goes to `backlink_anchors` classified as branded, keyword, URL, generic or empty, and twelve months of monthly new/lost history go to `backlink_history`. Those are three more cheap Backlinks calls, each cached 20 days and each reported on its own if it fails, so one missing endpoint never zeroes the others; `profile:false` skips them, and `domainLimit`, `anchorLimit` and `historyMonths` size them. Each pull is a dated snapshot, so re-pulling builds a trend. One gotcha: Backlinks is a **separate DataForSEO subscription** from SERP/Keywords/Labs; if it isn't activated the tool says so plainly. With `MAJESTIC_API_KEY` set, the most-backlinked URLs (up to 500) also get Majestic Trust Flow, Citation Flow and Topical Trust Flow, which the dashboard's Trapped authority report uses. Runs as a background job (poll `check_sync_status`).
> Pull the backlinks for mysite.com

### `link_intersect`
The links your competitors have that you don't - the classic outreach prospect list. One DataForSEO `domain_intersection` call over the competitor set (excluding your domain) returns every domain linking to your rivals but not to you, aggregated per prospect: how many of them it links to, its domain trust, worst spam score, whether the link is followed, the anchor mix. Sorted the way a link builder works - **followed links first, then domain trust**, spam filtered. Pass a single company (`competitors:["companyx.com"]`) to answer "what links does company X have that we don't?". Needs the separate Backlinks subscription. Pass competitors explicitly (max 20) or let it derive them from ranking overlap. Tuning: `poolLimit` (rows pulled, default 300), `minIntersections`, `maxSpamScore` (default 30), `dofollowOnly`, `topN` (returned and persisted, default 100), `sort:"intersections"` to lead with the broadest overlap instead. Results persist to `link_prospects`; `data_storage` flags when the set is going stale (rivals keep earning links).
> Link intersect for mysite.com vs rival1.com, rival2.com
> What links does rival.com have that we don't?

**The Majestic tier (optional, and worth it if you do outreach).** DataForSEO's domain rank measures link *volume*, which floats directories and syndicated press to the top of a prospect list. Set `MAJESTIC_API_KEY` and every qualifying prospect is enriched from [Majestic](https://majestic.com) with **Trust Flow** (0-100 editorial authority - the directory killer; a domain DataForSEO ranks 227 can be Trust Flow 0) and **Topical Trust Flow** (what that authority is *about*, as ranked topics), and the list **re-sorts by Trust Flow**. You can see it's on from the output: the `Domain trust` column becomes `Trust Flow` and a `Top topic` column appears. `enrichLimit` (default 100, max 500) caps how many prospects go to Majestic - they're batched 100 per call at roughly a unit each, and if more qualified than were enriched the response says so rather than quietly truncating. Cached for `MAJESTIC_CACHE_DAYS` (default 30). Without the key nothing breaks; you just get the DataForSEO ordering. Full write-up: [competitive.md](competitive.md#the-directory-problem-and-the-majestic-fix). (Trust Flow and Topical Trust Flow are Majestic's trademarked metrics.)
> Link intersect for mysite.com vs rival1.com, rival2.com, enrich the top 300 prospects

### `market_sizing`
Market Sizing and Prioritisation: your domain plus one to four named competitors (`competitors` is required), one cached Labs pull each, unioned into a keyword universe. Returns total monthly demand (deduplicated volume), each domain's share of voice (ETV share) overall and per topic cluster, and the leader per cluster - the "here's the market, here's who owns it, here's where to attack" table that opens an engagement.
> Size the market: mysite.com vs rival1.com and rival2.com

### `serp_features`
The SERP-feature footprint: how much of your keyword universe carries each feature - AI Overviews, featured snippets, People Also Ask, shopping, video - weighted by search volume, and how much of that volume you already rank page 1 for. One cached Labs pull. Answers "how exposed are we to AI Overviews and zero-click?" with real numbers.
> What's our AI Overview exposure on mysite.com?

## Content and recon

### `keyword_list`
Demand-first keyword clustering, from stored data, no paid calls. Give it a keyword list (or let it use your top GSC queries) and it clusters them by the page Google already answers them with, then a verdict per cluster: **own** (position ≤3), **weak** (4-20), **absent** (no ranking page), with the ranking URL and 90-day impressions. The keyword-research workhorse - paste a client list, get the topic map and where you stand.
> Cluster these keywords for mysite.com: [ ... ]

### `content_opportunities`
The content marketer's report, composed from stored data. Four sections: **write next** (demand you already earn impressions for with no winning page), **refresh now** (pages bleeding clicks), **rewrite snippets** (page-1 rankings under-clicked), **strengthen** (clusters at position 4-20). Every row traces to real Search Console data.
> Content opportunities for mysite.com

### `recon_targets`
Content recon - *why* a page is losing, and what to do. For your striking-distance pages (auto-selected: the top query per page at positions 3-15, highest impressions first, at least `minImpressions` (default 300); or pass `urls`, which need Search Console data in the last 28 days), it fetches your live page with the crawler, pulls the live Google SERP (DataForSEO SERP-advanced), and classifies the cause on the **organic-rank × AI-Overview-citation** matrix: *defend-and-deepen* (cited and strong), *accuracy-or-freshness* (you rank but the AI Overview won't quote you - the sharpest class), *consolidate-weak-page*, *competitive-gap*, or *page-cannot-rank* (the crawl says the URL is noindex or canonicalised away, so the fix is resolving the duplicate, not a content plan). It seeds deterministic to-dos (schema, freshness, cannibalisation, video) and returns the competitor set. Set `scrapeCompetitors:true` to fetch them too - free, no API key: Reddit through its own JSON, other pages through a browser-profile fetch, and the ranking videos listed for you to watch (a video page has no readable text over HTTP). `competitorLimit` (default 5, max 12) caps the fetches per page, and anything over the cap is listed as skipped; `crawlAs:"googlebot"` swaps the fetch's browser profile for Googlebot's. Cloudflare-challenge sites (PCMag) can't be fetched from a server and are flagged so you can paste their copy. Pass `location` to match where your impressions come from - organic rank is location-sensitive. `limit` sets the pages per batch (default 5, max 50). It runs as a background job (poll `check_sync_status`), and each page lands in the to-do ledger as it completes. Paid: ~$0.004 of DataForSEO per page, plus a small refundable surcharge for loading AI Overviews that arrive asynchronously.
> Run content recon on mysite.com, location United Kingdom

### `save_recon_todo`
Writes the content-gap and originality findings from the research session (the competitor diff) back into the ledger for a page, with a baseline snapshot so the fix's effect on rank and AIO citation is measurable later.
> Save these gaps for /my-page: [ ... ]

### `recon_todos`
The recon to-do board. List (optionally filtered by page or status), grouped by page with each page's verdict - the pick-a-page-to-work-on surface and the hand-off to your content pipeline. With an `id`: update a to-do's status (open → researching → drafted → shipped → dismissed) and append a dated annotation. On `status:shipped remeasure:true` it re-fetches the SERP and records whether you moved from AIO-uncited to cited, or up the ranks.
> Show my recon to-dos for mysite.com

## Monitoring

### `detect_changes`
Diffs your two most recent crawls, per URL, severity-classified: a 200 that became a 404 and a noindex that appeared are critical, a canonical flip is high, a title change is medium. Refresh on a schedule and this is your regression monitor - during a migration it's the difference between catching a stray noindex on Tuesday and explaining a traffic graph three weeks later. Needs at least two crawls.
> Detect changes on mysite.com

## Dashboard and reporting

### `get_dashboard`
The interactive dashboard, rendered right in the chat: eight tabs - summary, issues & fixes, crawl health, network, search performance, opportunities, links and content research. What each tab shows: [dashboard.md](dashboard.md). Needs synced data.
> Show me the dashboard for mysite.com

### `serve_dashboard`
The same dashboard, served on a localhost-only webserver so you can open it in a real browser tab: live data straight from the local database (always current, unlike an exported snapshot), a property switcher, and working CSV downloads. Localhost only - nothing is exposed to the network. A random free port unless you pass `port` (or set `SAC_DASHBOARD_PORT`); `stop:true` shuts it down.
> Serve the dashboard for mysite.com

### `open_dashboard`
One obvious way to say "show me the dashboard": it starts the local dashboard server if it isn't running and returns the property's link. Syncs, crawls, inspections, CrUX pulls and refreshes run in the server's own process do this themselves when they finish (jobs run by the external job runner don't), so the completed job's status says the dashboard is updated and gives the link (`run_audit` appends the link too). If the server can't start, it points you at `get_dashboard`, which renders the dashboard in chat. Behind the Docker MCP gateway a link served from inside the container isn't reachable from your machine. The server detects that (a container, with no published `SAC_DASHBOARD_BIND=0.0.0.0` + `SAC_DASHBOARD_PORT`) and, instead of the link, says it only works inside the container and gives the `docker run` line for the standalone dashboard ([dashboard.md](dashboard.md#in-your-browser)), or `get_dashboard` to see it in chat. `SAC_AUTOSERVE=0` stops the automatic start after jobs, but an explicit `open_dashboard` still starts the server, like `serve_dashboard`.
> Open the dashboard for mysite.com

### `get_dashboard_data`
Internal - the widget fetches its own dataset through this so the full payload never hits the model's token limits. Not for direct use; listed here so you know what it is when you see it.

### `export_report`
The same dashboard as one self-contained HTML file, written to your reports folder. Open it in any browser, email it to a client - nothing to install at their end.
> Export the report for mysite.com

## Utilities

### `seo_audit_help`
The full feature menu with an example prompt for each. The thing to ask when you've forgotten what's possible.
> run seo_audit_help

### `composition_cookbook`
The data-surface map - every source with its grain, dimensions, join keys, freshness and cost - plus worked multi-source recipes. Static, free, no API calls. Claude reads this before planning any bespoke cross-source question; you can read the expanded version at [composition.md](composition.md).
> Show me the composition cookbook

### `normalize_url`
Returns the `url_key` for any URL - the normalised join key everything matches on. Useful when you're debugging why two URLs did or didn't join.
> What's the url_key for https://www.mysite.com/page?utm_source=x

### `data_location`
Reports where the per-property databases live, or sets a new location (persisted; restart the client to apply).
> Where is my audit data stored?

### `data_storage`
The data-hygiene view: every property database with its size, key row counts (GSC rows, pages, links, snapshots, findings) and last sync/crawl dates, plus each `link_intersect` prospect set with its capture date (flagged once it's past 20 days - rivals keep earning links, so an old prospect list is a misleading one), the per-service caches (DataForSEO, Majestic, Wikidata) and the reports folder. When something's grown too big, `prune` offers three actions per property: `vacuum` (compact the file, reports bytes reclaimed), `clear-crawl-history` (drop snapshots and audit runs older than the five most recent, then vacuum), and `delete-property` (remove the database entirely). The destructive two require `confirm:true` and refuse loudly without it, naming exactly what would go; they refuse while any job may still be running (one with a heartbeat in the last 30 minutes), not just a sync or crawl. Search Console segment rows (`search_analytics_segments`) are counted beside the totals. Each property shows its GSC storage state: `migrated` (the 0.16 layout), `pending` (the next sync migrates it), `migrating` (interrupted; the next sync resumes), or `deferred` with the reason (the last attempt found too little free disk, and how much it needed). Backups (`<db>.bak-<stamp>`: the 0.16 storage migration's, a repair's, or your own) are listed per property with their size and date, the migration's marked, and counted in the total. Each is a full copy, so delete it yourself once you've confirmed the migration or repair went through (see [Upgrading to 0.16.0](../README.md#upgrading-to-0160)). The empty `-wal`/`-shm` files 0.16.0 left beside its backup are removed when this view runs. `lastCrawl` is the last *completed* crawl; a run that failed or died is listed separately.

**Integrity and repair.** If a sync keeps failing with "database disk image is malformed", run `data_storage` with `check:true` for the property. It runs SQLite's full `integrity_check` as a background job (minutes on a multi-GB file; `check:"quick"` is faster but misses damaged index rows) and names any damaged index. `prune` with `action:"repair"` and `confirm:true` then backs up the file, rebuilds only the damaged indexes and re-checks. Damage in table data rather than an index is reported, never papered over.
> How much disk is my audit data using?
> Vacuum the mysite.com database
> Clear the old crawl history for mysite.com
