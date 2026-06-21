# SEO Audit Console

**Your technical SEO audit, run by Claude — from your own Search Console data and a live crawl of your site.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-purple?style=flat-square)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)

SEO Audit Console is a [Model Context Protocol](https://modelcontextprotocol.io) server. It merges your **Google Search Console history** with a **first-party crawl of your site** (and, optionally, **DataForSEO**) into one thing: a **deterministic, prioritised, evidence-backed technical-SEO audit** you can hold a conversation with inside Claude Desktop — and that hands you **paste-ready fixes**.

---

## Why this exists

A technical SEO audit is usually a commodity: you pay an agency four figures, wait two weeks, and get a 60-page PDF of every issue a crawler could find — undifferentiated, no traffic context, and stale the day it lands. The hard part isn't *finding* issues. It's knowing **which five things to fix this week**, *why*, and *how*.

This tool is built on one idea:

> **Your crawl is intent. Search Console is reality. The money is where they diverge.**

A flat crawler tells you a page 404s. This tells you that 404 is draining 15% of your homepage's internal PageRank, that it used to earn 10,000 clicks a month, and gives you the 301 rule to fix it. It finds the page ranking #3 on 150,000 impressions with a 0.2% click-through rate — a title rewrite worth thousands of clicks — and ranks it *above* the cosmetic stuff, because everything is scored by **expected clicks per developer-hour**.

Every finding traces back to a raw datapoint. Nothing is a black box.

---

## What makes it different

- **Merged, not bolted-on.** GSC clicks/impressions/position join your crawl on a normalised URL key, so checks can ask the questions that need *both* datasets: cannibalisation, striking-distance queries, ghost pages (Google sends traffic but the crawl can't reach them), high-demand pages starved of internal links.
- **Prioritised by yield, not severity.** `Priority = (expected clicks × yield × certainty) / effort-hours`. A 5,000-page template tweak doesn't out-rank a single critical canonical bug just because it touches more pages.
- **Finding → fix.** It doesn't just flag — it generates the remediation: valid JSON-LD from your own page data, 301 redirect rules for broken links, internal-link suggestions from your highest-authority pages. Dry-run: it returns artifacts, it never touches your site.
- **Honest about confidence.** Every finding is labelled deterministic (cite the bytes) or judgement (gated behind a flag). A wrong finding is worse than none.
- **~58 checks** spanning crawlability, indexability (with the *reason* a URL isn't indexable), duplication/canonicalisation, on-page, structured data, internationalisation, security, performance, sitemap reconciliation, backlinks, and the GSC×crawl "expert questions".
- **Conversational + visual.** It runs inside Claude Desktop, so you ask follow-ups, drill in, and get a shareable HTML dashboard or a markdown report.

---

## How to do a technical SEO audit on your site

Once installed (see below), the whole audit is a short conversation with Claude. Here's the flow.

### 1. Pull your data
> *"Refresh sc-domain:example.com"*

`refresh_property` syncs your Search Console history, crawls your site (politely — respects robots.txt, backs off on rate-limits, never downloads images), inspects index coverage, and computes internal PageRank + click-depth. Watch progress with a live status; big sites stay light.

### 2. Run the audit
> *"Run an SEO audit on example.com"*

`run_audit` returns a prioritised markdown report — top opportunities first, each with the traffic at stake, the fix, and the evidence. Add `includeJudgement: true` for the heuristic findings (intent mismatches, entity gaps).

You'll see the story immediately: *where you rank but don't get clicked* (snippet rewrites), *where you compete with yourself* (cannibalisation), *where equity leaks* (broken internal links), *what Google can't index and why*.

### 3. Fix the top items
> *"Generate the fix for the broken link on /old-page"* · *"Write the Product schema for /widgets"*

`fix_finding` emits paste-ready artifacts: a 301 rule (`.htaccess`/nginx/Next.js), a complete JSON-LD block built from your page, or ranked internal-link donors. You review and ship.

### 4. Find the growth
> *"Suggest new pages for example.com"* · *"List the page templates"*

`suggest_pages` proposes new pages grounded in *real* Search Console demand you don't yet satisfy (ruthlessly de-duplicated so it never suggests a page you already have). `list_templates` clusters your site so one template fix corrects N pages.

### 5. Share it
> *"Export the report for example.com"*

`export_report` writes a self-contained, white-label HTML dashboard you can open in any browser or send to a client. Or open the interactive dashboard right in chat.

> **Tip:** start with *"run seo_audit_help"* — it lists every capability with an example prompt.

---

## Installation

### Prerequisites
- **Node.js ≥ 20**
- **Claude Desktop** (or any MCP client)
- A **Google Search Console** property you own (free)
- *(Optional)* a **DataForSEO** account for keyword volume, SERP data, competitor gaps, lab Core Web Vitals, and backlinks

### 1. Build
```bash
git clone https://github.com/houtini-ai/seo-audit-console.git
cd seo-audit-console
npm install
npm run build
```

### 2. Connect Google Search Console
The tool reads GSC via a **Google Cloud service account** (no OAuth dance):
1. In [Google Cloud Console](https://console.cloud.google.com), create a project and **enable the Search Console API**.
2. Create a **service account** and download its **JSON key**.
3. In [Search Console](https://search.google.com/search-console) → *Settings → Users and permissions*, add the service account's email as a **user** on each property you want to audit.

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
Only `GOOGLE_APPLICATION_CREDENTIALS` is required. Restart Claude Desktop, then ask *"list properties"* to confirm it's connected.

| Env var | Required | Purpose |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | ✅ | Path to the GSC service-account JSON |
| `SAC_DATA_DIR` | optional | Where per-property SQLite DBs + reports are stored (defaults to `~/Documents/seo-audit-console`) |
| `DATAFORSEO_USERNAME` / `DATAFORSEO_PASSWORD` | optional | Unlocks keyword/SERP/competitor/CWV/backlink tools |
| `DATAFORSEO_CACHE_DAYS` | optional | DataForSEO response cache TTL (default 20 days) |

### 4. (Optional) DataForSEO
DataForSEO powers the paid-data tools: **keyword search volume**, **SERP data**, **search-intent classification**, **competitor & content-gap discovery**, **per-URL lab Core Web Vitals (Lighthouse)**, and **backlink profiles**. It's pay-as-you-go and the audit calls it only **on demand** (one call per click), with a 20-day cache.

👉 **[Create a DataForSEO account](https://dataforseo.com/?aff=213701)**

> Note: the **Backlinks API is a separate DataForSEO subscription** from SERP/Keywords/Labs — `pull_backlinks` will tell you if it isn't activated.

Everything else — the crawl, the merge, ~50 of the checks, the priority model, fixes, dashboard — works with **just Search Console**.

---

## The tools

| Tool | What it does |
|---|---|
| `refresh_property` | Sync GSC + crawl + inspect + rank history (one step) |
| `sync_gsc` · `start_crawl` · `inspect_urls` · `track_ranks` | Run one part |
| `run_audit` | Scored, prioritised findings → markdown |
| `query_audit` · `list_checks` | One named check with evidence · list all checks |
| `fix_finding` | Paste-ready remediation (JSON-LD / 301 / internal links) |
| `list_templates` | Cluster pages into templates (one fix → N pages) |
| `suggest_pages` | New-page ideas grounded in real demand |
| `get_dashboard` · `export_report` | Interactive in-chat dashboard · shareable HTML |
| `keyword_volume` · `related_terms` · `search_intent` | DataForSEO keyword data |
| `competitors_domain` · `page_intersection` | DataForSEO competitive / content-gap |
| `page_lighthouse` · `pull_backlinks` · `resolve_entities` | Lab CWV · backlinks · Wikidata entities |
| `seo_audit_help` | Every feature + an example prompt |

---

## How it works

- **The join key (`url_key`).** GSC `page` and crawl `url` both normalise to the same key (force HTTPS, unify www/apex, strip tracking params, etc.). Everything joins on it.
- **One SQLite database per property** (WAL, prepared statements). Your data stays on your machine.
- **A polite, self-contained crawler.** Respects robots.txt; records *why* a URL isn't indexable (404 / noindex / X-Robots / canonicalised / robots-blocked / non-HTML); HEAD-only for images/PDFs/assets (status + size, never the bytes); skips junk (internal search, faceted params, login flows); and **adaptively backs off** when a host rate-limits, so it stays reliable on big sites.
- **Scored once, sorted by yield.** `(expected clicks × yield × certainty) / effort` — covering-indexed so the audit is fast even on multi-million-row GSC tables.
- **Owned-site only, dry-run fixes.** It crawls sites you control, and generators return artifacts — they never write to your site.

---

## Privacy & data

Your Search Console data and crawl live in local SQLite files under `SAC_DATA_DIR`. Nothing is sent anywhere except the API calls *you* trigger — Google (your own GSC) and, if configured, DataForSEO. No telemetry.

---

## Contributing

Issues and PRs welcome. The check registry (`src/audit/checks.ts`) is designed to be extended — each check is a pure read over the joined data returning findings with evidence. There's an end-to-end smoke test (`npm run smoke`) and per-feature probes (`npm run probe:*`).

## License

[Apache 2.0](./LICENSE) © [Houtini](https://houtini.com)
