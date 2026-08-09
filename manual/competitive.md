# Competitive analysis with DataForSEO

Everything in the core audit runs on your own Search Console data and your own crawl. But GSC can only describe searches where **you already appear**. The moment the question becomes "how big is this market?", "who do I compete with?" or "what do they rank for that I don't?", you need third-party data.

That's what the DataForSEO integration is for. Together these tools cover most of what I used to open Semrush for - the organic overview, top pages, ranked keywords, the content gap - inside the same conversation as your audit, joined to your own data.

## Setting up DataForSEO

[DataForSEO](https://dataforseo.com/?aff=213701) is a pay-as-you-go API: no subscription, no seat licence. You register, top up a balance, and calls draw it down at fractions of a cent to a few cents each. Then add your credentials to the MCP config:

```json
"env": {
  "DATAFORSEO_USERNAME": "you@example.com",
  "DATAFORSEO_PASSWORD": "your-dataforseo-password"
}
```

(Full config context in [getting-started.md](getting-started.md).) One wrinkle worth knowing up front: **Backlinks is a separate subscription** from the SERP/Keywords/Labs APIs on DataForSEO's side. If you call `pull_backlinks` without it activated you'll get a clear message saying so, not a cryptic error.

## What it costs

- Calls happen **on demand only** - one per question you ask. Nothing loops, nothing runs in bulk behind your back, and there are no scheduled pulls.
- Every response is **cached for 20 days** (configurable via `DATAFORSEO_CACHE_DAYS`). Ask the same question twice in a fortnight and the second answer is free.
- Live tool responses show the actual cost of the call; cached ones say "cached". `topic_gaps` is the biggest spender and it's bounded at four Labs calls maximum.
- `page_lighthouse` is the priciest single call (a full Lighthouse run on DataForSEO's infrastructure) and also the slowest (20-120s), which is why it's strictly one URL per request.

My own usage across several properties runs to a few dollars a month. Your mileage depends on how curious you are, but the design intent is that you can't accidentally spend real money.

## The Semrush-replacement workflows

### The organic overview: `domain_visibility`

Monthly ranking-keyword counts, position distribution (1-3 / 4-10 / 11-20 / 21-100) and estimated traffic value for **any domain or subdomain** - yours or a competitor's, no Search Console access needed. Comes back as a month-by-month table with a trend verdict.

> Show visibility over time for competitor.com
> Is rival.co.uk growing or declining in the UK market?

Point it at your own domain too: it's the outside-in view of you, which is what your competitors see.

### Their best content: `top_pages`

Any domain's top organic pages by estimated traffic, with ranking-keyword counts and top-3/top-10 splits. The fastest way to learn where a competitor's traffic concentrates - and which of their templates does the earning.

> Top pages on competitor.com
> What are rival.com's twenty biggest organic pages?

### What anything ranks for: `ranked_keywords`

Every keyword a target ranks for, scoped however you like: a whole domain, a subdomain, one URL (`scope:url`), or a subfolder (`scope:folder` with `folder:"/blog/"`). Rows carry position, volume, estimated traffic, the ranking URL, keyword difficulty, search intent and SERP features.

> What does competitor.com/blog/ rank for?
> What does this exact page rank for: https://rival.com/best-widgets

**The AI Overview view.** Set `aioOnly:true` and the same tool returns only keywords where the target is **exposed as a source in Google's AI Overviews**. Run it on yourself to see where you're feeding AI answers; run it on a competitor to see where they've become the quoted source. Then compose it with your own click data (recipe 1 in [composition.md](composition.md)) to find citations that cost you visits.

> Which keywords cite mysite.com in AI Overviews?

### Who you compete with: `competitors_domain`

Domains competing for your organic keywords, ranked by measured keyword overlap - not by who you assume. This is the seed list for the gap work below.

> Find competitors for mysite.com in the UK

### The page-level gap: `page_intersection`

Keywords that specific competitor pages rank for and yours doesn't. Competitor URLs take wildcards (`https://rival.com/guides/*`), and you pass your own page(s) to subtract. Use it when you're planning one page against theirs.

> Content gap: what does rival.com/buying-guide rank for that my /guide doesn't?

### The strategic gap: `topic_gaps`

The bigger question - what should this site cover to be seen as expert in its space? It pulls competitor keyword footprints (at most 4 bounded, cached Labs calls), subtracts every query you already surface for in GSC and every topic your pages already cover (title, H1, slug), clusters the survivors, and ranks the topics by search volume × how many competitors rank there. Each topic names the owning competitor, an example of their winning URL, and your nearest existing page to build from. Name up to three competitors or let it derive the top two from ranking overlap.

> What topics should mysite.com cover? Compare against rival.com

Where `suggest_pages` (free, GSC-only) mines demand Google has already shown you, `topic_gaps` maps the demand it hasn't. Run both and you have the quarter's content plan.

## The supporting keyword tools

- **`keyword_volume`** - true monthly volumes, CPC and competition for up to 700 keywords. Sizing before writing.
- **`related_terms`** - People Also Ask questions and related searches from a live SERP.
- **`search_intent`** - informational / navigational / commercial / transactional per keyword. Pass your `siteUrl` to persist the labels, which switches on the intent-vs-pagetype-mismatch audit check.
- **`page_lighthouse`** - lab Core Web Vitals for one URL. Pass `siteUrl` to persist, which switches on high-yield-cwv-fail.
- **`pull_backlinks`** - your backlink profile with a live status check on every linked page, so backlinks pointing at 404s become findings with ready-made 301s. Needs the separate Backlinks subscription, as above.
- **`link_intersect`** - the links your competitors have that you don't. One `domain_intersection` call over the rival set (or a single company), returning every domain that links to them but not you, sorted followed-first then by domain trust, spam filtered. Needs the separate Backlinks subscription. Covered in full below.
- **`track_ranks`** - the monthly rank-distribution history that gives the dashboard's visibility chart its time axis. Runs as part of `refresh_property` when credentials are present.

## Market sizing: `market_sizing` and `serp_features`

Two views that open an engagement. **`market_sizing`** takes your domain plus up to four named competitors, pulls one cached Labs footprint each, and unions them into a keyword universe: total monthly demand, each domain's share of voice (ETV share) overall and per topic cluster, and who leads each cluster. It's the "here's the market, here's who owns it, here's where to attack" table that used to need a Semrush subscription. **`serp_features`** measures how much of that universe carries each SERP feature - AI Overviews, snippets, PAA, video - by search volume, split by whether you already rank page 1 there. The honest answer to "how much of my market is zero-click now?"

> Size the market: mysite.com vs rival1.com and rival2.com
> What's our AI Overview exposure?

## Link intersect: `link_intersect`

The classic outreach question - *what links do our competitors have that we don't?* - and, for a single company, *what links does company X have that we don't?* One DataForSEO `domain_intersection` call over the target set (with your own domain excluded) returns every domain that links to your rivals but not to you. Each prospect is aggregated: how many of the targets it links to, its domain trust, its worst spam score, whether the link is followed, the anchor mix. The default sort is the link builder's - **followed links first, then domain trust** - with spam filtered out.

> Link intersect for mysite.com vs rival1.com, rival2.com
> What links does rival.com have that we don't?

**The directory problem, and the Majestic fix.** DataForSEO's domain rank is a link-volume metric, so directories and syndicated-press domains float to the top - technically high-authority, useless for outreach. Set an optional **`MAJESTIC_API_KEY`** and each prospect is enriched with Majestic **Trust Flow** (editorial authority) and **Topical Trust Flow** (whether that authority is *on your topic*), and the list is re-sorted by Trust Flow. The difference is stark: in testing, a domain DataForSEO ranked 227 came back Trust Flow 0 - pure noise the volume metric couldn't see. Majestic is entirely optional; the tool works without it, the key just makes the priority order defensible to a client. `MAJESTIC_CACHE_DAYS` (default 20) controls the cache; add the key to your MCP config's `env` block alongside the DataForSEO ones.

**Freshness.** Results persist to a `link_prospects` table per property. Because rivals keep earning links, that set ages - `data_storage` shows each property's prospect count and capture date and flags when it's likely stale, and re-running `link_intersect` supersedes it. The DataForSEO call itself is 20-day cached.

## Content recon: why a page is losing

The deepest use of the SERP data. **`recon_targets`** takes your worst declining or striking-distance pages, fetches your live page with the crawler, pulls the live Google SERP for its top query, and classifies *why* you're behind on the **organic-rank × AI-Overview-citation** matrix:

- **defend-and-deepen** - you rank well and the AI Overview already cites you; deepen to become the primary source.
- **accuracy-or-freshness** - you rank but the AI Overview won't quote you. This is the sharpest, most actionable class: it's a data-accuracy, freshness or markup problem, not a rewrite.
- **consolidate-weak-page** - cited on a weak page; strengthen it.
- **competitive-gap** - not cited, weak rank; run the full competitor diff.

It seeds deterministic to-dos (schema, freshness, cannibalisation, video) and returns the competitor set Google rewards. Set `scrapeCompetitors:true` and it fetches them too, routed by source: the ranking **videos** to Supadata for transcripts (usually what wins these SERPs), competitor **pages** to Firecrawl ([get a key](https://firecrawl.link/2d1PLD8)) with a free browser-profile fetch behind it that even reaches Reddit. Cloudflare-challenge publishers (PCMag) can't be fetched from a server - they're flagged so you can paste their copy and have it diffed in.

Then **`save_recon_todo`** writes the competitor-diff gaps back with a baseline, and **`recon_todos`** is the trackable, annotatable board - filter by page or status, update a to-do's status, append dated notes, and on `status:shipped remeasure:true` it re-fetches the SERP to show whether the fix moved you from AIO-uncited to cited.

> Run content recon on mysite.com, location United Kingdom
> Save these gaps for /my-page: [ ... ]
> Show my recon to-dos

## Location matters

Most of these tools take a `location` (a name like "United Kingdom" or "Australia", or a numeric code; the default is the United States). Set it to the market you compete in - rankings differ per country and so does every number downstream. This matters *especially* for content recon: a page that looks mid-table in your Search Console average can be outside the top 20 on a US SERP and top 5 on a UK one, and the verdict flips with it. `track_ranks` saves the location per property, so you set it once.
