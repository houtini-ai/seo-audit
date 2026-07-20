# Writer's brief — "How to do an SEO audit with Claude" (in-depth guide)

Handover for the long-form guide. Everything factual below is verified against the shipped product (v0.1, 90 checks). Where a number appears, it's real, from the simracingcockpit.gg property.

## The product in one line

SEO Audit Console is an MCP server that merges Google Search Console history, a first-party crawl, and on-demand DataForSEO data into one prioritised, fix-writing technical SEO audit run entirely by conversation inside Claude Desktop.

## The angle (don't bury it)

- **The merge is the story.** Crawl = what the site says. Search Console = what Google did about it. The recoverable traffic lives in the gap: cannibalisation, striking distance, ghost pages, titles missing the query the page already ranks for. No crawler-only tool can see these.
- **Priority by money, not severity.** Every finding is ranked by expected clicks per developer-hour. The reader should come away thinking "top five findings first", not "fix all 220".
- **It writes the fix.** Redirect rules, JSON-LD, internal-link donors, grounded content drafts. Dry-run only — it never touches the site.
- **Honesty as a feature.** Deterministic (D) vs judgement (N) labels; judgement checks are off unless asked for.

## Audience and voice

SEO consultants and in-house marketers; assume they know what a title tag is, not what MCP is. Write in Richard's Builtvisible register: short single-thought paragraphs, first-person experience, "in my view", honest caveats, British spelling, contractions, **no em-dashes** (spaced hyphens), zero AI-slop vocabulary (never: unlock, leverage, seamless, robust, delve, landscape, elevate). Reference corpus: builtvisible.com guides.

## Structure to follow

An article skeleton already exists at [plan/audit-workflow-article.md](../plan/audit-workflow-article.md) — it maps the standard 61-task crawler audit workflow to our conversational version. Use its skeleton as the spine. The condensed step-by-step (each step = a typed prompt, screenshot, then what-you're-looking-at):

1. **Setup** (one-time, ~10 min): Node 20+, Claude Desktop, GSC service account. The gotcha to call out: the service-account email must be added as a user on the GSC property. Full steps in the [README](../README.md#installation).
2. **Check it's connected** — `list properties`
3. **Pull the data** — `Refresh sc-domain:yoursite.com` (first sync = full history; every later one is incremental — 33 min → 19 s on our test property. Crawl discovers pages from links + sitemaps + GSC URLs: coverage went 29% → 70% of GSC-known pages).
4. **Run the audit** — `Run an SEO audit on yoursite.com` (+ variant "include the judgement findings"). Explain the priority model here.
5. **Read the top five** — walk one real finding end-to-end: evidence → traffic at stake → decision.
6. **Generate fixes** — `Generate the fix for the broken link on /old-page` · `Write the Product structured data for /widgets`
7. **Site health** — the Screaming Frog-style tab: response codes, speed, page weight, heavy images (header-only sampling — good honesty beat: the bytes are never downloaded).
8. **Growth**: `Suggest new pages` · `List the page templates` (one template fix corrects N pages).
9. **AI search**: `Score the passages` (local model, ~25MB, content never leaves the machine; classifier, can't hallucinate) → `Draft the missing content for /page` → `Check agent readiness`.
10. **Keyword research + competitor gap** (needs DataForSEO — see below): volumes, intent, `What do my competitors rank for that I don't?`, backlinks.
11. **Monitor** — `Detect changes on yoursite.com` (the migration-insurance story).
12. **Share** — `Export the report` (self-contained HTML for clients).

## DataForSEO section (affiliate)

Use the affiliate link **https://dataforseo.com/?aff=213701** everywhere DataForSEO is linked (it's the link used elsewhere on the site). Positioning: GSC only describes searches where you already appear; DataForSEO answers "how big is the market" and "what do competitors rank for that I don't". Pay-as-you-go, fractions of a cent per call, cached 20 days, only ever called on demand — "a few dollars a month" is the honest cost line. Gotcha worth a call-out box: the Backlinks API is a separate DataForSEO subscription from SERP/Keywords/Labs.

## Screenshots

Six ready-made in [docs/images/](images/), all from the real simracingcockpit.gg dataset:

| File | Shows | Use at step |
|---|---|---|
| dashboard-overview.png | Executive summary, critical issues, recoverable clicks | 4-5 |
| tab-issues.png | Prioritised findings list with impact sizes | 5 |
| site-health.png | Crawl diagnostics stat bars (the Screaming Frog moment) | 7 |
| tab-opps.png | Quick-wins matrix / opportunity charts | 8 |
| search-performance.png | Ranking-distribution area chart | 4 or 12 |
| tab-arch.png | Equity-vs-reality architecture charts | optional |

To make more: run `refresh_property` + `run_audit` on a property, then `export_report` — the saved HTML opens in any browser for clean captures. Chat-transcript screenshots (the prompts themselves) need a manual session — grab those during your own walkthrough, same as [docs/how-to-guide.md](how-to-guide.md) (which is the short-form companion piece; don't duplicate it, go deeper).

## Verified claim bank (safe to use, don't inflate)

- 90 checks; ~38 have no equivalent on the standard industry audit checklist.
- Priority formula: (expected clicks × yield × certainty) ÷ effort-hours.
- Crawl: HTTP/2, gzip/brotli, robots-respecting (bot-specific group replaces `*` per RFC 9309), always-GET, assets never downloaded.
- Cannibalisation thresholds ignore incidental long-tail overlap (real example: one page held 59,570 impressions for a term; nine pages with 1-7 impressions were NOT counted as competitors).
- Freshness honesty: sitemap lastmod lie-detection + a conditional-request probe (real finding: our test site sends Last-Modified yet returns 200, not 304).
- Privacy: SQLite on the user's machine, local scoring model, no telemetry.
- Licence: source-available, free for personal/evaluation use, commercial licence for agency/client work, each release becomes Apache 2.0 after three years.

## Links

- Repo: https://github.com/houtini-ai/seo-audit · Houtini: https://houtini.com
- DataForSEO (affiliate): https://dataforseo.com/?aff=213701
- Companion how-to: docs/how-to-guide.md · README: the full feature map · Article skeleton: plan/audit-workflow-article.md

## Don'ts

- Don't name or credit other SEO tool vendors as sources; "the standard crawler workflow" is the framing.
- Don't promise features from the roadmap (list mode, JS rendering, printable report) as shipped.
- Don't present judgement (N) findings as deterministic facts — the D/N honesty is part of the brand.
- Don't screenshot client properties; simracingcockpit.gg data is cleared for use.
