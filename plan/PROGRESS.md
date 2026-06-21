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

## Standing TODOs (parked, with design in roadmap.md)
- [ ] **URL Inspection prioritised budget** (404/noindex-first → crawl-validate → pattern redirect advice)
- [ ] **`instant_pages` CSR-hazard check** (deferred DataForSEO endpoint)
- [ ] **Pre-production perf/efficiency `/code-review`** (DFS call consolidation, don't-discard-paid-data, crawl perf + progress, DB indexing)
