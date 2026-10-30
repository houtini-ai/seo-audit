<p align="center">
  <img src="https://raw.githubusercontent.com/houtini-ai/seo-audit/master/assets/logo.png" width="120" height="120" alt="SEO Audit Console" />
</p>

# SEO Console - the technical/content/research/opportunity SEO audit MCP server for Claude

**A technical SEO audit you can hold a conversation with - built from your own Search Console data and a live crawl of your site, run inside Claude.**

[![npm version](https://img.shields.io/npm/v/@houtini/seo-audit-console.svg?style=flat-square)](https://www.npmjs.com/package/@houtini/seo-audit-console)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-purple?style=flat-square)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Socket Badge](https://socket.dev/api/badge/npm/package/@houtini/seo-audit-console)](https://socket.dev/npm/package/@houtini/seo-audit-console)

Almost every technical SEO audit I've been handed in twenty years is a crawler's opinion, and a crawler only ever sees half the picture. It tells you what your site *says*. It has nothing to say about what Google *did* about it: which queries you rank for, which pages earn the impressions, where the clicks land.

This one brings the other half. SEO Audit Console runs inside Claude, pulls your **Google Search Console** history, crawls your site properly, and joins the two so every finding carries the traffic at stake. A hundred and eleven checks, ranked by the clicks the fix could recover rather than how alarming the check sounds, and it writes the fix for you: the 301 rule, the JSON-LD, the internal links. The core audit needs nothing but your own Search Console; **DataForSEO** and **Majestic** slot in later, when your questions grow into competitors and link building. Your data stays on your machine.

**Built by [Houtini](https://houtini.com).** We build automation for the grunt work of digital marketing - the data collection, the crawling, the merging, the checking - so your team's time goes on the thinking, the strategy and the client work that needs a human. This plugin is that idea applied to the technical SEO audit.

> **New to MCPs, or not sure where to start?** The **[Getting started guide](manual/getting-started.md)** takes you from a completely fresh machine (no Node, no Git, never heard of a service account) to your first audit - every step screenshotted, including the one everyone misses. Ten minutes, honestly.

```console
you  › run an SEO audit on mysite.com

     ⣾ search console  1.8M rows synced (19s - incremental)
     ⣾ crawl           868 pages · HTTP/2 · robots-polite · 8 parallel
     ⣾ link graph      internal PageRank · click depth · in-degree
     ✓ 143 checks · 220 findings · ranked by expected clicks per dev-hour

     #1  CTR far below position-expected     /pricing                   XL
     #2  Page losing clicks (trend)          site-wide                  XL
     #3  Keyword cannibalisation             "project management app"   L
     #4  Robots-blocked page earning traffic /category/guides           L

you  › generate the fix for #1 ▍
```

[![The Summary tab - data freshness, a one-line verdict, the headline tiles, 16 months of clicks, health per audit, what's broken and what to fix first, what changed since the last crawl, AI search and data coverage](https://raw.githubusercontent.com/houtini-ai/seo-audit/master/assets/dashboard-summary.png)](https://github.com/houtini-ai/seo-audit)

[![The Network tab - the site-network map of your internal link skeleton, equity vs traffic by template, and the folder-to-folder equity flow](https://raw.githubusercontent.com/houtini-ai/seo-audit/master/assets/network.png)](https://github.com/houtini-ai/seo-audit)

## Quick start

It's on npm, so there's nothing to clone or build. You need Node.js 20 or newer and a Search Console property you own.

**Claude Desktop** - add this to `claude_desktop_config.json`, then restart Claude:

```json
{
  "mcpServers": {
    "seo-audit-console": {
      "command": "npx",
      "args": ["-y", "@houtini/seo-audit-console"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "C:/path/to/service-account.json",
        "DATAFORSEO_USERNAME": "",
        "DATAFORSEO_PASSWORD": "",
        "MAJESTIC_API_KEY": "",
        "CRUX_API_KEY": ""
      }
    }
  }
}
```

The first line is required. The others are optional: paste your key between the quotes, or **leave them empty to switch the tier off**. DataForSEO and Majestic are paid tiers; `CRUX_API_KEY` is field Core Web Vitals from a free Google API key restricted to the Chrome UX Report API. Empty means off. Template text such as `your-key-here`, `<your key>` or `changeme` is treated as empty too, and the server's log says so in one line (e.g. `MAJESTIC_API_KEY looks like a placeholder; Majestic tier disabled.`), so a tier you expected that stays off is worth a look at the log.

**Claude Code** - one command (add `--env DATAFORSEO_USERNAME=…` and the others the same way if you use them):

```bash
claude mcp add seo-audit-console --env GOOGLE_APPLICATION_CREDENTIALS=C:/path/to/service-account.json -- npx -y @houtini/seo-audit-console
```

`GOOGLE_APPLICATION_CREDENTIALS` alone is the whole core audit. The step everyone misses: the JSON key belongs to a Google Cloud service account, and that account's email has to be **added as a user on your property** in Search Console, or the tool can't see any of your data. [Getting started](manual/getting-started.md) walks through it with screenshots, plus the one-click Claude Desktop extension and the build-from-source route.

Then ask Claude: *"list properties"*, *"refresh mysite.com"*, *"run an SEO audit"*.

## Opening the dashboard

Once a property has been refreshed or audited, there are three ways to see it:

| You want | Ask Claude | What you get |
|---|---|---|
| A quick look in the chat | *"show me the dashboard for mysite.com"* | The dashboard drawn inside the conversation (`get_dashboard`) |
| The full dashboard in your browser | *"open the dashboard for mysite.com"* | A link such as `http://127.0.0.1:53817/dashboard?siteUrl=…` (`open_dashboard`). Click it. It reads the local database live, so reload after each refresh |
| Something to send a client | *"export the report for mysite.com"* | One self-contained HTML file (`export_report`) |

You often don't need to ask: when a refresh, crawl, sync or audit finishes, the reply says the dashboard is updated and includes the browser link. The link is local to your machine (it only answers on `127.0.0.1`), and the port changes each time the server starts, so use the link from the latest reply. Add `&theme=dark` for dark mode, or `&redact=1` to blur the numbers for a screenshot.

**Running it under Docker or the Docker MCP gateway?** The browser link points at a port inside the container, which your browser can't reach. Run the dashboard as its own small container on a fixed port instead, on the same data volume:

```bash
docker run -d --init --name seo-audit-dashboard --restart unless-stopped -p 127.0.0.1:8788:8788 -e SAC_DATA_DIR=/data -e SAC_DASHBOARD_BIND=0.0.0.0 -e SAC_DASHBOARD_PORT=8788 -v <your-data-volume>:/data node:22-slim npx -y -p @houtini/seo-audit-console@<your-version> seo-audit-dashboard
```

Then open `http://127.0.0.1:8788/dashboard?siteUrl=sc-domain:mysite.com`. Replace `<your-data-volume>` with the volume your MCP server writes to, and `<your-version>` with the version it runs, so the two match (the server prints this command with its own version filled in). The volume must be writable: the dashboard's actions start jobs. In Git Bash on Windows, put `MSYS_NO_PATHCONV=1` in front of the command so `/data` isn't rewritten as a Windows path. More in [dashboard.md](manual/dashboard.md).

## The manual

This README is the story and the quick start. The detail lives in the manual:

| Page | What's in it |
|---|---|
| [Getting started](manual/getting-started.md) | Install, the GSC service-account setup (and the step everyone misses), Claude Desktop and Claude Code config, your first audit, troubleshooting |
| [Tool reference](manual/tools.md) | Every tool: what it does, inputs, joins, an example prompt |
| [The check registry](manual/checks.md) | All 143 checks with what each catches, its D/N label, and the fix |
| [Composition](manual/composition.md) | The join keys, the grains, and fourteen recipes for asking your own questions across the data |
| [Competitive analysis](manual/competitive.md) | The competitive workflows, DataForSEO setup, link intersect with the Majestic Trust Flow tier, and the real costs |
| [Architecture](ARCHITECTURE.md) | For contributors and reviewers: how the code fits together (storage, the join key, collection, the audit engine, jobs, the dashboard) and the conventions it follows |
| [SEO Recon](manual/recon.md) | Why a page is losing: the live SERP + AI-Overview citation verdict, the competitor diff, and the trackable to-do ledger |
| [DataForSEO functions](manual/dataforseo.md) | Every DataForSEO-backed tool grouped by API module - Keywords, SERP, Labs, Backlinks, OnPage - each with its endpoint and cost |
| [Majestic functions](manual/majestic.md) | The optional Trust Flow tier - what it adds, and how `link_intersect` and `pull_backlinks` use it |
| [The portfolio](manual/portfolio.md) | Every domain you look after on one page (owned + watched): measured vs estimated, Domain Rank, AI mentions, needs-attention, the domain overview, and quoted, budget-capped refreshes |
| [Dashboard & reports](manual/dashboard.md) | The eight tabs, what each chart shows, the browser dashboard (and its standalone version for Docker), and the shareable export |

## Surprisingly little has changed in twenty years

The technical audit I was writing for clients in 2006 is, structurally, the audit most agencies still sell today. A crawler runs, a template fills, a 60-page PDF lands. Everything a crawler could find, in severity order, with no idea which findings are worth money and which are cosmetic.

What *has* changed is what's possible. Google gives every site owner a complete record of its search reality - which queries, which pages, how many impressions, where you ranked. Your crawl tells you what your site says. Search Console tells you what Google did about it. And in my experience, the gap between those two datasets is where nearly all of the recoverable traffic hides.

So that's what I built. SEO Audit Console is a [Model Context Protocol](https://modelcontextprotocol.io) server that merges your **Search Console history** with a **first-party crawl of your site** (and, when you want it, **DataForSEO**) into one thing: a prioritised, evidence-backed audit you can interrogate inside Claude Desktop. It hands you paste-ready fixes. Every finding traces back to a real datapoint.

One idea underneath all of it:

> **Your crawl is intent. Search Console is reality. The money is where they diverge.**

A flat crawler tells you a page 404s. Useful, but only just. This tells you the 404 is draining 15% of your homepage's internal PageRank, that the page used to earn 10,000 clicks a month, and it writes the 301 rule to fix it. It finds the page at position #3 on 150,000 impressions with a 0.2% click-through rate - a title rewrite probably worth thousands of clicks - and ranks that *above* the cosmetic findings. Severity is what crawlers sell you. Yield is what moves the numbers.

### Who is this for?

The SEO consultant who wants the collection and checking automated so the thinking time survives. The in-house marketer who's been quoted four figures for a commodity audit. And anyone newer to this who wants to learn what a good audit looks at - because every finding shows its evidence, the tool doubles as a teacher.

A note on where to run it. Claude Desktop is the easy start, but in my view **Claude Code is the best home for this tool** - because it closes the loop. In a chat client the audit hands you a 301 rule to paste somewhere. In Claude Code, the same session has your site's repo, a terminal and git: the audit finds the issue, writes the fix, applies it to the codebase, commits it, and re-crawls to verify. Finding to deployed fix, one conversation.

You don't need to learn an interface. You type *"run an SEO audit on mysite.com"* into Claude and it happens. Forget what's possible? Ask *"run seo_audit_help"* and you get the full menu with example prompts.

### Does the approach work?

Yes. The crawl-plus-GSC merge is not a novelty; it's the method. On one property, seeding the crawl from Search Console URLs took coverage of GSC-known pages from 29% to 70% - every one of those extra pages is a page a conventional crawl silently missed, and several were earning traffic with no internal links pointing at them at all. On the same property the incremental sync turned a 33-minute data refresh into 19 seconds, which is the difference between "audit quarterly" and "audit whenever you're curious".

---

## What the audit checks

`run_audit` executes **143 checks** over the joined data and returns a ranked list - not a wall of everything, a priority order with the traffic at stake attached to each finding. The families, briefly:

| Family | What it catches |
|---|---|
| **Crawlability & indexation** | Broken links, redirect hygiene (chains, loops, temporary redirects carrying equity, redirects onto non-indexable pages or the homepage, live pages removed without a redirect), URLs that don't exist answering 200 (soft-404 setup) and http/https or www/apex twins not redirected in one 301, orphans, index bloat, spider-traps, robots-blocked pages still earning traffic, canonicals that hand indexing to another host, hreflang that Google would ignore (invalid codes, no self-reference, duplicate locales, canonical conflicts), and the *reason* every URL isn't indexable |
| **On-page & structured data** | Titles, metas, H1s, alt text - plus a local validator covering ~30 rich-result types, required fields only, so it never nags about properties Google ignores. For stores: product pages that went from 200 to 404, and Product markup missing what merchant listings need |
| **Page weight & assets** | What every page loads, from the crawl: CSS, JavaScript and font files that return errors, render-blocking scripts and stylesheets in `<head>`, static files with no cache lifetime, broken images, images over 300 KB and JPEG/PNG where WebP would be smaller (measured as a browser is served them). Real-user Core Web Vitals come from CrUX |
| **Trends (GSC over time)** | Pages losing clicks, rankings slipping, vanished queries, rising pages worth doubling down on, stale content decaying year-on-year |
| **The merged questions** | Cannibalisation, striking distance, ghost pages, traffic to dead URLs, internal authority wasted on no-click pages, titles missing the query you already rank for |
| **AI-search readiness** | Phrases you rank for but never say, queries your copy never answers in one passage, content that doesn't chunk cleanly for retrieval |
| **Accessibility** | A deterministic subset of the axe-core rules read straight from the HTML - links and buttons with no accessible name, unlabelled form fields, pinch-zoom disabled, positive tabindex, duplicate ids - alongside alt text, heading order and missing `lang` |
| **JavaScript rendering & duplication** | On demand: *Response vs Render* (`render_pages`) crawls each page in headless Chromium and flags content and links that exist only after JavaScript, and what JavaScript changes (canonical, title, noindex in either direction, server-rendered copy it removes), and semantic near-duplicate detection (`find_duplicates`) finds pages that say the same thing - both run locally, no API cost |

Every check is labelled **D** (deterministic - here are the bytes) or **N** (judgement - off by default, ask for *"the judgement findings"* to see them). In my view a wrong finding is worse than no finding at all, so the heuristic checks have to ask permission. The full registry, check by check, is in [the manual](manual/checks.md).

And if you grew up on the classic desktop SEO crawlers, the dashboard's Crawl health tab will feel like home - response codes, indexability reasons, crawl depth, the heaviest images, server errors and slow pages, all as clean stat bars. Same diagnostics, except each one is sitting next to the Search Console numbers for the same URL. The tab-by-tab tour is in [dashboard.md](manual/dashboard.md).

---

## The crawl, properly explained

The crawl is where audits usually go wrong, so it's worth understanding what this one does differently. I've spent enough of my career cleaning up after crawlers that fooled themselves. This one is a proper SEO crawler - it just happens to have your Search Console history sitting next to it.

**It discovers pages three ways.** Following links, reading your XML sitemaps, and - the important one - starting from every URL Google is already sending traffic to, straight out of your GSC data. Coverage stops depending on your sitemap being honest. It's also exactly how ghost pages get caught: if Google ranks a URL your own site structure can't reach, that URL still gets crawled, and the mismatch becomes a finding.

**It records *why*, not just *what*.** For every URL that isn't indexable it stores the reason - 404, noindex, X-Robots header, canonicalised elsewhere, robots-blocked, non-HTML. "This page won't rank" is a fact; "this page won't rank because a plugin set an X-Robots header nobody remembers" is a fix.

**It refuses to be fooled.** A redirect that leaves your site (Shopify OAuth flows, I'm looking at you) is recorded as a redirect-out, never stored as a page. It always uses GET rather than HEAD, because a HEAD request can return a different status than the real request would - but it abandons the body for images, PDFs and assets, so it records status and size without downloading the bytes.

**It's quick without being rude.** HTTP/2 where your origin supports it, gzip and brotli negotiated, keep-alive connections reused. The speed comes from efficiency, not from hammering your server. It respects robots.txt properly (a bot-specific group replaces `*`, per the spec, which plenty of commercial crawlers get wrong), and skips the junk: internal search, faceted filter combinations, login flows. This is a crawler for sites you own. Being a good guest is the point.

**It slows down when your host asks it to.** A 429 (or a 503 with `Retry-After`) halves the crawl's concurrency, waits out the `Retry-After`, and puts the URL at the back of the queue for two more tries; clean responses add workers back. Shopify stores are spotted from their headers and start gently. A URL still rate limited at the end is stored as *rate limited* with no status, never as a broken page, and the crawl status tells you how many.

**It tests what a crawl can't find on its own.** Each crawl ends with up to five site probes: two URLs that can't exist (does the site answer 404, or 200 and a soft-404?) and the http/https and www/apex twins of the homepage and a deep page (one 301 to the canonical host, or a split?). It also records what every page loads - stylesheets, scripts, fonts, images, first or third party, in the head or the body - without downloading any of it; `headResources:true` adds a header-only pass for their status, size and caching.

**It says what it didn't measure.** A check whose data was never collected - the asset checks before a `headResources` crawl, the render checks before `render_pages`, field Core Web Vitals before `sync_crux` - is listed in the audit as *not collected*, with the step that collects it. An empty table never reads as a clean bill of health.

After the crawl it computes a real link graph: internal PageRank with nav and footer links down-weighted, click depth from the homepage counting body links only, in-degree per page. That graph powers the orphan, equity-leak and underlinked-page checks - and the donor rankings when the tool suggests internal links.

[![The Crawl health tab - the canonical, redirect and not-found breakdown, then classic crawl diagnostics as stat bars](https://raw.githubusercontent.com/houtini-ai/seo-audit/master/assets/crawl-health.png)](https://github.com/houtini-ai/seo-audit)

---

## The workflows, briefly

Each of these is a real procedure I use, and each is one prompt. The expanded versions, with what happens underneath, live in the manual pages linked.

1. **Your first audit.** *"Refresh sc-domain:mysite.com"*, then *"Run an SEO audit on mysite.com"*. Twenty minutes on a mid-size site, and the top five findings are usually worth more than the other eighty-five combined. Then *"generate the fix for #1"*. → [getting-started.md](manual/getting-started.md)
2. **Sitewide keyword optimisation.** The question isn't "what keywords should I target?" - it's "where does my copy fail to say what I already rank for?" *"Score the passages on mysite.com"* runs a small local relevance model over every ranking page; *"draft the missing content for /page"* writes the fix in your site's own voice, grounded so it invents nothing. → [tools.md](manual/tools.md#ai-search-readiness)
3. **Cannibalisation.** *"Show me the cannibalisation findings with evidence"* - thresholds tuned so incidental long-tail overlap doesn't count, so the consolidate-or-differentiate call is made on numbers. → [checks.md](manual/checks.md#the-merged-checks-24)
4. **The content plan.** *"Suggest new pages for mysite.com"* mines demand Google already shows you; *"what topics should mysite.com cover?"* maps the demand it doesn't. Together: a quarter's plan. → [competitive.md](manual/competitive.md)
5. **The template play.** *"List the page templates"* - big sites aren't 50,000 pages, they're a dozen templates repeated, and one template fix corrects the whole cluster. → [tools.md](manual/tools.md#list_templates)
6. **Monitoring and migrations.** *"Detect changes on mysite.com"* diffs your two most recent crawls by severity. During a migration this is the difference between catching a stray noindex on Tuesday and explaining a traffic graph in a board meeting three weeks later. I've been on the wrong end of that one. → [tools.md](manual/tools.md#monitoring)
7. **AI-search readiness.** *"Check agent readiness for mysite.com"* - the web is quietly growing a second audience, and almost no SEO tool checks any of it. → [tools.md](manual/tools.md#check_agent_readiness)
8. **Your own questions.** The four datasets share three join keys, and the most valuable analyses are the ones you compose yourself - *"which pages lost clicks after being cited in AI Overviews?"* is one prompt here and a feature nowhere else. → [composition.md](manual/composition.md)
9. **Reporting.** *"Show me the dashboard"* in the chat, *"serve the dashboard"* for the live version in your browser, or *"export the report"* as one self-contained HTML file you can send a client. → [dashboard.md](manual/dashboard.md)
10. **The content opportunity report.** If you write for a living, this is your page one: *"Content opportunities for mysite.com"* returns what to WRITE next (demand you already earn impressions for with no winning page), what to REFRESH (pages bleeding clicks), which SNIPPETS to rewrite (ranking well, under-clicked), and which clusters to STRENGTHEN (position 4-20, one push from the money). Every row traces to your own Search Console data - no invented keyword ideas - and *"draft the brief for row 1"* turns any of them into a grounded outline. → [competitive.md](manual/competitive.md)
11. **Market Sizing and Prioritisation.** *"Size the market: mysite.com vs rival1.com and rival2.com"* - the keyword universe, total monthly demand, and share of voice per topic cluster, from one cached call per domain. The engagement-opening read that used to need a paid SEO suite. → [competitive.md](manual/competitive.md)
12. **Content recon - why is this page losing?** *"Run content recon on mysite.com"* takes your highest-impression pages sitting at positions 3-15 (the ones a push could move), pulls the live Google SERP for each, and reads whether the **AI Overview** cites you. The verdict is the honest bit: *rank but not cited* is a data-accuracy or freshness problem, not a rewrite. It reads the reachable competitors with a free browser-profile fetch (Reddit through its own JSON), lists the ranking videos for you to watch, and writes the gaps into a tracked to-do board you can annotate and re-measure. → [recon.md](manual/recon.md)
13. **Link prospecting, sorted by authority that's real.** *"Link intersect for mysite.com vs rival1.com, rival2.com"* returns the domains linking to your rivals and not to you - the outreach list, followed-first and spam-filtered. Add a **Majestic** key and it re-sorts on **Trust Flow** and shows each prospect's **Topical Trust Flow**, so the directories drop out and what's left is authority that's on your topic. → [Majestic, below](#link-intersect-and-the-majestic-trust-flow-tier)

[![The Search performance tab - branded vs non-branded, ranking distribution over time (impressions by position bucket) and search visibility over time](https://raw.githubusercontent.com/houtini-ai/seo-audit/master/assets/search-performance.png)](https://github.com/houtini-ai/seo-audit)

[![Content architecture - your search demand grouped into topic clusters, each with a coverage score, striking-distance members and gaps](https://raw.githubusercontent.com/houtini-ai/seo-audit/master/assets/content-architecture.png)](https://github.com/houtini-ai/seo-audit)

---

## What DataForSEO adds (and what it costs)

Everything above works with just your Search Console data. But GSC can only describe searches where you already appear. The moment your question is "how big is this market?" or "what do competitors rank for that I don't?", you need third-party data - and that's [DataForSEO](https://dataforseo.com/?aff=213701): a pay-as-you-go API for volumes, live rankings, competitor data and Lighthouse runs. No subscription; calls cost fractions of a cent to a few cents, cached for 20 days, and only ever run when you ask. My own usage runs to a few dollars a month.

It unlocks the competitive layer: the organic visibility overview for any domain, any site's top pages and ranked keywords (including which of them show an **AI Overview**), the content gap, topic gaps, search intent, lab Core Web Vitals and backlinks. It also drives **content recon** - `recon_targets` pulls the live Google SERP for a losing page, reads whether the AI Overview cites you, and tells you *why* you're behind. The full workflows and setup: [competitive.md](manual/competitive.md).

It also powers the **portfolio**: one table across your owned properties and any domains you watch. Organic keywords and traffic, referring domains, Domain Rank and AI mentions (Google AI Overviews + ChatGPT) sit next to your measured Search Console clicks and audit health, with a "needs attention" tab and a per-domain overview. Every figure says whether it was measured or estimated, and refreshes quote their cost before anything is spent (8 domains on the weekly tier cost $0.22 on a live run). The detail: [portfolio.md](manual/portfolio.md).

One more thing DataForSEO unlocks gets a section of its own, because the link work has a second, optional service behind it.

---

## Link intersect, and the Majestic Trust Flow tier

Link building is the one discipline where the prospect list *is* the strategy, so `link_intersect` builds it from evidence rather than a hunch. One DataForSEO `domain_intersection` call over your competitor set - yours excluded - returns every domain that links to them and not to you, aggregated per prospect: how many of your rivals it links to, whether the link is followed, its worst spam score, the anchor mix. Point it at a single company instead of a set and it answers the other classic, *what links does company X have that we don't?*

That gets you a list. It doesn't get you a priority order, and this is where link prospecting has always gone wrong. DataForSEO sorts on domain rank, which is a link-**volume** metric, so directories, aggregators and syndicated-press domains float straight to the top - technically authoritative, worthless to pitch. Every link builder I know has lost a week to that list.

**Set `MAJESTIC_API_KEY` and the order changes to one you can defend.** [Majestic](https://majestic.com) has been crawling and scoring the web's link graph since before most of today's SEO tools existed, and its two flagship metrics are exactly the ones that fix this:

- **Trust Flow (0-100)** - editorial authority, propagated from a seed set of trusted sites. It measures who *vouches* for a domain rather than how many links it has managed to accumulate. That's the directory killer: in testing, a domain DataForSEO ranked **227** came back **Trust Flow 0**. A volume metric simply cannot see that.
- **Topical Trust Flow** - what that authority is *about*, as ranked topics. A Trust Flow 45 domain is a brilliant link when its top topic is `Recreation/Autos` and you sell car parts, and a wasted pitch when it's `Health/Nutrition`. It's the difference between a strong link and a relevant one, and it's the column that makes an outreach list survive contact with a client.

With the key set, every qualifying prospect is enriched, the table gains a Trust Flow column and each domain's leading topic, and the whole list is **re-sorted by Trust Flow**:

```console
you  › link intersect for mysite.com vs rival1.com, rival2.com

     Prospect domain     Links to  Trust Flow  Link    Spam  Backlinks  Top topic
     enthusiast-mag.com  2/2       54          follow  2     31         Recreation/Autos
     club-forum.org      2/2       41          follow  0     12         Recreation/Autos
     free-link-list.net  2/2       0           follow  28    904        –
```

(Shape of the output, names invented.) Same three prospects, same DataForSEO data underneath - and note which one has the most backlinks. Sorted DataForSEO's way, the directory is the one you'd have emailed first.

`link_intersect` needs DataForSEO's Backlinks subscription, which is separate from their SERP/Keywords/Labs APIs; if it isn't activated the tool says so in plain English rather than throwing a code at you.

The tier is careful with your allowance: enrichment is batched 100 domains per call (about one unit each), capped by `enrichLimit` (default 100 - and when more prospects qualify than get enriched, the response says so and tells you to raise it, rather than handing you a half-scored list), requests are serialised, and every response is cached for 30 days via `MAJESTIC_CACHE_DAYS`. Ask the same question twice in a fortnight and the second answer costs nothing.

Optional, and I mean optional: with no key, `link_intersect` still runs and still sorts followed-first by domain trust. Majestic is what turns "here are 100 domains" into "here are the 20 worth an email, and here's why". Grab a key on their [plans and pricing](https://majestic.com/plans-pricing) page; the full workflow is in [competitive.md](manual/competitive.md#link-intersect-link_intersect).

> Trust Flow and Topical Trust Flow are trademarks of [Majestic](https://majestic.com) (Majestic-12 Ltd). This tier calls the Majestic API with your own key, only when you run `link_intersect` or `pull_backlinks` (which adds Trust Flow to your own backlinked pages for the dashboard's Trapped authority report), and nothing else in the tool touches it.

---

## Installation, in brief

Three steps - the [quick start](#quick-start) above is the short version, and the full walkthrough with the gotchas is [getting-started.md](manual/getting-started.md):

1. **Get it:** the quick route is npx - point your MCP config at `npx -y @houtini/seo-audit-console` and there's nothing to build. Or clone this repo, `npm install`, `npm run build` if you want the source. Either way, Node ≥ 20.
2. **Connect Search Console:** create a Google Cloud service account, download its JSON key, and - the step everyone misses - **add the service account's email as a user on your property** in Search Console. Prefer a walkthrough with pictures? [Setting it up from scratch](https://houtini.com/articles/better-search-console/#setting-it-up-from-scratch) covers the whole flow.
3. **Point your MCP client at it** with `GOOGLE_APPLICATION_CREDENTIALS` set: `npx -y @houtini/seo-audit-console` for the published package, or `node /path/to/seo-audit-console/dist/index.js` if you built from source. Works in Claude Desktop and Claude Code; only the one env var is required.

Every environment variable the server reads, in one block. The first is required and everything below it is optional: fill in the ones you use and leave the rest as empty strings (or delete them). An empty value switches that service off, and so does leftover template text such as `your-key-here` (with one line in the server's log saying so).

```json
{
  "mcpServers": {
    "seo-audit-console": {
      "command": "npx",
      "args": ["-y", "@houtini/seo-audit-console"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "C:/path/to/service-account.json",
        "SAC_DATA_DIR": "",
        "DATAFORSEO_USERNAME": "",
        "DATAFORSEO_PASSWORD": "",
        "DATAFORSEO_CACHE_DAYS": "20",
        "MAJESTIC_API_KEY": "",
        "MAJESTIC_CACHE_DAYS": "30",
        "CRUX_API_KEY": ""
      }
    }
  }
}
```

Built from source instead? Swap the two launch lines for `"command": "node"` and `"args": ["C:/path/to/seo-audit-console/dist/index.js"]`; the `env` block is identical.

`GOOGLE_APPLICATION_CREDENTIALS` gets you the whole core audit. DataForSEO adds the market layer, `MAJESTIC_API_KEY` adds the Trust Flow re-sort to `link_intersect`, and `CRUX_API_KEY` (optional: field Core Web Vitals, a free Google API key restricted to the Chrome UX Report API) adds real-user LCP, INP and CLS. Line-by-line, including the advanced ones you'll probably never need (the reranker device, the Majestic sandbox host, and the dashboard server's bind, port and auto-start): [getting-started.md](manual/getting-started.md#environment-variables).

Then: *"list properties"* to check it's connected, *"refresh"*, *"run an SEO audit"*.

### Upgrading to 0.16.0

0.16.0 changes how Search Console rows are stored. The device and country rows a `segments:true` sync pulls now live in their own table (`search_analytics_segments`), and `search_analytics` holds only the all-country totals, so no total can count a day twice. Nothing to do by hand, but know what the first sync after upgrading does to a database that held both shapes:

- **It backs the database up first**, to `<database>.bak-<date-time>` beside it. The backup is a full copy, so a 5 GB database leaves a 5 GB `.bak` file.
- **It checks free disk before it starts**: room for the backup, plus half the database again, plus 256 MB. Without that room the migration waits: the sync still runs in the old layout (totals stay correct, because the views count each day once), the reply says "storage migration deferred: needs N GB free", nothing is moved, and it migrates on a later sync once there's space.
- **Then it moves the rows**, a batch of days at a time. On a 5.5 GB database that took under three and a half minutes, backup included. If it's interrupted it carries on from where it stopped on the next sync, and the numbers read correctly throughout.
- **Afterwards, reclaim the space.** The database file keeps its size until it's compacted: ask *"vacuum the mysite.com database"* (`data_storage`, `prune` with `vacuum`). On the 5.5 GB test database that took it to 4.4 GB. Once you're happy with the numbers, delete the `.bak` file yourself; nothing deletes it for you.

A database that only ever held one shape (most do: a sync without `segments`) is marked as migrated on first open, with no backup and no move. The [changelog](CHANGELOG.md) has the rest of the release.

### Docker and the Docker MCP gateway

Crawls, syncs and refreshes run as background jobs: the tool returns a job id at once and the work carries on while you poll `check_crawl_status`. Run normally (npx, or `node dist/index.js` from Claude Desktop), the server process is long-lived and does that work itself. Nothing below applies.

The Docker MCP gateway is different, in two ways.

- **Start-up.** The gateway runs the server in a worker container. Without `longLived: true` on the catalog entry it starts a fresh worker for **every tool call**; with it, one worker per client connection. A worker started from `node:22-slim` with `npx` installs the package before it can answer, which takes 60-90 seconds and is longer than Claude Code waits for a tool call. So every call times out, even `seo_audit_help`. The fix is an image with the package preinstalled, plus `longLived: true` (step 1 below).
- **Jobs.** The gateway replaces workers freely: on disconnect, on a router recreate, when it reaps idle ones. A job running inside a worker dies with it. The fix is to move the work out of the worker into one long-running **job runner** container that the gateway never touches (steps 2 and 3).

Measured on a gateway in October 2026 (0.16.2):

| Catalog entry | First call on a new connection | Later calls |
|---|---|---|
| `node:22-slim` + `npx`, no `longLived` | 88-108 s | 88-108 s (every call) |
| `node:22-slim` + `npx`, `longLived: true` | 75-80 s | instant |
| Prebuilt image, no `longLived` | 2 s | 2 s |
| **Prebuilt image, `longLived: true`** | **2 s** | **instant** |

**1. Build the image and point the catalog entry at it.** Pin the version, so the image and the runner stay on the same release:

```dockerfile
FROM node:22-slim
RUN npm install -g @houtini/seo-audit-console@0.17.0
ENTRYPOINT ["seo-audit-console"]
```

`docker build -t seo-audit-console:0.17.0 .` in the folder holding that file. Then, in the catalog entry, set `image: seo-audit-console:0.17.0`, delete the `command:` line (the image's entrypoint starts the server), and add `longLived: true`. The gateway runs local images with `--pull never`, so it finds the one you built. Rebuild the image for each release and change the tag in the catalog entry.

The runner takes the other two steps:

- the MCP server, started with `SAC_JOB_RUNNER=external`, only queues each job in `_jobs.db` in the data directory and reads its status;
- the runner (`seo-audit-runner`, in the same npm package) claims queued jobs, runs them and writes progress back to the same database.

The workers become disposable: recreate the router mid-crawl and the crawl carries on in the runner.

**2. Start the runner** on the same data volume, with the same credentials as the gateway's catalog entry, from the image you built in step 1:

```bash
docker run -d --init --name seo-audit-runner --restart unless-stopped \
  -v mcp-sac-data:/data -v mcp-sac-creds:/creds:ro \
  -e SAC_DATA_DIR=/data -e GOOGLE_APPLICATION_CREDENTIALS=/creds/gsc.json \
  -e DATAFORSEO_USERNAME -e DATAFORSEO_PASSWORD -e MAJESTIC_API_KEY -e CRUX_API_KEY \
  --entrypoint seo-audit-runner seo-audit-console:0.17.0
```

The four `-e NAME` flags with no value pass those variables through from your shell, so the keys stay out of the command line; leave out any you don't use. On Windows in Git Bash, prefix the command with `MSYS_NO_PATHCONV=1`, otherwise MSYS rewrites `/data` and `/creds` into Windows paths (PowerShell doesn't need it). `--init` makes `docker stop` reach the runner as a clean SIGTERM. `docker logs seo-audit-runner` shows it start and every job it claims. (Without the image, `node:22-slim npx -y -p @houtini/seo-audit-console@0.17.0 seo-audit-runner` works too: the runner is one long-running container, so npx installs only once, on its first start.)

**3. Switch the gateway to queueing.** Add `SAC_JOB_RUNNER=external` to the env of this server's catalog entry. **Keep `longLived: true`.** The runner makes jobs survive a worker being replaced; `longLived` keeps the worker warm between calls. They solve different problems, and they work together (tested: a sync queued through a `longLived` worker was claimed and finished by the runner).

**What you'll see.** A job reads `queued: waiting for the job runner` until the runner picks it up, then `running` as before. If a job stays queued for over a minute and no runner has checked in, the status says so and prints the `docker run` line above. After about two minutes with no runner heartbeat it reads `queued (no runner)` and no longer blocks `data_storage` prune or repair; it stays listed until the usual one-day prune. One runner runs one job at a time by default; set `SAC_RUNNER_CONCURRENCY` to run more, though two jobs for the same property never run at once. **To update:** build the image for the new release (step 1, new tag), change the tag in the catalog entry, restart the gateway, and recreate the runner from the new image (`docker rm -f seo-audit-runner`, then the `docker run` line again). Keep the runner and the gateway on the same release. A job running when the runner stops is recorded as `interrupted`, so re-run it.

**If you stay on `npx` in the gateway,** every new worker installs the package first, so expect the first call of each client connection to time out (later calls are fast with `longLived: true`). The server notices this case: started by npx inside a container, it logs a warning pointing here, visible in `docker logs` for the gateway.

**After upgrading, restart the MCP client.** Clients read the tool list once, when they connect, and keep it. Until Claude Desktop or Claude Code is restarted (fully, from the tray on Windows), tools added in the new release, such as `sync_crux`, stay invisible even though the server has them.

**Without the runner,** the older options still work: `longLived: true` on the catalog entry (or `--long-lived` on the gateway), or plain `docker run -i --rm` with the volumes mounted, which is one long-lived stdio process for the session. Either way, mount named volumes for the data directory and the credentials (for example `-v seo-audit-data:/data -e SAC_DATA_DIR=/data` and `-v seo-audit-creds:/creds:ro -e GOOGLE_APPLICATION_CREDENTIALS=/creds/service-account.json`) so audits and the job list survive a restart.

There's no published image for the server itself. Step 1's image installs the published npm package; to run your own build of this repo instead, use its `Dockerfile` (`docker build -t seo-audit-console .`), whose entrypoint is `node dist/index.js`, the stdio server.

Every job is recorded in `_jobs.db` in the data directory. If the process running a job exits before it finishes, the job reads as `interrupted` with the reason rather than disappearing, and a finished job's result can still be read after a restart.

The gateway doesn't publish the server container's ports, so the browser dashboard the server starts after a job isn't reachable from your machine. The server notices it is in a container without a published dashboard port (no `SAC_DASHBOARD_BIND=0.0.0.0` with `SAC_DASHBOARD_PORT`), and says so in place of the link, with the command to start the standalone dashboard. `get_dashboard` still renders it in chat, and for a browser tab you can run the standalone dashboard, `seo-audit-dashboard`, as a second container on the same data volume with a published port. The command is in [dashboard.md](manual/dashboard.md#in-your-browser).

---

## The tools, at a glance

The one-line version - full descriptions, inputs and example prompts for every tool are in [the tool reference](manual/tools.md).

| Tool | What it does |
|---|---|
| `refresh_property` | Sync GSC + crawl + inspect + rank history + CrUX field data, one job |
| `sync_gsc` · `start_crawl` · `inspect_urls` · `track_ranks` · `sync_crux` | Run a single part on its own (`sync_crux`: real-user Core Web Vitals from the Chrome UX Report, free with a `CRUX_API_KEY`) |
| `check_sync_status` · `check_crawl_status` | Watch a long job's progress |
| `run_audit` · `query_audit` · `list_checks` | The scored audit · one check with evidence · the catalogue |
| `query_data` | Read-only queries over the raw tables - aggregates in the database, answers not rows |
| `open_dashboard` | The property's live browser dashboard link; finished syncs and crawls offer it themselves |
| `probe_urls` · `triage_404s` | Test any URL live (redirects, canonical, cache, case/slash/host variants) · the 404 list as a redirect map |
| `fix_finding` | Paste-ready remediation (JSON-LD / 301 / internal links) |
| `detect_changes` | What changed between the two most recent crawls |
| `check_agent_readiness` | 0-100 AI-agent readiness score with copy-paste fixes |
| `list_templates` · `suggest_pages` | Template clusters · new-page ideas from real demand |
| `score_passages` · `draft_content` | Local relevance scoring · grounded writing briefs |
| `find_duplicates` · `render_pages` | Semantic near-duplicate pages (local model) · Response vs Render in headless Chromium (optional Playwright) |
| `resolve_entities` | Wikidata entities and the link gaps between them |
| `keyword_volume` · `related_terms` · `search_intent` | DataForSEO keyword data |
| `youtube_discovery` · `news_discovery` · `topic_trend` · `trend_categories` | Content research: the videos ranking for a topic (pair with a transcript tool) · recent news coverage / freshness · Google Trends interest-over-time for keywords, a whole category, or a term inside one (rising / falling / seasonal, plus breakout topics and queries) · free lookup of the Trends category codes |
| `competitors_domain` · `page_intersection` · `topic_gaps` | Competitors · content gap · topic gaps |
| `domain_visibility` · `top_pages` · `ranked_keywords` | Organic overview, top pages and ranked keywords for any domain (+ `aioOnly` for the keywords that show an AI Overview) |
| `page_lighthouse` · `pull_backlinks` | Lab CWV · backlink profile with live status |
| `link_intersect` | The links your competitors have that you don't - a prioritised outreach list (followed-first, sorted by domain trust; optional Majestic Trust Flow re-sort kills directory noise) |
| `market_sizing` · `serp_features` | Share of voice vs named competitors · AI-Overview / snippet / video exposure by volume |
| `keyword_list` · `content_opportunities` | Cluster a keyword list (own / weak / absent) · the content marketer's report |
| `recon_targets` · `save_recon_todo` · `recon_todos` | **Content recon:** why a page is losing (live SERP + AI Overview) → a tracked, annotatable to-do board |
| `portfolio` · `refresh_portfolio` · `schedule_portfolio_refresh` · `get_portfolio` | **The portfolio:** every domain you look after (owned + watched) in one table, measured vs estimated · refresh it (quotes first) · schedule it under a monthly budget cap · see it in chat |
| `get_dashboard` · `serve_dashboard` · `export_report` | In-chat dashboard · the same in a local browser tab · shareable HTML |
| `get_dashboard_data` · `get_portfolio_data` · `get_domain_overview` | Internal: the dashboard widgets fetch their data through these; not for direct use |
| `composition_cookbook` | The data-surface map and recipes for bespoke analyses |
| `data_storage` | Per-property disk usage and row counts, confirm-gated pruning, and an integrity check with index repair |
| `normalize_url` · `data_location` · `list_properties` · `seo_audit_help` | Utilities and the help menu |

---

## How it works under the hood

- **The join key (`url_key`).** GSC `page` and crawl `url` both normalise down to the same key - force HTTPS, unify www and apex, strip tracking params, and so on. Everything joins on that. It's the whole trick, really.
- **One SQLite database per property** (WAL, prepared statements). Your data stays on your machine.
- **Scored once, sorted by yield.** `(expected clicks × yield × certainty) / effort`. Covering-indexed, so the audit stays fast even when the GSC table runs to millions of rows.
- **Careful with your history.** Crawls and syncs never destroy the previous snapshot until new data has started arriving - a site outage mid-crawl doesn't cost you your data.
- **Owned-site only, dry-run fixes.** It crawls sites you control, and the generators return artifacts. They never write to your site. That's a line I won't cross.

## Privacy and data

Your Search Console data and the crawl live in local SQLite files under `SAC_DATA_DIR`. The passage-scoring model runs locally too. Nothing leaves your machine except the API calls *you* trigger - Google (your own GSC, and the Chrome UX Report if you've set `CRUX_API_KEY`: it's sent your origin and top page URLs) and, if you've set them up, DataForSEO and Majestic (`link_intersect` sends prospect domain names; `pull_backlinks` sends your own backlinked page URLs). Every one of those is keyed by you, called on demand, and cached locally so it isn't called twice. Content recon's competitor fetch requests those public pages directly, with no service in between. The crawl also reaches beyond your own site in one way: after each crawl it checks the outbound links your pages carry (a HEAD request, or a ranged GET, to each linked URL; `checkExternal:false` turns that off). And the free extras fetch from public sources: the local models download once from Hugging Face, `resolve_entities` queries Wikidata, and `news_discovery` reads the Google News feed. No telemetry. None.

---

## What's coming

A few things I'm building next, in rough order:

- **Structured-data opportunities, by template.** Not "you have no schema" (most modern stores have plenty), but "this template could earn review stars or an FAQ rich result and doesn't."
- **A per-page content scorecard.** A dedicated table of *every* ranking phrase your copy misses, not just the top query.
- **More agent readiness.** A WebMCP advisory (which tool actions your site could expose to agents) and the agent-commerce protocols.
- **A printable report.** A proper A4 document you can hand a client, not a slide deck.
- **Source-level parser checks.** The layer most tools never touch: elements that silently break `<head>` parsing, and directives hoisted into the body and ignored. (Raw-vs-rendered divergence now ships - see JavaScript rendering above.)

Got a weird edge case you wish a tool caught? Tell me - that's exactly how the merged GSC×crawl checks got built.

## About Houtini

[Houtini](https://houtini.com) exists for one reason: the hours your team loses to grunt work. Pulling Search Console exports, running crawls, cross-referencing spreadsheets, re-checking what changed since last month - none of it needs a person, and all of it eats the time your people should be spending on strategy, on clients, on the work that moves numbers. So we automate exactly that layer. SEO Audit Console is one of a family of tools built on the same principle - if a machine can collect it, merge it and check it, a machine should.

Questions, licensing, or something you'd like automated: **hello@houtini.com**

## Credits

SEO Audit Console stands on a few third-party services - all optional except your own Search Console access, and each called only with a key *you* provide:

- **[Google Search Console](https://search.google.com/search-console)** - your own search-performance history (the one required credential).
- **[DataForSEO](https://dataforseo.com/?aff=213701)** - SERP, keyword, Labs and backlink data: keyword volumes, competitor footprints, rank history, and the `link_intersect` domain intersection. Pay-as-you-go, optional.
- **[Majestic](https://majestic.com)** - **Trust Flow** and **Topical Trust Flow** for the `link_intersect` enrichment tier, which re-sorts link prospects by real editorial authority. Trust Flow and Topical Trust Flow are trademarks of Majestic (Majestic-12 Ltd). Optional; get a key on their [plans page](https://majestic.com/plans-pricing).

Built with [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [cheerio](https://cheerio.js.org), [Apache ECharts](https://echarts.apache.org), and a local [ms-marco cross-encoder](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2) (via [Transformers.js](https://github.com/huggingface/transformers.js)) for on-device passage scoring - no data leaves your machine for that.

## Contributing

Issues and PRs welcome. The check registry (`src/audit/checks.ts`) is built to be extended - each check is a pure read over the joined data that returns findings with evidence, so adding one is fairly self-contained. There's an end-to-end smoke test (`npm run smoke`) and per-feature probes (`npm run probe:*`) to keep you honest. By submitting a PR you agree your contribution is licensed under the project's [LICENSE](./LICENSE) (Apache-2.0).

## License

**Apache License 2.0.** Free to use, modify, and redistribute, including commercially - full terms in [LICENSE](./LICENSE).
