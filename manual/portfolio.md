# The portfolio: every domain you look after, on one page

Semrush opens on a "Domains for monitoring" table. SEO Stack opens on a portfolio of Search Console sites. This is the same idea, built on data you already hold plus a few cents of DataForSEO, with one difference: **every number says whether it was measured or estimated.**

- **Owned domains** come from your synced properties, automatically.
- **Watched domains** are added by you: competitors, prospects, clients without Search Console access.

The browser dashboard opens on the portfolio once you have more than one property (`/`, or `/portfolio`). In chat it's `get_portfolio`.

## What the table shows

| Column | Source | Notes |
|---|---|---|
| Clicks, 28 days | Google Search Console (measured) | Owned domains only, against the 28 days before |
| Organic keywords, Organic traffic | DataForSEO Labs (estimated) | For the row's country. Traffic is DataForSEO's ETV estimate, not visits you measured |
| Paid keywords and traffic | DataForSEO Labs (estimated) | Behind "Show paid" |
| Referring domains | DataForSEO Backlinks | Root domains, as Semrush counts them |
| Domain Rank | DataForSEO Backlinks, 0 to 100 | DataForSEO's rank. **Not** Semrush's Authority Score, and never labelled as one |
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
- Stale Search Console data or an old crawl.

## The domain overview

Click a domain for its overview, which is Semrush's Domain Overview with the joins only we can make:
- **Search (estimated) beside Search Console (measured):** the two never blend. Traffic share is shown among the domain's group, or among the portfolio.
- **AI search:**
  - per platform (AI Overviews, ChatGPT): mentions, AI search volume and cited pages, over 15 months;
  - for owned sites, a **rank and citation** table and quadrant from content recon. It shows which keywords show an AI Overview, whether your page is cited (yes / no / unknown, never "no" for unknown), and your organic rank;
  - **Top cited pages**, joined to your crawl status and Search Console clicks;
  - **Sources cited alongside**: sources, not competitors;
  - not measured by this data, and said so on the page: AI Mode, Gemini, Perplexity, and any 0 to 100 "visibility score".
- **Traffic trend:** estimated traffic plus measured Search Console clicks on their own axis.
- **Keyword positions** in Semrush's five bands, the search-results mix (organic, AI Overview references, featured snippets, local pack), countries, and new and lost referring domains.
- **Top pages by traffic and by links:** for owned sites each URL carries our crawl status, so a heavily linked page that 404s is flagged.

## Refreshing, and what it costs

The dashboard only reads. Spending starts from chat:

- **`refresh_portfolio`** quotes first: calls and cost per endpoint family, nothing spent. Run it again with `confirm: true` and it runs as a background job, then records what it actually spent. Cached responses cost nothing.
  - **Weekly tier:** current estimates, Domain Rank, referring domains, backlinks, new and lost, and the search-results mix. These are bulk calls, cents for the whole portfolio.
  - **Monthly tier:** history, countries, top pages, AI mentions, cited pages and sources. These are per domain, about $0.68 each.
- **Measured on a live run (24 Oct 2026):** 8 domains on the weekly tier cost $0.22. Two domains on the monthly tier cost $1.40, now quoted at $1.36.
- **`schedule_portfolio_refresh`** sets a weekly and monthly cadence with a **monthly budget cap**, in two steps: a preview, then `confirm: true`. Saving the schedule is your consent to spend up to the cap.
  - **Where it runs:** in the MCP process, or in the job runner under the Docker gateway. The claim is atomic, so two processes never run it twice.
  - **Within a run**, the cap is checked between endpoint families, and a run that would breach it stops and says so.
  - **If the cost grows** more than 25% since you agreed (domains added), the scheduled run is skipped until you re-confirm.
- **The "Copy refresh prompt" button** puts "Refresh my SEO Console portfolio" on your clipboard. In chat, "Ask Claude to refresh" sends it. Either way, Claude quotes before spending.

**DataForSEO needs:** Labs, Backlinks and LLM Mentions enabled on your account. Each is pay-as-you-go, with no monthly minimum since July 2026. A family that isn't enabled fails on its own and the rest of the refresh carries on.

## Managing the list

```text
portfolio                                   list everything (free)
portfolio action:add domain:rival.com group:competitors location:"United Kingdom"
portfolio action:remove domain:rival.com
portfolio action:group domain:rival.com group:prospects
portfolio action:location domain:mysite.com.au location:2036
```

**Locations:**
- An owned property uses its saved DataForSEO location. Failing that it uses its country domain (`.com.au` is Australia), and failing that the United States.
- A watched domain uses the location you give it.
- Up to 50 watched domains.
