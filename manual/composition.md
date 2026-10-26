# Composition: asking your own questions

The 111 preset checks are the floor, not the ceiling. The real power of holding Search Console, a crawl, URL Inspection and DataForSEO in **one database** is that you can ask bespoke questions across them - questions no single SEO tool answers, because no single tool holds all four datasets.

You don't write SQL for this (though you can - every table lives in one SQLite file per property, path via `data_location`). You describe the question in plain language, and Claude plans the join. The `composition_cookbook` tool gives Claude the map below; this page is the same map for you, with the recipes expanded into prompts you can copy. Most of the tables can be read without SQL through `query_data` (the list is under [Aggregate first](#aggregate-first)); the rest are read by the tools that write them, or by direct SQL.

> Which of my pages rank for keywords that now show an AI Overview, and are their clicks falling while their positions hold?

That's a composition question. Nothing ships that as a button. Here it's one prompt.

## The three join keys

Everything joins on one of three keys. Once you know them, you can predict which questions are answerable.

- **`url_key`** - one normalised URL form: forced https, www and apex unified, tracking params stripped, params sorted, no fragments. Joins the crawl (`pages.url_key`, and `links` at both ends through `source_key` / `target_key`) to GSC (`search_analytics.page_key`) to `url_inspection`, `sitemap_urls`, `findings`, `page_backlinks`, `redirect_sources`, `page_resources.page_key`, `external_link_status` (keyed on `links.target_key`), `page_cwv` and `page_entity`. `normalize_url` shows you the key for any URL.
- **`query`** - the literal search term. Joins GSC history to the DataForSEO keyword tools (`keyword_volume`, `search_intent`, `ranked_keywords` rows) and the persisted `keyword_intent` table (its column is `keyword`).
- **`domain`** - a bare host, no scheme, no www. Joins the Labs tools (`ranked_keywords`, `domain_visibility`, `top_pages`, `competitors_domain`, `topic_gaps`), the backlinks summary, and the `link_prospects` table that `link_intersect` writes.

## The grain of each source

Grain is the thing that trips people up when composing - what one row means, per source. Get the grain wrong and your aggregation is wrong.

| Source | One row is | Notes |
|---|---|---|
| `search_analytics` (GSC) | date × query × page, all-country totals (since 0.16.0 the device and country rows live in `search_analytics_segments`, so a total never counts a day twice) | Rows are additive, but **position must be impression-weighted** when you aggregate it. |
| `pages` (crawl) | one `url_key`, the **latest crawl only** | Carries title, H1, meta, canonical, schema, body text by section, internal PageRank, click depth, in-degree. Cross-crawl history lives in `page_snapshots` and is diffed by `detect_changes`. |
| `links` (crawl) | one link: source page → target URL, latest crawl | Anchor text, internal or external, placement (body / navigation / footer), rel, and how the href was written. |
| `redirect_sources` | one crawled URL that redirected | Every hop of its chain and where it finally lands. |
| `external_link_status` | one outbound link target | Live status, redirect chain and a verdict (ok / redirected / broken / unverifiable), cached 7 days. |
| `page_resources` / `resource_assets` | one subresource on one page / one CSS, JS or font file | What each page loads (type, first or third party, head or body, async/defer/preload); the header-only pass (`headResources:true`) adds status, size and caching per file. |
| `image_assets` | one image | Size and status from the response headers, and how many pages use it. |
| `probes` | one URL fetched by `probe_urls` with `persist:true`, or by the crawl's own site probes (`source = 'site-probe'`, the latest crawl's only) | Status, redirect chain, canonical, robots, content hash and cache headers. Site probes also carry `crawl_id`, `variant_type` (`soft404-root`, `soft404-section`, `host-home-scheme`, `host-home-host`, `host-deep`) and a `verdict`. |
| `url_inspection` | one inspected URL | Google's own view: coverage state, Google's canonical versus yours, last crawl time, rich results. Sampled from your top pages by clicks. |
| `sitemap_urls` | one sitemap URL | With its declared lastmod, captured at crawl time. |
| `rank_history` | one month, for the property's own domain | DataForSEO rank distribution plus estimated traffic volume (from `track_ranks`). |
| `page_backlinks` | one backlinked URL | Counts plus a live HTTP status. |
| `referring_domains` | one referring domain per pull (`snapshot_at`) | Rank, backlinks, pages, nofollow pages, spam score, first seen, lost date. |
| `backlink_anchors` | one anchor text per pull (`snapshot_at`) | `kind` (branded / keyword / url / generic / empty), backlinks, referring domains. |
| `backlink_history` | one day | Backlinks and referring domains, new and lost that day. |
| `link_prospects` | one prospect domain (links to your rivals, not to you) | Intersections, DataForSEO domain trust, worst spam score, followed flag, link-type mix - plus **Trust Flow**, Citation Flow and **Topical Trust Flow** for the prospects Majestic enriched when `MAJESTIC_API_KEY` is set (the top `enrichLimit`, 100 by default). Captured per `link_intersect` run and dated, so treat it as a snapshot: rivals keep earning links. |
| `crux_metrics` / `crux_fractions` / `crux_targets` (CrUX) | target (origin or `url_key`) × form factor × metric × 28-day window / the same × bucket / target × form factor | From `sync_crux`. p75 and good / needs-improvement / poor shares per window; the windows overlap a week apart, so never sum them. `crux_targets.status = 'insufficient_data'` means too little Chrome traffic, not zero. Read with `query_audit` on the `crux-*` checks or the dashboard; `query_data` doesn't expose these tables. |
| `_portfolio.db` (the portfolio, one file for ALL domains) | (domain, location) × month / capture | From `refresh_portfolio`. `domain_month` (DataForSEO history: Labs, backlinks, LLM mentions per platform), `domain_snapshot` (the weekly tier), `domain_country`, `domain_top_page`, `domain_cited_source`, plus the spend ledger `portfolio_run`. Cross-property, so it isn't a property DB and `query_data` doesn't read it. Read with `portfolio` / `get_portfolio`, or direct SQL. |
| `keyword_intent` / `page_cwv` | one keyword / one URL | Persisted when you pass `siteUrl` to `search_intent` / `page_lighthouse`. |
| Labs tools | keyword × target, or month × target | Cached 20 days; each live call costs money, so plan the fewest calls that answer the question. |
| `findings` | one finding per check × URL | With priority and evidence JSON, per audit run. |

## Aggregate first

Distribution questions - "how do my status codes break down?", "which pages get the most clicks?", "how many URLs sit at each click depth?" - don't need rows at all, and `query_data` exists so they never produce them. It aggregates **in the database** and returns the answer: group counts, percentages and sum/avg/min/max metrics as one small table with an honest total line, whether the table underneath holds eight hundred rows or two and a half million. It reads `pages`, `links`, `search_analytics`, `url_inspection`, `sitemap_urls`, `findings`, `image_assets`, `page_backlinks`, `redirect_sources`, `probes`, `page_resources`, `resource_assets` and `external_link_status`. Filters are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `in` and `match` - the last is full-text search (words, "phrases", prefix\*, AND/OR/NOT, NEAR) over GSC queries, page titles, H1s and body text, and anchor text, and it's far faster than `like` on a big table. Reach for it before any prompt that would otherwise dump rows into the conversation; switch to `mode:rows` only when you genuinely need to see individual URLs, and even then it pages loudly (*showing X-Y of TOTAL; next offset N*) with 120-character cells.

A worked example - status codes by template folder:

> Using query_data on mysite.com, group pages by status_code where url is like https://mysite.com/blog/%, then do the same for /product/ - which template is carrying the dead URLs?

Each call is one aggregate: `table:pages`, `groupBy:["status_code"]`, `filters:[{column:"url", op:"like", value:"https://mysite.com/blog/%"}]`. Two small tables back, zero row dumps, and the comparison falls straight out of the percentages. (For proper template clusters rather than folder prefixes, get the shapes from `list_templates` first and filter on each exemplar's path.)

## Three archetype chains

Most composition questions are one of three shapes:

1. **Demand → reality.** A GSC query with impressions but weak rank → the ranking page's crawl fields → does the page say what the query asks? Fix on-page, or draft the missing content.
2. **Authority → waste.** Internal PageRank or backlinks flowing into non-200, redirected or orphaned URLs → recover the equity with 301s or internal links (`fix_finding` generates both).
3. **Competitor → gap.** Competitor keyword footprints minus your GSC and crawled-page footprint → topics to cover, each tied to your nearest existing page.

## The fourteen recipes

Each of these is a real multi-source question, with the join spelled out and a prompt to copy. The first nine are worked recipes; the last five are combinations I've not seen any other tool surface.

### 1. AI Overview exposure and lost clicks

`ranked_keywords` with `aioOnly:true` lists the keywords you rank for where the SERP shows an AI Overview - exposure, not citation, because the Labs data doesn't say who the Overview quotes. Join each keyword's ranking page to its per-day clicks and position in `search_analytics`: a page whose position held while its clicks fell is losing them to the answer above it. Then check citation on the short list with `recon_targets` (pass the pages as `urls`), which reads the live SERP and tells you whether the AI Overview cites you. Cited and losing clicks means you're feeding the answer without earning the visit.

> Which of mysite.com's keywords show an AI Overview, and are clicks to those pages falling while their positions hold? Then check whether the Overviews cite us.

### 2. Striking distance without body coverage

The `striking-distance` check gives you queries at rank 11-20. For each, check the ranking page's body sections for the query's terms. Pages ranking on page 2 that never answer the query in one passage are the highest-yield rewrites - `body-missing-top-query`, `rag-answer-gap` and `score_passages` automate the layers of this.

> Show me my striking-distance queries where the ranking page never covers the query in its body copy

### 3. Not indexed, and no equity to deserve it

`url_inspection` coverage joined to the crawl's internal PageRank and in-degree. Low-iPR unindexed pages need internal links, not resubmission; a **high**-iPR unindexed page is the real anomaly worth investigating.

> Which of my pages aren't indexed, and how much internal link equity does each one get? Separate the underlinked from the true anomalies.

### 4. Cannibalisation with semantic overlap

The cannibalisation finding lists the competing URLs per query. Compare those pages' body sections: heavy overlap means consolidate (301 the loser); light overlap means differentiate the titles and H1s and interlink with distinct anchors.

> For my worst cannibalisation finding, compare the competing pages' content and tell me whether to consolidate or differentiate

### 5. Stable rank, falling CTR: the SERP feature shift

Find queries in `search_analytics` where position is flat but CTR declines, then pull the SERP features for those keywords to see what now sits above you - an AI Overview, a featured snippet, a shopping pack. `ranked_keywords` (scoped to the page with `scope:url`) carries the SERP features per keyword; `serp_features` gives the volume-weighted picture across your whole keyword universe. `ctr-below-expected` is the deterministic starting list.

> Which of my queries have stable rankings but falling CTR, and what SERP features appeared above me?

### 6. Schema versus rich-result reality

The crawl knows what schema you declare (`pages.json_ld`); URL Inspection knows what Google detected and what issues it found. The `rich-result-issues` check does the per-URL diff; the composition question is per **template** (`list_templates`): which template's schema never earns its rich result?

> By template, where does my declared schema not produce rich results according to Google?

### 7. Migration signal transfer

The crawl records every redirecting URL with every hop in `redirect_sources`; URL Inspection records whether Google's canonical follows the move; GSC records clicks by page before and after the migration date. Equity that didn't transfer shows up as a redirect target with no canonical adoption and no click recovery.

> We migrated /old-section/ to /new-section/ in March. Did the equity follow? Show me redirects where Google's canonical hasn't moved and clicks haven't recovered.

### 8. 404s with backlinks

`pages.status_code = 404` joined to `page_backlinks` (run `pull_backlinks` first). The audit surfaces it as `backlinks-to-404`, and `triage_404s` writes the redirect map: it weighs each dead URL's backlinks and referring domains alongside its search traffic, suggests the closest live page, checks live that it isn't already redirected, and returns paste-ready 301s.

> Pull my backlinks, then triage the 404s on mysite.com and give me the redirects for the ones with external links

### 9. Competitor topic gap

`topic_gaps` does the whole chain in one bounded, cached call: competitor keyword footprints, minus your GSC queries and page titles/H1s, clustered and ranked. Or do it manually with `ranked_keywords` per competitor when you want the raw rows. Full workflow: [competitive.md](competitive.md).

> What topics should mysite.com cover? Compare against rival.com and bigrival.com

### 10. Crawl budget versus equity

`url_inspection.last_crawl_time` × the crawl's internal PageRank. Your highest-equity pages should be recrawled often; a high-iPR page Google rarely revisits has a freshness or priority problem. The reverse matters too: junk crawled daily is wasted budget.

> Compare how often Google recrawls my pages against their internal PageRank - where's the mismatch?

### 11. AI Overview sources versus your content

`recon_targets` with `scrapeCompetitors:true` fetches the pages the AI Overview cites as text, after the organic results above you (raise `competitorLimit` if the cited pages land in the skipped list); compare them against your page's body sections: is the answer Google lifts from them on your page at all, and is it in one extractable chunk? (Recon reads the Overview's citations, not its wording, so the comparison is against the sources it quotes.)

> Run content recon on my "best sim racing wheel" page with the competitors fetched, and tell me whether my page holds the answer the AI Overview's sources give, in one passage

### 12. Crawl-to-first-impression latency

`url_inspection.last_crawl_time` versus the first date a page appears in `search_analytics` - how fast Google turns a crawl into impressions, per template. A slow template has an indexing-pipeline problem, not a content problem.

> How long does it take Google to start showing my new pages, broken down by template?

### 13. Crawled-as versus response times

`url_inspection.crawled_as` (which agent Google uses on you, mobile or desktop) × the crawl's response times - slow responses specifically on the agent Google measures you with.

> Is my site slower for the crawler agent Google uses on me?

### 14. Link prospects that match the pages you're trying to move

`link_intersect` returns (and stores in `link_prospects`) the domains linking to your rivals and not to you; with `MAJESTIC_API_KEY` set, the enriched ones carry **Trust Flow** and a ranked **Topical Trust Flow**, shown as the Top topic column. That topic column is the join nobody makes: instead of pitching the list top-down, match each prospect's leading topic to the cluster you actually need links into - your striking-distance pages from the audit, or your highest-iPR money pages. A Trust Flow 45 domain in your topic is worth more than a Trust Flow 60 domain in someone else's, and this is the only way to see the difference before you write the email. Check the set's age with `data_storage` first; a prospect list from three months ago is a list of links your rivals have already had for three months.

> Run link intersect for mysite.com vs rival1.com and rival2.com, then show the prospects whose top topic matches the topics of my striking-distance pages, sorted by Trust Flow

## Planning your own

The method, in one paragraph: state the question, name the join key (url_key, query or domain), state the grain of each side so aggregation is honest, then run the fewest paid calls that answer it. Everything free (GSC, crawl, inspection) is already in the database; only the Labs/backlinks side costs money, and it's cached for 20 days. If you're unsure whether a question is answerable, ask - Claude reads the same cookbook and will tell you which side of the join is missing.
