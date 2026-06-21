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
- **Delivery / display: SHIPPED** — `get_dashboard` (App UI; tiny result + widget fetches full data via app-only `get_dashboard_data` → renders in-chat, bypasses the model token cap), `export_report` (self-contained shareable HTML), `run_audit` markdown report in chat, live `sync-progress` widget, CSV (host + standalone).
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

---

## Recommended order
**1 → 2 → 4 → 3 → 5**, then 6/7/8 as needed, 9 if a client needs it.
Rationale: the moat (1) first (biggest differentiation, all deps ready); 2 + 4 are cheap, high-confidence check expansions that also feed the moat; 3 banks the most checklist coverage per build; 5 gets it in front of real use. 6–8 are the MED-confidence modules — do after the HIGH-confidence core is solid and live.

## Confidence note
1–5 are HIGH confidence (no unknown deps, data already captured, patterns proven). 6–8 carry one real risk each (browser/CrUX/large-files) — flagged so they're not promised as quick wins. Nothing in 1–5 needs new research; it's all build.
