# DataForSEO functions

Everything SEO Audit Console does with *market* data goes through [DataForSEO](https://dataforseo.com/?aff=213701) — a pay-as-you-go API for search volumes, live SERPs, competitor data, backlinks and Lighthouse. The SERP/Keywords/Labs APIs need no subscription; calls cost fractions of a cent to a few cents and are **cached locally for 20 days**, so a repeat question is free and nothing runs unless you ask. (Backlinks is a separate DataForSEO subscription — see the last section.)

Set `DATAFORSEO_USERNAME` + `DATAFORSEO_PASSWORD` ([getting-started](getting-started.md#environment-variables)). Each tool below names the DataForSEO endpoint (or endpoints) it calls, so you can price it against DataForSEO's own docs.

## Keywords Data — cheap, 20-day cached

### `keyword_volume`
True monthly search volume, CPC and competition for up to 700 keywords. How you size an opportunity before writing a word.
Endpoint: `/v3/keywords_data/google_ads/search_volume/live`
> What's the search volume for "standing desk" and "sit stand desk"?

### `topic_trend`
Google Trends relative interest (0–100) over time, with a rising / falling / flat read. Give up to 5 keywords, a `categoryCode` (find it with `trend_categories`), or both: keywords alone search every category; keywords + a category narrow a term to one industry (e.g. "jaguar" inside Autos); a `categoryCode` on its own returns interest across the whole market, no keyword needed. `related: true` (at most one keyword) adds the top + rising related topics and queries — the category-only form surfaces what is breaking out across a market. Answers "is this growing or fading, and is it seasonal" — whether a page is worth updating now, and when to publish. `timeRange` runs `past_7_days` → `2004_present`; `type` can be web / news / youtube / images / froogle.
Endpoint: `/v3/keywords_data/google_trends/explore/live`
> Is interest in "sim racing" rising or falling over the last 5 years?
> Is the Software category rising in the UK, and what's breaking out in it?

### `trend_categories`
Free (the endpoint costs nothing, though it still needs your DataForSEO credentials). Search the Google Trends category tree (~1,400 categories) by name for the codes `topic_trend` takes, each with its parent so you pick the right level. Omit the query to list the top-level categories.
Endpoint: `/v3/keywords_data/google_trends/categories` (cost 0)
> What's the Google Trends category code for software?

## SERP — a live call PER keyword

Use for a handful of explicit keywords, never a list.

### `related_terms`
People Also Ask questions and related searches for one keyword.
Endpoint: `/v3/serp/google/organic/live/advanced`
> Related terms for "ergonomic chair"

### `youtube_discovery`
The YouTube videos ranking for a keyword — title, channel, views, publish date, duration, shorts/live flags, in rank order. The video-research step: find what's winning, then transcribe the top few to mine what they say.
Endpoint: `/v3/serp/youtube/organic/live/advanced`
> Which YouTube videos rank for "sim racing cockpit setup"?

### `news_discovery`
Recent news articles for a keyword — title, source, publish time and URL. The "what's been published on this since {date}" / freshness check. The paid DataForSEO News SERP is one of two sources: Google News' own RSS search feed is free and needs no key. The default `source:"both"` merges the two (calling DataForSEO only when your credentials are set); `source:"google"` is the free lookup alone.
Endpoint: `/v3/serp/google/news/live/advanced` (+ the free Google News feed)
> What news is there on "direct drive wheelbase" this month?


## DataForSEO Labs — cheap, 20-day cached, top-down

ONE `ranked_keywords` call answers "what does this domain rank for" — never loop keywords through the SERP endpoints to reconstruct what a Labs call returns.

### `search_intent`
Classifies keywords informational / navigational / commercial / transactional, with probabilities. Pass `siteUrl` to persist the intents — that unlocks the intent-vs-pagetype-mismatch check.
Endpoint: `/v3/dataforseo_labs/google/search_intent/live`
> Classify the intent of my top 50 queries and save them for mysite.com

### `ranked_keywords`
Every keyword a domain / subdomain / URL / subfolder ranks for, with position, volume, ETV, difficulty, intent and SERP features. The Semrush "keywords a page or site ranks for" view, on any site. `aioOnly:true` lists only keywords whose SERP shows an AI Overview.
Endpoint: `/v3/dataforseo_labs/google/ranked_keywords/live`
> What does competitor.com/blog/ rank for?

### `serp_features`
SERP-feature and AI-Overview exposure across your keyword universe, volume-weighted — how much of the market the SERP furniture (features, snippets, video, AIO) already absorbs, and how much of that volume you rank page 1 for. One `ranked_keywords` pull of the property's top-volume keywords (default 1,000), persisted for the dashboard - never a per-keyword SERP loop.
Endpoint: `/v3/dataforseo_labs/google/ranked_keywords/live`
> What's our AI Overview exposure on mysite.com?

### `market_sizing`
Your domain plus up to four named competitors, one `ranked_keywords` pull each, unioned into a keyword universe: total demand, share of voice overall and per topic cluster, and the leader per cluster.
Endpoint: `/v3/dataforseo_labs/google/ranked_keywords/live` (one call per domain, up to 5)
> Size the market: mysite.com vs rival1.com and rival2.com

### `topic_gaps`
The topics competitors rank for that you don't cover, after subtracting your GSC queries and existing pages.
Endpoint: `/v3/dataforseo_labs/google/ranked_keywords/live` per competitor (max 3), plus `competitors_domain` when you don't name them - four calls at most
> What topics should mysite.com cover?

### `competitors_domain`
The domains competing for your keyword footprint, ranked by overlap.
Endpoint: `/v3/dataforseo_labs/google/competitors_domain/live`
> Who competes with mysite.com organically?

### `domain_visibility`
A domain's ranking distribution over time — the trend line of how it's doing in the market. `months` sets the window (default 12, up to 24; billed per month returned).
Endpoint: `/v3/dataforseo_labs/google/historical_rank_overview/live`
> How has mysite.com's visibility moved this year?

### `track_ranks`
The same rank history for your own property, written to `rank_history` for the dashboard's search-visibility chart (full history back to October 2020). A background job; `refresh_property` runs it as its last phase whenever DataForSEO is configured (`ranks:false` skips it).
Endpoint: `/v3/dataforseo_labs/google/historical_rank_overview/live`
> Track ranks for mysite.com in the UK

### `top_pages`
A domain's top ranking pages by estimated organic traffic.
Endpoint: `/v3/dataforseo_labs/google/relevant_pages/live`
> What are competitor.com's best-performing pages?

### `page_intersection`
The page-level content gap: keywords any of the competitor pages rank for (up to 20, wildcards like `https://rival.com/blog/*` allowed), minus the ones your own pages (`excludePages`, up to 10) already rank for.
Endpoint: `/v3/dataforseo_labs/google/page_intersection/live`
> Content gap between rival.com/guide and my /guide page

## The portfolio - Labs + Backlinks + LLM Mentions

### `refresh_portfolio`
Fills the [portfolio](portfolio.md) for every owned and watched domain. It quotes first and spends nothing until you confirm. Prices below are measured on a live run (24 Oct 2026); cached responses cost nothing.

| Tier | Endpoints | Calls | Cost |
|---|---|---|---|
| Weekly | Labs `bulk_traffic_estimation` (one per country); Backlinks `bulk_ranks`, `bulk_referring_domains`, `bulk_backlinks`, `bulk_new_lost_referring_domains`; Labs `ranked_keywords` metrics (per domain) | about 6 + 1 per domain | 8 domains: $0.22 |
| Monthly | Labs `historical_rank_overview`, `domain_rank_overview` (all countries), `relevant_pages`; Backlinks `history`, `domain_pages`; LLM Mentions `historical` (AI Overviews + ChatGPT), `top_mentioned_pages`, `top_mentioned_domains` | 9 per domain | about $0.68 per domain |

**Account requirements:**
- **Three API families:** the portfolio needs **Labs**, **Backlinks** and **LLM Mentions** enabled on your DataForSEO account. LLM Mentions is the AI Optimization API: pay-as-you-go, no monthly minimum since July 2026.
- **Failures stay contained:** a family that isn't enabled fails on its own, and the cell says "not enabled" rather than showing a zero.
- **ChatGPT is US-only:** DataForSEO's ChatGPT mention data covers the United States only.
- **Not covered:** AI Mode, Gemini and Perplexity aren't in the mentions data at all.

### `schedule_portfolio_refresh`
Runs the two tiers on a cadence under a monthly budget cap that you confirm. The cap is checked between endpoint families, so a run can't overshoot it.

## OnPage

### `page_lighthouse`
A live Lighthouse run for one URL: lab Core Web Vitals, category scores and the top time-saving opportunities. Slow (20–120s) and one of the pricier calls, so strictly per-URL on request. Pass `siteUrl` to persist the CWV (unlocks the high-yield-cwv-fail check).
Endpoint: `/v3/on_page/lighthouse/live/json`
> Run Lighthouse on https://mysite.com/slow-page

## Backlinks — SEPARATE subscription

The DataForSEO **Backlinks** API is billed separately from SERP/Keywords/Labs. If it isn't activated these tools say so in plain English (a `40204` error) rather than throwing a code.

### `pull_backlinks`
Your property's backlink profile, with the live HTTP status of each backlinked page (what powers `backlinks-to-404`). A background job - poll `check_sync_status`. With a [Majestic](majestic.md) key it also scores your most-backlinked pages by Trust Flow.
Endpoint: `/v3/backlinks/summary/live` + `/v3/backlinks/domain_pages_summary/live`
> Pull the backlink profile for mysite.com

### `link_intersect`
The links your competitors have that you don't — a prioritised outreach list (followed-first, sorted by domain trust). An optional [Majestic Trust Flow](majestic.md) re-sort kills directory noise.
Endpoint: `/v3/backlinks/domain_intersection/live` (+ `competitors_domain` when you don't name the competitors, + optional Majestic)
> What links do my top 3 competitors share that I don't have?

---

**Also paid, on the SERP endpoint:** `recon_targets` makes one `/v3/serp/google/organic/live/advanced` call per page it analyses (with the small surcharge for loading AI Overviews that arrive asynchronously), and `recon_todos` makes one more per to-do when you ask it to `remeasure` - see [recon.md](recon.md). **Free, from stored data:** `keyword_list` and `content_opportunities` make no DataForSEO call at all. See [tools.md](tools.md) and [composition.md](composition.md).

**Cost discipline in one line:** Labs/Keywords are cheap and cached — use them for top-down pulls; SERP is per-keyword — a handful of explicit keywords, never a list; Backlinks needs the separate subscription.
