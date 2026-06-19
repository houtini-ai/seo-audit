---
name: Ingestion gaps — API responses we receive but don't store
description: Findings from the standalone API probes (scripts/probe-crawl.mjs, scripts/probe-gsc.mjs) run against live houtini.com. Each is data the API returns that our schema currently drops and should persist.
type: findings
---

# Ingestion gaps (from live API probes)

Run anytime with `npm run probe:crawl <url>` and `npm run probe:gsc <property> <url>`.
Probed live against houtini.com on this session. Four gaps found — all data we receive and should store.

## 1. HTTP security / delivery headers — RETURNED, not stored  [crawl]
The crawl response carried these, none persisted (the `pages.security_headers` column exists but the extractor never fills it):
- `strict-transport-security` (HSTS), `x-frame-options`, `x-content-type-options`, `referrer-policy`, `permissions-policy`, `content-security-policy` — power the §11 security checks and agent-readiness.
- `content-encoding` (br) — powers the compression war-story (W6) and CWV proxy.
- `server` — fingerprinting/info.
**Fix:** in `extract.ts`/`Crawler.ts`, capture the response headers into `pages.security_headers` (JSON) on write.

## 2. Caching / conditional headers — not captured  [crawl]
`cache-control`, `last-modified`, `etag`, `vary` are needed for the 304/`If-Modified-Since` and `Vary:User-Agent` war-stories ([research/02](../research/02-war-stories.md) #55/W6) and the CWV cache proxy ([research/13](../research/13-performance-cwv.md)).
**Fix:** add columns `cache_control`, `last_modified`, `etag`, `vary`, `content_encoding`, `ttfb_ms` to `pages` (or fold into a `response_headers` JSON column) and populate on crawl.

## 3. GSC URL Inspection API — entire source uncaptured  [GSC]  ★ biggest
`urlInspection.index.inspect` returns the **authoritative per-URL index status** and we store none of it. Live sample returned: `coverageState` ("Submitted and indexed"), `indexingState`, `robotsTxtState`, `pageFetchState`, `lastCrawlTime`, **`googleCanonical` vs `userCanonical`** (the canonical-conflict signal — research/05 D5), `crawledAs` (MOBILE), plus `mobileUsabilityResult`.
**Fix:** add a `url_inspection` table keyed on `url_key` (Google-selected vs declared canonical, coverage/indexing/robots/fetch state, last-crawl time, mobile usability, rich results) and a sampled inspection pass (the API is quota-limited — inspect priority URLs, not the whole site). This is the index-status spine for the indexation checks; Screaming Frog's GSC integration pulls exactly this.

## 4. GSC `searchAppearance` dimension — never requested  [GSC]
We never request the `searchAppearance` dimension, so AMP/rich-result/Web-Light appearance buckets aren't captured. The `search_analytics.search_appearance` column exists but is always null.
**Fix:** optional second sync pass requesting `['searchAppearance', ...]`, or document as out-of-scope for v1.

## Priority for the next ingestion slice
1 + 2 (cheap, same crawl write path) → **3** (high value, needs a quota-aware inspection pass + new table) → 4 (optional). None require re-architecting; 1/2/4 are additive columns, 3 is one new table + a sampled fetch.
