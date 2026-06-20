---
name: Roadmap — build status + feasibility-checked change sequence
description: Current scoping snapshot (built vs remaining) and the next sequence of changes, each feasibility-checked with a confidence rating, dependencies, and acceptance criteria, ordered by value × confidence.
type: plan
phase: 5
---

# Roadmap — status + the next sequence

## Build status (scoping snapshot)

**Done (shipped + live-verified on houtini.com):**
- Data layer: GSC sync, crawl (stdio-safe), URL Inspection, DataForSEO (located, 20-day cache, on-demand), rank history. All joined on `url_key`.
- Audit engine: 30 scored checks (`P=(S×C×V)/E`), persisted findings (incl. schema-validate + extractor modules).
- **Finding→fix moat (#1 below): SHIPPED** — `src/generators/` + `fix_finding` tool (JSON-LD / 301 rules / internal-link suggestions, dry-run).
- **schema-validate (#2 below): SHIPPED** — `src/audit/schema-validate.ts` (maintained Rich-Results required-field map) + 4 checks.
- **Extractor checks (#4 below): SHIPPED** — extract.ts captures image-alt/canonical-count/canonical-relative + header-charset fallback; 3 checks; idempotent `AuditDatabase.migrate()`.
- Dashboard (MCP App): findings treemap + ranked table, 6 ECharts, page-performance/keyword-movement/device/country report tables, CSV export, host-theme.
- Orchestration: `refresh_property` + granular tools + audit tools. 17 tools.
- Hygiene: secrets gitignored, version-from-package.json, server.json metadata.

**Remaining (this roadmap).** Research is saturated (research/15) — remaining work is *modules + the moat*, not more checks.

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
Optional Playwright pass: render-parity diff (raw vs rendered), the 12 JS/SPA failure modes (research/12). **Risk:** heavy dep, perf, packaging size; opt-in only. **Acceptance:** sampled render + raw-vs-rendered diff findings.

### 8. Log-file analysis — feasibility MED, confidence MED
Ingest Combined Log Format; Googlebot crawl waste, soft-404 cross-ref, orphan-from-bot-view (research/01 §18). **Risk:** large-file handling. **Acceptance:** drop a log → bot-crawl findings.

### 9. Ecommerce vertical — feasibility MED, confidence LOW (scope TBD)
Inventory pages, Merchant Center schema, out-of-stock soft-404, IndexNow (research/15). Niche; scope before building.

---

## Recommended order
**1 → 2 → 4 → 3 → 5**, then 6/7/8 as needed, 9 if a client needs it.
Rationale: the moat (1) first (biggest differentiation, all deps ready); 2 + 4 are cheap, high-confidence check expansions that also feed the moat; 3 banks the most checklist coverage per build; 5 gets it in front of real use. 6–8 are the MED-confidence modules — do after the HIGH-confidence core is solid and live.

## Confidence note
1–5 are HIGH confidence (no unknown deps, data already captured, patterns proven). 6–8 carry one real risk each (browser/CrUX/large-files) — flagged so they're not promised as quick wins. Nothing in 1–5 needs new research; it's all build.
