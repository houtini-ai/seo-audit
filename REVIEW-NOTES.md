# Review notes: seo-audit-console (master @ 619e403)

A code review of the whole repository against the brief: components and the data pipeline, scrapers and fetchers, the 143 checks, the accuracy of the numbers, dashboard interactivity and web security, docs against code, and the model-facing context. Each fixed defect has its own PR with a regression test. This file lists what was **not** fixed, what needs real data to confirm, the tool-context measurements and the order to merge.

Ground rules kept:
- No paid or credentialed calls. No GSC, DataForSEO, Majestic or CrUX requests.
- No crawl of a third-party site. Every crawler and fetcher test ran against local servers on 127.0.0.1, with synthetic SQLite databases and `scripts/demo-property.mjs` (the fictional `larchmere.example`).

One disclosure: during the web-security review, one test call to `news_discovery` made **a single request to the free, keyless Google News RSS endpoint**. No paid API was involved, and the call was removed from that test script.

## 1. The PRs, in the order to merge them

| # | PR | Theme | Severity |
|---|---|---|---|
| 1 | houtini-ai/seo-audit#91 | test: restore `scripts/probe-web-unified.mjs`. `npm test` fails on a clean clone of master without it | blocker (test) |
| 2 | houtini-ai/seo-audit#89 | fix: the crawler checks every redirect hop **before** requesting it. It followed redirects to any host (SSRF) and into robots-disallowed paths | high (security) |
| 3 | houtini-ai/seo-audit#98 | fix: robots.txt per RFC 9309: `*` / `$`, path + query, product-token UA match, unreachable = disallow, site probes obey it. **Stacked on #89** | high |
| 4 | houtini-ai/seo-audit#92 | fix: dashboard web security. Paid DataForSEO calls were reachable from the browser; `SAC_DASHBOARD_PORT` adopted any service; plus Origin check, framing, prototype lookup, queued duplicates, worker fan-out. **Stacked on #91** | high (security, money) |
| 5 | houtini-ai/seo-audit#95 | fix: a Search Console sync that stops part-way writes nothing. It left days truncated for good, or wiped history | critical (data) |
| 6 | houtini-ai/seo-audit#90 | fix: response bodies are read with a size cap. A 50 MB page crashed the process | high (availability) |
| 7 | houtini-ai/seo-audit#96 | fix: a Domain property never shares a URL-prefix property's legacy file. `delete-property` could delete the other property's database | high (data) |
| 8 | houtini-ai/seo-audit#107 | fix: one collection job per property at a time, in-process too (two crawls corrupted each other's pages) | high (data) |
| 9 | houtini-ai/seo-audit#88 | fix: the dashboard and `list_findings` read the latest **completed** audit. A failed or running audit showed health 100 | high (numbers) |
| 10 | houtini-ai/seo-audit#87 | fix: average position is weighted by impressions on the dashboard (a plain mean said 26 for a true 2.05) | high (numbers) |
| 11 | houtini-ai/seo-audit#106 | fix: a finding's payoff is the page's real clicks, not the CTR curve (was overstated up to 75x) | high (numbers) |
| 12 | houtini-ai/seo-audit#94 | fix: a prior period that isn't held is missing, not zero or partial ("up from none", "+133%", "+300% YoY") | high (numbers) |
| 13 | houtini-ai/seo-audit#93 | fix: default audits run every deterministic check. Three D checks were silently gated | medium-high (rules) |
| 14 | houtini-ai/seo-audit#99 | fix: the health score counts pages past the per-check findings cap (58 for a true 0) | high (numbers) |
| 15 | houtini-ai/seo-audit#100 | fix: `position-slipping` compares the same page with a real baseline (false "high" findings) | high (rules) |
| 16 | houtini-ai/seo-audit#97 | fix: a CDN's `server` header is not a bot wall. Cloudflare rate limits triggered Chrome and stored 429 | high (fetchers) |
| 17 | houtini-ai/seo-audit#101 | fix: SSRF guards for third-party URLs (competitor fetch, outbound links), `probe_urls` and `render_pages` | medium (security) |
| 18 | houtini-ai/seo-audit#108 | chore(deps): drop the googleapis meta-package, zod 4, slim the install (862->588 MB), Node 22; 6 npm-audit findings to 0 | deps |
| 19 | houtini-ai/seo-audit#103 | fix: the model can find setup problems and help on its own (setup status in the instructions, `seo_audit_help`, open `dashboardUrl` in a built-in browser, cost and accuracy fixes in tool text) | model context |
| 20 | houtini-ai/seo-audit#102 | docs: README, manual and labels match the code. **Folds in #80; close #80 after merging** | docs |
| 21 | houtini-ai/seo-audit#105 | docs: document the review fixes and remove stale setup steps (npx-first getting started, the new behaviour in tools.md / dashboard.md / README, CHANGELOG, Node 22). **Stacked on #102** | docs |
| 22 | this PR | REVIEW-NOTES.md and four screenshots | - |

**How each PR was checked:**
- `npm ci` once on master.
- The full `npm run build` (server and UI) on every review branch.
- `npm run build:server` and each `npm test` step, run individually, on every branch. Every step passes except `probe:web` until #91 lands.
- Each PR body states which of its new assertions fail against master's `src`.

**Merged together:** all 22 review branches, plus this one, merge into master **cleanly, in the order above**. I checked this; a few branches got small follow-up commits to move their edits off lines another PR changes. With the 22 code/docs/deps PRs merged:
- `npm ci` and `npm run build` pass;
- **the full `npm test` exits 0, with 1,038 assertions passing and none failing**;
- `npm audit --omit=dev` reports **0 vulnerabilities**;
- the browser QA in section 5 gives the same results.

**Stacked PRs:** #98 is stacked on #89, #92 on #91, and #105 on #102 — merge each pair in order. #106, #107 and #108 branch from master and are independent.

**PR #80:** its non-`server.ts` hunks are in #102 and its `server.ts` hunks in #103. Two of its hunks needed redoing: the CHANGELOG (master already had an `[Unreleased]`) and the dashboard URL options (the paragraph was rewritten, and `?redact` → `&redact` was only half right). Its author is credited in both commits. It can be closed once those merge.

## 2. Findings not fixed

Severity is for the product's promise: a wrong or overstated number ranks above a crash.

### High
1. **The dashboard has no access token when bound to `0.0.0.0`** (the container setup). The Host check stops browser DNS rebinding, but any client that can reach the port and sends `Host: localhost` is answered. #92 corrects the comment and #102 the docs ("publish to 127.0.0.1 only"). A per-launch token for `/api/*` is the real fix.

_Fixed by #106 and #107: the overstated-payoff (T = impressions × CTR curve, up to 75× the real clicks) and the concurrent-in-process jobs are now addressed. #106 does not cover two adjacent items it noted: the traffic-decay stake flipping ~100× on whether the page kept a current-window row (`engine.ts:231-236`); and the doc claim that `high-yield-cwv-fail` uses field data when it reads Lighthouse lab data (`page_cwv`, `manual/checks.md`). Those remain open._

### Medium
2. **`url-key.ts` merges distinct pages** (`:15-20`).
   - `?ref=` is stripped, and the whole `pk_*`, `mc_*` and `_hs*` prefixes are stripped too. So `?ref=main` / `?ref=dev` and `?pk_id=5` / `?pk_id=6` collapse into one key.
   - Invalid UTF-8 query escapes collapse to U+FFFD (`?q=%E9` and `?q=%E8`).
   - The key is not idempotent for `//`, `www.www.` or lowercase percent-hex.
   - `hostForm:'www'` prefixes `www.` to any host, including external link targets (`:66`).
3. **Silent caps** (the "no silent caps" rule):
   - URLs dropped at the crawl's `maxPages` or `maxDepth` are never counted (`Crawler.ts:668`).
   - `MAX_IMAGES` and `MAX_RESOURCES` (500) apply silently.
   - The external link check stops at `maxTargets` silently.
   - The sitemap reader's `maxSitemaps` (60) and `maxUrls` caps (`sitemap.ts:92,113`) are silent too, which makes `indexable-not-in-sitemap` over-report. #90 reports oversized sitemaps only.
4. **Device / country breakdowns compare part of a window with a full prior one** when the segment rows stop early (`dashboardData.ts:444-450`). `breakdownWindowStart` is always 28 days, whatever window is selected.
5. **The Summary's non-brand figures follow the selected window while its text says 28 days** (`summary.ts:84`, built from `brandedSplit`). Needs a fixed 28-day non-brand pair in the payload.
6. **The Summary's ranking mix slices rows, not dates** (`summary.ts:459`): "last 28 days" covers more calendar days on a site with gaps.
7. **Portfolio:**
   - AI mentions add the platforms even when one is missing for a month, giving a false "down 50%" (`portfolioData.ts:226-231`).
   - Its 28-day window and monthly completeness use the raw latest day, not `gscFreshness` (`:266`, `:401`), so the portfolio and the dashboard disagree for the same property.
8. **"Zero impressions" claims from query-level rows** (`index-bloat`, `faceted-spider-trap`, `checks.ts:563-566`, `:1001-1010`). GSC drops anonymised queries from date×query×page rows, so a page with only rare-query impressions reads as zero. `faceted-spider-trap` also has no history-span guard.
9. **Missing data reads as a pass for most checks.** Only the asset, probe and render checks have `collected()` hooks. For example, with no GSC at all `notCollected` lists no GSC check.
10. **External link check details:**
    - A 503 with Retry-After is stored as `broken`.
    - `conditional_304` is stored as 0 for any non-304 status (`Crawler.ts:829`), so `no-304-revalidation` claims more than it saw.
11. **`render_pages`:** Chromium following a redirect isn't guarded. #101 checks the passed URLs only.
12. **`missing-required-fields`** treats recommended properties as "Google-required" (Article: headline/author/datePublished/image; Organization: logo) (`schema-validate.ts:32-36`). See section 3.

### Low
13. ~~**The domain picker shows "All domains" for a hidden property opened by URL** (`shell.ts:39-51`).~~ **Fixed** (#109-follow-up): the open property is always a selected option (the logic moved to a pure `core/domainPicker.ts`, tested in `probe-dashboard-rules`), labelled "(hidden)" when hidden.
14. **A failed window switch** leaves the new window labelled over the old data (`dashboard.ts:1513-1523`). Not verified.
15. **Cancel feedback:** after Cancel, a running crawl's card still reads "running" for about 10 s, because the in-flight fetch doesn't take the job signal (`webHandlers.ts:166`).
16. **"Show more" can mix runs:** "Show more" and the filters page the latest completed run, which may differ from the run the page loaded. Pass `fc.runId` to `list_findings`.
17. **Runner staleness:** the runner's claim treats a same-property job as dead after 90 s without a heartbeat, not the 30-minute `SAFETY_STALE_MS` (`JobManager.ts:417`).
18. **Database file names:** separators collapse, so `https://x.com/~u/` and `https://x.com/u/` share a file (`paths.ts:19-33`). Rare.
19. **`ipr-bleed-by-status`** sums iPR per link row, not per source (`checks.ts:972`).
20. **`coverage-not-indexed`'s title:** it reads "Crawled but not indexed", but `LIKE '%not indexed%'` also matches "Discovered - currently not indexed".
21. **Critical-count wording:** the verdict's "N critical issues are open" should read "at least N" when a crit check is capped. The same applies to the portfolio's "Audit health down" across different scopes, which is unverified.
22. **`findingsQuery` sort:** no tie-breaker (`, id`). Paging tested stable here, but SQLite doesn't promise it.
23. **Em dashes in UI text:** 78 lines of check titles and fix strings in `src/audit/checks*.ts` contain em dashes, and they are shown in the Issues table (see the screenshot). This breaks the house rule.
24. ~~**UI type-checking:** `src/ui/**` is not type-checked by any build step.~~ **Fixed:** `tsconfig.ui.json` type-checks `src/ui`, wired into `build` (and so CI). The 74 errors were drift (the UI kept a partial copy of `DashboardData`) plus loose callback params; the UI now reads the server's `DashboardData` type, and `noImplicitAny` is relaxed for DOM callbacks.
25. **ARCHITECTURE.md**, one-line fixes left until after the merge (each sits next to a line a fix PR edits, so changing it now would conflict):
    - The data-dir file list omits `wikidata-cache.db` and `reports/`.
    - The Collection bullet says the GSC resume uses a "3-day lag buffer"; `LAG_DAYS` is 4. #95 states the right figure under Conventions.

### Dependencies (`npm audit --omit=dev`) — fixed by #108
- The high `zod` advisory (GHSA-mrhx-c7xc-m3w5) and all five moderates (`glob` / `minimatch` / `rimraf` / `gaxios` under `googleapis-common`) are cleared: **0 vulnerabilities**. zod moved to 4 (the MCP SDK 1.32 declares `zod ^3.25 || ^4.0`), and the `googleapis` meta-package was replaced by the scoped `@googleapis/searchconsole` + `google-auth-library`, which removes `googleapis-common`.
- **Node:** engines, the MCPB manifest and the docs now say Node 22 (`undici` 8 and the Google libraries require it; Node 20 is EOL).
- **Install size** (`npm install --omit=dev`): 208 packages / 862 MB → 180 / 588 MB. The remaining weight is **`onnxruntime-node` (548 MB)**, pulled by `@huggingface/transformers` for the local embeddings behind near-duplicate detection and passage scoring. It can't be dropped from the default install by moving it to `optionalDependencies` (npm installs those by default); trimming it means making those two features opt-in — convert `embeddings.ts` / `reranker.ts` to lazy `import()` and degrade gracefully when the module is absent (as `render.ts` does for Playwright), then document a manual `npm i @huggingface/transformers`. That is a feature decision, left for the owner.

### Swept and found sound
- **No SQL injection:** no SQLite statement is built from user input. `query_data` whitelists columns from `PRAGMA table_info` and binds values; other interpolations are constants, schema-checked numbers or the database's own dates.
- **No floating promises:** none found in server code without a handler. `JobManager.launch` catches.
- **Correct as they are:**
  - totals vs segment rows after the migration (no double count);
  - the migration's backup / resume;
  - the lag-day replace;
  - `possiblyRunning()` on destructive data_storage actions;
  - the probe_urls hop guard;
  - Retry-After handling and AIMD;
  - CTR as summed clicks / summed impressions;
  - the window boundaries for 7/28/90/180;
  - the boot payload's `</script>` escaping;
  - the Host allowlist against rebinding hostnames;
  - the JSON content-type CSRF guard;
  - XSS: crawled text was injected into 27 columns and rendered escaped everywhere.

## 3. Needs real data or credentials to confirm
- **How far GSC query-attributed totals differ from the property total** (anonymised queries, per-page impressions), and whether the KPI tiles should say "query-attributed" or sync a date-only totals row.
- **The cost of staging every GSC page (#95)** on a multi-million-row first sync: time and temporary disk.
- **Whether real users hold pre-fix `x.com.db` files** shared by a Domain and a URL-prefix property (#96).
- **Node 20 compatibility** with `undici` 8.
- **Google's documented required vs recommended properties** for Article and Organization (finding 14). This came from knowledge, not checked online.
- **Real Cloudflare / DataDome / PerimeterX challenge responses** (#97 relies on the documented `cf-mitigated: challenge` header).
- **Every paid path** (DataForSEO, Majestic, CrUX, URL Inspection, the portfolio scheduler) was read, not run.

## 4. Tool-context size (`tools/list` and instructions)
Measured by spawning `dist/index.js` over stdio with an empty data dir, no credentials, and `net`/`dns`/`http`/`fetch` blocked. There were zero network attempts at startup, with or without fake keys.

| | master | after #103 |
|---|---|---|
| `initialize.instructions` | 4,869 bytes | 6,136 bytes (adds START HERE: setup line, help-first, browser rule, siteUrl format) |
| `tools/list` result | 77,533 bytes (one page) | 77,259 bytes |
| tools | 65: 61 model-visible + 4 app-only (`get_dashboard_data`, `list_findings`, `get_portfolio_data`, `get_domain_overview`) | same |
| descriptions / input schemas | 39,910 / 27,295 bytes | 39,625 / 27,289 bytes |
| approx tokens (bytes/4) | ~20,600 | ~20,850 |

- **Largest tools (bytes):** `start_crawl` 3,676; `recon_targets` 3,596; `query_data` 3,241; `link_intersect` 2,723; `data_storage` 2,344; `pull_backlinks` 2,240; `triage_404s` 2,153.
- **Where the bytes go:**
  - 175 of 251 parameters have no description, including `siteUrl` in about 45 tools; the instructions now state its format once.
  - About 5 KB of the schemas is `$schema` / `additionalProperties` boilerplate.
  - No tool has `readOnlyHint` or `destructiveHint` annotations. They'd help, especially on `data_storage` and `data_location`.
- **Further trims proposed, not made** (they move behaviour detail out of the model's context into `manual/tools.md`): `start_crawl` from about 1,850 to 600 description bytes, `recon_targets` from 2,400 to 800, `triage_404s`, `data_storage`, `query_data`.
- **`list_checks` result size:** it returns 10 bytes of text plus 61 KB of `structuredContent`, over the roughly 60k host cap that ARCHITECTURE.md mentions. A compact text table (about 6 KB) would fit.
- **Overlapping tools** (candidates to merge or cross-reference):
  - `check_sync_status` / `check_crawl_status` (now described as an alias);
  - `open_dashboard` / `serve_dashboard`;
  - `suggest_pages` / `content_opportunities` / `keyword_list` / `topic_gaps`;
  - `ranked_keywords aioOnly` / `serp_features` / `recon_targets`;
  - `competitors_domain` / `market_sizing` / `domain_visibility`;
  - `page_intersection` / `topic_gaps` / `link_intersect`;
  - `portfolio` / `get_portfolio` / `get_dashboard`;
  - `data_location` / `data_storage`;
  - `seo_audit_help` / `composition_cookbook` / `list_checks`.
- **How a model now discovers help and setup** (#103):
  - The instructions carry a computed `SETUP AT START: ...` line, tell the model to call `seo_audit_help` on first use or after any credentials error, and tell an agent with a built-in browser to open `dashboardUrl` there.
  - `seo_audit_help` leads with "Setup on this machine": the key file (set, placeholder, missing, not a service account, or OK with its `client_email`), the optional keys, local data and the runner mode, each with its fix.
  - The Search Console and DataForSEO errors point to it.
  - `list_properties` with zero results explains how to add the service account's email.

## 5. Dashboard QA (headless Chromium, fictional demo property, master build)
Built with `scripts/demo-property.mjs`: 300 pages, 16 months of synthetic GSC and three real crawls of a local site. Screenshots were taken with `scripts/demo-screenshots.mjs --qa` (every tab, 1440 px light and dark, 390 px light). A Playwright script then drove the interactions:

| Check | Result |
|---|---|
| Window switching (28d → 7d): URL `days=7`, tiles change, `data-win` labels follow | pass |
| Findings paging: "Show more" adds rows (50 → 150 findings) | pass |
| Filters: the High chip shows only high findings; the count line says "matching the filter" | pass |
| Domain picker lists every property; a hidden property leaves it | pass |
| A hidden property opened by URL: picker shows its name | **fail**: shows "All domains" (finding 15) |
| Sidebar Crawl → queued job card with Cancel → Cancel → state `cancelled` | pass |
| 390 px, light and dark, every one of the 10 tabs: no horizontal scroll | pass |
| Page errors / console errors during the run | none |

The screenshots are in `review-screenshots/`. Delete the folder before merging if you'd rather not keep them in the repo.
- `summary-light-390.png`: the phone-width Summary.
- `summary-dark-1440.png` and `issues-dark-1440.png`: the dark theme. The Issues table shows the em dashes from finding 25.
- `jobs-after-cancel.png`: the job card after Cancel.
