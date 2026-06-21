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

### 6b — per-template source analysis (the N-pages-per-fix lever)  ← IN PROGRESS
- [x] template detection — `src/audit/templates.ts`: URL morphology + JSON-LD @type clustering, N≥4 filter, median-healthy exemplar, `list_templates` tool (probe-templates 9/9). _DOM-skeleton LSH refinement deferred (needs crawl-time structural signature; current signals separate most templates)._
- [ ] per-template playbook checks: faceted, category+pagination, PDP, article, home (each → generator dry-run fix)

### 6c — new-page opportunity engine (grounded demand, ruthless dedup)
- [ ] demand universe → 3-rule subtraction → SERP-overlap clustering → yield score → evidence

### 6d — Wikidata entity layer (skip vanity; keep the 3 that compute)
- [ ] entity-graph internal linking · entity content-gap · disambiguation footprints

## Standing TODOs (parked, with design in roadmap.md)
- [ ] **URL Inspection prioritised budget** (404/noindex-first → crawl-validate → pattern redirect advice)
- [ ] **`instant_pages` CSR-hazard check** (deferred DataForSEO endpoint)
- [ ] **Pre-production perf/efficiency `/code-review`** (DFS call consolidation, don't-discard-paid-data, crawl perf + progress, DB indexing)
