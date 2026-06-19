---
name: SEO Gets teardown + technical-check coverage matrix (incl. web-search requirement)
description: What seogets.com charges for (it's GSC-analytics only, no crawler), and a coverage matrix mapping the user's required technical checks to the master checklist plus the NEW capabilities they demand — web search for duplicate content, conditional-request probing, sitemap/robots parsers, schema validation, and agent-generated JSON-LD.
type: research
phase: 1
---

# SEO Gets teardown + technical-check coverage matrix

## 1. SEO Gets — what it actually is

**It's a GSC (+GA4) analytics layer. It does NOT crawl.** Scraped from [seogets.com/pricing](https://seogets.com/pricing):

| Plan | $/mo | Notable |
|------|------|---------|
| **Core** | $39 | **unlimited users & websites**, GSC+GA4 unified, master dashboard, content groups/topic clusters, branded keyword tracking, **striking-distance & cannibalization reports**, **content-decay heatmaps**, SEO testing, client portals / magic shared links, **index reporting**, saved views |
| **Core + Super Sites** | $49 | + track up to 5,000 indexed pages, **track exact page content changes over time**, **email alerts the moment indexing/rankings drop**, **5 years of history**, AI dashboard setup, **"chat with your data"** (answers, content suggestions, anomaly detection) |

**Verdict — this is the single most important competitive datapoint so far:**
- seogets' *entire* product is the GSC-analytics layer that **better-search-console already replicates locally and free** (and we store unlimited history, beating their "5 years"). Their flagship reports — **striking distance, cannibalization, content decay, index reporting, content-change tracking, chat-with-data** — map 1:1 onto things we already have or have specced:
  - striking distance → [research/05](05-gsc-and-dataforseo-overlap.md) B3
  - cannibalization → B2
  - content decay → the C-series decline diagnosis (and we go further: we can say *why* via the crawl)
  - index reporting / filter-by-index-status → D-series
  - content-change-over-time → a crawl-diff feature (we store crawl snapshots)
  - chat-with-data → inherent to MCP
- **What seogets CANNOT do: crawl.** No robots/sitemap parsing, no orphan detection, no resource-size, no 304 probing, no schema validation, no on-page technical audit. That's the entire seo-crawler half — and the user's check-list below.

**So the combined `seo-audit-console` strictly dominates seogets:** everything seogets does (GSC analytics) **plus** the technical crawl audit it lacks **plus** agent-native remediation (JSON-LD generation, redirect configs) none of them do — at zero seat/credit cost, local. The content-change tracking, decay heatmaps, and proactive drop alerts are worth explicitly mirroring (cheap given our data) so the comparison is unarguable.

---

## 2. Coverage matrix — the user's required checks

Mapping each requested check to the [master checklist](01-modern-technical-seo-checklist.md) and the **capability** it needs. ✅ already in seo-crawler-mcp · 🟡 specced/near-term · 🆕 **new module required**.

| Requested check | Checklist # | Status | Capability needed |
|---|---|---|---|
| **Duplicate content** (internal) | #72, content/duplicate-* | ✅/🟡 | crawl has duplicate title/H1/meta; ADD near-duplicate **body** detection via content hashing (simhash / shingling) across crawled pages |
| **Duplicate content** (external / scraped) | #204, new | 🆕 | **WEB SEARCH** — exact-phrase `"distinctive sentence"` queries to find the same content on other domains (scraped from us, or us duplicating others) |
| **robots.txt valid?** | #9–11, #15–17 | 🟡 | fetch + **RFC 9309 parser**: 200 at root, syntax, no accidental global `Disallow: /`, conflicting allow/disallow, sitemap directive present |
| **Pages not in sitemap** | #22, #30–32 | 🟡 | **sitemap fetcher/parser** (incl. nested indices) → reconcile vs crawl + GSC (the 3-way reconcile, §1.3) |
| **Orphaned pages** | #33, #154 | ✅ | internal-link graph (crawler `links` table) + sitemap/GSC reconcile; D1 in research/05 (orphans *with* GSC impressions = top wins) |
| **Resources of excessive size** | #95–101, #104, #108 | 🆕 | capture **byte sizes** of HTML + assets (img/JS/CSS) during crawl via `Content-Length`/response size; flag oversized + uncompressed |
| **HEAD / 304 Not Modified** | #55, #100, #106 | 🆕 | **conditional-request prober** — send `If-Modified-Since`/`If-None-Match`, assert correct 304 behaviour; flag never-304 (no caching) and always-304-on-updated (stale) |
| **Schema validator** | #109–123 | 🆕 | extract JSON-LD/microdata + **validate** against schema.org types and Google Rich Results required/recommended fields; flag markup-vs-visible-content mismatch (#118) |
| **Claude generates JSON-LD snippets** | new (remediation) | 🆕 | **agent-native generator**: Claude reads the crawled page content → emits valid, type-correct JSON-LD ready to paste (the wedge from [research/08](08-saas-disruption-and-features.md) #5) |

"…there's more, directionally the core technical tenets" → the [master checklist](01-modern-technical-seo-checklist.md) is the full surface; this matrix just confirms the user's named priorities are covered and surfaces what's genuinely new to build.

---

## 3. New capability: a **web-search module** (the user's key addition)

> "use web search to perform search queries that reveal issues like duplicate content"

This is a new data source alongside crawl + GSC. Concrete uses:

- **External duplicate / scraped content** — pick the page's most distinctive sentence(s) or content shingles, query as an exact phrase `"…"`; results on *other* domains ⇒ duplication (we're scraped, or we're the copy). Deterministic-ish signal, cite the offending URLs.
- **Indexation spot-check** — `site:domain.com inurl:…` style queries to sanity-check what's actually indexed vs GSC.
- **SERP context (E-series)** — who shares the SERP, SERP features, AI-overview citation — overlaps with DataForSEO (research/05 §E).

**Implementation:** a `core/web-search.ts` provider abstraction with pluggable backends — **Brave Search API**, **Firecrawl search**, and **DataForSEO** (for true SERP structure). Treat results as `N`/`S`-labelled evidence (judgement, cite sources), never silent. Rate-limit and cache; this is the one area with per-query external cost, so make the backend + budget configurable.

**Caveat to encode:** exact-phrase web search for duplication is a *heuristic* — it finds copies but can't prove direction or originality. Label `N`, present evidence (the matching URLs + the shared passage), let the user judge.

---

## 4. Architecture deltas (→ update [plan/architecture.md](../plan/architecture.md))

New modules implied by this matrix:
- `core/web-search.ts` — Brave/Firecrawl/DataForSEO provider abstraction (duplicate-content + SERP).
- `core/robots-sitemap.ts` — RFC 9309 robots parser + sitemap (incl. index) parser for the 3-way reconcile.
- `core/conditional-probe.ts` — HEAD + `If-Modified-Since`/`If-None-Match` 304 behaviour checks (a light post-crawl pass, not part of the main fetch).
- `analyzers/schema-validate.ts` — JSON-LD/microdata extraction + schema.org/Rich-Results validation.
- crawl extractor: **record response + asset byte sizes** (excessive-resource check).
- `generators/json-ld.ts` — agent-native JSON-LD generation from page content (remediation; dry-run/diff, never silent write — same safety contract as auto-PRs).
- near-duplicate **body** detection (simhash/shingling) in the analysis layer.

---

## Sources
- [seogets.com/pricing](https://seogets.com/pricing) (scraped this session — plans, limits, feature list)
- [research/05 — GSC × crawl catalogue](05-gsc-and-dataforseo-overlap.md), [research/08 — SaaS disruption](08-saas-disruption-and-features.md), [research/01 — master checklist](01-modern-technical-seo-checklist.md) (§1.1 robots, §1.2–1.3 sitemap reconcile, §4 resources, §5 schema, §1.5 #55 304 war-story, #154 orphans, #204 compromise/duplication)
- [research/07 — prior art](07-prior-art.md) (gap analysis)
