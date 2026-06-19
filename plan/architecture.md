---
name: seo-audit-console — architecture & implementation plan
description: The consolidation architecture for the new houtini MCP that merges seo-crawler-mcp + better-search-console (+ later geo-analyzer/DataForSEO) into one audit server. Covers data model, the async-crawl fix, the normalised URL join key, tool surface, migration, and performance.
type: plan
phase: 5
---

# seo-audit-console — architecture & implementation plan

**Product name (decided):** `seo-audit-console`. npm `@houtini/seo-audit-console`, repo `houtini-ai/seo-audit-console`. (Sidesteps the `RichardDillman/seo-audit-mcp` name clash noted in [07-prior-art](../research/07-prior-art.md).)

**Thesis:** one MCP that **collects** (crawl + GSC history, later SERP), **analyses** (deterministic checks + the merged GSC×crawl questions in [research/05](../research/05-gsc-and-dataforseo-overlap.md)), and **recommends** with traceable evidence. The differentiator is the **historical GSC database joined to crawl snapshots** — decline-diagnosis questions no single-crawl tool can answer.

This plan is grounded in a **code review of the two existing servers** (see findings inline). Two of the existing pieces are reusable largely as-is; one needs a structural fix before it's fit for purpose.

---

## 0. The one thing that must change first — crawl execution model

**Finding (seo-crawler-mcp code review):** `run_seo_audit` is **fully synchronous** — `await orchestrator.run()` ([run-seo-audit.ts:80](../../seo-crawler-mcp/src/tools/run-seo-audit.ts)) blocks the MCP tool call until the whole crawl drains. With `maxPages` default 1000 at a few pages/sec, the call always exceeds the ~60s MCP tool-call ceiling: the call fails, the result/output-path is lost, and the crawl is orphaned. The CLI mode exists purely as a workaround. **This is why crawl performance is "unreliable" — it's not slowness, it's the wrong execution model for MCP.**

**The fix is the pattern better-search-console already proves:**
- `start_crawl` returns a `crawlId` **immediately** (kick off `orchestrator.run()` without awaiting; hold the promise in an in-memory `Map<crawlId,…>`).
- Progress is persisted to `crawl_metadata` (already happens every 10 pages).
- `check_crawl_status(crawlId)` polls that row (status + crawled/discovered/failed counts).
- Optional MCP-App progress UI mirroring better-search-console's sync-progress widget.

Everything else in the crawler is salvageable. This single change is the prerequisite for the merged product.

**Companion crawl fixes from the review (do alongside):**
1. **Batch page inserts** — pages are written one-row-per-transaction; the `savePageBatch` transaction exists but is unused. Buffer 50–100 + `pragma synchronous=NORMAL`.
2. **Honour throttle config** — orchestrator ignores `config.concurrency`/`delay`, hardcodes `maxConcurrency:20`, `maxRequestRetries:5` (retry storms). Wire config through; expose `maxConcurrency`/`delay`/`requestTimeout` as tool inputs; respect the CLAUDE.md "≤1 rps, polite" rule.
3. **Persist the request frontier + resume** — currently an ephemeral in-memory queue purged in `finally`; no resume, and an OOM vector on large sites (consistent with the 3 GB DB / server-restart we saw on a big GSC sync). Persist per `crawlId`; mark `status='interrupted'` on disconnect.
4. **Write the `errors` table** — `db.saveError()` has no caller today; failed URLs survive only as a count. Wire it in.
5. **Bound read/export paths** — `getAllPages`/`getAllLinks`/`exportToCsv` and the analysis queries `.all()` whole tables; add `LIMIT`/streaming for large sites.

---

## 1. Module shape

```
seo-audit-console/
  src/
    core/
      url-key.ts          # SHARED normalisation → url_key (single source of truth)
      AuditDatabase.ts     # unified SQLite: crawl tables + gsc tables + audit runs
      GscClient.ts         # lifted from better-search-console (googleapis wrapper)
      GscSync.ts           # lifted: fetch → transform → batch insert, incremental
      CrawlOrchestrator.ts # lifted from seo-crawler-mcp, async-job-ified (§0)
      JobManager.ts        # in-memory Map<jobId> for crawl + sync, status polling
      web-search.ts       # NEW: Brave/Firecrawl/DataForSEO provider abstraction
                          #      (external duplicate-content + SERP); N/S-labelled, cached
      robots-sitemap.ts   # NEW: RFC 9309 robots parser + sitemap(+index) parser → 3-way reconcile
      conditional-probe.ts# NEW: HEAD + If-Modified-Since/If-None-Match 304-behaviour checks
    analyzers/
      queries/            # crawl-only SQL (28 from seo-crawler-mcp, deduped/fixed)
      merged/             # NEW: the GSC×crawl SQL from research/05 (A–D series)
      schema-validate.ts  # NEW: JSON-LD/microdata extraction + schema.org/Rich-Results validation
      dedupe.ts           # NEW: near-duplicate body detection (simhash/shingling)
      QueryRunner.ts      # whitelist-by-name (read-only), as seo-crawler-mcp does
    generators/
      json-ld.ts          # NEW: agent-native JSON-LD generation from page content (dry-run/diff)
      redirects.ts        # NEW: 404→200 fuzzy-match → .htaccess/nginx/next.config blocks
    tools/                # MCP tool handlers (see §4)
    ui/                   # MCP-App dashboards (port better-search-console's houtini design)
    server.ts             # McpServer; SERVER_VERSION derived from package.json

# Crawl extractor must additionally capture response + asset byte sizes (excessive-resource check).
# New modules + the check→capability mapping are specced in research/09-seogets-and-check-coverage.md.
# Web search is the one data source with per-query external cost — backend + budget configurable.
```

Stack inherited from both: TypeScript, ES modules, `better-sqlite3` (WAL), `@modelcontextprotocol/sdk` 1.29, `crawlee` (HttpCrawler), `cheerio`, `googleapis`, `zod@3`. UI via `@modelcontextprotocol/ext-apps` 1.7 + the shared houtini `tokens.css` already built for better-search-console.

---

## 2. Data model & the join key

**Decision: one SQLite database per property** (matches better-search-console's per-property model and keeps GSC history + crawl colocated for cheap joins). Tables:

- **GSC side** (from better-search-console): `search_analytics(date, query, page, device, country, clicks, impressions, ctr, position, …)` + sync metadata. Add **`page_key`** (normalised).
- **Crawl side** (from seo-crawler-mcp): `crawl_metadata`, `pages`, `links`, `errors`. Add **`url_key`** to `pages` and to `links.target_url`.
- **Audit side** (new): `audit_runs`, `findings(check_id, url_key, severity, evidence_json, deterministic)`.

**The join key — `url_key`** (resolves the [research/05](../research/05-gsc-and-dataforseo-overlap.md) normalisation pitfalls). A single `core/url-key.ts` function used identically by the crawl write path and the GSC sync write path:

```
url_key(raw):
  lowercase scheme + host           # host is case-insensitive
  force https                       # protocol-normalise
  unify host to property form        # www vs apex per the GSC property type
  strip default ports :80 :443
  strip fragment
  strip tracking params (utm_*, gclid, fbclid, mc_*, _hs*, igshid, …)
  sort remaining query params
  strip trailing slash except root
  preserve path case
```

Joins are then `gsc.page_key = pages.url_key`. Raw URLs are retained for evidence; **raw-URL / canonical divergence is itself a finding** (D5). Index `url_key` on both tables.

> This also fixes a *crawl-only* bug found in review: `orphan-pages`, `broken-internal-links`, `uncrawled-internal-links` currently join `links.target_url = pages.url` on raw strings and miss trailing-slash/case variants. Switching those joins to `url_key` fixes false orphans/missed-broken-links for free.

---

## 3. Analysis layer

- **Crawl-only checks** — port the 28 SQL queries, applying the review fixes: redirects must actually be **captured** (today `processPage` hardcodes `redirects:[]` and HttpCrawler collapses 3xx, so `redirects.sql` is dead — capture pre-redirect hops or use a HEAD/no-follow pass); resolve relative canonicals to absolute before `canonical-issues`; drop the inconsistent `depth<=5` filter on `missing-titles`; case-fold duplicate-detection; exclude `<script>` text from `word_count`.
- **Merged checks** — implement the A–D series from [research/05](../research/05-gsc-and-dataforseo-overlap.md) as `analyzers/merged/*.sql`, joined on `url_key`. C-series (decline diagnosis) is the flagship.
- **Security model** — keep seo-crawler-mcp's **whitelist-by-name, read-only** query execution (strictly safer than better-search-console's regex blocklist on free SQL). Add Zod param parsing inside each tool (defense-in-depth).
- **Determinism labels** — every check carries `D`/`N` and an evidence payload (per [01-checklist](../research/01-modern-technical-seo-checklist.md) §20). `N` checks gate behind a flag and cite grounding.

---

## 4. Tool surface (contract summary; full schemas → tool-surface.md)

| Tool | Sync? | Purpose |
|------|-------|---------|
| `list_properties` | sync | GSC properties + local sync/crawl status (from better-search-console) |
| `sync_gsc` / `check_sync_status` | **async job** | pull GSC history into the DB (from better-search-console, unchanged — it already works) |
| `start_crawl` / `check_crawl_status` | **async job** | crawl a property into the DB (**the §0 rewrite of `run_seo_audit`**) |
| `run_audit` | sync (reads) | run crawl-only + merged checks, return findings (extends `analyze_seo`) |
| `query_audit` | sync (reads) | run one named check (extends `query_seo_data`, whitelist-by-name) |
| `list_checks` | sync | list available checks w/ severity, D/N, data requirements |
| `get_dashboard` / `get_overview` | sync (App UI) | the houtini MCP-App dashboards (from better-search-console) |

Both long-running operations (crawl, GSC sync) use the **return-jobId-then-poll** pattern. No tool blocks past the MCP ceiling.

---

## 5. Migration — keep / rewrite / fold

| Source | Verdict |
|--------|---------|
| **better-search-console** | **KEEP wholesale.** GSC client, sync (async job already), per-property SQLite, houtini App UI, version-from-package.json — all directly reusable. It's the template the crawler should follow. |
| **seo-crawler-mcp** | **KEEP + REWRITE the execution model.** Crawler engine, extractors, 28 SQL queries, whitelist-by-name security are good. Must: async-job-ify the crawl (§0), persist `url_key`, fix the redirect/orphan/canonical bugs, batch inserts. |
| **geo-analyzer** | **FOLD LATER, don't lift as-is.** Per CLAUDE.md the GEO score "needs a rebuild" — bring in as `N` checks behind a flag in a later phase, not v1. |
| **DataForSEO / SERP (E-series)** | **PHASE 2+.** Same URL→query→SERP spine; out of scope for the first GSC×crawl build. |

---

## 6. Performance budget (the user's hard requirement)

- **No MCP tool call may block past ~50s.** Crawl + sync are jobs; everything else is a bounded read.
- Crawl throughput: HttpCrawler (cheerio, no browser) is the right fast default; batch DB writes; honour polite throttle; resume on interruption.
- Large-site memory: persistent frontier (not in-RAM), streamed reads/exports, `LIMIT` on analysis queries. (The 3 GB DB / restart we observed is the failure mode to engineer against.)
- Render-dependent checks (JS sites) are a **separate opt-in Playwright pass**, never the default crawl.

---

## 7. Open questions (→ open-questions.md)

1. One DB per property (chosen) vs one DB with a `property` column — per-property keeps joins simple and matches better-search-console; confirm.
2. `www`/apex unification in `url_key` is property-type dependent (domain property vs URL-prefix). Derive host form from the GSC property identifier at sync time.
3. Crawl ↔ GSC freshness contract: do merged checks require a crawl within N days of the GSC window? Surface staleness in findings.
4. Ship core (~150 checks) first, deep-dive behind flags — confirm the cut.

---

## Sources / references
- [research/05 — GSC × crawl question catalogue](../research/05-gsc-and-dataforseo-overlap.md) (the merged checks)
- [research/01 — master checklist](../research/01-modern-technical-seo-checklist.md) §16, §1.3, §20
- [research/07 — prior art](../research/07-prior-art.md) (gap analysis; the join is established practice, the *historical* join + MCP-native is the gap)
- Code review of `seo-crawler-mcp` v2.1.5 (this session): synchronous crawl, dead redirect capture, raw-URL joins, unused batch insert, errors table never written, in-memory frontier.
- `better-search-console` (this session): async sync job + poll, per-property SQLite, version-from-package.json, houtini App UI — the reuse template.
