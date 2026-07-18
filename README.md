# SEO Audit Console

**A technical SEO audit you can hold a conversation with - built from your own Search Console data and a live crawl of your site, run inside Claude.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-purple?style=flat-square)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)

I've run a lot of technical SEO audits over the years. The hard part was never *finding* the issues - any crawler will hand you a few thousand of those. The hard part is knowing which five things to fix this week, why they matter, and how to actually ship the fix.

So I built the tool I always wanted. SEO Audit Console is a [Model Context Protocol](https://modelcontextprotocol.io) server that merges your **Google Search Console history** with a **first-party crawl of your site** (and, if you want it, **DataForSEO**) into one thing: a prioritised, evidence-backed audit you can interrogate inside Claude Desktop. It hands you paste-ready fixes. And every finding traces back to a real datapoint, so nothing is a black box.

If you want the step-by-step version with screenshots, start with the **[how-to guide](docs/how-to-guide.md)**. This README is the full map.

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
- **Finding, then fix.** It doesn't only flag things. It writes the remediation: valid JSON-LD built from your own page data, exact-match 301 rules for broken links (using the redirect destination the crawler actually recorded, not a guess), internal-link suggestions from your highest-authority pages. All dry-run - it returns artifacts, it never touches your site.
- **Honest about confidence.** Every finding is labelled deterministic (here are the bytes) or judgement (gated behind a flag). In my view a wrong finding is worse than no finding at all, so the heuristic stuff has to ask permission.
- **Built for the AI-search era too.** It doesn't stop at classic technical SEO. It checks whether your copy actually *says* the phrases you rank for, whether any passage on the page answers the query the way AI search extracts answers (a local relevance model, runs on your machine), and whether your site is ready for AI agents at all - `llms.txt`, `agents.md`, MCP server cards, AI-bot rules.
- **Conversational, and visual.** It runs inside Claude Desktop, so you ask follow-ups, drill in, and pull up a shareable HTML dashboard or a markdown report when you're done.

---

## Everything it does

The short version: five capabilities, each a conversation away.

### 1. Pull your data
`refresh_property` runs the whole pipeline in one step: syncs your Search Console history (incrementally - after the first pull, later syncs only fetch the delta, which turned a 33-minute refresh into 19 seconds on one of my properties), crawls your site, checks index coverage via the URL Inspection API, and pulls your rank history. Each part also runs on its own (`sync_gsc`, `start_crawl`, `inspect_urls`, `track_ranks`), and the long ones report progress live (`check_sync_status`, `check_crawl_status`).

The crawler deserves a word. It's polite - respects robots.txt (properly: a bot-specific group replaces `*`, per the spec), backs off when a host rate-limits, and never downloads images or other assets (status and size, not the bytes). It discovers pages three ways - by following links, from your XML sitemaps, and from every URL Google is already sending traffic to - so coverage doesn't depend on your sitemap being honest. On one site that took crawl coverage of GSC-known URLs from 29% to 70%. It also refuses to be fooled: a redirect that leaves your site (Shopify OAuth flows, I'm looking at you) is recorded as a redirect-out, never stored as a page.

### 2. Audit it
`run_audit` runs **80+ checks** over the joined data and gives you a prioritised markdown report. `query_audit` re-runs any single check with full evidence; `list_checks` shows the whole catalogue. The families:

| Family | What it catches |
|---|---|
| **Crawlability & indexation** | Broken internal links, redirect chains, links through redirects, deep pages, orphans, index bloat, faceted spider-traps, and the *reason* each URL isn't indexable |
| **Canonicalisation & directives** | Broken/chained canonical targets, pagination canonicalising to page 1, noindex conflicts, robots contradictions, HTTPS→HTTP flips |
| **On-page** | Duplicate titles and metas, title/H1 mismatches, missing alt text, heading hierarchy, mixed content, image dimensions (CLS), social tags |
| **Structured data** | A local validator covering ~30 rich-result types (Product, Article, JobPosting, Dataset, Hotel, Restaurant and more) - required fields, value sanity (ISO dates, currency codes, absolute URLs), impossible dates. Required-only by design, so it doesn't nag you about properties Google ignores |
| **Internationalisation** | Broken hreflang targets, missing return tags (x-default counts, as it should) |
| **Performance** | Oversized HTML (estimated *transfer* size, not raw bytes), uncompressed responses, and measured Core Web Vitals when you've pulled them |
| **Trends (GSC over time)** | Pages losing clicks period-over-period, page-one rankings slipping, queries that vanished, rising pages worth doubling down on, stale content decaying year-on-year |
| **The merged questions** | Cannibalisation (with sensible thresholds - incidental long-tail appearances don't count), striking-distance queries, ghost pages, traffic to dead URLs, internal authority wasted on no-click pages, high-demand pages starved of links, titles and H1s missing the query you already rank for |
| **AI-search readiness** | Phrases you rank for but never say in the body, multi-term queries your copy never answers in one place, pages with no extractable answer passage, incoherent inbound anchor text, content that doesn't chunk cleanly for retrieval |

Every check is labelled **D** (deterministic) or **N** (judgement, off by default - pass `includeJudgement: true` to see them).

### 3. Fix it
`fix_finding` turns a finding into an artifact you can ship: a complete JSON-LD block built from your own page data, an exact-match 301 rule in `.htaccess`, nginx or Next.js flavour, or a ranked list of internal-link donor pages (your highest-authority pages that don't yet link to the one that needs it, with sensible anchor text). Redirect fixes use the destination the crawler recorded; fuzzy matching only steps in for genuinely dead URLs, and it tells you when it's guessing.

### 4. Find the growth
This is the keyword-research and content-opportunity side, and most of it needs nothing beyond your own GSC data:

- `suggest_pages` - new pages grounded in *real* demand: queries you earn impressions for at rank 11+ with no winning page. It de-duplicates ruthlessly (won't suggest a page you've already got, or a topic one URL already dominates) and tells you the nearest existing page to link the new one from.
- `list_templates` - clusters your site into templates by URL shape and schema type, so one template fix corrects N pages at once. If you've read anything I've written about site architecture, you'll know this is where the long-tail gains tend to hide.
- `score_passages` - the AI-search piece. A small local relevance model (downloads once, ~25MB, no Python, never leaves your machine) reads each ranking page's content chunks against its top query and scores whether *any* passage actually answers it. It's a classifier, not a generator - it can't hallucinate. Pages that rank on demand they never densely answer are your rewrite list.
- `draft_content` - the follow-through on a weak passage. It assembles a grounded writing brief from the page itself: the query gap, the page's own paragraphs as voice exemplars, and its most query-relevant passages as the only permitted facts. Claude then drafts the missing answer passage in *your site's* voice, inventing nothing. No bundled LLM, no made-up claims.
- `resolve_entities` - maps your pages to Wikidata entities and finds internal-link gaps between topically-related pages.
- `detect_changes` - compares your two most recent crawls and flags what moved, by severity. A page that went noindex, a canonical that flipped, a title that changed. Run a refresh on two different days and this becomes your monitor.
- `check_agent_readiness` - scores your site 0-100 for the AI-agent audience: `llms.txt`, `agents.md`, AI-bot rules in robots.txt, MCP server cards, OAuth discovery, markdown content negotiation. With copy-paste fixes. And it's not fooled by a catch-all route that 200s everything.

With a DataForSEO account (optional, pay-as-you-go, only ever called on demand):

- `keyword_volume` · `related_terms` - search volumes and term expansion.
- `search_intent` - classify query intent, which also feeds the intent-vs-page-type audit check.
- `competitors_domain` · `page_intersection` - who you actually compete with, and the content gap: queries they rank for where you don't show up.
- `page_lighthouse` - lab Core Web Vitals per URL, which feeds the high-yield-CWV-fail check.
- `pull_backlinks` - your backlink profile with live status checks, so backlinks pointing at 404s get caught. (Heads up: the Backlinks API is a separate DataForSEO subscription from SERP/Keywords/Labs. If it isn't activated the tool says so plainly rather than failing quietly.)

### 5. Share it
`get_dashboard` opens an interactive dashboard right in the chat - findings treemap, rank trends, the equity-vs-reality scatter (internal PageRank against actual impressions, which is where the structural stories jump out), cannibalisation, keyword movement, CSV export. `export_report` writes the same thing as a single self-contained HTML file you can send to a client. No login, nothing installed.

A few utilities round it out: `normalize_url` (see exactly how a URL joins between datasets), `data_location` (where the SQLite files live), `list_properties`, and `seo_audit_help` - which lists every capability with an example prompt, and is honestly the quickest way in.

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
| `DATAFORSEO_USERNAME` / `DATAFORSEO_PASSWORD` | optional | Switches on the keyword / SERP / competitor / CWV / backlink tools |
| `DATAFORSEO_CACHE_DAYS` | optional | DataForSEO response cache TTL (default 20 days) |

### 4. (Optional) DataForSEO
DataForSEO is what powers the paid-data tools. It's pay-as-you-go, and the audit only ever calls it **on demand** - one call per click, cached for 20 days. I'm deliberately careful with it. It never fires in bulk behind your back.

👉 **[Create a DataForSEO account](https://dataforseo.com/?aff=213701)**

Everything else - the crawl, the merge, most of the checks, the priority model, the fixes, the dashboard - works with **just Search Console**.

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
- **A polite, self-contained crawler.** Respects robots.txt. Records *why* a URL isn't indexable (404, noindex, X-Robots, canonicalised, robots-blocked, non-HTML). Always GETs (a HEAD can return a different status than the GET would), but abandons the body for images, PDFs and assets - status and size, never the bytes. Skips the junk - internal search, faceted params, login flows. And it backs off when a host starts rate-limiting, which is what keeps it reliable on the big sites.
- **A real link graph.** Post-crawl it computes internal PageRank (nav and footer links down-weighted), body-only click depth from the homepage, and in-degree. That's what powers the orphan, equity-leak and underlinked-page checks - and the donor rankings in `fix_finding`.
- **Scored once, sorted by yield.** `(expected clicks × yield × certainty) / effort`. Covering-indexed, so the audit stays fast even when the GSC table runs to millions of rows.
- **Careful with your history.** Crawls and syncs never destroy the previous snapshot until the new data has actually started arriving - a site outage mid-crawl doesn't cost you your data.
- **Owned-site only, dry-run fixes.** It crawls sites you control, and the generators return artifacts. They never write to your site. That's a line I won't cross.

---

## Privacy and data

Your Search Console data and the crawl live in local SQLite files under `SAC_DATA_DIR`. The passage-scoring model runs locally too - your content never goes anywhere for scoring. Nothing leaves your machine except the API calls *you* trigger - Google (your own GSC) and, if you've set it up, DataForSEO. No telemetry. None.

---

## What's coming

A few things I'm building next, in rough order:

- **Structured-data opportunities, by template.** Not "you have no schema" (most modern stores have plenty), but "this template could earn review stars or an FAQ rich result and doesn't." One fix per template corrects every page in the cluster.
- **A per-page content scorecard.** The checks already catch phrases you rank for but never say; a dedicated table of *every* ranking phrase your copy misses is next.
- **More agent readiness.** A WebMCP advisory (which tool actions your site could expose to agents) and the agent-commerce protocols.
- **A printable report.** A proper A4 document you can hand a client, not a slide deck.
- **Source-level parser checks.** The audit spec is written - [~94 checks](docs/DEFINITIVE-TECHNICAL-AUDIT.md) covering the layer most tools never touch: elements that silently break `<head>` parsing, canonical and hreflang directives that get hoisted into the body and ignored, raw-vs-rendered divergence, service workers feeding Google a stale shell. The crawler already fetches everything these checks need.

Got a weird edge case you wish a tool caught? Tell me - that's exactly how the merged GSC×crawl checks got built.

## Contributing

Issues and PRs welcome. The check registry (`src/audit/checks.ts`) is built to be extended - each check is a pure read over the joined data that returns findings with evidence, so adding one is fairly self-contained. There's an end-to-end smoke test (`npm run smoke`) and per-feature probes (`npm run probe:*`) to keep you honest.

## License

[Apache 2.0](./LICENSE) © [Houtini](https://houtini.com)
