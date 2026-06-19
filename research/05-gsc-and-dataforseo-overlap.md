---
name: GSC × crawl × SERP overlap — the merged-data question catalogue
description: The high-leverage diagnostic questions that are only answerable by joining Google Search Console performance data to crawl data (and, where noted, SERP/DataForSEO) on a normalised page URL. This is the differentiator catalogue for seo-audit-console.
type: research
phase: 1
---

# GSC × crawl × SERP — the merged-data question catalogue

**Question being answered:** what can we diagnose by *joining* the persistent GSC history (better-search-console) to a crawl snapshot (seo-crawler-mcp) that neither dataset answers alone? This catalogue is the spec source for the merged queries in `plan/tool-surface.md`.

**Prior-art reality check (important — we are not first to the join):**
Screaming Frog has had native GSC API integration for years: connect GSC before a crawl and it pulls clicks/impressions/CTR/avg-position per URL, plus URL Inspection API coverage/last-crawl/mobile-usability, straight into the crawl table (sources below). So "join GSC to crawl on URL" is **established practice, which de-risks the design** — but every one of those tools joins **one live crawl to a ~16-month GSC snapshot pulled at crawl time**.

**Our differentiator (the gap from [07-prior-art](07-prior-art.md) #2):** better-search-console already stores **months of *daily* GSC rows in SQLite**, per property. Joining a *historical, queryable* GSC database to crawl snapshots lets us answer **trend and change questions** ("this page's clicks fell 60% over 6 weeks — and the last crawl shows it went `noindex`") that a single-crawl API pull structurally cannot. MCP-native + conversational + historical is the whitespace.

**Labels** (carried from [01-modern-technical-seo-checklist](01-modern-technical-seo-checklist.md)): **D** deterministic · **N** judgement (LLM/heuristic, gated + cited) · **G** needs GSC · **S** needs SERP/DataForSEO.

---

## A. CTR / snippet opportunities (GSC perf × on-page crawl)

| # | Question | GSC metric | Crawl field | Join / threshold |
|---|----------|------------|-------------|------------------|
| A1 | **Pages whose CTR is far below the position-expected curve** (snippet/title rewrite) [high] G D | impressions, ctr, avg_position | title, meta_description, title_length | join on url; flag where `avg_position` is in a band (e.g. 1–10) AND `ctr` < band-expected-CTR × 0.6 AND impressions ≥ N. Cross-ref crawl: missing/short/duplicate meta description, title not matching query. |
| A2 | **High-impression pages with a missing or truncated meta description** [high] G D | impressions | meta_description (null/empty), meta_description_length | url join; `meta_description IS NULL/''` OR length >155, ordered by impressions desc. The crawl explains the GSC symptom. |
| A3 | **Title doesn't contain the page's top-impression query** (relevance gap) [med] G D N | top query by impressions per page | title | url join; tokenise top query, check presence in title; N to judge intent match. |
| A4 | **Branded vs non-branded CTR split anomalies** — pages living on brand CTR while non-brand impressions leak [med] G N | clicks/impressions by branded/non-branded | (page type from crawl) | url join + brand-term classification (better-search-console already has a branded split). |

## B. Content gaps & cannibalisation (GSC query layer × crawl URL inventory)

| # | Question | GSC metric | Crawl field | Join / threshold |
|---|----------|------------|-------------|------------------|
| B1 | **Queries with impressions but no dedicated landing page** (content gap) [high] G N | query-level impressions, the page GSC attributes them to | pages.url inventory | for each high-impression query, the GSC-attributed page is a weak/tangential match (judgement) OR maps to a hub/category rather than a specific page → gap. |
| B2 | **Keyword cannibalisation — one query, multiple ranking URLs** [high] G D | per-query: distinct pages receiving impressions/clicks over the window | crawl: confirm both URLs are indexable & near-duplicate (title/H1/word overlap) | group GSC rows by query; flag queries where ≥2 URLs each clear an impression floor; crawl confirms they're genuine duplicates vs intentional. |
| B3 | **Striking-distance queries (avg position 11–20) on pages with on-page gaps** [high] G D | avg_position 11–20, impressions | title/H1/word_count/internal in-links | url join; position band 11–20 + impressions ≥ N + crawl shows thin content, weak title, or few internal links → highest-ROI fix list. |
| B4 | **Pages ranking for queries their content doesn't target** (intent drift) [med] G N | top queries per page | title, H1, body text | url join; N judgement that ranking queries ≠ page's apparent target. |

## C. Decline & change diagnosis (GSC *history* × crawl — our unique axis)

| # | Question | GSC metric | Crawl field | Join / threshold |
|---|----------|------------|-------------|------------------|
| C1 | **Declining pages explained by a crawl regression** [crit] G D | clicks/impressions trend (period vs prior; daily history) | status_code, indexable, canonical_url, robots meta, internal in-link count | url join; page with significant click decline AND crawl now shows: became `noindex`, started 3xx/4xx/5xx, canonical now points elsewhere, or internal in-links dropped. **The killer query — only possible with GSC history + fresh crawl.** |
| C2 | **Pages with clicks last period but zero this period** (de-ranked / dropped) [crit] G D | clicks current vs prior | crawl presence + status | url join; clicks_prior>0 AND clicks_current=0; crawl says whether the page still exists / is indexable. |
| C3 | **Newly-indexing pages — did a recent publish get picked up?** [med] G D | first-seen impressions date | crawl discovered, status 200, indexable | url join over recent crawl vs GSC first-impression date. |
| C4 | **Sitewide/section decline correlated with a template change** [high] G D N | aggregate clicks by URL path prefix, trended | crawl: shared template signals (e.g. all section pages lost a schema block, changed canonical) | group by path prefix; correlate decline window with crawl-diff. |

## D. Index hygiene & crawl-budget (GSC coverage × crawl reachability — the 3-way reconcile)

| # | Question | GSC metric | Crawl field | Join / threshold |
|---|----------|------------|-------------|------------------|
| D1 | **Orphan pages that still receive GSC impressions** [high] G D | impressions/clicks > 0 | internal in-link count = 0 (crawl) | url join; in-links=0 AND GSC impressions>0 → high-value internal-linking wins (a page Google ranks but the site barely links). |
| D2 | **Index bloat — indexed pages with ~0 clicks AND thin/duplicate** [high] G D N | clicks ≈ 0 over long window, impressions low | word_count low, duplicate title/H1, indexable=true | url join; long-window clicks≈0 + thin/dupe + indexable → noindex/consolidate candidates (crawl-budget + quality). |
| D3 | **GSC-known pages missing from the crawl** ("ghost" / unreachable) [high] G D | pages with impressions | absent from crawl `pages` | anti-join: GSC page URL not in crawl → not internally reachable; investigate. |
| D4 | **Crawled pages GSC has never shown** (zero-impression inventory) [med] G D | absent from GSC | crawl pages, indexable | anti-join the other way; candidates for noindex or improvement. |
| D5 | **Canonical conflicts: GSC's attributed (canonical) URL ≠ crawl's `<link rel=canonical>`** [high] G D | the page URL GSC reports impressions on | canonical_url from crawl | url join; Google's chosen canonical disagreeing with the declared canonical is a real signal. |

## E. SERP-enriched (needs DataForSEO — phase 2+, S)

| # | Question | source | Join |
|---|----------|--------|------|
| E1 | Page intent vs live SERP intent mismatch [high] S N | DataForSEO SERP for the page's top query | url→query→SERP |
| E2 | SERP feature presence (AI Overview, PAA, image pack) for ranking queries — are we eligible/cited? [med] S | DataForSEO | query layer |
| E3 | Competitor overlap on shared SERPs [info] S | DataForSEO | query layer |

These are out of scope for the first merged build (GSC×crawl) but the URL→query→SERP spine is the same.

---

## The join key — URL normalisation (the make-or-break detail)

Both datasets key on a page URL, but **neither normalises**, and they normalise *differently* in practice:

- **GSC `search_analytics.page`** (better-search-console): the **Google-canonicalised** URL — protocol-normalised, host as registered in the GSC property, Google's trailing-slash decision, no tracking params.
- **Crawl `pages.url`** (seo-crawler-mcp): the **raw discovered** URL from Crawlee — whatever was linked, including trailing-slash/case/param variance. (Confirmed in the code review: `UrlManager.normalizeUrl` exists but its output is never persisted, and it doesn't strip www/trailing-slash/params despite its comment.)

**Top URL-normalisation pitfalls when joining:**
1. **Trailing slash** — `/page` vs `/page/`. The single biggest source of false anti-joins (ghost pages, orphans, broken-link misses). Pick one rule: strip trailing slash except root.
2. **Protocol + `www`** — `http`↔`https`, `www.`↔apex. GSC uses the property's canonical host; the crawl uses as-linked. Force `https` and unify host to the GSC property's form.
3. **Tracking / ordering of query params** — `?utm_*`, `gclid`, `fbclid`, `mc_*` produce phantom crawl rows that never match GSC's clean canonical. Strip known tracking params and **sort remaining params**.
- (Plus: lowercase scheme+host but **preserve path case**; strip default ports `:80`/`:443`; strip fragments.)

**Design decision for `plan/architecture.md`:** compute a stored `url_key` column at write time in *both* stores, from a **single shared normalisation util** (one source of truth, imported by both the crawler write path and the GSC sync). Join on `url_key`; keep the raw URL for evidence. Treat raw-URL divergence (esp. D5 canonical disagreement) as a *finding*, not noise.

---

## How this maps to the product

- These merged questions are **`G`-flagged** in [01-modern-technical-seo-checklist](01-modern-technical-seo-checklist.md) §16 — this file turns that section into concrete, joinable queries.
- The decline-diagnosis set (C1–C4) is the **flagship**: it's the one class Screaming-Frog-style live joins can't do, and it's exactly the user's "investigate the issues live" loop (a GSC symptom → the crawl explains the cause).
- Severity/evidence framing follows the `open-seo-crawler` citation pattern noted in [07-prior-art](07-prior-art.md).

---

## Sources

### Established GSC × crawl integration practice (validates the join)
- [SEOCOM — How to use Google Search Console and Screaming Frog to perform a technical audit](https://seocom.agency/en/blog/how-to-use-google-search-console-and-screamingfrog-to-perform-a-technical-audit-of-your-domain/)
- [LuccaAM — AI + Screaming Frog smart workflow: connect GSC + GA4, pull CTR/impressions/clicks into the crawl](https://www.luccaam.com/ai-screaming-frog-smart-workflow-seo-analysis/)
- [Windmill Strategy — connect GA, GSC, PageSpeed to Screaming Frog for insights beyond any one tool](https://www.windmillstrategy.com/how-to-use-screaming-frog-to-get-the-most-out-of-a-website-audit/)
- [The Opinionated SEO — Screaming Frog and the Search Console URL Inspection API](https://opinionatedseo.com/2022/02/screaming-frog-and-the-search-console-url-inspection-api/)
- [Lupage Digital — The Screaming Frog API tutorial](https://www.lupagedigital.com/blog/screaming-frog-api/)
- [Mavlers — top Screaming Frog features incl. GSC/GA4/PSI integration](https://www.mavlers.com/blog/screaming-frog-features/)
- [SEOCOM — GSC + Screaming Frog for structured data auditing](https://seocom.agency/en/blog/how-to-use-google-search-console-with-screaming-frog-to-audit-and-improve-your-structured-data/)

### 2026 technical-SEO context (cross-validation)
- [Digital Applied — Technical SEO Audit Checklist Guide 2026](https://www.digitalapplied.com/blog/technical-seo-audit-checklist-guide-2026)
- [Page One Power — Technical SEO Audit Checklist 2026 (Schema Edition): internal-link priority questions](https://www.pageonepower.com/linkarati/the-technical-seo-audit-checklist-for-2026-schema-edition)
- [NoGood — Technical SEO Checklist 2026: What Really Matters](https://nogood.io/blog/technical-seo-checklist/)
- [Involve Digital — Technical SEO Foundations 2026 (crawlability, llms.txt, AI crawlers)](https://www.involvedigital.com/insights/technical-seo-foundations-2026)

### Internal references
- [01-modern-technical-seo-checklist.md](01-modern-technical-seo-checklist.md) §16 (GSC-derived checks), §1.3 (sitemap↔GSC↔crawl reconcile)
- [07-prior-art.md](07-prior-art.md) — gap #2 (GSC + crawl reconciliation: no OSS tool does it)

> **Follow-up:** a Gemini `deep_research` pass on this exact question set was attempted but timed out against Claude Desktop's ~4-min MCP ceiling (the tool's own guidance: run 5–7 iterations from an IDE / Agent-SDK context). Worth running there to enrich C-series decline patterns and E-series SERP joins.
