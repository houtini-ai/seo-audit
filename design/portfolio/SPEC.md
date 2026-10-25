# Portfolio dashboard: Semrush/SEO Stack-style domains view on DataForSEO

Status: **v1.1, 24 Oct 2026**: v1 plus the review outcome at the end, which **overrides** earlier sections where they conflict. Owner: Richard. Builds on 0.16.3.

## 1. Goal

Get as close as honest data allows to two SaaS views, inside the local dashboard:

- **Semrush Home, "Domains for monitoring"**: one row per domain with organic keywords, organic traffic, paid keywords, paid traffic, referring domains and Authority Score, each with a % change and a sparkline, plus a Month/Year toggle and "Add domain".
- **Semrush Domain Overview**: an AI Search block (visibility, mentions, cited pages per platform), an SEO block (authority, organic traffic, traffic share, keywords, referring domains, backlinks), distribution by country, top cited sources, a traffic trend, a keyword position-bucket trend, SERP positions distribution, and top pages (by traffic and by links).
- **SEO Stack's portfolio** (GSC-first): the clicks/impressions table per owned site, and a **"Needs attention"** tab with a one-line reason per site. That's the idea worth taking, because it's where we beat both: we hold GSC truth *and* a crawl *and* an audit per owned property.

**The differentiator is that every number is labelled measured or estimated.** For owned properties we show GSC clicks (measured) next to DataForSEO's ETV (estimated), and the dashboard never blends them.

**Non-goals:**
- a proprietary composite score;
- sentiment;
- AI-visibility "scores" with an unpublished normalisation;
- daily data (DataForSEO is monthly);
- AI Mode, Gemini and Perplexity mention counts (DataForSEO has no mentions database for them; see section 9).

## 2. What DataForSEO can supply (verified against docs, 24 Oct 2026)

Prices are post-1 July 2026. Labs is $0.012/task + $0.00012/item. Backlinks is $0.024/task + $0.000036/row. LLM Mentions is $0.10/task + $0.001/row. Each family has to be enabled on the account; there's no monthly minimum now.

| Semrush metric | Our equivalent | Endpoint | Calls for 10 domains | Cadence |
|---|---|---|---|---|
| Organic keywords, organic traffic, paid keywords, paid traffic (now) | `count` / `etv`, organic + paid | Labs `bulk_traffic_estimation` (≤1000 targets) | 1 | weekly |
| ...12-month trend + position buckets (top 3 / 4-10 / 11-20 / 21-50 / 51-100) | monthly `metrics.organic.pos_*`, `etv`, `count` | Labs `historical_rank_overview` (1 target; already used by RankTracker) | 10 (incremental) | monthly |
| Authority Score | **DataForSEO Domain Rank**, 0-100 (`rank_scale: one_hundred`). Labelled as such, never "Authority Score" | Backlinks `bulk_ranks` | 1 | weekly |
| Ref. domains, backlinks (now) | `referring_main_domains` (Semrush counts root domains), `backlinks` | `bulk_referring_domains`, `bulk_backlinks` | 2 | weekly |
| Ref. domains trend | monthly `referring_main_domains`, `rank`, new/lost | Backlinks `history` (1 target, monthly from 2019) | 10 (incremental) | monthly |
| Traffic share | this domain's `etv` ÷ the sum over the set (portfolio, or the domain + its competitors) | derived | 0 | - |
| Distribution by country | per-location `etv` / `count` | Labs `domain_rank_overview` with no location (**verify** it returns one row per location) | 10 | monthly |
| SERP positions distribution (organic / AI Overviews / other) | `metrics.{organic, featured_snippet, local_pack, ai_overview_reference}` position counts | Labs `ranked_keywords`, `limit: 1` (**verify** the `metrics` block; a code comment at DataForSeoClient.ts:399 says `item_types` 40501s) | 10 | weekly |
| AI Search: mentions, per platform | `mentions`, `ai_search_volume` for **Google AI Overviews and ChatGPT** only | LLM Mentions `multi_target_metrics` (2-10 targets/call) | 1 | weekly |
| ...mentions trend | monthly, from 2025-08 | LLM Mentions `historical` | 10 | monthly |
| Cited pages | URLs + mentions per platform | LLM Mentions `top_mentioned_pages` | 10 | monthly |
| Top cited sources | domains AI cites alongside the target | LLM Mentions `top_mentioned_domains` | 10 | monthly |
| Top pages by traffic | `page_address`, `etv`, `count`, buckets | Labs `relevant_pages` (already used) | 10 | monthly |
| Top pages by links | `page`, `referring_main_domains`, `backlinks`, `broken_backlinks`, `rank` | Backlinks `domain_pages` (sortable) | 10 | monthly |

**Estimated cost for 10 domains** (agent estimate from the price lists):
- weekly tier about $0.35/run (about $1.50/month);
- monthly tier about $4.40/month;
- **about $6/month in total**.

The per-domain endpoints (`historical_rank_overview` at $0.12/task, LLM Mentions at $0.10/task) are about 80% of it. Everything that takes many targets in one call costs pennies. Each response carries `cost`, and **we record the actual spend** (section 5.4), so the estimate gets replaced by real numbers.

## 3. Product shape

### 3.1 The domain list (the "portfolio")

- **Owned domains are automatic:** every local property DB (`listLocalProperties`). A `sc-domain:x.com` property yields `x.com`; a URL-prefix property yields its host.
- **Watched domains are added by the user:** competitors, prospects, clients without GSC access. They're stored in the portfolio DB with a location (default: the owning property's location, else "United States" per the US-first memory) and an optional group label ("competitors of ehi").
- The **target** sent to DataForSEO is the registrable domain, so `www.` is stripped, matching Semrush's root-domain behaviour. A row can override this to a subdomain later; out of scope for v1.

### 3.2 Portfolio view (`Domains`)

- **Where it lives:**
  - In web mode it's the landing page at `/` when there's more than one property, replacing today's plain picker. The picker's job (open a property) becomes the row link.
  - It's also reachable as `/portfolio`.
  - In chat it's a new App tool `get_portfolio` that renders the same UI module.
- **Header:** the counts (owned / watched), when the data was last refreshed per tier, the schedule if any ("weekly, next Mon 27 Oct, budget $10/mo, spent $1.42 this month"), and the Month | Year toggle.
- **Tabs:** All · Needs attention · Owned · Watched.
- **Table columns:**

| Column | Content |
|---|---|
| Domain | Link + location flag. Owned rows are marked "GSC" and open the property dashboard. |
| Clicks (28d, GSC) | Owned only. The measured figure, with change vs the prior 28 days. |
| Organic keywords | DataForSEO `count`. Change % and a 12-month sparkline. |
| Organic traffic (est.) | `etv`. Change and sparkline. |
| Paid keywords / Paid traffic (est.) | |
| Ref. domains | `referring_main_domains`. Change and sparkline from backlinks history. |
| Domain Rank | 0-100, with change. |
| AI mentions | AI Overviews + ChatGPT. Change and sparkline from 2025-08. |
| Audit health | Owned only: latest run, with change. |

- **Change % rules:**
  - "Month" = latest month vs the previous month.
  - "Year" = vs the same month a year earlier.
  - Use `displayRules.countChange` (small-base guard, SMALL_BASE_MIN). Below the base it shows the absolute change, not a misleading %.
- **Sparklines:** ECharts minimal line, 12 points, no axes, one per cell, with **one shared ECharts instance per column** (an instance per cell would mean hundreds of instances).
- **Empty cells say why:**
  - "not fetched yet", when a domain was added since the last refresh;
  - "Backlinks API not enabled" (40204);
  - "LLM Mentions not enabled";
  - "no data at this location".
  - Never a bare 0.
- **"Needs attention"** is a deterministic rule list, each producing a one-line reason with its numbers:
  - Owned GSC clicks (28d) down ≥20% with ≥200 prior clicks.
  - Organic ETV down ≥20% month on month (ETV ≥100).
  - Referring domains lost ≥10% in a month.
  - Domain Rank down ≥5 points.
  - AI mentions down ≥30% (≥20 prior).
  - Owned: audit health down ≥5, or a new critical finding.
  - Owned: data stale (GSC >7 days, crawl >30 days, per displayRules).
  - **DataForSEO estimate vs GSC disagree in direction** for 2+ months (ETV up, clicks down or vice versa). This one is unique to us: it tells you the third-party estimate is lying for this site.

### 3.3 Domain overview (click a row)

This is a Semrush Domain Overview equivalent. It's a page at `/portfolio/domain?d=x.com`, and in chat the `get_portfolio` tool takes `domain` and opens on it.

- **SEO block:**
  - Domain Rank, organic traffic (est.), organic keywords, paid traffic and keywords, referring domains, backlinks.
  - **Traffic share** among this domain and its group (competitors), or among the portfolio when there's no group.
  - For owned rows, a **"GSC (measured)" strip** beside it: clicks, impressions, top pages count.
- **AI Search block:** mentions and AI search volume per platform (AI Overviews, ChatGPT), with a footnote that AI Mode, Gemini and Perplexity aren't in DataForSEO's mentions data. Cited pages count, plus top cited pages (table) and top cited sources (table).
- **Traffic trend:** monthly organic and paid ETV (24 months if fetched), with a GSC clicks line for owned domains on a **second axis**, labelled measured vs estimated (the honesty core).
- **Keyword positions trend:** stacked buckets, Semrush's five bands, mapped from DataForSEO's `pos_1, pos_2_3, pos_4_10, pos_11_20 ... pos_91_100`.
- **SERP positions distribution:** donut of organic / AI Overview references / featured snippet / local pack.
- **Distribution by country:** table of location, ETV, keywords and share.
- **Backlinks:** referring domains trend and new/lost per month.
- **Top pages:** two tabs, "By traffic (est.)" (relevant_pages) and "By links" (domain_pages, sortable by referring domains, backlinks, broken). For owned domains, each URL is marked with its crawl status and GSC clicks when it joins on `urlKey`. That join is ours alone: a top-linked page that 404s in our crawl is flagged.

### 3.4 Refresh and scheduling (the dashboard can't start a prompt)

- **Paid calls only ever start from chat.** The dashboard can't trigger a prompt, and it must not spend money behind the user's back. So:
  - **`refresh_portfolio` tool.**
    - Default is **quote only:** it lists the calls per tier, the cache hits, and the estimated cost.
    - `confirm: true` runs it as a job (`portfolio` kind, runner-compatible, scope `_portfolio`).
    - Options: `tier: 'weekly'|'monthly'|'all'`, `domains?`.
  - **`schedule_portfolio_refresh` tool.**
    - Records a cadence (`weekly` for the weekly tier plus `monthly` for the monthly tier, or off), a **monthly budget cap in USD**, and the day.
    - Recording the schedule is the user's consent to spend up to the cap.
    - `enabled: false` turns it off.
  - **The dashboard:**
    - shows the schedule, the next due run and the month's spend;
    - offers a **copyable prompt** ("Refresh my portfolio") for an unscheduled update;
    - in the chat App, offers a button that sends that prompt with the ext-apps `ui/message` API (**verify** it's supported by the hosts we target; otherwise copy only).
- **Who executes a due schedule:**
  - With `SAC_JOB_RUNNER=external`, the **runner**: it's the one long-running process.
  - Otherwise, the **MCP server process**: a timer every 15 minutes that checks `next_due` and submits the job (deduped on scope).
  - In both, a job is submitted only if the month's recorded spend + the quote ≤ the cap. Otherwise it's skipped and logged with the reason, which the dashboard shows ("skipped 27 Oct: would exceed $10 budget").
- **Missed runs** (machine off) run once on next start, not once per missed week.
- **Tool-result nudge:** while a schedule is off and data is older than 30 days, portfolio tool results end with one line offering to schedule. The host can then ask the user, which is the "ask if they'd like to schedule" in the brief.

## 4. Data model: `_portfolio.db` in the data dir

It's separate from the property DBs because watched domains have no property, and it's cross-property by nature. The leading underscore keeps it out of property enumeration (like `_jobs.db`; `sanitizeProperty` strips leading underscores). It also has to be added to `CACHE_DB_NAMES` / `listLocalProperties` exclusions.

```sql
portfolio_domain(domain TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('owned','watched')),
  site_url TEXT, location_code INTEGER, language_code TEXT, group_label TEXT,
  added_at TEXT, removed_at TEXT)            -- owned rows synced from listLocalProperties on read
domain_month(domain, location_code, month TEXT /*YYYY-MM*/, source TEXT /*labs|backlinks|llm*/,
  organic_count, organic_etv, paid_count, paid_etv,
  pos_1_3, pos_4_10, pos_11_20, pos_21_50, pos_51_100,
  rank, referring_main_domains, referring_domains, backlinks, new_rd, lost_rd,
  llm_mentions_aio, llm_mentions_chatgpt, llm_volume_aio, llm_volume_chatgpt,
  PRIMARY KEY(domain, location_code, month, source))
domain_snapshot(domain, captured_at, location_code, organic_count, organic_etv, paid_count, paid_etv,
  rank, referring_main_domains, backlinks, new_rd_30d, lost_rd_30d,
  serp_organic, serp_aio_ref, serp_featured, serp_local,
  llm_mentions_aio, llm_mentions_chatgpt, PRIMARY KEY(domain, captured_at))
domain_country(domain, captured_at, location_code, etv, count)
domain_top_page(domain, captured_at, kind TEXT CHECK(kind IN ('traffic','links','cited')),
  url, url_key, metrics_json)                  -- latest capture per (domain, kind) kept + one prior
domain_cited_source(domain, captured_at, source_domain, mentions, platform)
portfolio_schedule(id INTEGER PRIMARY KEY CHECK(id=1), enabled, weekly_dow, monthly_dom,
  budget_usd_month, next_weekly_due, next_monthly_due, updated_at)
portfolio_run(id, started_at, finished_at, tier, trigger /*manual|schedule*/, quoted_usd,
  spent_usd, calls, cache_hits, status, note)  -- the spend ledger + "skipped: budget" rows
portfolio_fetch(domain, endpoint, fetched_at, status, error) -- per-domain/endpoint state, for "why is this empty"
```

**Why each table exists:**
- The month series comes from the history endpoints.
- Snapshots are the weekly bulk tier. Their own history grows over time: that's where SERP-feature share and the weekly Domain Rank trend come from, since DataForSEO has no history for those.

## 5. Implementation notes

1. **Per-call cache age.** Today `DataForSeoClient` has one TTL (20 days, shared with the dashboard sidecar). Add `call(endpoint, body, { maxAgeMs })`, plus a `maxAgeDays` option on the new methods.
   - The weekly tier uses 6 days; the monthly tier uses 25 days.
   - The shared default doesn't change. A shorter max age only means this call refetches sooner.
2. **New client methods**, each verified live once with a tiny request and its raw response saved as a fixture:
   - `bulkTrafficEstimation`, `bulkRanks`, `bulkReferringDomains`, `bulkBacklinks`, `bulkNewLostReferringDomains`, `domainRankOverview`, `domainPages`;
   - `llmMultiTargetMetrics`, `llmHistorical`, `llmTopMentionedPages`, `llmTopMentionedDomains`.
3. **Job `portfolio`** in `jobKinds.ts`: tiers run in order, one endpoint family at a time.
   - It records `portfolio_fetch` status per (domain, endpoint).
   - Partial failures don't abort the run: the Backlinks family off ≠ Labs off.
   - It writes `portfolio_run.spent_usd` from summed `cost`.
4. **Spend ledger.** Add a `costLedger` hook (`onCost(endpoint, usd)`) to the client, so a portfolio run totals actual spend, cache hits counting $0.
5. **Quote.** A pure function `quotePortfolioRefresh(domains, tier, cacheState)` that uses the price table in one constant (`DFS_PRICES`, with the source URL and date). A quote is labelled an estimate; the ledger has the actuals.
6. **Payload.**
   - `getPortfolioData(dataDir)` reads `_portfolio.db` plus, for owned rows, cheap per-property reads: `clickWindows`, the latest `audit_runs`, freshness. It **never runs** `getDashboardData` per row (about 6 s per big DB).
   - `getDomainOverview(dataDir, domain)`.
   - Both are pure reads, cached by a version key (`PORTFOLIO_PAYLOAD_VERSION` plus `MAX(captured_at)`).
7. **Web.**
   - New routes: `/portfolio`, `/portfolio/domain`, `GET /api/portfolio`.
   - Allowlisted free handlers: `get_portfolio_data`, `get_domain_overview`, and `portfolio_add_domain` / `portfolio_remove_domain`. Adding and removing are free (no API call), but they are writes: POST only, JSON only, behind the existing Host guard.
   - Paid tools are **not** allowlisted for the web.
8. **UI module** `src/ui/portfolio.ts` + `portfolio.html` (a Vite single-file entry, like `sync-progress`), reusing tokens, `EChartWrapper`, `data-grid` and `displayRules`. No em dashes in UI text; table headers spelled out (memory).
9. **MCP tools.**
   - New: `portfolio` (list / add / remove / show, free), `refresh_portfolio` (quote; confirm to run), `schedule_portfolio_refresh`, and `get_portfolio` (App UI).
   - Existing `domain_visibility` / `ranked_keywords` stay as they are.

## 6. Honesty rules (copy into the code as comments where they bite)

- "Organic traffic" is always **"(est.)"** and its tooltip names DataForSEO ETV. GSC clicks are "measured".
- Domain Rank is **DataForSEO's**. Never called Authority Score.
- AI mentions are **per platform**, and only for the two platforms the data covers. There's no "AI visibility score".
- Every figure carries its month or captured date. The month toggle names the two months compared.
- A domain never fetched, an API family not enabled, and a real zero are three different cells.

## 7. Tests

`scripts/probe-portfolio.mjs` (into `npm test`), with DataForSEO responses from **saved fixtures** (fetch injected; no network):
- the quote maths;
- tier dispatch and partial-failure isolation (40204 on Backlinks while Labs succeeds);
- the spend ledger, including a cache hit = $0;
- the budget guard (a skip row is written, no job);
- the missed-run rule (one catch-up);
- the bucket mapping;
- owned-domain derivation from `sc-domain:` and URL-prefix properties;
- the "Needs attention" rules (positives and near-misses);
- the payload shape, empty-reason cells, and Month/Year change maths.

## 8. Phasing

1. Client methods + live shape verification (a few cents) + fixtures.
2. `_portfolio.db`, the `portfolio` tool, `refresh_portfolio` (quote + job), the ledger.
3. `getPortfolioData` + `getDomainOverview` + probe.
4. UI: the portfolio table, then the domain overview.
5. Scheduler (runner and in-process timer), the budget guard, the nudge.
6. Docs (README section, manual page), CHANGELOG, CLAUDE.md.

## 9. Gaps vs Semrush / SEO Stack (state them in the docs)

| Gap | Why | Path |
|---|---|---|
| AI Mode, Gemini, Perplexity mentions | Not in DataForSEO's LLM Mentions database. AI Mode is a per-keyword SERP; Gemini and Perplexity are only available as LLM Responses (you write the prompts). | Later: a bounded "AI prompt panel": N user prompts × engines, monthly, quoted. That's SEO Stack's model. |
| Authority Score | Proprietary. | DataForSEO Domain Rank, labelled. |
| Daily / weekly history | DataForSEO history is monthly. | Our weekly snapshots build it going forward. |
| "AI Visibility" 0-100 score | Unpublished normalisation. | Show raw mentions and AI search volume. |
| Sentiment | No defined scale. | Skip. |

---

## Review outcome → v1.1 (authoritative)

**Review process:** an adversarial review read the code and the DataForSEO docs. A live shape check covered all 14 endpoints, at $0.68 total; the raw responses are in `scripts/fixtures/portfolio/`. AI-visibility patterns came from studying Semrush's Visibility Overview and AIO tools, SEOmonitor's AIO tracker and Ahrefs Brand Radar.

### Blockers, fixed

1. **Schedules must never run twice.**
   - A due run is **claimed atomically** in `_portfolio.db`: `BEGIN IMMEDIATE; UPDATE portfolio_schedule SET next_due=@new WHERE id=1 AND next_due=@old`. A job is submitted only on `changes === 1`.
   - Every submit, manual or scheduled, also checks `liveJobTypes(dataDir, '_portfolio.db')` first.
   - The in-process timer runs only when `SAC_JOB_RUNNER !== 'external'`, never in the dashboard sidecar, and is `unref()`'d.
   - `next_due` is computed from **now**, so missed runs catch up once.
   - Job scope is `_portfolio.db`, never NULL: unscoped rows count as live for every property.
2. **Partial months.**
   - Every Month/Year comparison and every attention rule uses the **last complete calendar month**.
   - The current month shows hollow and labelled "to date". This is the summary page's honest treatment.
   - Live evidence: LLM `historical` gave Oct 2026 = 280 vs Sep = 866.
3. **Keys.**
   - Every table is keyed on `(domain, location_code)`.
   - `portfolio_domain_property(domain, site_url)` links one domain to several properties (`sc-domain:` + URL-prefix + www).
   - The property→target derivation is ONE shared function, used by RankTracker too. It strips `www.`. Today `RankTracker.domainFromProperty` doesn't, which makes the property dashboard and the portfolio disagree.
   - Owned rows take their location from `db.getDfsLocation()`.
4. **LLM Mentions is per platform.**
   - `multi_target_metrics` is one call per platform (`google`, `chat_gpt`), with 2-10 targets.
   - A single-domain portfolio uses `target_metrics`.
   - `historical` is per domain per platform.
   - Every LLM row stores `platform` and `location_code`.
   - AI Overviews is queried at the domain's location. ChatGPT is US-only: label it "ChatGPT (US)" for non-US domains.

### Should-fix, adopted

- **Costs:** `DFS_PRICES` uses the observed per-call costs:
  - `historical_rank_overview` $0.127;
  - LLM Mentions $0.101-0.103;
  - Backlinks bulk $0.0241;
  - Labs bulk/`ranked_keywords` $0.0121;
  - `domain_rank_overview` $0.0126.
  - With per-platform LLM calls, 10 domains cost **about $0.45 per weekly run and about $8 per monthly run, so about $10/month**. The quote shows this; the ledger shows the actuals (summed from `DfsResponse.cost`).
- **SERP mix:** `ranked_keywords` must send `item_types: [organic, paid, featured_snippet, local_pack, ai_overview_reference]`. Without it those blocks are null. Verified live: simracingcockpit.gg shows 1,465 AI Overview references, organic 5,370. Fix the stale 40501 comment in `DataForSeoClient.rankedKeywords`.
- **Countries:** `domain_rank_overview` with no location returns one row per **(location, language)**, sorted by location code. Fetch all rows, sum languages per location, sort by ETV client-side.
- **One rank scale:** `backlinks/history` gets `rank_scale: one_hundred`, the same as `bulk_ranks`.
- **Cache age:** `maxAgeDays` may be longer *or* shorter than the 20-day default. The weekly tier uses 6 days and the monthly tier 27 days.
- **Budget guard:**
  - Manual runs count toward the cap too. A manual run over the cap needs `overBudget: true` stated in chat.
  - The guard is checked **between endpoint families** (`spent + next family's quote ≤ cap`), and the run stops with a note when the next family would breach.
  - Consent records the domain count and the quote. A scheduled run whose quote rose >25% since consent is skipped with "re-confirm".
  - Watched domains are capped at 50.
  - `schedule_portfolio_refresh` is two-step: a preview with cadence, cap and current quote, then `confirm: true`.
  - The cap is stated as "portfolio refreshes only".
- **The spending rule, restated:** the portfolio's bulk and scheduled spend starts only from chat. (The web allowlist already exposes some small paid lookups, such as `keyword_volume` and `related_terms`; that's existing behaviour, unchanged.)
- **Reuse for owned domains.** One ingest of `historical_rank_overview` writes both `rank_history` (the property DB) and `domain_month` (the portfolio). It's sent with RankTracker's exact body, so the cache is shared and neither side pays twice. The paid block and the 21-50 / 51-100 split are kept in `domain_month`.
- **Web:** no separate `GET /api/portfolio`.
  - Everything goes through `POST /api/call` handlers (`get_portfolio_data`, `get_domain_overview`, `portfolio_add_domain`, `portfolio_remove_domain`), so the sidecar shares them.
  - Added domains are validated (hostname regex, ≤253 chars).
  - `_portfolio.db` has no `property_meta` table and goes into `CACHE_DB_NAMES`.
- **Chat button.** ext-apps 1.7.5 has `app.sendMessage({ role: 'user', content: [{ type: 'text', text }] })`.
  - It's shown only when `app.getHostCapabilities()?.message`.
  - On `isError` it falls back to copy.
  - The sent prompt never contains `confirm`, so the model still quotes first.
- **AI tables:**
  - "Top cited sources" excludes the target itself; live, the target was #1.
  - "Cited pages" keeps only the domain's own pages.
- **Attention rules, de-noised:**
  - ETV needs 2 consecutive complete months at ≥20% down, or 1 month at ≥30%.
  - Referring domains use main domains with a base of ≥50.
  - The "estimate vs GSC disagree" rule compares like with like (GSC country segment = the DataForSEO location), and is omitted when segments aren't synced.
  - Each figure names its source: snapshot (this week) vs history (last complete month).

### AI search visibility: the view, ranked (from the vendor study)

What we build, in order:
1. **KPI tiles per platform:** mentions, AI search volume, cited pages, each vs the last complete month. AI Overviews and ChatGPT, each named.
2. **Monthly combo chart:** mentions as bars + AI search volume as a line on a second axis, with a platform toggle. This is Semrush's Trend 2, with the partial month hollow.
3. **Rank × citation keyword matrix** (owned domains, from content recon). Columns: keyword, AI Overview present, our page cited (yes / no / **unknown**), organic rank (+ SERP depth), GSC impressions and clicks (28-day window). This is SEOmonitor's per-keyword card as a table. Unknown is its own grey state.
4. **Rank × citation quadrant** (owned): ranks & cited · ranks, not cited (the content target) · cited, not ranking · neither. Bubble = impressions.
5. **Top cited pages:** URL, mentions per platform, GSC clicks, and crawl status and indexability. A cited page that's noindexed or redirecting is flagged. That join is ours alone.
6. **Co-cited sources:** horizontal bars of the domains AI cites alongside us (target excluded). They're labelled sources, never "competitors".
7. **Share of voice among chosen domains:** monthly mentions of this domain vs its group. Labelled "among N chosen domains", never market share.
8. **Mentions by location:** ranked bars (few locations, so no map).

**Not shown (we can't measure it, so the gap is stated in a footnote):**
- a 0-100 visibility score;
- AI Mode / Gemini / Perplexity / Copilot;
- daily granularity;
- citation rank position;
- full answer text;
- sentiment;
- AI referral traffic.

### Scope: v1 vs later

**v1 builds:**
- the domain table (owned + watched, location-aware);
- the weekly bulk tier;
- the monthly history tier;
- LLM Mentions (AI Overviews + ChatGPT);
- the domain overview with the AI view above;
- the quote/confirm refresh and the ledger;
- the atomic scheduler with the budget guard;
- the CSV export of the table;
- group filter and sort.

**Later:**
- competitor auto-suggest on add (`competitors_domain`, paid);
- keyword-list position tracking;
- a per-row location picker in the UI (v1: set the location via the `portfolio` tool);
- an LLM Responses prompt panel for Gemini, Perplexity and Claude.

**Side fix:** `Backlinks.ts` / `backlinkProfile.ts` call backlinks history "daily". It's monthly.
