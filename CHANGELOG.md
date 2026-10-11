# Changelog

All notable changes to **@houtini/seo-audit-console**. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); the check registry is the source of truth
(`list_checks` always returns the live list).

## [0.13.0] — 2026-10-11

### Added - Screaming Frog / Sitebulb parity features (99 → 107 checks)
- **Accessibility audit (static axe-core subset).** A new `accessibility` category of deterministic checks decidable from raw HTML: `a11y-link-name`, `a11y-button-name`, `a11y-form-label`, `a11y-viewport-zoom-disabled`, `a11y-duplicate-id`, `a11y-positive-tabindex` (alongside the existing image-alt, heading-hierarchy and missing-lang signals). Accessible-name aware; submit/reset inputs and labelled fields aren't false-flagged. Findings flow into the dashboard by-category view automatically.
- **Semantic near-duplicate detection.** `find_duplicates` embeds each indexable page's title+body with a local sentence model (all-MiniLM-L6-v2, transformers.js/ONNX, GPU with CPU fallback, no Python, no API cost), flags pairs above a cosine threshold (default 0.9), and persists them; `run_audit` reports `near-duplicate-content` (judgement, gated behind `includeJudgement`). The content-similarity / cannibalisation signal Screaming Frog v22 and Sitebulb surface - done locally.
- **JavaScript render tier (Response vs Render).** `render_pages` renders a bounded, sampled set of pages in headless Chromium and diffs the rendered DOM against the raw HTML, surfacing content and internal links that exist only after JavaScript (`content-only-in-rendered-dom`). Opt-in: Playwright is an optional dependency and the render pass is a separate async job, never part of the normal HTTP crawl; it degrades with a clear install hint when the browser isn't present. Install once with `npm i playwright && npx playwright install chromium`.

### Notes
- Each feature ships with a regression test (`npm run probe:a11y` / `probe:neardup` / `probe:render`) and was live-verified. The render tier and the embedding model are both opt-in / downloaded-on-first-use, so a default install is unchanged in size and behaviour.

## [0.12.2] — 2026-10-11

### Fixed
- **Crawled titles / meta descriptions / H1s now whitespace-normalised.** A multi-line `<title>` in the source (e.g. Shopify's `…2500kg\n – EHI.com.au`) was stored with the embedded newline intact - the title read with a stray gap in reports and its `title_length` over-counted by a character or two (which could tip the >60-char check). Title, meta description and H1 are now collapsed to single spaces and trimmed, the way a browser renders them, so every length / duplicate / keyword-in-title measurement is computed on the clean string.
- **Crawler honours the response charset (decode once).** HTML bodies were read with `res.text()`, which always decodes UTF-8 regardless of the declared charset - correct for a UTF-8 site but mojibake for a page served as ISO-8859-1 / Windows-1252. Bodies are now decoded once via the declared charset (Content-Type → `<meta charset>` → UTF-8 fallback, invalid label → UTF-8), so non-UTF-8 pages no longer corrupt. New regression test: `npm run probe:charset`.
- **Shopify 429 back-off now pauses the whole crawl, not just the one request.** A 429/503 retry backed off only the request that hit it while the other workers kept hammering the rate-limited host, so pages could still be recorded as 429 (56 of them on a recent ehi.com.au crawl, including top content pages). A shared throttle gate now makes every worker respect the cooldown after any 429/503, the retry budget is raised (4 → 6) and `Retry-After` is honoured up to 30s. Only the final status after retries is recorded.

### Notes
- **No data-migration is run, by design.** The mojibake reported against stored titles (`â\x80\x93` for "–") was a *display* artifact of the viewer, not the stored bytes: direct inspection of the crawl database showed the en dash stored correctly as UTF-8 (`E2 80 93`) in 2,099 titles and **zero** Latin-1-mojibake rows. A Latin-1→UTF-8 "repair" would therefore have corrupted correct data. Existing rows are repaired simply by re-crawling (the crawler replaces the `pages` snapshot), which also recovers the pages that had been recorded as 429.

## [0.12.1] — 2026-10-06

### Fixed
- **`domain_visibility` ignored its `months` window.** The tool accepted `months` (1-24) but never translated it to a `date_from`, so the DataForSEO endpoint fell back to its default previous-six-months window - `months: 24` silently returned 6. It now sends `date_from` for the requested window (via a shared `historicalDateFrom` helper, computed in UTC on the first of the month so the cache key is stable, clamped to the 2020-10-01 data floor), reports `requestedMonths` alongside the returned `months`, and adds an honest shortfall note when a young domain or the data floor returns fewer months than asked. Live-verified: `months: 24` → 24 points, `months: 6` → 6.
- **Paid-tool cost/cached now match between text and JSON.** `market_sizing` and `serp_features` reported the spend and cache state in the markdown but omitted both from `structuredContent`; `link_intersect` reported the combined `totalCost` (intersect + any competitor-derivation call) in text but exposed only the intersect cost in JSON, understating the spend when competitors were auto-derived. All three now carry the same facts in both surfaces (`link_intersect` adds an `intersectCost`/`deriveCost` breakdown), matching the shape `keyword_volume`, `topic_trend` and `search_intent` already use.

## [0.12.0] — 2026-10-06

### Added
- **Content architecture (topic clusters)** view on the Opportunities tab: your Search Console demand grouped into topic clusters - a pillar topic with supporting sub-topics - each classified covered / thin / gap, with a coverage score, a funnel read (where `keyword_intent` exists), the concrete gaps, and pillar-to-member internal-link suggestions. GSC-first, grounded in your own demand, no paid calls.

### Fixed
- **Historical rank overview returned only ~6 months.** The DataForSEO `historical_rank_overview` call never sent `date_from`, so the endpoint returned its default previous-six-months window - the rank-history / visibility-over-time chart silently showed only ~6 months. Now sends `date_from` (2020-10-01, the endpoint's earliest data) for the full history. Live-verified: 6 → 72 months.

## [0.11.1] — 2026-10-06

### Added
- `?theme=dark|light` deep-link for the served dashboard, so a shared link or a headless capture opens in the chosen theme.

### Fixed
- Redact mode (`?redact=1`) now fully de-identifies a public screenshot: it also blurs the property name (header + switcher) and the highest-impact-fix slugs, and suppresses the crawl-structure-map node labels (canvas text CSS can't blur).

## [0.11.0] — 2026-10-06

### Added - dashboard redesign + new views
- **Houtini house design language** across the whole dashboard and every chart: Schibsted Grotesk + JetBrains Mono, Houtini green as the one accent, warm paper, flat hairline surfaces, with a house-derived warm dark mode. Re-themed via a token remap, so it flows through every ECharts chart.
- **Crawl-structure map** (Architecture) - a force-directed graph of the internal link skeleton, node size = internal PageRank, coloured by health (green indexable / amber non-indexable / red broken). Drag, scroll-zoom, and click a node to open the page. The equity-vs-reality scatter is now click + zoom too.
- **Site Health Score** on Overview (0-100, banded, honest definition: share of crawled internal pages with no critical/high finding), and **coverage %** per issue in the by-category view.
- **Eight new thematic views**, each built from data already collected and hidden when its data is absent: Security / HTTPS header coverage, Structured-data (JSON-LD @type) coverage, GSC index coverage (URL Inspection), Redirect chains, Core Web Vitals, Hreflang / international, Entity & topic graph (Wikidata), and **AI answerability** (local cross-encoder max-passage score per ranking page - the GEO moat).

### Fixed
- A code-review pass fixed: the Security view read the wrong header key (`referrer` vs `referrerPolicy`, always 0%); the Health Score / coverage % counted findings on non-crawled URLs (understated the score, coverage could exceed 100%); structured-data coverage dropped top-level-array JSON-LD; and the structure-map edge selection was made robust when the iPR threshold is 0.

## [0.10.0] — 2026-09-29

### Added
- **Google Trends category support** (following DataForSEO's Sep 2026 category-only filtering). `topic_trend` now takes keywords, a `categoryCode`, or both:
  - keywords alone search every category (unchanged);
  - keywords + `categoryCode` narrow a term to one industry (e.g. "jaguar" inside Autos);
  - `categoryCode` alone returns interest across a whole market, no keyword needed.
  - `related: true` (at most one keyword) adds the top and rising related topics and queries — with a category on its own, this is how you see what's breaking out across a market.
- **`trend_categories`** (free, **52 tools total**) — searches the Google Trends category tree (~1,400 categories) by name for the codes `topic_trend` takes, each with its parent so you pick the right level.
- Verified against the live DataForSEO API: category-only graphs return one value per point and an empty `keywords` array (the series is labelled `category:<code>`); category + `related` returns breakout topics/queries as percentage rises.

## [0.9.1] — 2026-09-24

### Fixed
- Stripped comments from the published build (`removeComments`) so no source comments ship in the npm tarball.

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
