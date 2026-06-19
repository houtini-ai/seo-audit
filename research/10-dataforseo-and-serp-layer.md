---
name: DataForSEO / SERP layer — what our scopes unlock for the audit
description: How the three DataForSEO modules we have (SERP, KEYWORDS_DATA, DOMAIN_ANALYTICS) extend the GSC×crawl audit — with an honest line on what our scope does NOT include (Labs). Source for the web-search/SERP module in plan/architecture.
type: research
phase: 1
---

# DataForSEO / SERP layer — what our scopes unlock

**Our scope (verified):** `ENABLED_MODULES = SERP, KEYWORDS_DATA, DOMAIN_ANALYTICS`. Exact endpoints + the credential pointer live in `.secrets/dataforseo-scopes.md` (gitignored). **Not enabled: DataForSEO Labs, Backlinks, On-Page, Content Analysis** — so keyword-difficulty, ranked-keywords, domain-intersection and backlink data are out unless we extend `ENABLED_MODULES`.

This is the `S`-labelled layer from [01-checklist](01-modern-technical-seo-checklist.md) §17 and the E-series in [05-gsc-and-dataforseo-overlap](05-gsc-and-dataforseo-overlap.md). DataForSEO + GSC + crawl is the third leg of the join; per [07-prior-art](07-prior-art.md) no OSS tool blends all three.

## What each module adds on top of GSC×crawl

| # | New capability | Join logic | Module | Cost |
|---|----------------|-----------|--------|------|
| 1 | **True search volume to prioritise striking-distance** — GSC gives *our* impressions, not *market* volume | GSC queries at position 11–20 → `google_ads/search_volume/live` → rank fixes by total demand × our position | KEYWORDS_DATA | cheap |
| 2 | **SERP-feature / AI-Overview presence per ranking query** — are our queries triggering AI Overviews, PAA, image/video packs, and do we appear? | top GSC queries → `serp/google/organic/live/advanced` → inspect `items[].type` for features + our domain | SERP | per-request |
| 3 | **Page-intent vs live-SERP-intent mismatch** — does our page format match what actually ranks? | for a page's top query, pull top-10 SERP, classify dominant intent/format vs our crawled page type | SERP (+ N judgement) | per-request |
| 4 | **Competitor overlap / share of voice** — who really shares our SERPs | aggregate domains in top-10 across our GSC query portfolio (we compute it from raw SERP, since **Labs domain_intersection is NOT in scope**) | SERP | per-request |
| 5 | **External duplicate / scraped content** — find copies on other domains | exact-phrase `"distinctive sentence"` or `"<title>"` via SERP → other-domain hits ⇒ duplication/scraping (cite URLs) | SERP | per-request |
| 6 | **Live cannibalisation verification** — confirm GSC-suspected cannibalisation is real | search the query, check if ≥2 of our URLs appear in the live top-100 | SERP | per-request |
| 7 | **Seasonal demand context** — is a GSC decline a drop or just seasonality? | core queries → `google_trends/explore` 12-mo curve vs GSC impression trend | KEYWORDS_DATA | cheap |
| 8 | **Competitor tech-stack benchmarking** — what are the domains outranking us built on? | top SERP competitors → `domain_analytics/technologies` | DOMAIN_ANALYTICS | cheap |
| 9 | **Brand-term / cybersquatting watch** — who ranks for our brand, and who owns it | brand queries → SERP domains → `domain_analytics/whois` | SERP + DOMAIN_ANALYTICS | mixed |
| 10 | **Video opportunity** — queries that trigger video packs we don't own | GSC queries with video SERP features → `serp/youtube/organic` | SERP | per-request |

## Design implications (→ `plan/architecture.md` `core/web-search.ts`)

- DataForSEO is one **backend** of the `web-search.ts` provider abstraction (alongside Brave/Firecrawl). Use **Brave/Firecrawl** for cheap duplicate-content phrase lookups; use **DataForSEO SERP** when we need *structured* SERP (features, ranks, competitor domains) — it's the one with real per-request cost.
- **Budget + cache hard.** SERP `live/advanced` is the only expensive call; gate behind explicit opt-in, cache by (query, location), and never fan out across a whole keyword set without a cap (the "no silent cap" rule).
- **Scope honesty:** features #1–#10 are all achievable with our 3 modules. If we later want keyword-difficulty or one-call competitor intersection, that's a `ENABLED_MODULES += DATAFORSEO_LABS` decision with cost implications — record in `open-questions.md`, don't assume it.
- Everything here is **`S`-labelled** evidence (live, external, costs money) — cite the SERP `check_url` and datetime in findings.

## Sources
- context7 — DataForSEO v3 docs (`/llmstxt/dataforseo_v3_llms_txt`): `serp/google/organic/live/advanced`, `keywords_data/google_ads/search_volume/live`, `keywords_data/google_trends/explore`, `serp/youtube/organic`, and (for the out-of-scope note) `dataforseo_labs/google/domain_intersection/live`.
- Gemini (`gemini-3.1-pro-preview`, grounded, chunked chat) — the 10-capability creative pass, filtered here against our actual module scope.
- `.secrets/dataforseo-scopes.md` — exact enabled modules + endpoint list (local only).
- Cross-ref: [05-gsc-and-dataforseo-overlap.md](05-gsc-and-dataforseo-overlap.md) §E, [09-seogets-and-check-coverage.md](09-seogets-and-check-coverage.md) §3 (web-search module).
