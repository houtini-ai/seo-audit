---
name: Roadmap — build status + feasibility-checked change sequence
description: Current scoping snapshot (built vs remaining) and the next sequence of changes, each feasibility-checked with a confidence rating, dependencies, and acceptance criteria, ordered by value × confidence.
type: plan
phase: 5
---

# Roadmap — status + the next sequence

## Build status (scoping snapshot)

**Done (shipped + live-verified — last updated 2026-06-20):**
- Data layer: GSC sync (**lite default** date×query×page + `segments` opt-in; mode guard), crawl (stdio-safe, **fresh-snapshot per crawl**, no-cache fetch, robots Allow+Disallow), URL Inspection, DataForSEO (located, 20-day cache, on-demand), rank history. All joined on `url_key`.
- Audit engine: **39 scored checks** (`P=(S×C×V)/E`), persisted findings — incl. schema-validate, extractor (CLS/headings/mixed-content/social/canonical), and **merged crawl×GSC** (striking-distance, cannibalisation, ctr-below-expected [impression-weighted], orphan, canonical-conflict, ghost-pages, title-missing-top-query) + **link-graph** (deep-pages, underlinked-high-demand).
- **#1 Finding→fix moat: SHIPPED** — `src/generators/` + `fix_finding` (JSON-LD / 301 rules / iPR-ranked internal-link suggestions, dry-run).
- **#2 schema-validate: SHIPPED** — `src/audit/schema-validate.ts` + 4 checks.
- **#4 Extractor checks: SHIPPED** — + idempotent `AuditDatabase.migrate()`.
- **Internal link-graph (part of #12): SHIPPED** — `src/core/linkGraph.ts` computes iPR (0–100) + body-only click-depth post-crawl.
- **#5 Registered in Claude Desktop: SHIPPED** — live-verified on houtini/ehi/simracing.
- **Delivery / display: SHIPPED** — `get_dashboard` (App UI; tiny result + widget fetches full data via app-only `get_dashboard_data` → renders in-chat, bypasses the model token cap), `export_report` (self-contained shareable HTML), `run_audit` markdown report in chat, live `sync-progress` widget, CSV export (standalone blob; in-host gated on the `downloadFile` host capability with a clipboard fallback + visible toast — current Claude Desktop doesn't advertise `downloadFile`, so `export_report` HTML remains the reliable in-host deliverable).
- Hygiene: secrets gitignored, version-from-package.json, data dir → `~/Documents/seo-audit-console` (`SAC_DATA_DIR` in config / `data_location` tool).

**Remaining (this roadmap):** the rest of the #12 research-gap cluster (backlinks layer ← building now; hreflang; integrity gates; redirect-health; soft-404; perf proxies), then #3 robots-sitemap, #6 CWV, #7 render tier, #8 logs, #10 agent-readiness, #11 chunked sync, #9 ecommerce.

---

## The sequence (ordered by value × confidence)

Each: **feasibility** (is the data/dep ready?), **confidence** (HIGH = no unknowns; MED = one risk), **deps**, **acceptance**.

### 1. Finding → fix generators (the moat) — ✅ SHIPPED (feasibility HIGH, confidence HIGH)
Click a finding / call `fix_finding` → Claude explains the cause and generates the concrete fix.
- **JSON-LD generator** for `missing-structured-data` — `schema-dts`-typed, `safeJsonLd` serialise (validated via context7); dry-run copy block.
- **Redirect-block generator** for `broken-internal-links`/404 — `.htaccess`/nginx/next.config from the broken→suggested map.
- **Internal-link suggestions** for `orphan-with-impressions`/`striking-distance` — donor pages (high in-degree, topically relevant) → the receiver (research/14 money-move).
- **Deps:** findings table, pages/links, schema-dts (installed concept). **Acceptance:** `fix_finding(runId, checkId, urlKey)` returns a validated, paste-ready artifact; never writes silently (dry-run/diff). **This is what makes it replace, not undercut.**

### 2. schema-validate module — ✅ SHIPPED (feasibility HIGH, confidence HIGH)
Validate captured `json_ld` against a maintained Google-Rich-Results required-field map (research/11). Adds checks: invalid-schema, missing-required-fields, markup-vs-visible (N). **Deps:** json_ld already captured. **Acceptance:** per-type validation with cited missing fields; feeds generator #1.

### 3. robots-sitemap module — feasibility HIGH, confidence HIGH
Fetch robots.txt (RFC 9309) + sitemap(s); reconcile vs crawl + GSC. Unlocks a *cluster*: sitemap-present, pages-not-in-sitemap, robots-valid, accidental-disallow, AI-crawler-access (research/04). **Deps:** simple fetch+parse (minimal robots.ts exists). **Acceptance:** 3-way reconcile (sitemap↔crawl↔GSC) + the new checks fire.

### 4. Extractor-dependent checks — ✅ SHIPPED (feasibility HIGH, confidence HIGH)
Extend `extract.ts`: count images-without-alt, resolve relative canonicals to absolute, capture multiple-canonical, charset-from-header. Adds: image-alt, canonical-relative, multiple-canonical. **Deps:** extractor change only. **Acceptance:** new checks fire; re-crawl populates.

### 5. Register in Claude Desktop + live App verify — feasibility HIGH, confidence HIGH
Add the config entry (creds env), restart, run `refresh_property` → `get_dashboard`, confirm the App renders + theme + CSV download in-host. **Deps:** none. **Acceptance:** dashboard renders live; one cold-path bug-bash.

### 6. CWV ingestion — feasibility MED, confidence MED
Field via CrUX API (free) + GSC Page-Experience; lab proxies from crawl (TTFB/render-blocking/asset sizes — partly captured). Full lab (LCP/CLS) needs the render tier (#7). **Risk:** lab needs a browser. **Acceptance:** field CWV + cheap proxies surface; radar chart (#9).

### 7. Render / JS-SEO tier — feasibility MED, confidence MED
Optional render pass: render-parity diff (raw vs rendered), the 12 JS/SPA failure modes (research/12). **Risk:** heavy dep, perf, packaging size; opt-in only. **Acceptance:** sampled render + raw-vs-rendered diff findings.
**Decision (2026-06-20):** additive bolt-on, NOT surgery — the default HTTP crawler stays; a render tier re-fetches a *sample* through a browser and writes the already-present `pages.rendered` / `pages.render_diff` columns. **Backend: Playwright (Node)** over Puppeteer (auto-wait is essential for "did content appear after JS settled"; multi-engine). Alternative considered: crawl4ai as an opt-in Docker REST service (richer: markdown/screenshot/JS-exec, fully decoupled, but Python + user-run container) — keep as fallback if we want screenshots/PDF without bundling Chromium. Gate behind an env flag; degrade gracefully when absent (same pattern as DataForSEO creds). NB: crawl4ai's *HTML-derivable* extras were already absorbed into the HTTP crawler (CLS/headings/mixed-content/rel/social/microdata) — the render tier is only for genuinely JS-dependent data.

### 8. Log-file analysis — feasibility MED, confidence MED
Ingest Combined Log Format; Googlebot crawl waste, soft-404 cross-ref, orphan-from-bot-view (research/01 §18). **Risk:** large-file handling. **Acceptance:** drop a log → bot-crawl findings.

### 9. Ecommerce vertical — feasibility MED, confidence LOW (scope TBD)
Inventory pages, Merchant Center schema, out-of-stock soft-404, IndexNow (research/15). Niche; scope before building.

### 10. Agent-readiness checks — feasibility HIGH, confidence MED (FUTURE TODO, added 2026-06-20)
Expand the existing `agentic` category to mirror what **isitagentready.com** (Cloudflare) scans — most are HTTP-derivable (no JS), so they fit our crawler. Grounded in research/04 + the live check list:
- **Discoverability:** robots.txt present + valid, sitemap directive, `Link:` response headers, DNS-AID (DNS for AI discovery).
- **Content accessibility:** **Markdown content negotiation** — request a page with `Accept: text/markdown` and check the server returns markdown (Cloudflare "markdown for agents" — the user's example). Also `llms.txt` / `llms-full.txt` presence.
- **Bot access control:** explicit AI-bot rules in robots.txt (GPTBot, ClaudeBot, Google-Extended, etc.), Cloudflare **Content Signals**, **Web Bot Auth**.
- **Protocol discovery (.well-known / files):** MCP Server Card, A2A Agent Card, **Agent Skills**, WebMCP, **API Catalog** (RFC 9727), **OAuth discovery** (RFC 8414), **OAuth Protected Resource** (RFC 9728), `auth.md`.
- **Agentic commerce:** x402, MPP, UCP, ACP (presence/discovery only).
- **Implementation:** a small fetch pass for well-known paths + an `Accept: text/markdown` probe on a sample page; each maps to a deterministic `agentic` check. **Acceptance:** robots-AI-rules, markdown-negotiation, llms-txt, and the .well-known discovery checks fire. Note: many of these are emerging standards — gate the speculative ones (commerce) behind a flag and cite the spec per finding.
- Source: isitagentready.com (Cloudflare), https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/, research/04.

### 11. Chunked / resumable GSC sync (first-sync durability) — feasibility HIGH, confidence HIGH (FUTURE TODO, added 2026-06-20)
The first sync of a large property is one long, fragile job. **Evidence:** simracingcockpit = 1.8M rows / ~40 min, and an earlier run was wiped by a mid-sync restart, forcing a full re-fetch. The API already paginates within a request (25k rows / `startRow`), but the *job* isn't durable or resumable.
- **Idea:** chunk the export by date window (e.g. per-week, or per-day for huge sites), commit each chunk, and record completed chunks in a small `sync_chunks` table (property, dimensions-shape, date-range, status). A re-run resumes from the first incomplete chunk instead of starting over.
- **Benefits:** survives restarts/crashes/timeouts; accurate chunk-level progress for the sync widget (done/total chunks instead of an open-ended row counter); optional bounded concurrency across chunks (watch GSC quota). Pairs with the lite-sync default already shipped.
- **Acceptance:** kill a sync mid-way → re-run resumes and converges to the same row count; progress widget shows N/total chunks.
- **Note:** for extreme sites, GSC also offers **Bulk Data Export to BigQuery** — out of scope, but the escape hatch for million-row corpora.

### 12. Research-gap cluster (from the 2026-06-20 review) — mostly derivable from data we ALREADY capture
A full research-vs-implementation audit found high-value checks specified in the research but not built — and notably, several read columns the crawler already fills (`links`, `hreflang`, `redirects`, `rel_next/prev`, `x_robots_tag`, `response_time_ms`, `bytes`, `content_encoding`). Highest-leverage first:
- **Link-graph cluster (research/14) — HIGH, the most under-built differentiator.** All derivable from the existing `links` table, none built:
  - **Internal PageRank (iPR)** — the `pages.ipr` column + index exist but are never computed; run power-iteration (d=0.85, nav/footer×0.2, log-normalise 0–100) post-crawl. Feeds the donor→receiver "money-move" link engine + the `iPR>80 & clicks<10` waste check.
  - **Click-depth (BFS, body-only pass excluding nav/footer)** — flag pages ≥4 clicks deep. `pages.depth` is discovery-order, not shortest-path.
  - **Anchor-text concentration** — over-optimised (`top_anchor>60% & inlinks>10`) + weak ("click here"/empty/image-only), `GROUP BY target_key` over `links`.
- **hreflang validation (research/01 §10) — HIGH.** `pages.hreflang` is captured but **zero checks consume it**: self-reference, bidirectional reciprocity, x-default present, ISO 639/3166 code validity.
- **Crawl-integrity gates (research/06) — HIGH (honesty contract).** `audit_runs.integrity_ok` is currently FAKED from `pageCount>0` (engine.ts) — no real parity checks. Add a sampled re-fetch/diff (status/header/body, G1–G3) and surface "⚠ integrity not verified" when gates fail. This underpins the credibility of every finding.
- **Redirect-target health (research/02 W5/W7/W8) — MED/HIGH.** `redirect-chain` only counts hops; add redirect loops, redirect→4xx/5xx final target, and `<meta http-equiv=refresh>` (one-line extract.ts add).
- **War-story no-new-request subset (research/02) — MED/HIGH.** W1 (X-Robots-Tag header `noindex` contradicting on-page meta — both already stored), W9 (canonical to #fragment), W10 (bad Content-Type) — all checkable with zero extra requests.
- **GSC×crawl anti-joins (research/05 D3/D4) — MED/HIGH, derivable now.** Ghost pages (GSC-known, missing from crawl) + crawled-but-never-in-GSC, a cheap subset of the #3 sitemap module pulled forward.
- **Soft-404 (HTTP slice) (research/01 #47) — HIGH.** 200 + thin body + "not found" text + no canonical (SPA soft-404 needs the render tier #7).
- **Cheap perf proxies (research/13 Layer A) — MED.** TTFB>800ms, oversized HTML/assets, missing brotli/gzip, render-blocking sync scripts — from `response_time_ms`/`bytes`/`content_encoding` (+ small extract add). Distinct from the CrUX field-data work (#6).
- **Snippet checks A2/A3 (research/05) — MED.** Title/meta missing the page's top-impression query; traffic-weighted.
- **Pagination canonical (research/02 W4) — MED.** `rel_next` set AND canonical points to a non-self page-1 URL → deep items deindexed.
- **Index hygiene D2/near-dup B2 — MED.** Indexed-but-thin/zero-click; confirm cannibalisation via title/H1/word overlap to cut false positives.

### Delivery / display work (the "make it visible + shareable" track — agreed 2026-06-20)
Settled by investigation: MCP-App widgets don't render in current Claude Desktop (host doesn't advertise `io.modelcontextprotocol/ui`; both this server and better-search-console register identically — no workaround). Gzip can't help (no resource encoding field; the token cap is about model-facing text, not bytes). So:
- **`export_report siteUrl`** — write the self-contained dashboard HTML (data inlined) to `…/reports/<site>.html`, return the path. The shareable, white-label agency deliverable; renders in any browser today. (Future: optional upload → shareable link.)
- **Markdown audit report** in `run_audit`'s `content` text — a concise executive summary (top crit/high by category + examples), NOT all rows, so it renders in chat and Claude can discuss it without blowing context. Exhaustive data stays in the HTML.
- **Trim `get_dashboard`** — `findings.top` is 50% of the 73k payload (double-encoded JSON strings); cut top 50→25 + store evidence/recommendation as real objects ≈ halves it; add `getUiCapability` graceful-degradation.
- **Template library + chunked reports** — split the monolith into small focused report tools (`get_trend`/`get_top_pages`/`get_summary`…) each targeting a tiny branded template; a `list_templates` discovery tool (id + when-to-use + dataShape) so the assistant picks the right template (or a branded blank) and injects data via `structuredContent`/inlined JSON. Templates share `tokens.css`; reuse the Vite multi-entry build. This also fixes the token-cap problem as a side effect.

### Phase 6 — Domain-expert + opportunity engine (build plan, Gemini conversation DONE 2026-06-21)
The gating Gemini "how an SEO actually audits a site" conversation is **complete** (3 grounded calls: audit mental model + missing findings; per-template analysis; opportunity engine + entity layer + unified priority). The build list below is the synthesis. Core insight to carry through everything: **the crawl is *intent*; GSC + DataForSEO are *reality* — every high-value finding lives where they diverge.** Ordered by value × confidence.

#### 6a. New deterministic findings (highest value, lowest effort — all computable from data we already store)
The "expert questions" a flat checklist misses. Add to `checks.ts`; keep the false-positive discipline (a wrong finding is worse than none).
**STATUS 2026-06-21:** reconciled the 10 against existing checks, then shipped the genuinely-new ones (probe `npm run probe:6a`: 6/6 green with evidence). **Already existed:** #1 canonical-usurp = `canonical-conflict`; #3 phantom-traffic-bearer = `ghost-pages`; #2 query-cannibalisation = `keyword-cannibalisation` (now **tightened** per the conversation: count only impression-weighted pos<20 URLs, exclude pos 1–2 dominance). **✅ SHIPPED new:** #4 `ipr-bleed-by-status`, #5 `broken-canonical-target` + `broken-hreflang-target`, #6 `hreflang-no-return-tag`, #7 `faceted-spider-trap`, #8 `soft-404-shell`. **✅ SHIPPED (persistence layer 2026-06-21):** added `keyword_intent` + `page_cwv` tables; `search_intent`/`page_lighthouse` persist when passed `siteUrl`; #9 `intent-vs-pagetype-mismatch` (gated on `keyword_intent`; N/0.7 — runs with includeJudgement) and #10 `high-yield-cwv-fail` (gated on `page_cwv`) now live. **6a COMPLETE** — `npm run probe:6a` 8/8 green. NOTE several 6a checks need URL Inspection populated (canonical-conflict, soft-404-shell) — pairs with the URL-Inspection-budget TODO.
1. **canonical-usurp (CRIT)** — `user_canonical != google_canonical` (crawl canonical vs URL-Inspection google-canonical). Google distrusts our canonical logic; usually internal links point at the non-canonical. *Needs URL Inspection populated.*
2. **query-cannibalisation (HIGH)** — GSC: queries where `COUNT(DISTINCT page WHERE position<20) > 1 AND impressions > threshold`; exclude where the two URLs hold pos 1–2 (dominance is fine). Splitting our own equity.
3. **phantom-traffic-bearer (CRIT)** — GSC URLs with `clicks>0` that are **absent from the crawl** (the inverse of ghost-pages). Money pages users can't navigate to (dropped category, legacy URL, broken nav).
4. **ipr-bleed-by-status (HIGH)** — sum the **iPR of source pages** linking to each non-200 target; rank wasted-equity targets. (Upgrades "found a 404" → "this 404 drains 15% of homepage equity.")
5. **broken-canonical/hreflang-target (HIGH)** — canonical/hreflang `target_url` joined back to crawl is non-200 or `noindex`. Invalidates the directive.
6. **hreflang-reciprocation (HIGH)** — A→B hreflang without B→A return tag (self-join on hreflang targets). Google ignores non-reciprocated hreflang.
7. **faceted-spider-trap (HIGH)** — indexable multi-parameter URLs (`>1 query param`) with zero GSC impressions; group by parameter keys to name the offending facet. Index bloat / crawl-budget burn.
8. **soft-404-shell (MED)** — URL-Inspection `pageFetchState=SOFT_404` AND crawl `status=200` (+ thin `bytes`/word-count). Crawler says fine, Google says trash. *(Was research-cluster #12 — promoted.)*
9. **intent-vs-pagetype-mismatch (MED, strategic)** — join GSC top query → `search_intent` → crawl schema `@type`; flag `@type∈{Product,Offer}` ranking for informational intent (or Article for transactional). Consumes the shipped `search_intent` tool.
10. **high-yield-cwv-fail (MED)** — top-decile-by-clicks URLs whose `page_lighthouse` CWV fails. Aims expensive dev hours at the URLs with ROI. Consumes the shipped `page_lighthouse` tool.

#### 6b. Per-template source analysis (the N-pages-per-fix lever) — ✅ CORE SHIPPED 2026-06-21
`src/audit/templates.ts` clusters pages by URL morphology + JSON-LD @type (N≥4, median-healthy exemplar); `list_templates` tool. Per-template checks: `pagination-canonical-to-page-1`, `article-date-illogical` (probe-6b green). Deferred playbook items (data we don't capture / judgement): PDP variant-thin + faceted parameter-order duplication (need variant/permutation crawling), home mega-menu dilution (judgement); DOM-skeleton LSH refinement (needs crawl-time structural signature). Note overlaps already covered: faceted indexable trap → `faceted-spider-trap`; PDP Product schema gaps → `missing-required-fields`.
Original spec:
- **Template detection — tripartite composite key (CMS-agnostic):** (1) **URL morphology** — path tokens with numerics→`[NUM]`, slugs→`[SLUG]`, keep query-param *keys* not values; (2) **JSON-LD root `@type`** (else `None`); (3) **DOM-skeleton hash** — strip text/scripts/styles, keep block-tag sequence + structural ids/classes, **MinHash/LSH** for ≥95% structural match. Cluster on all three. **Filter:** clusters with `N<4` → singletons (home/about), per-URL not per-template. **Exemplar:** the **median-DOM-byte-size** 200/indexable/≥1-inlink page (not the first crawled).
- **Per-template playbook (each pairs with the generator moat → dry-run fix artifact):**
  - *Faceted/filter:* multi-param URL indexable + self-canonical (should be `noindex,follow`); parameter-order duplication (`?a=1&b=2` vs `?b=2&a=1`). Fix: robots disallow pattern + meta-robots payload.
  - *Category/collection + pagination:* **page-2+ canonical pointing to page 1** (drops deep products from crawl); grid links with trailing-slash mismatch → systemic 301 per click. Fix: self-referencing paginated canonical.
  - *Product (PDP):* variant URL self-canonical but identical title/h1 to base; `Product` missing `offers`/`price`/`priceCurrency`; `aggregateRating` missing `reviewCount`/`ratingValue`. Fix: merged dry-run JSON-LD patch from scraped DOM.
  - *Article:* `dateModified < datePublished` (impossible) or DOM-visible date vs schema date drift >24h; `author` as a bare string not a `Person` entity. Fix: entity-author JSON-LD snippet.
  - *Home (N=1, governs PageRank flow):* mega-menu dilution (links to >50% of all URLs) or JS-hidden nav (links to <1%). Fix: HTML list of top category pages missing from the home DOM.

#### 6c. New-page opportunity engine (grounded in real demand, ruthless dedup) — ✅ SHIPPED 2026-06-21
`src/audit/opportunities.ts` + `suggest_pages` tool, computable from stored GSC + crawl (no paid calls). Demand = GSC queries with impressions ≥ min and best rank > 10; subtract A (we rank ≤10), B (an existing page's title/h1/slug covers ≥70% of the query's tokens), C (one contender page ranking ≤15 owns >80% of impressions → optimise it); cluster survivors by token Jaccard; score impressions × intent (from persisted `keyword_intent`, default 0.5); evidence includes member queries, current best position, and the nearest existing page to internal-link the new page from. probe-6c 7/7. Refinements (SERP-overlap clustering, volume/achievability) layer on with DataForSEO later.
Original spec:
Pipeline: **(1) Demand universe** — GSC queries with `impressions>X AND avg_position≥11` + competitor `page_intersection` gaps, enriched with `search_volume` + `search_intent` (drop navigational). **(2) Subtraction (the part that usually ships garbage):** drop a query if (A) any of our URLs ranks ≤10 for it; (B) lemmatised token overlap vs our crawled `title`/`h1`/`slug` ≥70% (page exists → it's an *optimisation*, not a new page); (C) one URL takes >80% of the query's impressions (→ that URL's optimisation queue). **(3) Cluster by SERP overlap, NOT NLP** — two surviving queries share a cluster if their top-10 ranking URLs overlap by ≥4 (Google's SERP is the truth; "cheap" vs "luxury flights" cluster apart). Head term = highest-SV query. **(4) Score** `cluster_SV × intent_mult (txn 1.0 / comm 0.8 / info 0.3) × achievability (our domain strength vs ranking-URL median)`. **(5) Evidence** — proposed H1, cluster SV, secondary queries, top-3 competitor proof, and existing pos-11+ URLs to **internal-link the new page from**.

#### 6d. Wikidata entity layer (skip the vanity, keep the 3 that compute) — ✅ CORE SHIPPED 2026-06-21
Decision: heuristic H1/title → Wikidata search resolution (findings N/judgement, gated behind includeJudgement). `WikidataClient` (public API, 45-day cache) + `Entities` resolver + `resolve_entities` async tool (`page_entity` + `entity_edge` P279/P361 tables). Play #1 shipped: `entity-internal-link-gap` (subclass/part-of related pages with no internal link → suggest one). probe-6d 5/5 incl. live Wikidata. Plays #2 (entity content-gap) and #3 (disambiguation footprints) deferred — need competitor-page extraction / page body text we don't store (we keep word_count, not full text).
Original spec:
A bare `sameAs` QID is mostly vanity (Google extracts entities from DOM text, not hidden JSON-LD). Real, computable value: **(1) entity-graph internal linking** — resolve pages → QIDs; where Wikidata says `Q_b subclass/part-of Q_a` (P279/P361) but no internal link A→B exists, suggest it (a mathematically-grounded topical mesh); **(2) entity content-gap** — entity-extract top-3 competitor pages → QIDs; entities all competitors mention that our page's text lacks = missing entity (survives synonyms, beats TF-IDF); **(3) disambiguation footprints** — for a page's `about` QID, pull deterministic Wikidata facts (P571 inception, P112 founder, …); if absent from the page's `<p>` text, suggest adding them. Source: `C:\MCP\wikidata`.

#### 6e. Unified priority model — switch to Expected Clicks / Dev-Hour (yield, not points) — ✅ SHIPPED 2026-06-21
Implemented in `engine.ts`: `Priority = (T × Y × C) / E`. T = max(current clicks, impressions × CTR@position) per URL; site-wide findings = severity fraction of total site clicks; a severity floor keeps zero-GSC findings (e.g. backlinks-to-404) from collapsing to 0. Y derived from category × severity (low/info dampened so cosmetics don't ride high-traffic pages), overridable per check via `yieldCoef`. E = effort hours. Report + `top` now expose `expectedClicks`/`hours`/`yield`. Verified by `npm run probe:priority` (noindex-recovery 4400 ≫ cosmetic title-length 0.8). The new-page branch (`cluster_SV × CTR@pos3`) wires in with 6c.
Original spec:
Replace the abstract `(severityWeight × certainty × log10(trafficValue)) / effort` with a yield model that makes a 5,000-page template fix, a single critical canonical bug, and a 10k-search new page directly comparable: **`Priority = (T × Y × C) / E`** where **T** = traffic baseline (existing: SUM last-30d GSC clicks of *affected URLs only*; new page: `cluster_SV × CTR@pos3`); **Y** = yield coefficient (critical blocker recovery ~0.9, new content 1.0, template tweak ~0.05); **C** = certainty (technical fix 1.0, new content 0.5); **E** = effort in **hours** (global template fix ~4h covers N pages, single URL bug ~1h, new page ~8h). This stops page-count from auto-winning: a 5k-page H1 tweak at 5% yield on low-traffic pages correctly sinks below a homepage canonical bug. Report sorts top-down by this single number.

#### Sequencing within Phase 6
**6a first** (cheap, deterministic, immediate audit-value uplift; some items just need URL Inspection populated — pairs with the URL-Inspection-budget TODO below). Then **6e** (re-rank everything on yield — small change, big clarity). Then **6b** (template engine — the biggest multiplier, most build). Then **6c** (opportunity engine). **6d** last (entity layer — highest effort, needs the Wikidata MCP + entity extraction).

### URL Inspection — prioritised budget strategy (TODO, user direction 2026-06-21)
The URL Inspection API cap is **2,000/day, 600/min per property** — too scarce to inspect everything. So spend it on URLs with **severe SEO implications first**, accumulate results in `url_inspection` over time, then **validate by crawling those URLs ourselves** to build **real, pattern-based redirect advice** (feeds the existing 301 redirect-rules generator).
- **Priority queue (highest → lowest):** (1) URLs our crawl already flags 4xx/5xx with internal/external links pointing at them; (2) URLs Google may still index but we serve `noindex` (indexable-intent vs `noindex` conflict); (3) canonical conflicts (google vs user canonical); (4) high-impression GSC pages with coverage anomalies; (5) a rolling **sample** of the rest so coverage broadens over time.
- **Accumulate, don't re-inspect:** skip URLs inspected within N days (the `lastCrawlTime`/`fetched_at` already stored); spread the daily budget so a large property converges over a week.
- **Validate → pattern:** re-crawl the flagged URLs ourselves, cluster by URL pattern (path prefix, template), and emit redirect advice at the **pattern** level (e.g. "all `/old-blog/*` → `/blog/*`") rather than one-off rules. Deterministic, evidence-backed.

### DataForSEO v3 endpoint expansion — Gemini API sweep (2026-06-21)
**✅ SHIPPED 2026-06-21 (live-verified on simracingcockpit.gg):** `search_intent`, `competitors_domain`, `page_intersection`, `page_lighthouse` tools (client methods + result shaping). Live-test corrections folded in: `page_intersection` rejects `order_by` (sort client-side) and nests data under `items[].keyword_data.{keyword,keyword_info}` (docs were simplified); `competitors_domain` returns the target itself (filtered out). `page_lighthouse` uses a 120s timeout (Lighthouse renders). Probe: `npm run probe:dfs-labs <domain>`. **Still TODO:** the auto-*findings* that consume these (intent-mismatch check, auto content-gap) — they need page-type/template detection (Phase 6) to know which queries/pages to compare; the on-demand tools land first.

Ranked from a skeptical sweep of the full v3 surface vs what we already have (crawl + GSC + SERP + volume + backlinks). **Keep on-demand + cached; never bulk.** Adopt in this order:
1. **`on_page/instant_pages` fired twice (`enable_javascript:false` vs `true`)** — DOM diff = the CSR-hazard finding (canonical/schema/internal-links present only after JS). **Deterministic.** Cheap headless-render validation (~100 / ~500 credits) — a lighter path to the render tier (#7) than bundling a browser. **→ TODO (deferred, user direction 2026-06-21): build the `instant_pages` CSR-hazard check later.**
2. **`on_page/lighthouse/live`** — per-URL **lab** CWV (LCP/CLS/render-blocking) on demand; complements CrUX field data in #6 (which is aggregate + delayed). ~2000 credits. Powers concrete CWV fixes per page.
3. **`dataforseo_labs/google/search_intent/live`** — query intent (info/nav/commercial/transactional) → explains the GSC symptom "high impressions, low CTR, stuck at 11–20" as **intent mismatch** (e.g. product page ranking for an informational query). N (judgement). ~50 credits. Feeds Phase 6 new-page suggestions.
4. **`dataforseo_labs/google/page_intersection/live`** — per-URL topic/entity gap vs top-3 competitors (seed competitors from our existing SERP call). "Add a section on X to URL Y." N. ~50 credits. Pairs with per-template analysis + the moat.
5. **`dataforseo_labs/google/competitors_domain/live`** — domain-level competitor discovery (seed list for gap analysis). ~50 credits.
6. **`merchant/google/products/live`** *(ecommerce vertical #9 only)* — validates how Google parsed product schema/feed (price/availability mismatch). ~100 credits.

**Skip (confirmed vanity/redundant — do NOT add):** `bulk_keyword_difficulty` (KD is a black-box estimate — derive our own from live SERP + backlink counts we already have); `ranked_keywords` for the *first-party* domain (GSC is ground truth — only use for competitors); `relevant_pages` for cannibalisation (GSC `page`-grouped by query is superior); `content_parsing` readability (Flesch/keyword-density are non-signals — intent + topical coverage already cover content quality).

---

## Pre-production review — performance & efficiency (TODO, user direction 2026-06-21)
**When the feature set is compiled and close to production, run `/code-review` with a performance/efficiency focus** (not just correctness). Specific lenses the user called out:
- **DataForSEO call consolidation** — can we batch calls to cut cost? (e.g. `searchVolume`/`searchIntent` accept up to 700–1000 keywords/call — are we ever looping single keywords where one array call would do? Can SERP/Labs requests for the same property share a task array?)
- **Are we discarding data we already paid for?** Each DataForSEO response carries far more than we parse (e.g. SERP `advanced` returns PAA + related + features; `keyword_info` carries `monthly_searches`, trend, CPC bands; Lighthouse returns every audit). Capture the useful extras at first fetch so we don't pay for a second call to get them. Audit each `*.tasks[0].result` mapping for dropped fields.
- **Crawl performance + progress indicator** — is the crawler concurrency/back-pressure sound? Is the `sync-progress` widget reporting crawl phases accurately? Are we capturing everything insightful from each fetch (timing, headers, redirect chain, bytes, encoding, hreflang, structured data) or silently dropping signal we'd otherwise re-crawl for?
- **Database indexing discipline** — does every hot query path (joins on `url_key`/`page_key`, `crawl_id` scoping, findings/ranking lookups, `page_backlinks`) have a covering index? Check for full-table scans on the big tables (`search_analytics`, `pages`, `links`). Confirm WAL + prepared-statement + transaction-batch usage is consistent.

Output: a prioritised list of cost/perf wins (cheap → expensive), then implement the high-value ones before publish.

## Recommended order
**1 → 2 → 4 → 3 → 5**, then 6/7/8 as needed, 9 if a client needs it.
Rationale: the moat (1) first (biggest differentiation, all deps ready); 2 + 4 are cheap, high-confidence check expansions that also feed the moat; 3 banks the most checklist coverage per build; 5 gets it in front of real use. 6–8 are the MED-confidence modules — do after the HIGH-confidence core is solid and live.

## Confidence note
1–5 are HIGH confidence (no unknown deps, data already captured, patterns proven). 6–8 carry one real risk each (browser/CrUX/large-files) — flagged so they're not promised as quick wins. Nothing in 1–5 needs new research; it's all build.
