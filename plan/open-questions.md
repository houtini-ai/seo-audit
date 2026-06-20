---
name: Open questions — decisions needed before / during the build
description: Consolidated decision log accumulated across the research + plan docs. Each needs a call before the relevant code is written; defaults proposed where sensible.
type: plan
phase: 5
---

# Open questions — decisions before code

Grouped by area. **Bold** = proposed default.

## Product / packaging
1. **Free/OSS core + optional paid layer, vs flat fee?** The wedge ([research/08](../research/08-saas-disruption-and-features.md)) is "no seats/credits/cloud." **Default: free local OSS, paid only if a hosted/team layer emerges later.**
2. Repo/npm naming: **`@houtini/seo-audit-console` / `houtini-ai/seo-audit-console`** (done — repo created). Confirm product name sticks.
3. Ship `core` (~150 checks) first, `full` behind a flag? **Default: yes — `run_audit` defaults to `core`.**

## Safety (must decide before building generators)
4. **Auto-PR / file remediation boundary** — **dry-run + diff approval only, never silent writes.** Confirm we never write to a repo without explicit per-change approval.
5. **JSON-LD / redirect generators** — same: emit copy-block/diff, user applies. Confirm.
6. **Privacy-safe revenue joins** (Stripe/CRM) — local-only data contract, PII never leaves the machine. Defer to v3; confirm the boundary when built.

## Data model & join
7. **One DB per property** (matches better-search-console) vs single DB with a `property` column. **Default: per-property.**
8. `url_key` `www`/apex unification is property-type dependent (domain vs URL-prefix GSC property) — **derive host form from the GSC property identifier at sync time.**
9. Crawl↔GSC freshness contract for merged checks: require a crawl within N days of the GSC window? **Default: surface staleness in findings rather than block.**

## Crawl / rendering / performance
10. **Render tier default** — HTTP-first, render only flagged/sampled pages ([research/12](../research/12-rendering-and-js-seo.md)); full-site render is opt-in (`render:true`). Confirm the JS-dependent heuristic thresholds (body-text floor, `<a>` count, SPA-root detection).
11. WRS budget for the render snapshot: **~5s, configurable.** Confirm.
12. Use Crawlee's `AdaptivePlaywrightCrawler` directly vs our own HTTP→render escalation gate? **Default: evaluate Adaptive first; fall back to our gate if its heuristic doesn't fit.**
13. Resume model for interrupted crawls — persistent frontier per `crawlId` (code-review fix). Confirm scope (resume vs just mark interrupted).

## External data / cost
14. **DataForSEO Labs NOT in current scope** ([research/10](../research/10-dataforseo-and-serp-layer.md)) — keyword-difficulty / domain-intersection unavailable. **Decision: derive competitor overlap from raw SERP for v2; only enable `DATAFORSEO_LABS` (cost) if needed.**
15. Web-search backend default for duplicate-content (Brave vs Firecrawl vs DataForSEO SERP) + per-run budget cap. **Default: Brave/Firecrawl for phrase-dup (cheap); DataForSEO only for structured SERP, opt-in.**

## Analysis
16. Schema validation: maintain our own Rich-Results required-field map (no public Google API) — **yes**; which types in v1? **Default: Article, Product, Organization, BreadcrumbList, FAQPage, Recipe, Event, LocalBusiness, VideoObject, JobPosting.**
17. Accessibility: bundle `axe-core` (MPL-2.0) vs implement WCAG checks ourselves ([research/01](../research/01-modern-technical-seo-checklist.md) open-Q3). **Default: axe-core on the render tier.**
18. Log-file analysis (§18): accept raw Combined Log Format files + (later) Cloudflare/analytics APIs. v3.
19. Recommendation `N`-finding narratives: one Gemini-grounded call per finding *group* (not per finding) — confirm cost posture.

## DataForSEO cost + location policy (decided this session)
- **No automatic bulk enrichment.** A property can have a million keywords; we never fan
  DataForSEO calls across all of them. The only per-property DataForSEO call in a refresh
  is one `historical_rank_overview` (domain-level, the "top view"). Per-keyword data
  (search volume, related terms, SERP) is **on-demand only** — fetched for the keyword the
  user clicks in the dashboard, or an explicit bounded list via `keyword_volume`.
- **Location is per-property.** DataForSEO calls take a `location` (name e.g. "Australia",
  "United Kingdom", or a numeric code), saved on `property_meta` and reused. No more
  hardcoded US — set it once via `track_ranks`/`refresh_property` `location:"Australia"`.
- Open: surface the resolved location on the dashboard; optional bounded "enrich top N
  visible keywords with volume" button (still capped, never the whole site).

## To-dos surfaced during the build
21. **True SERP rank tracking over time** — we have GSC *average position* by date (powers the rank-over-time line), but NOT exact daily SERP rank per keyword. Needs a scheduled DataForSEO SERP snapshot job writing to a `rank_history` table (date, keyword, position). Defer; design after the audit engine. The candlestick keyword chart can run on GSC position in the meantime.

## Phasing (from [tool-surface](tool-surface.md))
20. v1 = GSC sync + async crawl + run_audit/query_audit + dashboards. v2 = web_search + generators. v3 = logs + semantic + SERP-heavy + agentic wrap. Confirm v1 cut.

_Source: consolidated from research/01–14 and plan/architecture + tool-surface + recommendation-engine._
