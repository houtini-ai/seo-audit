# SEO Audit Console

**A technical SEO audit you can hold a conversation with - built from your own Search Console data and a live crawl of your site, run inside Claude.**

[![License: Source-Available](https://img.shields.io/badge/License-Source--Available-orange.svg?style=flat-square)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-purple?style=flat-square)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)

**The complete technical SEO audit, at conversation speed.** SEO Audit Console merges your **Google Search Console** history, a **first-party crawl** of your site, and on-demand **DataForSEO** market data into one prioritised audit inside Claude - from crawlability, indexation, canonicalisation, structured data, Core Web Vitals and hreflang right through to keyword cannibalisation, striking-distance queries, content gaps, competitor analysis and AI-search readiness. Ninety checks, every finding ranked by the clicks it could recover, every fix written for you: paste-ready redirects, JSON-LD, internal links and grounded content briefs. What used to be a fortnight of crawling, exporting and cross-referencing spreadsheets is twenty minutes and a prompt - and your data never leaves your machine.

**Built by [Houtini](https://houtini.com).** We build automation for the grunt work of digital marketing - the data collection, the crawling, the merging, the checking - so your team's time goes on the thinking, the strategy and the client work that actually needs a human. This plugin is that idea applied to the technical SEO audit.

```console
you  › run an SEO audit on simracingcockpit.gg

     ⣾ search console  1.8M rows synced (19s - incremental)
     ⣾ crawl           868 pages · HTTP/2 · robots-polite · 8 parallel
     ⣾ link graph      internal PageRank · click depth · in-degree
     ✓ 90 checks · 220 findings · ranked by expected clicks per dev-hour

     #1  CTR far below position-expected     /how-to-install-mods       XL
     #2  Page losing clicks (trend)          site-wide                  XL
     #3  Keyword cannibalisation             "beamng drive mods"        L
     #4  Robots-blocked page earning traffic /category/wheels           L

you  › generate the fix for #1 ▍
```

![The dashboard overview - executive summary, critical issues, recoverable clicks](docs/images/dashboard-overview.png)

## Surprisingly little has changed in twenty years

The technical audit I was writing for clients in 2006 is, structurally, the audit most agencies still sell today. A crawler runs, a template fills, a 60-page PDF lands. Everything a crawler could find, in severity order, with no idea which findings are worth money and which are cosmetic.

What *has* changed is what's possible. Google gives every site owner a complete record of its search reality - which queries, which pages, how many impressions, where you ranked. Your crawl tells you what your site says. Search Console tells you what Google did about it. And in my experience, the gap between those two datasets is where nearly all of the recoverable traffic hides.

So that's what I built. SEO Audit Console is a [Model Context Protocol](https://modelcontextprotocol.io) server that merges your **Search Console history** with a **first-party crawl of your site** (and, when you want it, **DataForSEO**) into one thing: a prioritised, evidence-backed audit you can interrogate inside Claude Desktop. It hands you paste-ready fixes. Every finding traces back to a real datapoint.

One idea underneath all of it:

> **Your crawl is intent. Search Console is reality. The money is where they diverge.**

A flat crawler tells you a page 404s. Useful, but only just. This tells you the 404 is draining 15% of your homepage's internal PageRank, that the page used to earn 10,000 clicks a month, and it writes the 301 rule to fix it. It finds the page at position #3 on 150,000 impressions with a 0.2% click-through rate - a title rewrite probably worth thousands of clicks - and ranks that *above* the cosmetic findings. Severity is what crawlers sell you. Yield is what moves the numbers.

### Who is this for?

The SEO consultant who wants the collection and checking automated so the thinking time survives. The in-house marketer who's been quoted four figures for a commodity audit. And honestly, anyone newer to this who wants to learn what a good audit actually looks at - because every finding shows its evidence, the tool doubles as a teacher.

A note on where to run it. Claude Desktop is the easy start, but in my view **Claude Code is the best home for this tool** - because it closes the loop. In a chat client the audit hands you a 301 rule to paste somewhere. In Claude Code, the same session has your site's repo, a terminal and git: the audit finds the issue, writes the fix, applies it to the codebase, commits it, and re-crawls to verify. Finding to deployed fix, one conversation.

You don't need to learn an interface. You type *"run an SEO audit on mysite.com"* into Claude and it happens. Forget what's possible? Ask *"run seo_audit_help"* and you get the full menu with example prompts.

### Does the approach work?

Yes. The crawl-plus-GSC merge is not a novelty; it's the method. On one property, seeding the crawl from Search Console URLs took coverage of GSC-known pages from 29% to 70% - every one of those extra pages is a page a conventional crawl silently missed, and several were earning traffic with no internal links pointing at them at all. On the same property the incremental sync turned a 33-minute data refresh into 19 seconds, which is the difference between "audit quarterly" and "audit whenever you're curious".

---

## What the audit actually checks

Let's get the scope on the table. `run_audit` executes **90 checks** over the joined data and returns a ranked list - not a wall of everything, a priority order with the traffic at stake attached to each finding.

| Family | What it catches |
|---|---|
| **Crawlability & indexation** | Broken internal links, redirect chains, links through redirects, deep pages, orphans, index bloat, faceted spider-traps, robots-blocked pages still earning traffic, and the *reason* every URL isn't indexable |
| **Canonicalisation & directives** | Broken and chained canonical targets, pagination canonicalising to page 1, noindex conflicts, HTTPS→HTTP flips |
| **On-page** | Duplicate titles and metas, title/H1 mismatches, missing alt text, heading hierarchy, mixed content, image dimensions (CLS), language attributes, favicons, analytics presence |
| **Structured data** | A local validator covering ~30 rich-result types (Product, Article, JobPosting, Dataset, Hotel and more) - required fields, value sanity, impossible dates. Required-only by design, so it never nags about properties Google ignores |
| **Internationalisation** | Broken hreflang targets, missing return tags (x-default counts, as it should) |
| **Performance** | Oversized HTML measured on estimated *transfer* size, uncompressed responses, servers that ignore conditional requests (no 304), and measured Core Web Vitals when you've pulled them |
| **Freshness honesty** | Sitemap `<lastmod>` claims tested against reality - generator timestamps, future dates, changes claimed between crawls where nothing changed |
| **Trends (GSC over time)** | Pages losing clicks period-over-period, page-one rankings slipping, vanished queries, rising pages worth doubling down on, stale content decaying year-on-year |
| **The merged questions** | Cannibalisation (with thresholds tuned so incidental long-tail overlap doesn't count), striking-distance queries, ghost pages, traffic to dead URLs, internal authority wasted on no-click pages, titles and H1s missing the query you already rank for |
| **AI-search readiness** | Phrases you rank for but never say in the body, queries your copy never answers in one passage, incoherent inbound anchor text, content that doesn't chunk cleanly for retrieval |

Every check is labelled **D** (deterministic - here are the bytes) or **N** (judgement - off by default, ask for *"the judgement findings"* to see them). In my view a wrong finding is worse than no finding at all, so the heuristic checks have to ask permission.

And if you grew up on desktop crawlers, the dashboard's **Site health** tab will feel like home - response codes, indexability reasons, response-time and page-weight buckets, crawl depth, title and meta issues, the heaviest images your pages load (sampled from response headers; the bytes are never downloaded), plus the server errors and slow pages listed out:

![The Site health tab - classic crawl diagnostics as clean stat bars](docs/images/site-health.png)

---

## The crawl, properly explained

The crawl is where audits usually go wrong, so it's worth understanding what this one does differently. I've spent enough of my career cleaning up after crawlers that fooled themselves.

**It discovers pages three ways.** Following links, reading your XML sitemaps, and - the important one - starting from every URL Google is already sending traffic to, straight out of your GSC data. Coverage stops depending on your sitemap being honest. It's also exactly how ghost pages get caught: if Google ranks a URL your own site structure can't reach, that URL still gets crawled, and the mismatch becomes a finding.

**It records *why*, not just *what*.** For every URL that isn't indexable it stores the reason - 404, noindex, X-Robots header, canonicalised elsewhere, robots-blocked, non-HTML. "This page won't rank" is a fact; "this page won't rank because a plugin set an X-Robots header nobody remembers" is a fix.

**It refuses to be fooled.** A redirect that leaves your site (Shopify OAuth flows, I'm looking at you) is recorded as a redirect-out, never stored as a page. It always uses GET rather than HEAD, because a HEAD request can genuinely return a different status than the real request would - but it abandons the body for images, PDFs and assets, so it records status and size without downloading the bytes.

**It's quick without being rude.** HTTP/2 where your origin supports it - eight parallel fetches multiplex over one or two connections rather than eight sockets - gzip and brotli negotiated, keep-alive connections reused. The speed comes from efficiency, not from hammering your server. It respects robots.txt properly (a bot-specific group replaces `*`, per the spec, which plenty of commercial crawlers get wrong), backs off when your host rate-limits, and skips the junk: internal search, faceted filter combinations, login flows. This is a crawler for sites you own. Being a good guest is the point.

After the crawl it computes a real link graph: internal PageRank with nav and footer links down-weighted, click depth from the homepage counting body links only, in-degree per page. That graph powers the orphan, equity-leak and underlinked-page checks - and the donor rankings when the tool suggests internal links.

---

## A methodology, step by step

I'm going to take you through the workflows I actually use. Each one is a real procedure, with the prompts to type. Take the methodology as it is: something to develop and modify to taste.

### 1. Your first audit

> list properties
> Refresh sc-domain:mysite.com
> Run an SEO audit on mysite.com

Twenty minutes on a mid-size site, most of it the crawl. What comes back is a ranked list, and the top five findings are usually worth more than the other eighty-five combined. Ask about any of them: *"show me the evidence for the cannibalisation finding"*. Then *"generate the fix"*.

`fix_finding` is the part that changes the job. A complete JSON-LD block built from your own page data. An exact-match 301 rule in `.htaccess`, nginx or Next.js flavour - using the destination the crawler actually recorded, with fuzzy matching only for genuinely dead URLs, and it tells you when it's guessing. A ranked list of internal-link donors: your highest-authority pages that don't yet link to the page that needs them. All dry-run. It returns artifacts; it never touches your site.

### 2. Sitewide keyword optimisation

The workflow I use most. The question isn't "what keywords should I target?" - it's "where does my copy fail to say what I already rank for?"

Run the audit and look at the merged findings: titles missing the query the page ranks for, H1 mismatches, phrases you earn impressions on but never say in the body. These are pages Google already half-trusts. You're not chasing new rankings - you're closing the gap between the demand you're getting and the copy you're serving, which is far easier.

> Score the passages on mysite.com

Now the deeper cut. A small local relevance model (downloads once, ~25MB, no Python, your content never leaves your machine) reads each ranking page against its top query and scores whether *any* passage actually answers it. It's a classifier, not a generator - it can't hallucinate. Pages that rank on demand they never densely answer are your rewrite list, in priority order.

> Draft the missing content for /sim-racing-wheels

And the follow-through: a grounded writing brief built from the page itself - the query gap, the page's own paragraphs as voice exemplars, its most query-relevant passages as the only permitted facts. Claude drafts the missing passage in *your site's* voice, inventing nothing. On a site with a few hundred indexed pages this collapses weeks of traditional keyword-mapping into an afternoon.

### 3. Fixing cannibalisation

Consider the scenario. Two of your pages compete for the same query, Google alternates between them, and neither settles. Classic, and quietly expensive.

> Show me the cannibalisation findings for mysite.com with evidence

The audit finds these with thresholds tuned to ignore incidental long-tail overlap - a page with 59,000 impressions on a term isn't "competing" with nine pages that got seven. The evidence shows every competing URL with its share, so the consolidate/differentiate/canonicalise decision is made on numbers, not vibes.

### 4. The content refresh list

> Run an SEO audit on mysite.com and include the judgement findings

The trends family surfaces decay: pages losing clicks year-on-year, page-one rankings slipping, queries that vanished. Stale content decays quietly - this makes it loud. Cross-reference with the next workflow and you have a quarter's content plan: refresh, write, or let die.

### 5. The new-content pipeline

> Suggest new pages for mysite.com

`suggest_pages` works from your own impressions - demand Google has already shown you, at rank 11+, with no winning page. It de-duplicates ruthlessly (it won't suggest a page you've already got, or a topic one URL already dominates) and names the nearest existing page to link each new one from, so nothing launches as an orphan. With DataForSEO connected, size each idea with real volumes and add the competitor gap: queries they rank for where you don't appear at all.

### 6. The template play

> List the page templates on mysite.com

Big sites aren't 50,000 pages; they're a dozen templates, repeated. One template fix corrects every page in the cluster. On ecommerce and anything programmatic, this is where the long-tail gains hide, and it's the lens I'd start with on anything over a few thousand URLs.

### 7. Monitoring, migrations, and "what changed?"

> Detect changes on mysite.com

Refresh on a schedule and this diffs your two most recent crawls by severity: a page that went noindex, a canonical that flipped, a title that changed, schema that vanished. During a migration this is the difference between catching a stray noindex on Tuesday and explaining a traffic graph in a board meeting three weeks later. I've been on the wrong end of that one.

### 8. AI-search readiness

> Check agent readiness for mysite.com

The web is quietly growing a second audience - AI agents - and they find sites through `llms.txt`, `agents.md`, AI-bot rules in robots.txt, MCP server cards. Almost no SEO tool checks any of it. This scores you 0-100 across discoverability, content, bot access and capabilities, with copy-paste fixes - and it isn't fooled by a catch-all route that returns 200 for everything. Pair it with passage scoring (workflow 2) and you've covered both halves: the infrastructure agents need, and the extractable answers AI search actually quotes.

### 9. Reporting

> Show me the dashboard for mysite.com
> Export the report for mysite.com

The dashboard runs right in the chat: findings treemap, rank trends, the equity-vs-reality scatter (internal PageRank against actual impressions, where the structural stories jump out), cannibalisation over time, CSV exports. The export is the same thing as one self-contained HTML file - send it to a client, nothing to install, and every claim in it traces to a datapoint.

The Search performance tab is the Search Console view you wish Google shipped - and because the history lives in your own database, it isn't capped at 16 months:

![Ranking distribution over time - impressions by position bucket](docs/images/search-performance.png)

---

## What DataForSEO adds (and what it costs)

Everything above works with just your Search Console data. But GSC can only describe searches where you already appear. The moment your question is "how big is this market?" or "what do competitors rank for that I don't?", you need third-party data - and that's [DataForSEO](https://dataforseo.com/?aff=213701): a pay-as-you-go API for volumes, live rankings, competitor data and Lighthouse runs. No subscription. You top up a balance; calls cost fractions of a cent to a few cents.

- `keyword_volume` · `related_terms` - real monthly volumes and term expansion. How you size an opportunity before writing a word.
- `search_intent` - classifies queries informational/commercial/navigational/transactional, and feeds the check that flags a blog post ranking for a "buy" query.
- `competitors_domain` · `page_intersection` - who you actually compete with (measured from ranking overlap, not who you *think*), and the content gap.
- `page_lighthouse` - lab Core Web Vitals per URL, feeding the high-yield-CWV-fail check.
- `pull_backlinks` - your backlink profile with live status checks, so links pointing at 404s get caught. (One gotcha: Backlinks is a separate DataForSEO subscription from SERP/Keywords/Labs. If it isn't activated the tool says so plainly.)

I'm deliberately careful with your balance. Calls happen **on demand** - one per question you ask, cached for 20 days, never in bulk behind your back. My own usage runs to a few dollars a month.

---

## Installation

### What you need first
- **Node.js ≥ 20**
- **Claude Desktop** (or any MCP client)
- A **Google Search Console** property you own (free - if your site isn't verified there yet, do that first; it's ten minutes and you should have it regardless)
- *Optional:* a **DataForSEO** account

### 1. Build it
```bash
git clone https://github.com/houtini-ai/seo-audit.git
cd seo-audit
npm install
npm run build
```

### 2. Connect Google Search Console
The tool reads GSC through a **Google Cloud service account** - a robot login you create once, rather than an OAuth dance every session:
1. In [Google Cloud Console](https://console.cloud.google.com), create a project and **enable the Search Console API**.
2. Create a **service account** and download its **JSON key**.
3. In [Search Console](https://search.google.com/search-console), under *Settings → Users and permissions*, add the service account's email as a **user** on each property you want to audit.

That third step is the one people miss. The service account is its own "person" - it sees nothing until you add it to the property, same as any colleague.

### 3. Configure Claude Desktop
Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "seo-audit-console": {
      "command": "node",
      "args": ["C:/path/to/seo-audit-console/dist/index.js"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "C:/path/to/service-account.json",
        "SAC_DATA_DIR": "C:/path/to/where/audits/are/stored",
        "DATAFORSEO_USERNAME": "you@example.com",
        "DATAFORSEO_PASSWORD": "your-dataforseo-password"
      }
    }
  }
}
```
Only `GOOGLE_APPLICATION_CREDENTIALS` is required. Restart Claude Desktop, then ask *"list properties"* to check it's connected.

| Env var | Required | Purpose |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | ✅ | Path to the GSC service-account JSON |
| `SAC_DATA_DIR` | optional | Where per-property SQLite DBs and reports live (defaults to `~/Documents/seo-audit-console`) |
| `DATAFORSEO_USERNAME` / `DATAFORSEO_PASSWORD` | optional | Switches on the keyword / SERP / competitor / CWV / backlink tools |
| `DATAFORSEO_CACHE_DAYS` | optional | DataForSEO response cache TTL (default 20 days) |

---

## The tools, at a glance

| Tool | What it does |
|---|---|
| `refresh_property` | Sync GSC + crawl + inspect + rank history, in one step |
| `sync_gsc` · `start_crawl` · `inspect_urls` · `track_ranks` | Run a single part on its own |
| `check_sync_status` · `check_crawl_status` | Watch a long job's progress |
| `run_audit` | Scored, prioritised findings → markdown |
| `query_audit` · `list_checks` | One named check with its evidence · list every check |
| `fix_finding` | Paste-ready remediation (JSON-LD / 301 / internal links) |
| `list_templates` | Cluster pages into templates (one fix → N pages) |
| `suggest_pages` | New-page ideas grounded in real demand |
| `score_passages` | Local relevance model: does any passage answer the page's top query? |
| `draft_content` | Grounded writing brief so Claude can draft the missing passage in your site's voice |
| `detect_changes` | What changed between the two most recent crawls, by severity |
| `check_agent_readiness` | 0-100 AI-agent readiness score with copy-paste fixes |
| `resolve_entities` | Map pages to Wikidata entities, find entity link gaps |
| `get_dashboard` · `export_report` | Interactive in-chat dashboard · shareable HTML |
| `keyword_volume` · `related_terms` · `search_intent` | DataForSEO keyword data |
| `competitors_domain` · `page_intersection` | DataForSEO competitive / content-gap |
| `page_lighthouse` · `pull_backlinks` | Lab CWV · backlink profile with live status |
| `normalize_url` · `data_location` · `list_properties` | Utilities |
| `seo_audit_help` | Every feature, with an example prompt |

---

## How it works under the hood

- **The join key (`url_key`).** GSC `page` and crawl `url` both normalise down to the same key - force HTTPS, unify www and apex, strip tracking params, and so on. Everything joins on that. It's the whole trick, really.
- **One SQLite database per property** (WAL, prepared statements). Your data stays on your machine.
- **Scored once, sorted by yield.** `(expected clicks × yield × certainty) / effort`. Covering-indexed, so the audit stays fast even when the GSC table runs to millions of rows.
- **Careful with your history.** Crawls and syncs never destroy the previous snapshot until new data has actually started arriving - a site outage mid-crawl doesn't cost you your data.
- **Owned-site only, dry-run fixes.** It crawls sites you control, and the generators return artifacts. They never write to your site. That's a line I won't cross.

## Privacy and data

Your Search Console data and the crawl live in local SQLite files under `SAC_DATA_DIR`. The passage-scoring model runs locally too. Nothing leaves your machine except the API calls *you* trigger - Google (your own GSC) and, if you've set it up, DataForSEO. No telemetry. None.

---

## What's coming

A few things I'm building next, in rough order:

- **List mode.** Paste any list of URLs - a migration map, old ranking pages, a PPC export - and have it status-checked and audited. The migration-verification workflow, basically.
- **Structured-data opportunities, by template.** Not "you have no schema" (most modern stores have plenty), but "this template could earn review stars or an FAQ rich result and doesn't."
- **A per-page content scorecard.** A dedicated table of *every* ranking phrase your copy misses, not just the top query.
- **More agent readiness.** A WebMCP advisory (which tool actions your site could expose to agents) and the agent-commerce protocols.
- **A printable report.** A proper A4 document you can hand a client, not a slide deck.
- **Source-level parser checks.** The audit spec is written - [~94 checks](docs/DEFINITIVE-TECHNICAL-AUDIT.md) covering the layer most tools never touch: elements that silently break `<head>` parsing, directives hoisted into the body and ignored, raw-vs-rendered divergence.

Got a weird edge case you wish a tool caught? Tell me - that's exactly how the merged GSC×crawl checks got built.

## About Houtini

[Houtini](https://houtini.com) exists for one reason: the hours your team loses to grunt work. Pulling Search Console exports, running crawls, cross-referencing spreadsheets, re-checking what changed since last month - none of it needs a person, and all of it eats the time your people should be spending on strategy, on clients, on the work that moves numbers. So we automate exactly that layer. SEO Audit Console is one of a family of tools built on the same principle - if a machine can collect it, merge it and check it, a machine should.

Questions, licensing, or something you'd like automated: **hello@houtini.com**

## Contributing

Issues and PRs welcome. The check registry (`src/audit/checks.ts`) is built to be extended - each check is a pure read over the joined data that returns findings with evidence, so adding one is fairly self-contained. There's an end-to-end smoke test (`npm run smoke`) and per-feature probes (`npm run probe:*`) to keep you honest. By submitting a PR you grant the licence set out in the [LICENSE](./LICENSE) contributions clause.

## License

**Source-available, converting to open source.** Free to download, build, and run unmodified for personal, evaluation, and educational use. Commercial use - including agency and client work - needs a [commercial licence](./COMMERCIAL.md), which is a short email away. Modifications and redistribution need written permission. And every released version automatically becomes **Apache 2.0** three years after its release, so nothing stays locked up forever. Full terms in [LICENSE](./LICENSE).
