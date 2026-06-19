---
name: seo-audit-console — MCP tool surface (contract)
description: The MCP tool list with input/output contracts for the consolidated server. Contract only, not implementation. Long-running ops use return-jobId-then-poll; everything else is a bounded read. Derived from architecture.md + the research catalogue.
type: plan
phase: 5
---

# seo-audit-console — tool surface (contract)

**Conventions:** inputs sketched as Zod (`zod@3`, SDK 1.x). Every tool result is JSON; audit findings carry `severity`, `label` (D/N/L/G/S — see [research/03](../research/03-deterministic-vs-not.md)), and `evidence`. **No tool blocks past ~50s** ([architecture](architecture.md) §6): crawl + sync are jobs; the rest are bounded reads. SERP/web-search tools are opt-in + budgeted.

---

## Data collection (async jobs)

### `sync_gsc`  /  `check_sync_status`  — lifted from better-search-console (works today)
```
sync_gsc: { siteUrl: z.string(), startDate?: z.string(), endDate?: z.string(),
            dimensions?: z.array(z.string()), searchType?: z.enum([...]) } → { jobId, status }
check_sync_status: { jobId?: z.string() } → { jobId, status, rowsFetched, ... }
```
Returns immediately; polls. Already proven.

### `start_crawl`  /  `check_crawl_status`  — the §0 rewrite of run_seo_audit
```
start_crawl: { siteUrl: z.string(), maxPages?: z.number().max(50000),
               depth?: z.number().max(10), maxConcurrency?: z.number(),
               delayMs?: z.number(), userAgent?: z.enum(['chrome','googlebot','gptbot']),
               render?: z.boolean() /* opt-in Playwright */ } → { crawlId, status:'running' }
check_crawl_status: { crawlId: z.string() } → { crawlId, status, crawled, discovered, failed, outputPath }
```
**Returns `crawlId` immediately, runs detached, polls** — the fix for the timeout problem. `render:true` triggers the separate Playwright pass (default false).

---

## Analysis (bounded reads)

### `run_audit` — the headline
```
{ siteUrl, scope?: z.enum(['core','full']).default('core'),
  categories?: z.array(z.enum(['integrity','crawlability','indexation','onpage',
     'schema','performance','war-stories','agentic','merged'])),
  includeJudgement?: z.boolean().default(false) /* gates N checks */,
  includeSerp?: z.boolean().default(false) /* gates S checks, costs money */ }
→ { runId, integrityGatesPassed: boolean, findings: Finding[], summary }
```
`Finding = { checkId, category, severity, label[], urlKey?, evidence, recommendation? }`. **Integrity gates run first** ([research/06](../research/06-crawl-integrity.md)); if not green, findings carry a "⚠ integrity unverified" banner.

### `query_audit` — one named check (whitelist-by-name, read-only)
```
{ check: z.string(), limit?: z.number().min(1).max(1000).default(100) } → { check, findings }
```
Security model from seo-crawler-mcp (no arbitrary SQL). Covers the 28 crawl-only checks + the merged A–D series ([research/05](../research/05-gsc-and-dataforseo-overlap.md)) + war-stories ([research/02](../research/02-war-stories.md)).

### `list_checks`
```
{ category?, label?, severity? } → Check[]  // {checkId, title, category, label[], severity, dataRequired, fix}
```

---

## Web/SERP (opt-in, budgeted — S-labelled)

### `web_search` — duplicate-content + general lookups
```
{ query: z.string(), mode?: z.enum(['phrase','serp']), backend?: z.enum(['brave','firecrawl','dataforseo']),
  limit?: z.number() } → { results, cited }
```
Brave/Firecrawl for cheap phrase-duplication; DataForSEO SERP for structured SERP. Cached by query; per-call cost surfaced. (See [research/10](../research/10-dataforseo-and-serp-layer.md), [research/09](../research/09-seogets-and-check-coverage.md) §3.) **Not enabled with current DataForSEO scope: Labs** (keyword-difficulty, domain-intersection).

---

## Remediation generators (dry-run / diff — never silent write)

### `generate_schema` — agent-native JSON-LD ([research/11](../research/11-schema-validation.md) Part B)
```
{ urlKey: z.string(), type?: z.string() /* else inferred */ } → { jsonLd, validation, scriptTag }
```
schema-dts-typed generation from page content → validated through the audit rules → returned as a copy block. User applies.

### `generate_redirects` — 404→200 fuzzy match
```
{ format: z.enum(['htaccess','nginx','nextjs']) } → { rules, matched, unmatched }
```

---

## App UI (MCP-App, houtini design)

### `get_overview` / `get_dashboard` — lifted from better-search-console
Multi-property overview grid + per-property dashboard, now able to surface **audit findings** alongside GSC trends (merged view). Same `registerAppTool` + houtini `tokens.css`.

---

## Tool count & phasing
- **v1:** sync_gsc(+status), start_crawl(+status), run_audit, query_audit, list_checks, get_overview, get_dashboard. (Covers GSC analytics + technical crawl audit + the merged decline diagnosis — already beats seogets.)
- **v2:** web_search, generate_schema, generate_redirects.
- **v3:** log ingestion, semantic ghost-query, SERP-heavy checks, agentic `scan_site` wrap.

## Open questions (→ open-questions.md)
- Auto-apply boundary for generators (dry-run only vs opt-in write-to-repo).
- `run_audit` default scope `core` (~150 checks) vs `full` — confirm the cut.
- Per-property DB vs single DB (architecture §7 Q1).

## Sources
- [architecture.md](architecture.md) §4; research [02](../research/02-war-stories.md)/[03](../research/03-deterministic-vs-not.md)/[05](../research/05-gsc-and-dataforseo-overlap.md)/[06](../research/06-crawl-integrity.md)/[09](../research/09-seogets-and-check-coverage.md)/[10](../research/10-dataforseo-and-serp-layer.md)/[11](../research/11-schema-validation.md).
