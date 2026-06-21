# SEO Audit Console — Progress Log (what we want vs what's done)

Single source of truth for the active workstream. `[x]` = shipped + verified + committed; `[~]` = in progress; `[ ]` = wanted, not started. Detailed design lives in `roadmap.md`; this is the checklist.

_Last updated: 2026-06-21_

## Recently shipped (this session)
- [x] **CSV export** → host `downloadFile` capability-gated + **clipboard fallback** + visible toast (`955dbd0`)
- [x] **DataForSEO tools** (live-verified): `search_intent`, `competitors_domain`, `page_intersection`, `page_lighthouse` (`faee4cd`)
- [x] **Backlink layer**: `pull_backlinks` + `backlinks-to-404` + `orphan-no-links` + `seo_audit_help` (`8a509e9`) — _needs DataForSEO Backlinks subscription (40204 until activated)_
- [x] **Gemini "how SEOs audit" conversation** → Phase 6 build plan synthesised (`88df82c`)

## Phase 6 — domain-expert + opportunity engine
Sequence: **6a → 6e → 6b → 6c → 6d**

### 6a — new deterministic findings (`d59e1d1`)
- [x] `ipr-bleed-by-status` (HIGH)
- [x] `broken-canonical-target` (HIGH)
- [x] `broken-hreflang-target` (HIGH)
- [x] `hreflang-no-return-tag` / reciprocation (HIGH)
- [x] `faceted-spider-trap` (HIGH)
- [x] `soft-404-shell` (MED)
- [x] tighten `keyword-cannibalisation` (pos<20 only, exclude pos 1–2 dominance)
- [x] reconcile vs existing (canonical-usurp=`canonical-conflict`, phantom=`ghost-pages`)
- [x] **persistence layer** — `keyword_intent` + `page_cwv` tables; `search_intent`/`page_lighthouse` persist when `siteUrl` passed
- [x] `intent-vs-pagetype-mismatch` (MED, N) — Product/Offer page on informational query (or Article on transactional); gated on `keyword_intent`
- [x] `high-yield-cwv-fail` (MED) — CWV-failing page (LCP>2.5s / CLS>0.1 / perf<50) that earns clicks; gated on `page_cwv`
- _6a COMPLETE — `npm run probe:6a` 8/8 green_

### 6e — unified priority model (Expected Clicks / Dev-Hour)  ✅ DONE
- [x] replaced `(severityW × certainty × log10(traffic))/effort` with `Priority = (T × Y × C) / E`
- [x] T = max(current clicks, impressions × CTR@position); site-wide findings = severity fraction of site clicks; severity floor so zero-GSC findings aren't lost
- [x] Y = yield from category × severity (override via `yieldCoef`); low/info dampened so cosmetics don't ride high-traffic pages
- [x] E = effort hours (effortBase × fixType scale)
- [x] surfaced expected-clicks + hours in the markdown report; `top` now returns `effort`; probe-priority green (recovery 4400 ≫ cosmetic 0.8)

### 6b — per-template source analysis (the N-pages-per-fix lever)  ✅ CORE DONE
- [x] template detection — `src/audit/templates.ts`: URL morphology + JSON-LD @type clustering, N≥4 filter, median-healthy exemplar, `list_templates` tool (probe-templates 9/9). _DOM-skeleton LSH refinement deferred (needs crawl-time structural signature; current signals separate most templates)._
- [x] per-template checks: `pagination-canonical-to-page-1` (HIGH), `article-date-illogical` (MED) — probe-6b 2/2 green
- [~] remaining playbook items deferred (need data we don't capture / judgement): PDP variant-thin + faceted parameter-order duplication (need variant/permutation crawling), home mega-menu dilution (judgement). Faceted indexable trap already covered by `faceted-spider-trap`; PDP Product schema gaps by `missing-required-fields`.

### 6c — new-page opportunity engine (grounded demand, ruthless dedup)  ✅ DONE
- [x] `src/audit/opportunities.ts` + `suggest_pages` tool: demand (GSC impr, rank 11+) → subtract [A rank≤10 · B page covers ≥70% query tokens · C contender page ≤15 owns >80% impr] → lexical cluster → score (impr × intent) → evidence + nearest existing page to link from. probe-6c 7/7 green.
- [~] SERP-overlap clustering + search-volume/intent enrichment = refinement (lexical clustering + persisted intent used for now; intent via `search_intent siteUrl:`)

### 6d — Wikidata entity layer  ✅ CORE DONE (play #1)
Decision: **heuristic H1/title → Wikidata search** resolution (user choice), findings labelled N + gated behind includeJudgement.
- [x] `WikidataClient` (public API, 45-day cache) + `Entities` resolver + `resolve_entities` async tool (`page_entity` + `entity_edge` tables)
- [x] `entity-internal-link-gap` (LOW, N) — Wikidata says two resolved pages' entities are subclass/part-of related but no internal link connects them → suggest one. probe-6d 5/5 (incl. live Wikidata).
- [~] plays #2/#3 deferred (need data we don't store): entity content-gap (competitor page extraction), disambiguation footprints (page body text — we keep word_count, not full text).

## Testing
- [x] **Extended smoke test** (`npm run smoke` / `npm test`) — seeds one realistic property covering every data source, asserts: all ~52 checks run without throwing, ≥30 findings across ≥25 checks with 31 must-fire present, priority finite+sorted, templates ≥2, ≥1 new-page proposal, dashboard builds. _Caught a real bug: 3 JSON-LD checks (article-date-illogical, intent-vs-pagetype, templates.jsonLdType) parsed `json_ld` as objects when the real column is an array of raw strings — fixed via shared `parseJsonLdNodes`._
- [x] Per-feature probes: `probe:6a/6b/6c/6d/templates/priority/dfs-labs/backlinks` (+ schema/extract/crawl/gsc)

## Live QA — simracingcockpit.gg (2026-06-21, post-restart)
- [x] **Recrawl** (522 pages, 0 failed) — unlocked iPR (424 pages) + click_depth → ipr-bleed/deep-pages now fire.
- [x] **Crawl-data QA: 36/36 random samples clean** (`qa:crawl`) — status/title/h1/canonical/noindex/json_ld/word-count all matched live re-fetch; 404/410/image URLs handled correctly.
- [x] **FP #1 fixed — Cloudflare `/cdn-cgi/`** (`15782f9`): email-protection 404 was linked from 445 pages, dominating ipr-bleed at 17,755 iPR. Now skipped at extraction.
- [x] **FP #2 fixed — schema `missing-required-fields` type-level dedup**: WP/RankMath pages carry a complete `@graph` Article + a 2nd partial Article (about/mentions); validator flagged the partial as "missing author/datePublished/image" despite a valid Article existing (would have mis-fired across many of the 229 findings). Now suppresses 'required' for a type when any node of that type is fully complete. Verified: real page → no required issue; probe:schema 15/15 + smoke 9/9 still green.
- _Both fixes apply to the live MCP after the next Desktop restart + recrawl._
- [x] **Verified live after restart+recrawl (521 pages):** `missing-required-fields` 229 → **1** (schema dedup), `ipr-bleed-by-status` now lists only real internal 404s (cdn-cgi gone). Schema-category findings 250 → 49.
- [x] **Scoring fix — query-level findings rank by their own opportunity**: the 40 `keyword-cannibalisation` findings all had identical priority (150.16) because the scorer used a flat site-wide fraction for null-url findings and ignored the per-query impressions in evidence. Engine now uses `evidence.impressions × CTR@bestPos` (or clicks) for null-url findings → they rank by real prize size (e.g. "best vr headset" 54k impr → 718, vs "simhub" 16k → 118). smoke 9/9. _Verified live after restart._
- [x] **Crawler perf — don't download asset bodies.** Known asset file-types (images, media, fonts, archives, office, css/js, pdf) are fetched with **HEAD** (status + content-type + content-length, no body; GET fallback on 405/501); any other non-HTML GET has its body stream **cancelled**. We still record assets (status/type/size from headers) so broken-link checks work, but never pull image/PDF bytes. Robust MIME parsing (text/html + xhtml, split on `;`) replaces substring matching. Verified: images stored 200 + `image/jpeg` + bytes-from-header + indexable 0, HTML extraction intact (445/468 titled).
- [x] **FP #3 — `fix_finding` suggested `/feed/` (RSS) as an internal-link donor.** Root cause: `indexable` was derived from status 200 alone, so non-HTML resources (RSS/images/PDF/text) were marked indexable + linkable. Fix uses the already-logged `content_type`: crawler `indexable` now requires HTML; `missing-title`/`missing-viewport`/`missing-hsts` + the donor query require `content_type LIKE '%html%'`. Verified via fresh crawl: indexable=1 is text/html only (397; images/PDF/feed excluded), donors for /sim-racing-wheels are all relevant sim-racing-* pages. _Applies live after next restart + recrawl._

## Crawl scale / "fast and light" (for big sites without MCP timeout)
- [x] **HEAD-only asset file-types** (images/media/fonts/archives/office/css/js/pdf) — status + size from headers, no body download.
- [x] **Skip-list for junk URLs** — internal site-search (`?sps_query`/`?s=`/`/search-results/`), cart/checkout, `wp-json`/`wp-admin`/`xmlrpc`, comment-reply, page-builder params are never fetched (still recorded as link targets so broken-link checks see them). Configurable per crawl via `excludePatterns` (e.g. `["/author/","/tag/","/page/"]`) to trim archives on large sites. Verified on simracing: 521 → 496 crawled (25 dead `?sps_query` 410s gone), content intact (468 HTML). Leaner crawl → smaller `pages` table → `run_audit` stays under the tool ceiling on big sites.
- [ ] **Non-content flag** (next): treat archive/pagination/author/tag pages as discovery-only — crawl for links but exclude from content findings + link-donors (so they don't pollute the audit). ~101 such pages on simracing.

## Standing TODOs (parked, with design in roadmap.md)
- [ ] **URL Inspection prioritised budget** (404/noindex-first → crawl-validate → pattern redirect advice)
- [ ] **`instant_pages` CSR-hazard check** (deferred DataForSEO endpoint)
- [ ] **Pre-production perf/efficiency `/code-review`** (DFS call consolidation, don't-discard-paid-data, crawl perf + progress, DB indexing)
