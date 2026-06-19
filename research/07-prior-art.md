---
name: Prior art — OSS technical SEO audit tools
description: GitHub OSS survey of technical SEO auditors / crawlers / agent-readiness scanners with verdicts on what to borrow, what to skip, and where the gap is
type: research
phase: 1
---

# Prior art — OSS technical SEO audit tools

**Question being answered:** Before we build, who's already in this space? What's already MIT and good enough to borrow from? Where's the gap our MCP can credibly fill?

**Bottom line:** The OSS space is much more mature than I'd have guessed. There are ~15 credible projects, two of which (SEOmator / SEO Audit Skill, and SiteOne Crawler) are engineered to a high standard. **No existing project combines (a) MCP-native interface, (b) GSC integration, (c) DataForSEO/SERP integration, (d) grounded-LLM judgement layer, and (e) explicit deterministic-vs-non-deterministic separation.** That's our gap.

---

## Tier 1 — engineered to a high standard (study these carefully)

### 1. `seo-skills/seo-audit-skill` ("SEOmator") — **the one to beat**
- **Stars:** 223 · **License:** MIT · **Lang:** TypeScript 99.5%
- **Surface:** **251 rules across 20 categories** (the README says 108/12 — the codebase has more). Categories: Core, Performance, Links, Images, Security, Technical SEO, Crawlability, Structured Data, JavaScript Rendering, Accessibility, Content, Social, E-E-A-T, URL Structure, Redirects, Mobile, Internationalization, HTML Validation, AI/GEO Readiness, Legal Compliance.
- **Stack:** Node 18+, Playwright (Core Web Vitals + JS render), better-sqlite3 (persistent), Vitest tests, tsup bundler.
- **Distribution:** CLI (`seomator audit <url>`), Electron desktop app, library (`createAuditor()`), and **Claude Skill integration**. Output formats: console, JSON, HTML, Markdown, **LLM**.
- **Verdict:** **BORROW THE RULE TAXONOMY.** Their 251-rule list is the closest thing to "checklist of all checklists" in OSS. License is MIT so we can lift the taxonomy wholesale and credit them. Skip their CLI/Electron framing — we're MCP-native.
- Source: <https://github.com/seo-skills/seo-audit-skill>

### 2. `janreges/siteone-crawler` — **best engineering**
- **License:** MIT · **Lang:** Rust 98% (single native binary, Win/macOS/Linux x64+arm64)
- **Surface:** 5 weighted categories (Performance 20%, SEO 20%, Security 25%, Accessibility 20%, Best Practices 15%) with deterministic 0.0–10.0 scoring.
- **Unusual features:** offline site clone, markdown export with AI-friendly dedup, built-in web server to render markdown reports, exit-code-10 CI gate, post-deploy cache warmer.
- **Verdict:** **STUDY THE ARCHITECTURE.** Rust single-binary + async + multi-thread is the gold standard for crawl perf. We won't rewrite in Rust, but the *modular analyser pattern* and the *markdown export for LLM consumption* are both worth mimicking. Skip the desktop angle.
- Source: <https://github.com/janreges/siteone-crawler>

### 3. `StJudeWasHere/seonaut` — **the popular one**
- **Stars:** 709 (highest of any in this list) · **License:** MIT · **Lang:** Go (backend), HTML/CSS + vanilla JS + ECharts (frontend), MySQL persistence, Docker Compose
- **Surface:** Broken links, redirect issues (chains/loops), missing/duplicate meta, heading order. Severity tiers: critical/high/low. Multi-user web app.
- **Verdict:** **WATCH FOR UX IDEAS.** 709 stars tells us what SEOs want to *see* (dashboards, severity, multi-project). The check coverage itself is shallow vs. SEOmator. Don't borrow their schema; do borrow their issue-presentation patterns.
- Source: <https://github.com/StJudeWasHere/seonaut>

### 4. `PhialsBasement/LibreCrawl` — **the Screaming-Frog clone**
- **License:** MIT · **Lang:** Python (Flask) + Playwright + JS frontend
- **Surface:** Up to 5M URLs, JS rendering via Playwright, multi-tenant sessions, PageSpeed Insights integration, CSV/JSON/XML export, plugin system.
- **Verdict:** **NOT FOR US.** Web-app posture, not MCP. But the *5M-URL ambition* is a useful watermark — if our crawler can't handle 100k URLs at minimum, we're not credible. Note their **localStorage-vulnerable-to-cache-clear** limitation as a cautionary tale about state.
- Source: <https://github.com/PhialsBasement/LibreCrawl>

### 5. `puneetindersingh/open-seo-crawler` — **best severity model**
- **License:** MIT · **Lang:** JS+Python mix
- **Surface:** Title/meta/H1, canonical (with external-canonical detection), schema.org, OG/Twitter, thin-content flag (<200 words), slow-response (>3s), real-vs-cosmetic redirects, indexability (meta + X-Robots-Tag), viewport, mixed content, URL hygiene (uppercase, underscores, spaces, len>115, tracking params), missing-alt images, security headers (HTTPS, HSTS, CSP, X-Frame-Options, X-Content-Type-Options).
- **Unusual:** CMS auto-detect (Shopify, WP+Yoast/Rank Math, Webflow, Wix, Squarespace, Kajabi, Ghost, Drupal, HubSpot, Joomla) with one-click exclude patterns and per-CMS JS-render recommendations. **Cites Ahrefs/Moz per issue** — best-in-class evidence framing.
- **Verdict:** **BORROW THE SEVERITY TAGGING + CITATIONS PATTERN.** Every issue tagged error/warning/info with a "why it matters" panel and a cited source — that's exactly the evidence-trail discipline our `plan/recommendation-engine.md` is going to need.
- Source: <https://github.com/puneetindersingh/open-seo-crawler>

---

## Tier 2 — worth knowing about

| Repo | License | Lang | Notable | Verdict |
|---|---|---|---|---|
| `viasite/site-audit-seo` | MIT | JS | Lighthouse-per-page CLI, CSV/JSON/XLSX, web UI for public reports | Skip — Lighthouse wrapper, no novel checks |
| `StanGirard/seo-audits-toolkit` | (various) | Mixed | Lighthouse + security headers + sitemap/keywords/images extractor + summariser | Borrow: "summariser" pattern for issue narratives |
| `sethblack/python-seo-analyzer` | MIT | Python | Word counts, basic structural checks | Skip — supersede |
| `eliasdabbas/seo-audit-and-analysis` | (template) | Python (advertools) + Jupyter | **`advertools` library** is excellent for sitemap parsing, robots, log analysis | **BORROW:** `advertools` is the Python power tool we should depend on for log + sitemap + robots if we go Python anywhere |
| `VesterlundCoder/SEO-JavaScript-Crawler-IncRev` | (varies) | Python+Playwright | JS detection + render parity (raw vs DOM) with stealth mode | Borrow: render-parity check is essential for Phase 3 |
| `plainsignal/seo-auditor` | — | Chrome ext | In-browser quick audit for indexability + accessibility | Skip — wrong form factor |
| `MarcinKilarski/Website-Audit` | (template) | Markdown | Report template, not a tool | Borrow as a *report shape* reference |
| `olleepalmer/beaming-bog` | OSS | Python | "Built with ChatGPT in 30 minutes" — basic | Skip |
| `Umair-khurshid/Growling-Cat` | OSS | — | Stated alternative; unverified | Skip — too thin |
| `webshealth/SEO-tools` | (fork of StanGirard) | Mixed | Fork | Skip |

---

## Tier 3 — MCP-native + GEO/agentic angle (direct competition)

### `RichardDillman/seo-audit-mcp` — name clash, niche
- **Stars:** 0 · **License:** MIT · **Status:** single commit (early)
- **Surface:** 5 tools — `analyze_page`, `crawl_site`, `run_lighthouse`, `analyze_sitemap`, `check_urls`. Specialised for **job board** sites (JobPosting schema validation).
- **Verdict:** **Name clash, but no real competition.** Our scope is general technical SEO + GSC + DataForSEO + agentic. We may want to rename to avoid confusion (e.g. `houtini-ai/seo-audit` or `houtini-ai/seo-auditor`). Note: this repo isn't a published npm package, just a GitHub repo with one commit — so the name on npm is likely free.
- Source: <https://github.com/RichardDillman/seo-audit-mcp>

### `zubair-trabzada/geo-seo-claude` — Claude-Code skill for GEO
- **Lang:** Markdown (skill definitions)
- **Surface:** GEO-first SEO skill for Claude Code — citability scoring, AI crawler analysis, brand authority, schema, platform-specific optimisation, PDF reports.
- **Verdict:** Different shape — it's a *Claude Skill*, not an MCP. Useful inspiration for the GEO/AI-search half of our checklist. Read the prompts.
- Source: <https://github.com/zubair-trabzada/geo-seo-claude>

### `claude-seo.md` — Claude Code AI SEO skill suite
- **Lang:** Claude Code skills/subagents
- **Surface:** 23 sub-skills + 18 subagents covering technical SEO, E-E-A-T, schema, GEO, local SEO, semantic clustering, SXO, drift monitoring.
- **Verdict:** **Form-factor competitor.** They've taken the Claude-Skill route to "AI SEO audit". We've taken the MCP route. Their advantage: zero install, lives in Claude Code. Our advantage: tool composability with non-Claude clients, reusable as a server. Worth being aware of but not architecturally similar enough to copy.
- Source: <https://claude-seo.md/>

### `ngstcf/ai-seo-auditor` — GEO/AEO 2025
- **Surface:** 11 scored categories, programmatic checks → LLM analysis. Specifically checks 12 AI bots in robots.txt (GPTBot, ClaudeBot, PerplexityBot, ChatGPT-User, OAI-SearchBot, Google-Extended, Amazonbot, etc.).
- **Verdict:** Borrow the AI-bot-policy checklist; their 12-bot list is the most concrete I've seen.
- Source: <https://github.com/ngstcf/ai-seo-auditor>

---

## Tier 4 — agent-readiness scanners (the new category)

This is the most interesting frontier and where there's the *least* prior art.

### `isitagentready.com` (Cloudflare) — **the reference implementation**
- Exposes `scan_site` as an **MCP tool at `/.well-known/mcp.json`** — Streamable HTTP. Any MCP-compatible agent can invoke it.
- **Four scoring categories + commerce (non-scoring):**
  1. **Discoverability** — `robots.txt` (RFC 9309), `sitemap.xml`, Link headers (RFC 8288 — e.g. `Link: </.well-known/api-catalog>; rel="api-catalog"`).
  2. **Content** — markdown content negotiation (serve `text/markdown` on `Accept: text/markdown`). Adoption rate: **3.9%** of scanned sites.
  3. **Bot access control** — Content Signals (e.g. `Content-Signal: ai-train=no, search=yes, ai-input=yes`) in robots.txt, AI bot rules, Web Bot Auth (`/.well-known/http-message-signatures-directory`).
  4. **Capabilities** — Agent Skills (`/.well-known/agent-skills/index.json`), API Catalog (RFC 9727 at `/.well-known/api-catalog`), OAuth discovery (RFC 8414, RFC 9728), MCP Server Card (`/.well-known/mcp/server-card.json`), WebMCP.
  5. **Commerce (non-scoring):** x402 (HTTP 402), Universal Commerce Protocol, Agentic Commerce Protocol.
- **Adoption baseline (200k domains scanned):** 78% have robots.txt; 4% declare AI usage preferences via Content Signals; 3.9% support markdown content negotiation; **<15 sites support MCP Server Cards or API Catalogs**.
- **Verdict:** **WRAP, DON'T REBUILD.** This is Cloudflare-maintained, exposed as an MCP tool already. Our consolidated MCP should *invoke `isitagentready.com`'s `scan_site` tool* and merge its findings into our audit. Build a local fallback for offline use, but don't try to out-Cloudflare Cloudflare on protocol scanning.
- Source: <https://blog.cloudflare.com/agent-readiness/>, <https://isitagentready.com/>

### `isagentready.com` (different project, similar scope)
- 5 categories: Discoverability, Content Accessibility, Bot Access Control, Protocol Discovery, Commerce (incl. MPP, UCP, ACP).
- **Verdict:** Note as alternative. Pick one as canonical (Cloudflare's is the well-known one).

---

## What's missing across all of them

The gap-list — these are the things *nobody* in the OSS landscape currently does well:

1. **MCP-native everything.** Of all the tools surveyed, only RichardDillman's (job-board-niche, early) and isitagentready's `scan_site` are MCPs. The whole audit-as-conversation experience is wide open.
2. **GSC + crawl reconciliation.** No OSS tool I found cross-references *what GSC says is indexed* against *what the crawl can reach* against *what's in the sitemap*. This three-way reconcile is where orphan pages, soft-404s, and crawl-budget waste actually live.
3. **DataForSEO/SERP integration.** Nothing OSS pulls live SERP context to ask "is this page's title aligned with the queries actually ranking for it?"
4. **Grounded-LLM judgement layer.** SEOmator and others have "AI/GEO Readiness" *categories* but no *intent-mismatch* check that says "this page targets X but ranks for Y — rewrite intent". That's a Gemini-grounded judgement we can make.
5. **Deterministic-vs-non-deterministic separation.** All existing tools blend them. We can be the first to label every output as one or the other and gate the latter behind a flag.
6. **Internal-link graph as a first-class object.** Most tools detect orphans by sitemap-vs-crawl diff. Almost none expose the *full directed graph* (PageRank-style internal authority flow, hub pages, dead-end pages, anchor-text concentration) as a queryable structure.
7. **Render-parity as a test, not a feature.** Only `VesterlundCoder/SEO-JavaScript-Crawler-IncRev` makes raw-vs-rendered diff a primary output. This should be a routine check.
8. **Syndication-opportunity detection.** No tool flags "you have a blog with no RSS/Atom feed", "your podcast feed lacks `<itunes:*>` tags", or "your news section qualifies for Google News if you exposed a feed". Easy wins, nobody automates them.
9. **Server-log integration.** A handful mention log analysis as a feature, none ingest a log file and reconcile against the crawl + sitemap + GSC.
10. **War-story rules.** None of the tools encode the specific known failure modes — iframe-in-`<head>` killing rankings, `Vary: User-Agent` triggering soft-404s, `If-Modified-Since` loops, hreflang reciprocity failures across language splits. These are the deep-tail rules that justify a senior audit.

---

## What we can lift (license-compatibly)

All of these are **MIT** so the taxonomy / rule lists / patterns are reusable with credit:

- **SEOmator's 251-rule taxonomy** → seed our rule catalogue. (Credit `seo-skills/seo-audit-skill`.)
- **Open SEO Crawler's severity + citation pattern** → recommendation evidence format.
- **SiteOne's modular analyser shape** → architectural inspiration for `plan/architecture.md`.
- **`advertools` library** (Python, MIT, by Elias Dabbas) → sitemap parsing, robots, log analysis primitives if we end up needing Python-side workers.
- **isitagentready's `scan_site` tool** → wrap rather than rebuild.

---

## Open question for the user (file this in `plan/open-questions.md` later)

**Repo & npm naming.** `seo-audit-mcp` (our intended name) is already taken on GitHub by `RichardDillman/seo-audit-mcp` (single-commit job-board niche). Not on npm under `@houtini/`. Options:
- Ship as `@houtini/seo-audit-mcp` (npm) with repo `houtini-ai/seo-audit` (drop the `-mcp` suffix on the repo to match house style — cf. `houtini-ai/lm`, `houtini-ai/yubhub`).
- Or `@houtini/seo-auditor` if we want to dodge the name clash entirely.

---

## Sources

### Direct prior-art (read deeply)
- [seo-skills/seo-audit-skill](https://github.com/seo-skills/seo-audit-skill) — SEOmator, 223★, MIT, TS, 251 rules / 20 categories
- [janreges/siteone-crawler](https://github.com/janreges/siteone-crawler) — Rust, 5-category weighted score
- [StJudeWasHere/seonaut](https://github.com/StJudeWasHere/seonaut) — Go, 709★, multi-user Docker
- [PhialsBasement/LibreCrawl](https://github.com/PhialsBasement/LibreCrawl) — Python+Playwright, 5M URL scale
- [puneetindersingh/open-seo-crawler](https://github.com/puneetindersingh/open-seo-crawler) — Ahrefs/Moz citation pattern
- [viasite/site-audit-seo](https://github.com/viasite/site-audit-seo) — Lighthouse wrapper, CLI
- [StanGirard/seo-audits-toolkit](https://github.com/StanGirard/seo-audits-toolkit)
- [eliasdabbas/seo-audit-and-analysis](https://github.com/eliasdabbas/seo-audit-and-analysis) — advertools + Jupyter
- [VesterlundCoder/SEO-JavaScript-Crawler-IncRev](https://github.com/VesterlundCoder/SEO-JavaScript-Crawler-IncRev) — render parity
- [sethblack/python-seo-analyzer](https://github.com/sethblack/python-seo-analyzer)
- [MarcinKilarski/Website-Audit](https://github.com/MarcinKilarski/Website-Audit) — report template
- [plainsignal/seo-auditor](https://github.com/plainsignal/seo-auditor) — Chrome extension
- [olleepalmer/beaming-bog](https://github.com/olleepalmer/beaming-bog)
- [Umair-khurshid/Growling-Cat](https://github.com/Umair-khurshid/Growling-Cat)

### MCP / Claude-native competition
- [RichardDillman/seo-audit-mcp](https://github.com/RichardDillman/seo-audit-mcp) — name-clash, job-board niche, 1 commit
- [zubair-trabzada/geo-seo-claude](https://github.com/zubair-trabzada/geo-seo-claude) — Claude Code GEO skill
- [claude-seo.md](https://claude-seo.md/) — Claude Code AI SEO skill suite, 23 sub-skills
- [ngstcf/ai-seo-auditor](https://github.com/ngstcf/ai-seo-auditor) — GEO/AEO, 12-bot AI policy checks

### Agent-readiness reference
- [Cloudflare — Introducing the Agent Readiness score](https://blog.cloudflare.com/agent-readiness/)
- [isitagentready.com](https://isitagentready.com/) — Cloudflare scanner + MCP tool
- [isagentready.com](https://isagentready.com/) — sister project

### Topic indexes
- [GitHub topic: seo-audit](https://github.com/topics/seo-audit)
- [GitHub topic: seo-site-audit](https://github.com/topics/seo-site-audit)
- [GitHub topic: technical-seo](https://github.com/topics/technical-seo)
- [GitHub topic: screaming-frog](https://github.com/topics/screaming-frog)
- [serpapi/awesome-seo-tools](https://github.com/serpapi/awesome-seo-tools) — curated list
