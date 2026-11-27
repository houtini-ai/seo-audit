# The portfolio: every domain you look after, on one page

One table for every site you look after, and the competitors you watch, built on data you already hold plus a few cents of DataForSEO. **Every number says whether it was measured or estimated.**

- **Owned domains** come from your Search Console properties, automatically: a Domain property (`sc-domain:`) as soon as it exists, a URL-prefix property (`https://…/`) once it has been synced. A database made by crawling a site that isn't in your Search Console (a competitor or research site), or by `pull_backlinks` or `link_intersect` for someone else's site, is not one of them.
- **Watched domains** are added by you: competitors, prospects, clients without Search Console access.

In the browser it's **All domains**, the first entry in the dashboard's domain dropdown, and the page the dashboard opens on once you have more than one property. In chat it's `get_portfolio`.

## What the table shows

| Column | Source | Notes |
|---|---|---|
| Clicks, 28 days | Google Search Console (measured) | Owned domains only, against the 28 days before |
| Organic keywords, Organic traffic | DataForSEO Labs (estimated) | For the row's country. Traffic is DataForSEO's ETV estimate, not visits you measured |
| Paid keywords and traffic | DataForSEO Labs (estimated) | Behind "Show paid" |
| Referring domains | DataForSEO Backlinks | Root domains |
| Domain Rank | DataForSEO Backlinks, 0 to 100 | DataForSEO's rank, labelled as DataForSEO's. It isn't an industry-standard authority score. The Links tab and `link_intersect` show the same rank on DataForSEO's 0 to 1000 scale, so the two numbers aren't comparable |
| AI mentions | DataForSEO LLM Mentions | Google AI Overviews + ChatGPT, monthly. ChatGPT data is US-only |
| Audit health | Your latest `run_audit` | Owned domains only |

**How the numbers behave:**
- **Change chips** compare the **last complete month** with the month before (Month) or the same month a year earlier (Year). A month in progress is never compared: it shows hollow, marked "to date".
- **Lagging sources:** DataForSEO's Labs history lags a month or two, so each series compares its own latest complete month. The tooltip names the two months.
- **Empty cells say why:** "not fetched yet", "Backlinks API not enabled on the DataForSEO account", "no data at this location", "skipped to stay within the budget". A real zero shows as 0.

**Needs attention** is a fixed rule list, and each flag names its numbers:
- Search Console clicks down 20% or more, from at least 200.
- Estimated traffic down 30% in a month, or 20% two months running.
- Referring domains down 10% or more, from at least 50.
- Domain Rank down 5 points or more.
- AI mentions down 30% or more, from at least 20.
- Audit health down 5 points or more.
- A critical issue that is new in the latest audit, named (compared with the previous audit at the same scope; a check added by an upgrade doesn't count as new).
- The TLS certificate expiring within 21 days, expired, or not trusted.
- Stale Search Console data or an old crawl.

## The domain overview

Click a domain for its overview, including joins only your own data allows:
- **Search (estimated) beside Search Console (measured):** the two never blend. Traffic share is shown among the domain's group, or among the portfolio.
- **AI search:**
  - per platform (AI Overviews, ChatGPT): mentions, AI search volume and cited pages, over 15 months;
  - for owned sites, a **rank and citation** table and quadrant from content recon. It shows which keywords show an AI Overview, whether your page is cited (yes / no / unknown, never "no" for unknown), and your organic rank;
  - **Top cited pages**, joined to your crawl status and Search Console clicks;
  - **Sources cited alongside**: sources, not competitors;
  - **AI prompt panel** (once you have one): per engine (ChatGPT, Claude, Gemini, Perplexity, Google AI Mode), how many of your prompts' answers mention the domain and how many cite it, the model that answered and the run month, then one row per prompt;
  - not measured by the mentions data: AI Mode, Gemini and Perplexity. The page says so for each until the prompt panel has measured it, then states the panel result instead. There is no 0 to 100 "visibility score".
- **Traffic trend:** estimated traffic plus measured Search Console clicks on their own axis.
- **Keyword positions** in five bands (1-3, 4-10, 11-20, 21-50, 51-100), the search-results mix (organic, AI Overview references, featured snippets, local pack), countries, and new and lost referring domains.
- **Top pages by traffic and by links:** for owned sites each URL carries our crawl status, so a heavily linked page that 404s is flagged.
- **Tracked keywords:** the domain's position on each keyword you track in its country, the change since the previous check, the ranking page, and when it was checked. "Not in top 100" means just that; nothing is known below it.

## Refreshing, and what it costs

The dashboard never spends. Adding or removing a watched domain is free and works from the All domains page; spending starts from chat:

- **`refresh_portfolio`** quotes first: calls and cost per endpoint family, nothing spent. Run it again with `confirm: true` and it runs as a background job, then records what it actually spent. Cached responses cost nothing.
  - **Weekly tier:** current estimates, Domain Rank, referring domains, backlinks, new and lost, and the search-results mix. These are bulk calls, cents for the whole portfolio.
  - **Monthly tier:** history, countries, top pages, AI mentions, cited pages and sources. These are per domain, about $0.68 each.
- **Measured on a live run (24 Oct 2026):** 8 domains on the weekly tier cost $0.22. Two domains on the monthly tier cost $1.40, now quoted at $1.36.
- **`schedule_portfolio_refresh`** sets a weekly and monthly cadence with a **monthly budget cap**, in two steps: a preview, then `confirm: true`. Saving the schedule is your consent to spend up to the cap.
  - **Where it runs:** in the MCP process, or in the job runner under the Docker gateway. The claim is atomic, so two processes never run it twice.
  - **Within a run**, the cap is checked between endpoint families, and a run that would breach it stops and says so.
  - **If the cost grows** more than 25% since you agreed (domains added), the scheduled run is skipped until you re-confirm.
- **Competitor suggestions** (`portfolio` action `suggest`, about $0.015): one DataForSEO Labs call proposes competitors for an owned property in its country, ranked by shared keywords, with the evidence. Quoted first, cached 20 days, and nothing is added until you pick.
- **Keyword positions** (`track_keywords` action `check`, about $0.0175 a keyword): one live Google results page per tracked keyword answers every portfolio domain in that country at once. Quoted first, on request only, never scheduled.
- **AI prompt panel** (`ai_prompt_panel` action `run`, about $0.09 a prompt for all five engines): each of your prompts asked once of ChatGPT, Claude, Gemini, Perplexity and Google AI Mode. Quoted first per engine, on request only, never scheduled; a prompt already answered this month is not asked again unless you say so.
- All three are recorded in the same spend ledger as refreshes and count toward the monthly budget if you set one.
- **The "Copy refresh prompt" button** puts "Refresh my SEO Console portfolio" on your clipboard. In chat, "Ask Claude to refresh" sends it. Either way, Claude quotes before spending.

**DataForSEO needs:** Labs, Backlinks and LLM Mentions enabled on your account. Each is pay-as-you-go, with no monthly minimum since July 2026. A family that isn't enabled fails on its own and the rest of the refresh carries on.

## Managing the list

In the browser, use the form above the All domains table to watch a domain (domain, optional group, and a country picked from the list), a watched row's country picker to move it to another market (its history for the old one is kept; the new one's numbers arrive with the next refresh), and a row's Remove link to stop. In chat:

```text
portfolio                                   list everything (free)
portfolio action:add domain:rival.com group:competitors location:"United Kingdom"
portfolio action:remove domain:rival.com
portfolio action:group domain:rival.com group:prospects
portfolio action:location domain:mysite.com.au location:2036
portfolio action:suggest domain:mysite.com             quote; then confirm:true (paid)
portfolio action:add domains:["a.com","b.com"] location:2840   group defaults to competitors
track_keywords action:add keywords:["sim racing cockpit"] location:2840
track_keywords action:check                              quote; then confirm:true (paid)
track_keywords                                           latest positions and change (free)
ai_prompt_panel action:add prompts:["What are the best sim racing cockpits?"] location:2840
ai_prompt_panel action:run                               quote per engine; then confirm:true (paid)
ai_prompt_panel domain:mysite.com                        mentioned / cited per engine and prompt (free)
```

**Locations:**
- An owned property uses its saved DataForSEO location. Failing that it uses its country domain (`.com.au` is Australia), and failing that the United States.
- A watched domain uses the location you give it.
- Up to 50 watched domains.
