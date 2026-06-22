# SEO Audit Console

**A technical SEO audit you can hold a conversation with - built from your own Search Console data and a live crawl of your site, run inside Claude.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-purple?style=flat-square)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)

I've run a lot of technical SEO audits over the years. The hard part was never *finding* the issues - any crawler will hand you a few thousand of those. The hard part is knowing which five things to fix this week, why they matter, and how to actually ship the fix.

So I built the tool I always wanted. SEO Audit Console is a [Model Context Protocol](https://modelcontextprotocol.io) server that merges your **Google Search Console history** with a **first-party crawl of your site** (and, if you want it, **DataForSEO**) into one thing: a prioritised, evidence-backed audit you can interrogate inside Claude Desktop. It hands you paste-ready fixes. And every finding traces back to a real datapoint, so nothing is a black box.

---

## Why I built it

A technical audit is usually a commodity. You pay an agency four figures, wait a fortnight, and get a 60-page PDF of everything a crawler could find. Undifferentiated. No traffic context. Stale the day it lands.

The whole thing rests on one idea I keep coming back to:

> **Your crawl is intent. Search Console is reality. The money is where they diverge.**

A flat crawler tells you a page 404s. Useful, but only just. This tells you that the 404 is draining 15% of your homepage's internal PageRank, that the page used to earn 10,000 clicks a month, and it hands you the 301 rule to fix it. It finds the page sitting at position #3 on 150,000 impressions with a 0.2% click-through rate - a title rewrite probably worth thousands of clicks - and it ranks that *above* the cosmetic stuff. Because everything's scored by expected clicks per developer-hour, not by severity.

That last bit matters more than it sounds. Severity is what crawlers sell you. Yield is what actually moves the numbers.

---

## What's different about it

- **Merged, not bolted on.** GSC clicks, impressions and position join your crawl on a normalised URL key. So the checks can ask the questions that need *both* datasets at once - cannibalisation, striking-distance queries, ghost pages (Google sends traffic but the crawl can't reach the URL), high-demand pages starved of internal links. A keyword tool can't see those. A crawler can't either.
- **Prioritised by yield.** `Priority = (expected clicks × yield × certainty) / effort-hours`. A 5,000-page template tweak doesn't get to out-rank a single critical canonical bug just because it touches more URLs.
- **Finding, then fix.** It doesn't only flag things. It writes the remediation: valid JSON-LD built from your own page data, 301 rules for broken links, internal-link suggestions from your highest-authority pages. All dry-run - it returns artifacts, it never touches your site.
- **Honest about confidence.** Every finding is labelled deterministic (here are the bytes) or judgement (gated behind a flag). In my view a wrong finding is worse than no finding at all, so the heuristic stuff has to ask permission.
- **Around 64 checks.** Crawlability, indexability (with the *reason* a URL isn't indexable), duplication and canonicalisation, on-page, structured data, internationalisation, security, performance, sitemap reconciliation, backlinks, and the GSC × crawl questions that only make sense when the two are joined - including the *trend* questions you actually live in: pages losing clicks period-over-period, page-one rankings slipping, queries that have dropped out, and index bloat that earns nothing.
- **Conversational, and visual.** It runs inside Claude Desktop, so you ask follow-ups, drill in, and pull up a shareable HTML dashboard or a markdown report when you're done.

---

## How to actually do a technical SEO audit on your site

Once it's installed (that's further down), the whole audit is a short conversation. Here's the flow I use. If you'd rather have it spelled out step by step - the kind of thing you can follow along with, screenshots and all - there's a [friendly walkthrough guide](docs/how-to-guide.md) too.

### 1. Pull your data
> *"Refresh sc-domain:example.com"*

`refresh_property` syncs your Search Console history, crawls your site, inspects index coverage, and works out internal PageRank and click-depth. The crawl is polite - it respects robots.txt, backs off when a host rate-limits, and never downloads images (HEAD only, so it gets the status and size without pulling the bytes). You watch progress live. Big sites stay light.

### 2. Run the audit
> *"Run an SEO audit on example.com"*

`run_audit` gives you a prioritised markdown report. Top opportunities first, each one carrying the traffic at stake, the fix, and the evidence behind it. Add `includeJudgement: true` if you also want the heuristic findings (intent mismatches, entity gaps and the like).

You'll see the story straight away. Where you rank but don't get clicked (snippet rewrites). Where you compete with yourself (cannibalisation). Where equity leaks out (broken internal links). What Google can't index, and *why*.

### 3. Fix the top items
> *"Generate the fix for the broken link on /old-page"* · *"Write the Product schema for /widgets"*

`fix_finding` emits paste-ready artifacts - a 301 rule (`.htaccess`, nginx, or Next.js), a complete JSON-LD block built from your actual page, or a ranked list of internal-link donors. You review it and you ship it. The tool never does.

### 4. Find the growth
> *"Suggest new pages for example.com"* · *"List the page templates"*

`suggest_pages` proposes new pages grounded in *real* Search Console demand you're not yet satisfying. It de-duplicates ruthlessly, so it won't suggest a page you've already got. `list_templates` clusters your site so one template fix corrects N pages at once - which, if you've read anything I've written about site architecture, you'll know is where the long-tail gains tend to hide.

### 5. Share it
> *"Export the report for example.com"*

`export_report` writes a self-contained, white-label HTML dashboard. Open it in any browser, or send it to a client. Or just open the interactive dashboard right there in the chat.

> **Tip:** start with *"run seo_audit_help"*. It lists every capability with an example prompt, which is honestly the quickest way in.

---

## Installation

### What you need first
- **Node.js ≥ 20**
- **Claude Desktop** (or any MCP client)
- A **Google Search Console** property you own (free)
- *Optional:* a **DataForSEO** account for keyword volume, SERP data, competitor gaps, lab Core Web Vitals and backlinks

### 1. Build it
```bash
git clone https://github.com/houtini-ai/seo-audit-console.git
cd seo-audit-console
npm install
npm run build
```

### 2. Connect Google Search Console
The tool reads GSC through a **Google Cloud service account** - no OAuth dance to sit through:
1. In [Google Cloud Console](https://console.cloud.google.com), create a project and **enable the Search Console API**.
2. Create a **service account** and download its **JSON key**.
3. In [Search Console](https://search.google.com/search-console), under *Settings → Users and permissions*, add the service account's email as a **user** on each property you want to audit.

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
| `DATAFORSEO_USERNAME` / `DATAFORSEO_PASSWORD` | optional | Unlocks the keyword / SERP / competitor / CWV / backlink tools |
| `DATAFORSEO_CACHE_DAYS` | optional | DataForSEO response cache TTL (default 20 days) |

### 4. (Optional) DataForSEO
DataForSEO is what powers the paid-data tools: **keyword search volume**, **SERP data**, **search-intent classification**, **competitor and content-gap discovery**, **per-URL lab Core Web Vitals (Lighthouse)**, and **backlink profiles**. It's pay-as-you-go, and the audit only ever calls it **on demand** - one call per click, cached for 20 days. I'm deliberately careful with it. It never fires in bulk behind your back.

👉 **[Create a DataForSEO account](https://dataforseo.com/?aff=213701)**

> One gotcha: the **Backlinks API is a separate DataForSEO subscription** from SERP / Keywords / Labs. If it isn't activated, `pull_backlinks` will tell you so rather than failing quietly.

Everything else - the crawl, the merge, around 50 of the checks, the priority model, the fixes, the dashboard - works with **just Search Console**.

---

## The tools

| Tool | What it does |
|---|---|
| `refresh_property` | Sync GSC + crawl + inspect + rank history, in one step |
| `sync_gsc` · `start_crawl` · `inspect_urls` · `track_ranks` | Run a single part on its own |
| `run_audit` | Scored, prioritised findings → markdown |
| `query_audit` · `list_checks` | One named check with its evidence · list every check |
| `fix_finding` | Paste-ready remediation (JSON-LD / 301 / internal links) |
| `list_templates` | Cluster pages into templates (one fix → N pages) |
| `suggest_pages` | New-page ideas grounded in real demand |
| `get_dashboard` · `export_report` | Interactive in-chat dashboard · shareable HTML |
| `keyword_volume` · `related_terms` · `search_intent` | DataForSEO keyword data |
| `competitors_domain` · `page_intersection` | DataForSEO competitive / content-gap |
| `page_lighthouse` · `pull_backlinks` · `resolve_entities` | Lab CWV · backlinks · Wikidata entities |
| `seo_audit_help` | Every feature, with an example prompt |

---

## How it works under the hood

- **The join key (`url_key`).** GSC `page` and crawl `url` both normalise down to the same key - force HTTPS, unify www and apex, strip tracking params, and so on. Everything joins on that. It's the whole trick, really.
- **One SQLite database per property** (WAL, prepared statements). Your data stays on your machine.
- **A polite, self-contained crawler.** Respects robots.txt. Records *why* a URL isn't indexable (404, noindex, X-Robots, canonicalised, robots-blocked, non-HTML). HEAD-only for images, PDFs and assets, so it gets status and size and never the bytes. Skips the junk - internal search, faceted params, login flows. And it backs off when a host starts rate-limiting, which is what keeps it reliable on the big sites.
- **Scored once, sorted by yield.** `(expected clicks × yield × certainty) / effort`. Covering-indexed, so the audit stays fast even when the GSC table runs to millions of rows.
- **Owned-site only, dry-run fixes.** It crawls sites you control, and the generators return artifacts. They never write to your site. That's a line I won't cross.

---

## Privacy and data

Your Search Console data and the crawl live in local SQLite files under `SAC_DATA_DIR`. Nothing leaves your machine except the API calls *you* trigger - Google (your own GSC) and, if you've set it up, DataForSEO. No telemetry. None.

---

## Contributing

Issues and PRs welcome. The check registry (`src/audit/checks.ts`) is built to be extended - each check is a pure read over the joined data that returns findings with evidence, so adding one is fairly self-contained. There's an end-to-end smoke test (`npm run smoke`) and per-feature probes (`npm run probe:*`) to keep you honest.

## License

[Apache 2.0](./LICENSE) © [Houtini](https://houtini.com)
