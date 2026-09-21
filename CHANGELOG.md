# Changelog

All notable changes to **@houtini/seo-audit-console**. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); the check registry is the source of truth
(`list_checks` always returns the live list).

## [0.9.0] — 2026-09-21

### Added
- **Google Discover readiness checks** — 6 new checks (**99 total**) that audit article/news pages for Google Discover, gated so product/listing pages are never flagged:
  - **`discover-max-image-preview`** (flagship) — article pages missing `max-image-preview:large`, the tag that unlocks the large, high-CTR Discover image card. Ships a paste-ready fix.
  - **`discover-missing-og`** — article pages missing `og:title`/`og:image` (Discover builds cards from Open Graph).
  - **`discover-image-schema`** — Article schema that declares no `image`.
  - **`discover-generic-article-type`** — generic `Article` where a more specific `@type` (`NewsArticle`/`LiveBlogPosting`/`ProfilePage`) fits.
  - **`discover-slow-response`** — article response over ~600ms.
  - **`discover-crawl-waste`** — site-level: crawl budget spent on redirects / non-indexable URLs.

### Fixed
- A **Fable 5.1 code audit** of the new cluster caught two evidence-accuracy bugs, fixed before release:
  - Array `@type` handling — `["Article","BlogPosting"]` is no longer misread as generic `Article` (removed 337 false positives on a test site).
  - `discover-image-schema` now requires a real article node (an empty-array `.some()` had flagged pages with no article schema at all).
- Eligibility now treats typed JSON-LD as authoritative over a blanket `og:type=article`, so listing/product pages aren't matched.

### Changed
- `discover-slow-response` labelled judgement (`N`) with an honest `wallTimeMs` note — it's whole-fetch wall time, not a measured TTFB.

### Docs & repo
- Check count corrected to **99**; DataForSEO cache TTL fixed **20→7 days**, Majestic **20→30 days**; dashboard tab count six→eight.
- De-identified the test property across docs, comments and scripts; all 8 dashboard screenshots replaced.
- Source license headers aligned to **Apache-2.0** (matching the LICENSE).

## [0.8.0] — 2026-08-21

### Added
- **Auto-served dashboard** — `refresh_property` and `run_audit` now start the local dashboard server and return its URL, so a populated property always has a one-click browser link.
- **Docker-aware dashboard sidecar** — a separate publishable entrypoint (`seo-audit-dashboard`) that mounts the shared data volume and serves the identical dashboard on a fixed port, for setups where the MCP runs behind the Docker MCP gateway (which can't publish the server container's ports).
- `serve_dashboard` bind is env-configurable (`SAC_DASHBOARD_BIND`/`SAC_DASHBOARD_PORT`/`SAC_DASHBOARD_URL_HOST`); auto-serve is opt-out via `SAC_AUTOSERVE=0`.

### Changed
- Web dashboard call-handlers factored into one shared module used by both the in-MCP server and the sidecar.

## [0.7.8] — 2026-08-17

### Added
- **Link intersect** (`link_intersect`) — one DataForSEO `domain_intersection` call over a competitor set → the domains linking to your rivals but not you, sorted followed-first by domain trust. Optional **Majestic Trust Flow / Topical Trust Flow** re-sort surfaces genuinely on-topic authority and sinks directory noise.
- **Content recon** (`recon_targets` / `save_recon_todo` / `recon_todos`) — pulls the live Google SERP for a losing page, reads whether the **AI Overview** cites you, and returns a verdict (rank-but-not-cited = a freshness/accuracy fix, not a rewrite). Fetches the ranking competitors + video transcripts and writes gaps to a trackable to-do ledger.
- **Content research** — `news_discovery` (free Google News + DataForSEO), `youtube_discovery`, `topic_trend`.
- **Trapped Authority** report — pages the web trusts (referring domains + Majestic Trust Flow) buried deep in your architecture, where the equity never reaches your money pages.
- **Dashboard redesign** — eight tabs, a report hub, a light/dark toggle, and a shareable self-contained HTML export.

### Changed
- Cache TTLs: DataForSEO 7 days, Majestic 30 days. Results persisted to SQLite so repeat lookups are free.

## [0.6.0] — 2026-08-16 and earlier

Foundation of the tool:
- Merges **Google Search Console** history, a **first-party crawl**, and on-demand **DataForSEO** into one prioritised technical-SEO audit inside Claude, joined on a shared URL key.
- The scored **check engine** — findings ranked by expected clicks per developer-hour, with **D/N honesty** (deterministic findings cite the bytes; judgement checks gated behind a flag) and full traceability from recommendation → finding → datapoint.
- **Finding→fix generators** (`fix_finding`) — paste-ready JSON-LD, 301 rules, internal-link suggestions.
- Hand-rolled, stdio-safe crawler seeding discovery from links + sitemap + GSC-known URLs; post-crawl internal PageRank, click-depth and in-degree.
- Incremental GSC sync, change-detection (`detect_changes`), sitemap reconciliation, and the **AI-search layer** — a local cross-encoder passage-scorer (no Python, cannot hallucinate) plus agent-readiness scoring.

[0.9.0]: https://www.npmjs.com/package/@houtini/seo-audit-console/v/0.9.0
[0.8.0]: https://www.npmjs.com/package/@houtini/seo-audit-console/v/0.8.0
[0.7.8]: https://www.npmjs.com/package/@houtini/seo-audit-console/v/0.7.8
[0.6.0]: https://www.npmjs.com/package/@houtini/seo-audit-console/v/0.6.0
