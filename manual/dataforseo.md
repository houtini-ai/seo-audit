# DataForSEO functions

Everything SEO Audit Console does with *market* data goes through [DataForSEO](https://dataforseo.com/?aff=213701) — a pay-as-you-go API for search volumes, live SERPs, competitor data, backlinks and Lighthouse. The SERP/Keywords/Labs APIs need no subscription; calls cost fractions of a cent to a few cents and are **cached locally for 20 days**, so a repeat question is free and nothing runs unless you ask. (Backlinks is a separate DataForSEO subscription — see the last section.)

Set `DATAFORSEO_USERNAME` + `DATAFORSEO_PASSWORD` ([getting-started](getting-started.md#environment-variables)). Each tool below wraps one DataForSEO endpoint — the endpoint is named so you can price it against DataForSEO's own docs.

## Keywords Data — cheap, 20-day cached

### `keyword_volume`
True monthly search volume, CPC and competition for up to 700 keywords. How you size an opportunity before writing a word.
Endpoint: `/v3/keywords_data/google_ads/search_volume/live`
> What's the search volume for "standing desk" and "sit stand desk"?

### `topic_trend`
Google Trends relative interest (0–100) over time for up to 5 keywords, with a rising / falling / flat read. Answers "is this growing or fading, and is it seasonal" — whether a page is worth updating now, and when to publish. `timeRange` runs `past_7_days` → `2004_present`; `type` can be web / news / youtube.
Endpoint: `/v3/keywords_data/google_trends/explore/live`
> Is interest in "sim racing" rising or falling over the last 5 years?

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
Recent news articles ranking for a keyword — title, source, snippet, publish timestamp. The "what's been published on this since {date}" / freshness check.
Endpoint: `/v3/serp/google/news/live/advanced`
> What news is there on "direct drive wheelbase" this month?

### `serp_features`
SERP-feature and AI-Overview exposure across a keyword set, volume-weighted — how much of the market the SERP furniture (features, snippets, video, AIO) already absorbs.
Endpoint: `/v3/serp/google/organic/live/advanced`
> Which SERP features show up for my money keywords?

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

### `competitors_domain`
The domains competing for your keyword footprint, ranked by overlap.
Endpoint: `/v3/dataforseo_labs/google/competitors_domain/live`
> Who competes with mysite.com organically?

### `domain_visibility`
A domain's ranking distribution over time — the trend line of how it's doing in the market.
Endpoint: `/v3/dataforseo_labs/google/historical_rank_overview/live`
> How has mysite.com's visibility moved this year?

### `top_pages`
A domain's top ranking pages by estimated organic traffic.
Endpoint: `/v3/dataforseo_labs/google/relevant_pages/live`
> What are competitor.com's best-performing pages?

### `page_intersection`
The keywords a set of pages all rank for — their shared footprint.
Endpoint: `/v3/dataforseo_labs/google/page_intersection/live`
> What keywords do these three competitor pages all rank for?

## OnPage

### `page_lighthouse`
A live Lighthouse run for one URL: lab Core Web Vitals, category scores and the top time-saving opportunities. Slow (20–120s) and one of the pricier calls, so strictly per-URL on request. Pass `siteUrl` to persist the CWV (unlocks the high-yield-cwv-fail check).
Endpoint: `/v3/on_page/lighthouse/live/json`
> Run Lighthouse on https://mysite.com/slow-page

## Backlinks — SEPARATE subscription

The DataForSEO **Backlinks** API is billed separately from SERP/Keywords/Labs. If it isn't activated these tools say so in plain English (a `40204` error) rather than throwing a code.

### `pull_backlinks`
A domain's backlink profile with live link status.
Endpoint: `/v3/backlinks/summary/live` + `/v3/backlinks/domain_pages_summary/live`
> Pull the backlink profile for mysite.com

### `link_intersect`
The links your competitors have that you don't — a prioritised outreach list (followed-first, sorted by domain trust). An optional [Majestic Trust Flow](majestic.md) re-sort kills directory noise.
Endpoint: `/v3/backlinks/domain_intersection/live` (+ optional Majestic)
> What links do my top 3 competitors share that I don't have?

---

**Composed on top of these:** `market_sizing`, `topic_gaps`, `keyword_list`, `content_opportunities` and `recon_targets` join the calls above with your stored GSC + crawl data — no *new* paid call for the composition. See [tools.md](tools.md) and [composition.md](composition.md).

**Cost discipline in one line:** Labs/Keywords are cheap and cached — use them for top-down pulls; SERP is per-keyword — a handful of explicit keywords, never a list; Backlinks needs the separate subscription.
