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
- **`track_ranks`** - the monthly rank-distribution history that gives the dashboard's visibility chart its time axis. Runs as part of `refresh_property` when credentials are present.

## Location matters

Most of these tools take a `location` (a name like "United Kingdom" or "Australia", or a numeric code; the default is the United States). Set it to the market you compete in - rankings differ per country and so does every number downstream. `track_ranks` saves the location per property, so you set it once.
