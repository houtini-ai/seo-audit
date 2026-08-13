# Tool reference

Every tool the server exposes, grouped by job. Each entry gives you what it does, the inputs that matter, the data grain and join keys where they're relevant, and a prompt you can copy. You never call these by name unless you want to - *"run an SEO audit on mysite.com"* routes to the right tool on its own - but knowing what exists is how you get the most out of it.

DataForSEO-backed tools are marked **[paid]**. They cost real money per live call (fractions of a cent to a few cents), are cached for 20 days, and only ever run when you ask - never in bulk behind your back. Setup and honest cost notes: [competitive.md](competitive.md). One tool, `link_intersect`, has a second optional service behind it - **Majestic**, billed in its own resource units - which switches on when `MAJESTIC_API_KEY` is set and stays entirely out of the way when it isn't.

## The data pipeline

These fill the local database. Long operations run as background jobs - you get a job id back and poll it (or just carry on; Claude checks for you).

### `list_properties`
Lists the Search Console properties the service account can see. Your connectivity check.
> List my Search Console properties

### `refresh_property`
The "sync everything" verb: GSC sync → site crawl → URL inspection → rank history, one background job with a live progress panel. GSC sync is **incremental** - the first run pulls the window (default last 90 days; pass `startDate` to go deeper), later runs fetch only the new days. Set `segments:true` to also pull device/country breakdowns (heavier on large sites), `full:true` to force a complete re-pull, or turn individual phases off (`crawl:false` etc.).
> Refresh sc-domain:mysite.com
> Refresh mysite.com but skip the crawl

### `sync_gsc`
Just the Search Console history. Grain: date × query × page (plus device/country with `segments:true`). Joins to everything else on `page_key` (the normalised URL) and `query`. Same incremental behaviour as above; `searchType` covers web, discover, news, image and video.
> Sync Search Console data for mysite.com back to 2024-01-01

### `start_crawl`
Just the crawl. Fetches the site into the local database: status, titles, H1s, metas, canonicals, robots, structured data, hreflang, redirect chains, body text by section, then computes internal PageRank, click depth and in-degree. Discovery is links + sitemaps + every URL Google already knows about from GSC. Respects robots.txt; assets are checked without downloading their bytes; search/cart/login junk is skipped. `excludePatterns` adds your own skip regexes, `maxPages` caps it. Grain: one row per `url_key`, latest crawl only (history lives in snapshots, see `detect_changes`).
> Crawl mysite.com, 500 pages max
> Crawl mysite.com but exclude /author/ and /tag/

### `inspect_urls`
Just the GSC URL Inspection data: Google's own view of coverage, indexing, its chosen canonical versus yours, and the last crawl time. Quota-limited, so it samples your top pages by clicks. Grain: one row per inspected URL.
> Inspect the top 100 URLs on mysite.com

### `track_ranks` [paid]
Ingests the DataForSEO monthly rank distribution and estimated traffic value into `rank_history`, so rank charts get a real time axis reconciled with your GSC dates. One call per refresh, cached 20 days. Pass `location` once ("United Kingdom", "Australia", or a code) - it's saved per property.
> Track ranks for mysite.com in the UK

### `check_sync_status` / `check_crawl_status`
Poll a job by id, or list recent jobs. Sync, inspection, backlinks and entity jobs report through `check_sync_status`; crawls through `check_crawl_status`.
> Check the crawl status

## The audit

### `run_audit`
Runs the full check registry over the joined data and returns scored findings ranked by expected clicks per developer-hour: priority = (traffic at stake × yield × certainty) / effort. `categories` filters (crawlability, indexation, onpage, content, schema, security, performance, merged); `includeJudgement:true` adds the heuristic (N) checks, which are off by default.
> Run an SEO audit on mysite.com
> Run an SEO audit on mysite.com, indexation and schema only, with judgement findings

### `query_audit`
One named check, with every affected URL and its full evidence. The drill-down after `run_audit` shows you a headline. For big result sets: `columns` narrows the evidence to just the keys you name, long values are truncated at 120 characters (with a visible ellipsis), and `offset` + `limit` page through the rest - the response always states *showing X-Y of TOTAL* so nothing is silently dropped.
> Show me striking-distance for mysite.com
> Run the keyword-cannibalisation check on mysite.com with evidence

### `list_checks`
The whole check catalogue - all 93, with categories and labels. The same list, annotated, is [checks.md](checks.md).
> What does the audit check for?

### `list_templates`
Clusters crawled pages into templates by URL shape and schema type, each with a page count and a representative example. Most technical issues live at the template level - one fix corrects every page in the cluster - so this is the map for working on anything bigger than a few hundred URLs.
> List the page templates on mysite.com

## Raw data

### `query_data`
Direct, read-only access to the property database, built around one principle: **aggregate in the database and return answers, not rows**. The default mode groups by the columns you name and returns counts, percentages and sum/avg/min/max metrics - "status codes by folder", "clicks by page", "coverage states by verdict" - each as one small table with an honest total line, however many rows sit underneath. Tables: `pages`, `links`, `search_analytics`, `url_inspection`, `sitemap_urls`, `findings`, `image_assets`, `page_backlinks`. Filters (equals, ranges, like, in) are always parameterised, and every column name is validated against the live schema - there's no way to smuggle SQL in. `mode:rows` returns raw rows when you genuinely need them, with a curated default column set, 120-character cells and a *showing X-Y of TOTAL; next offset N* footer.
> How do status codes break down on mysite.com?
> Top 10 pages by total clicks from the raw GSC data
> Show me the 404 rows with their inlink counts

## Fixes

### `fix_finding`
The finding-to-fix step. Give it a finding id from `run_audit` (or a check + URL) and it returns a paste-ready artefact built from your own data: a complete JSON-LD block for missing or invalid schema, an exact-match 301 rule (`.htaccess`, nginx or Next.js flavour) using the destination the crawler recorded, or internal-link suggestions ranked by the donor page's internal PageRank. Redirect chains get collapsed to single hops. Everything is dry-run: it returns artefacts, it never writes to your site.
> Generate the fix for finding 12
> Write the redirect rule for /old-page in nginx format

Checks without a generator return their deterministic fix guidance instead, so the tool always answers.

## Growth and content

### `suggest_pages`
Proposes new pages from demand Google has already shown you: queries where you get impressions at rank 11+ with no winning page, after subtracting everything you already cover. Survivors are clustered into one proposed page per intent, scored by impressions × intent, each with the nearest existing page to link the new one from so nothing launches as an orphan. Works entirely from your synced data - no paid calls. (Run `search_intent` with your `siteUrl` first if you want the intent weighting.)
> Suggest new pages for mysite.com

### `resolve_entities`
Maps each top page's primary topic (from its H1, falling back to the title) to a Wikidata entity, and stores the relationships between them. Unlocks the entity-internal-link-gap finding: pages whose topics are related but which never link to each other. Free (public Wikidata API), cached about 45 days, and honest about being a heuristic - its findings are judgement-labelled and gated behind `includeJudgement`.
> Resolve entities for mysite.com

## AI-search readiness

### `score_passages`
The flagship AI-search check. A small local relevance model (a cross-encoder reranker, ~25MB one-time download, no Python, runs on your machine) reads each ranking page's sections against its top query and scores whether any single passage densely answers it. It's a classifier, not a generator - it scores relevance and cannot hallucinate. Pages that rank on demand they never answer become `weak-passage-answer` findings in the next audit. About 0.6s per page; `limit` and `minImpressions` bound the run. Re-run after a re-crawl.
> Score the passages on mysite.com

### `draft_content`
The follow-through. Builds a grounded writing brief for a weak page: the query gap, the page's own paragraphs as voice exemplars, and its most query-relevant passages as the only permitted facts. Claude then drafts the missing answer in *your site's* voice, told to invent nothing. Omit the URL and it targets the weakest-scoring page.
> Draft the missing content for /sim-racing-wheels

### `check_agent_readiness`
Is your site ready for AI agents? Live HTTP probes of your origin scoring four categories - discoverability (robots rules, sitemap, Link headers), content (`llms.txt`, `agents.md`, Markdown negotiation), bot access control (AI-bot rules, Content Signals, Web Bot Auth) and capabilities (MCP server card, Agent Skills, API catalogue, OAuth discovery). Returns 0-100, a level, and copy-paste fixes for everything missing. No crawl or GSC data needed, and it isn't fooled by a catch-all route that returns 200 for everything.
> Check agent readiness for mysite.com

## Competitive and keyword data (DataForSEO)

All **[paid]**, all cached 20 days, all on-demand. Full workflows in [competitive.md](competitive.md).

### `keyword_volume`
True monthly search volume, CPC and competition for up to 700 keywords. How you size an opportunity before writing a word.
> What's the search volume for "standing desk" and "sit stand desk"?

### `related_terms`
People Also Ask questions and related searches for a keyword, from a live SERP call.
> Related terms for "ergonomic chair"

### `search_intent`
Classifies keywords as informational / navigational / commercial / transactional, with probabilities. Pass your `siteUrl` to persist the intents - that's what unlocks the intent-vs-pagetype-mismatch check (a product page ranking for a how-to query, and the reverse).
> Classify the intent of my top 50 queries and save them for mysite.com

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
Monthly ranking-keyword distribution and estimated traffic value for **any** domain or subdomain - no Search Console access needed. The Semrush-style organic overview, with a trend verdict. Grain: month × domain.
> Show visibility over time for competitor.com

### `top_pages`
Any domain's top organic pages by estimated traffic, with keyword counts and top-3/top-10 splits. Works on competitors.
> Top pages on competitor.com

### `ranked_keywords`
Every keyword a target ranks for - scoped to a whole domain, a subdomain, one URL (`scope:url`), or a subfolder (`scope:folder`, `folder:"/blog/"`). Rows carry position, volume, ETV, the ranking URL, keyword difficulty, intent and SERP features. `aioOnly:true` narrows it to keywords where the target is **ranked where the SERP shows a Google AI Overview (exposure; per-keyword citation checking is the SERP recipe in composition.md)** - the "which keywords cite us in AIO" view, which as far as I know almost nothing else surfaces. Joins to your GSC data on the keyword.
> What does competitor.com/blog/ rank for?
> Which keywords cite mysite.com in AI Overviews?

### `topic_gaps`
The bigger question: what should this site cover to be seen as expert in its space? Pulls competitor keyword footprints (at most 4 bounded, cached Labs calls), subtracts every query you already appear for and every topic your pages already cover, clusters what survives, and ranks the topics by volume × competitor coverage - each with the owning competitor, an example of their winning page, and your nearest page to build from. Name competitors yourself (max 3) or let it derive the top two from ranking overlap. Needs synced GSC data.
> What topics should mysite.com cover? Compare against rival.com

### `pull_backlinks`
Your backlink profile - summary metrics plus per-page backlink and referring-domain counts - with a live HTTP status check on each linked page, so backlinks pointing at 404s get caught (`backlinks-to-404` in the next audit). One gotcha: Backlinks is a **separate DataForSEO subscription** from SERP/Keywords/Labs; if it isn't activated the tool says so plainly. Runs as a background job.
> Pull the backlinks for mysite.com

### `link_intersect`
The links your competitors have that you don't - the classic outreach prospect list. One DataForSEO `domain_intersection` call over the competitor set (excluding your domain) returns every domain linking to your rivals but not to you, aggregated per prospect: how many of them it links to, its domain trust, worst spam score, whether the link is followed, the anchor mix. Sorted the way a link builder works - **followed links first, then domain trust**, spam filtered. Pass a single company (`competitors:["companyx.com"]`) to answer "what links does company X have that we don't?". Needs the separate Backlinks subscription. Pass competitors explicitly (max 20) or let it derive them from ranking overlap. Tuning: `poolLimit` (rows pulled, default 300), `minIntersections`, `maxSpamScore` (default 30), `dofollowOnly`, `topN` (returned and persisted, default 100), `sort:"intersections"` to lead with the broadest overlap instead. Results persist to `link_prospects`; `data_storage` flags when the set is going stale (rivals keep earning links).
> Link intersect for mysite.com vs rival1.com, rival2.com
> What links does rival.com have that we don't?

**The Majestic tier (optional, and worth it if you do outreach).** DataForSEO's domain rank measures link *volume*, which floats directories and syndicated press to the top of a prospect list. Set `MAJESTIC_API_KEY` and every qualifying prospect is enriched from [Majestic](https://majestic.com) with **Trust Flow** (0-100 editorial authority - the directory killer; a domain DataForSEO ranks 227 can be Trust Flow 0) and **Topical Trust Flow** (what that authority is *about*, as ranked topics), and the list **re-sorts by Trust Flow**. You can see it's on from the output: the `Domain trust` column becomes `Trust Flow` and a `Top topic` column appears. `enrichLimit` (default 100, max 500) caps how many prospects go to Majestic - they're batched 100 per call at roughly a unit each, and if more qualified than were enriched the response says so rather than quietly truncating. Cached for `MAJESTIC_CACHE_DAYS` (default 20). Without the key nothing breaks; you just get the DataForSEO ordering. Full write-up: [competitive.md](competitive.md#the-directory-problem-and-the-majestic-fix). (Trust Flow and Topical Trust Flow are Majestic's trademarked metrics.)
> Link intersect for mysite.com vs rival1.com, rival2.com, enrich the top 300 prospects

### `market_sizing`
Market Sizing and Prioritisation: your domain plus up to four named competitors, one cached Labs pull each, unioned into a keyword universe. Returns total monthly demand (deduplicated volume), each domain's share of voice (ETV share) overall and per topic cluster, and the leader per cluster - the "here's the market, here's who owns it, here's where to attack" table that opens an engagement.
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
Content recon - *why* a page is losing, and what to do. For your worst declining / striking-distance pages (auto-selected, or pass `urls`), it fetches your live page with the crawler, pulls the live Google SERP (DataForSEO SERP-advanced), and classifies the cause on the **organic-rank × AI-Overview-citation** matrix: *defend-and-deepen* (cited and strong), *accuracy-or-freshness* (you rank but the AI Overview won't quote you - the sharpest class), *consolidate-weak-page*, or *competitive-gap*. It seeds deterministic to-dos (schema, freshness, cannibalisation, video) and returns the competitor set. Set `scrapeCompetitors:true` to fetch them too - videos to Supadata for transcripts, pages to Firecrawl ([get a key](https://firecrawl.link/2d1PLD8)) with a free browser-profile fetch behind it that even gets Reddit. Cloudflare-challenge sites (PCMag) can't be fetched from a server and are flagged so you can paste their copy. Pass `location` to match where your impressions come from - organic rank is location-sensitive. Paid: ~$0.004 of DataForSEO per page.
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
The interactive dashboard, rendered right in the chat: six tabs of findings, crawl health, opportunities, search performance and architecture. What each tab shows: [dashboard.md](dashboard.md). Needs synced data.
> Show me the dashboard for mysite.com

### `serve_dashboard`
The same dashboard, served on a localhost-only webserver so you can open it in a real browser tab: live data straight from the local database (always current, unlike an exported snapshot), a property switcher, and working CSV downloads. Localhost only - nothing is exposed to the network. `stop:true` shuts it down.
> Serve the dashboard for mysite.com

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
The data-hygiene view: every property database with its size, key row counts (GSC rows, pages, links, snapshots, findings) and last sync/crawl dates, plus each `link_intersect` prospect set with its capture date (flagged once it's past 20 days - rivals keep earning links, so an old prospect list is a misleading one), the per-service caches (DataForSEO, Majestic, Firecrawl, Supadata, Wikidata) and the reports folder. When something's grown too big, `prune` offers three actions per property: `vacuum` (compact the file, reports bytes reclaimed), `clear-crawl-history` (drop snapshots and audit runs older than the five most recent, then vacuum), and `delete-property` (remove the database entirely). The destructive two require `confirm:true` and refuse loudly without it, naming exactly what would go; nothing runs while a sync or crawl job is in flight.
> How much disk is my audit data using?
> Vacuum the mysite.com database
> Clear the old crawl history for mysite.com
