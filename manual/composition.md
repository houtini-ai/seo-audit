# Composition: asking your own questions

The 93 preset checks are the floor, not the ceiling. The real power of holding Search Console, a crawl, URL Inspection and DataForSEO in **one database** is that you can ask bespoke questions across them - questions no single SEO tool answers, because no single tool holds all four datasets.

You don't write SQL for this (though you can - every table lives in one SQLite file per property, path via `data_location`). You describe the question in plain language, and Claude plans the join. The `composition_cookbook` tool gives Claude the map below; this page is the same map for you, with the recipes expanded into prompts you can copy.

> Which of my pages lost clicks in the weeks after they started being cited in AI Overviews?

That's a composition question. Nothing ships that as a button. Here it's one prompt.

## The three join keys

Everything joins on one of three keys. Once you know them, you can predict which questions are answerable.

- **`url_key`** - one normalised URL form: forced https, www and apex unified, tracking params stripped, params sorted, no fragments. Joins the crawl (`pages`, `links`) to GSC (`search_analytics.page_key`) to `url_inspection`, `page_backlinks`, `page_cwv` and `page_entity`. `normalize_url` shows you the key for any URL.
- **`query`** - the literal search term. Joins GSC history to the DataForSEO keyword tools (`keyword_volume`, `search_intent`, `ranked_keywords` rows) and the persisted `keyword_intent` table.
- **`domain`** - a bare host, no scheme, no www. Joins the Labs tools (`ranked_keywords`, `domain_visibility`, `top_pages`, `competitors_domain`, `topic_gaps`) and the backlinks summary.

## The grain of each source

Grain is the thing that trips people up when composing - what one row means, per source. Get the grain wrong and your aggregation is wrong.

| Source | One row is | Notes |
|---|---|---|
| `search_analytics` (GSC) | date × query × page (+ device/country when synced with segments) | Rows are additive, but **position must be impression-weighted** when you aggregate it. |
| `pages` + `links` (crawl) | one `url_key`, the **latest crawl only** | Carries title, H1, meta, canonical, schema, body text by section, internal PageRank, click depth, in-degree. Cross-crawl history lives in `page_snapshots` and is diffed by `detect_changes`. |
| `url_inspection` | one inspected URL | Google's own view: coverage state, Google's canonical versus yours, last crawl time, rich results. Sampled from your top pages by clicks. |
| `sitemap_urls` | one sitemap URL | With its declared lastmod, captured at crawl time. |
| `rank_history` | month × domain | DataForSEO rank distribution plus estimated traffic value. |
| `page_backlinks` | one backlinked URL | Counts plus a live HTTP status. |
| `keyword_intent` / `page_cwv` | one keyword / one URL | Persisted when you pass `siteUrl` to `search_intent` / `page_lighthouse`. |
| Labs tools | keyword × target, or month × target | Cached 20 days; each live call costs money, so plan the fewest calls that answer the question. |
| `findings` | one finding per check × URL | With priority and evidence JSON, per audit run. |

## Aggregate first

Distribution questions - "how do my status codes break down?", "which pages get the most clicks?", "how many URLs sit at each click depth?" - don't need rows at all, and `query_data` exists so they never produce them. It aggregates **in the database** and returns the answer: group counts, percentages and sum/avg/min/max metrics as one small table with an honest total line, whether the table underneath holds eight hundred rows or two and a half million. Reach for it before any prompt that would otherwise dump rows into the conversation; switch to `mode:rows` only when you genuinely need to see individual URLs, and even then it pages loudly (*showing X-Y of TOTAL; next offset N*) with 120-character cells.

A worked example - status codes by template folder:

> Using query_data on mysite.com, group pages by status_code where url is like https://mysite.com/blog/%, then do the same for /product/ - which template is carrying the dead URLs?

Each call is one aggregate: `table:pages`, `groupBy:["status_code"]`, `filters:[{column:"url", op:"like", value:"https://mysite.com/blog/%"}]`. Two small tables back, zero row dumps, and the comparison falls straight out of the percentages. (For proper template clusters rather than folder prefixes, get the shapes from `list_templates` first and filter on each exemplar's path.)

## Three archetype chains

Most composition questions are one of three shapes:

1. **Demand → reality.** A GSC query with impressions but weak rank → the ranking page's crawl fields → does the page say what the query asks? Fix on-page, or draft the missing content.
2. **Authority → waste.** Internal PageRank or backlinks flowing into non-200, redirected or orphaned URLs → recover the equity with 301s or internal links (`fix_finding` generates both).
3. **Competitor → gap.** Competitor keyword footprints minus your GSC and crawled-page footprint → topics to cover, each tied to your nearest existing page.

## The thirteen recipes

Each of these is a real multi-source question, with the join spelled out and a prompt to copy. The first nine are worked recipes; the last four are combinations I've not seen any other tool surface.

### 1. AI Overview citation loss

`ranked_keywords` with `aioOnly:true` lists the keywords where you're cited as an AI Overview source. Join each cited keyword's ranking page to its per-day clicks in `search_analytics`. Pages whose clicks fell while the citation appeared are feeding the answer without earning the visit.

> Which keywords cite mysite.com in AI Overviews, and did clicks to those pages fall after the citations appeared?

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

Find queries in `search_analytics` where position is flat but CTR declines, then pull the SERP features for those keywords (`ranked_keywords` or `related_terms`) to see what now sits above you - an AI Overview, a featured snippet, a shopping pack. `ctr-below-expected` is the deterministic starting list.

> Which of my queries have stable rankings but falling CTR, and what SERP features appeared above me?

### 6. Schema versus rich-result reality

The crawl knows what schema you declare (`pages.json_ld`); URL Inspection knows what Google detected and what issues it found. The `rich-result-issues` check does the per-URL diff; the composition question is per **template** (`list_templates`): which template's schema never earns its rich result?

> By template, where does my declared schema not produce rich results according to Google?

### 7. Migration signal transfer

The crawl records redirect chains; URL Inspection records whether Google's canonical follows the move; GSC records clicks by page before and after the migration date. Equity that didn't transfer shows up as a redirect target with no canonical adoption and no click recovery.

> We migrated /old-section/ to /new-section/ in March. Did the equity follow? Show me redirects where Google's canonical hasn't moved and clicks haven't recovered.

### 8. 404s with backlinks

`pages.status_code = 404` joined to `page_backlinks` (run `pull_backlinks` first). The audit surfaces it as `backlinks-to-404`, and `fix_finding` writes the 301 that recovers the equity.

> Pull my backlinks, then show me every dead page with external links pointing at it, and write the redirects

### 9. Competitor topic gap

`topic_gaps` does the whole chain in one bounded, cached call: competitor keyword footprints, minus your GSC queries and page titles/H1s, clustered and ranked. Or do it manually with `ranked_keywords` per competitor when you want the raw rows. Full workflow: [competitive.md](competitive.md).

> What topics should mysite.com cover? Compare against rival.com and bigrival.com

### 10. Crawl budget versus equity

`url_inspection.last_crawl_time` × the crawl's internal PageRank. Your highest-equity pages should be recrawled often; a high-iPR page Google rarely revisits has a freshness or priority problem. The reverse matters too: junk crawled daily is wasted budget.

> Compare how often Google recrawls my pages against their internal PageRank - where's the mismatch?

### 11. AI Overview text versus your content

The AI Overview items in a SERP call, against your page's body sections: is the text Google quotes on your page at all, and is it in one extractable chunk?

> For "best sim racing wheel", what does the AI Overview say, and does my page contain that answer in one passage?

### 12. Crawl-to-first-impression latency

`url_inspection.last_crawl_time` versus the first date a page appears in `search_analytics` - how fast Google turns a crawl into impressions, per template. A slow template has an indexing-pipeline problem, not a content problem.

> How long does it take Google to start showing my new pages, broken down by template?

### 13. Crawled-as versus response times

`url_inspection.crawled_as` (which agent Google uses on you, mobile or desktop) × the crawl's response times - slow responses specifically on the agent Google measures you with.

> Is my site slower for the crawler agent Google uses on me?

## Planning your own

The method, in one paragraph: state the question, name the join key (url_key, query or domain), state the grain of each side so aggregation is honest, then run the fewest paid calls that answer it. Everything free (GSC, crawl, inspection) is already in the database; only the Labs/backlinks side costs money, and it's cached for 20 days. If you're unsure whether a question is answerable, ask - Claude reads the same cookbook and will tell you which side of the join is missing.
