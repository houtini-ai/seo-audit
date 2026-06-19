# seo-audit-mcp

**Status:** Investigation / planning workspace (no code yet).
**Goal:** Consolidate `seo-crawler-mcp`, `better-search-console`, and parts of `geo-analyzer` / DataForSEO into a single **SEO-Audit MCP** that produces deterministic, defensible technical SEO audits with prioritised, actionable recommendations.

This directory is intentionally **a research and planning repo first, code repo second**. Do the investigation work properly before writing any consolidation code.

---

## The thesis

Technical SEO is gatekept far more than it deserves to be. The process is actually simple:

1. **Collect data** — crawl, GSC, SERP, performance, structured data, server signals.
2. **Analyse** — against deterministic checks (e.g. robots blocks, 304s, missing canonicals, sitemap drift, waterfall metrics) and non-deterministic checks (e.g. "this page needs a rework because intent has shifted").
3. **Recommend** — in likely priority order, with citations to the evidence that produced the recommendation.

The product is an audit that a competent technical SEO would sign off on without being embarrassed. The differentiator is **honesty about what is deterministic vs not**, and **traceability** from recommendation → finding → raw datapoint.

## What the consolidated MCP should be able to answer

For any property the user owns or has GSC access to:

- **On-page keyword targeting** — does each indexable page actually target what GSC says it ranks for? Title/H1/intro alignment, internal anchor text, etc.
- **Missing pages / content gaps** — queries with impressions but no dedicated landing page; topic clusters with holes.
- **Pages that need a rework, and why** — declining queries, low CTR vs position, intent mismatch (use a Gemini-grounded LLM check, NOT the legacy GEO score as-is — that needs a rebuild).
- **Technical correctness** — the long tail of "war story" failure modes: iframe in `<head>`, robots blocked, 304 Not Modified loops, pages missing from sitemap, canonical chains, hreflang errors, Vary header issues, JS-rendered orphans, soft 404s, mixed content, CWV regressions, etc.
- **Agentic readiness** — modern stuff: `llms.txt`, WebMCP exposure, structured data quality for LLM ingestion, `isagentready.com`-style checks, JS-rendered content reachable without execution.

## Properties available for live crawl-integrity testing

- `simracingcockpit.gg` (owned, small, good "real site" test bed)
- Whatever is currently authenticated in `better-search-console` — list those first, then pick 1–2 small ones.

**Rule:** never hammer. Polite crawl budgets (≤ 1 rps, respect robots, identifiable UA) on owned sites only.

---

## Phases of work

### Phase 1 — Research (output: `research/`)

Build the knowledge base before touching any code. Use:

- **`mcp__gemini__gemini_deep_research`** / `gemini_chat` — chunked, grounded research. One topic per file.
- **`mcp__brave-search__brave_web_search`** + `brave_news_search` — find primary sources, war stories, recent algorithm/spec changes.
- **`mcp__context7__query-docs`** — when researching a specific spec/SDK (e.g. robots, sitemaps, schema.org, Lighthouse, MCP itself).
- **Your own reasoning** for synthesis.

Topics to cover (one markdown file per topic, with sources):

1. `research/01-modern-technical-seo-checklist.md` — the full audit surface, 2025/26.
2. `research/02-war-stories.md` — Reddit/Twitter/blog war stories. Each gets: symptom, root cause, signal that would have caught it.
3. `research/03-deterministic-vs-not.md` — taxonomy of every datapoint we'd collect and whether it's deterministic. Performance waterfalls = deterministic. "Page needs rework" = not.
4. `research/04-agentic-readiness.md` — WebMCP, `llms.txt`, isagentready.com, structured data for LLMs, JS-rendered reachability.
5. `research/05-gsc-and-dataforseo-overlap.md` — what each gives us, where they disagree, when to prefer which.
6. `research/06-crawl-integrity.md` — how do we know our own crawl data is correct? UA spoofing detection, render parity, sampling validation.
7. `research/07-prior-art.md` — Screaming Frog, Sitebulb, Ahrefs Site Audit, Semrush, Lumar — what they get right and where they overreach.

Each file must end with a **Sources** section linking primary docs, not "as Claude knows".

### Phase 2 — Audit of existing MCPs (output: `audit/`)

Read the actual code. Don't trust READMEs.

- `audit/seo-crawler-mcp.md` — what it does, what it claims to do, gaps, security issues (SSRF? unbounded fetch? auth handling?), transportability (stdio vs HTTP, env coupling, hardcoded paths), test coverage.
- `audit/better-search-console.md` — same shape. Pay attention to OAuth/token storage, DB schema (it has a local DB for GSC sync), prune/cancel semantics.
- `audit/geo-analyzer.md` — short. Decide: keep as-is, rebuild with Gemini grounding, or fold into SEO-Audit MCP.
- `audit/dataforseo-usage.md` — which endpoints we actually need; cost per audit.

Each audit ends with: **Keep / Refactor / Replace** verdict and a short justification.

### Phase 3 — Crawl integrity testing (output: `crawl-tests/`)

Run the existing `seo-crawler-mcp` against owned properties and validate the output is trustworthy before we consolidate anything.

- `crawl-tests/simracingcockpit.gg-baseline.md` — full small crawl, every field validated against manual `curl -I` and view-source. Record discrepancies.
- `crawl-tests/<gsc-property>-baseline.md` — repeat for one or two small GSC-authenticated properties. Cross-check sitemap, robots, and a sample of pages against what GSC says is indexed.
- `crawl-tests/render-parity.md` — does the crawler see what Googlebot sees? Test a JS-heavy page; compare raw HTML vs rendered.
- `crawl-tests/integrity-report.md` — summary: which crawler outputs we trust, which we don't, and the patch list needed before this data can drive an audit.

**Validation gates** before moving to Phase 4:

- Status codes match `curl -I` 100% on the sample.
- Canonical, title, meta description, H1 match view-source 100%.
- Sitemap parsing matches what's actually in `sitemap.xml` (and any nested sitemaps).
- Robots interpretation matches Google's official robots tester for the same UA.

### Phase 4 — Findings & gap list (output: `findings/`)

Synthesise Phases 1–3 into:

- `findings/security.md` — concrete security issues in the existing MCPs (SSRF, secret handling, token storage, log hygiene, MCP transport choice).
- `findings/transportability.md` — what stops these MCPs running on someone else's machine cleanly. Hardcoded Windows paths? Env var assumptions? Native deps?
- `findings/data-quality.md` — every place the crawl/GSC data is currently wrong or untrustworthy, ranked.
- `findings/missing-checks.md` — every check from Phase 1 that nothing in the current stack performs.

### Phase 5 — Consolidation plan (output: `plan/`)

Only after Phases 1–4 are credible.

- `plan/architecture.md` — proposed SEO-Audit MCP shape: tool surface, internal modules (crawler, GSC client, SERP/DFS client, analyser, recommender), where Gemini grounding plugs in.
- `plan/tool-surface.md` — exact MCP tool list with input/output schemas (just the contract, not the impl).
- `plan/migration.md` — what we keep from `seo-crawler-mcp` and `better-search-console`, what we rewrite, what we delete. Repo strategy (new repo under houtini-ai or fold into one of the existing two).
- `plan/recommendation-engine.md` — how findings get prioritised into a task list. Scoring model. How a recommendation cites its evidence.
- `plan/open-questions.md` — anything that needs the user's call before code starts.

---

## Working principles for this repo

- **Sources or it didn't happen.** Every research claim links to a primary source. Every audit claim cites a file and line range.
- **Owned-site testing only.** Never crawl third-party sites at volume from this workspace. Brave search is fine; Firecrawl on competitors should be single-page and rare.
- **Determinism is a feature.** When something is non-deterministic (LLM judgement, intent assessment), say so in the output and gate it behind a flag.
- **Don't ship the legacy `geo-analyzer` scoring blindly.** It needs a rethink with Gemini grounding before it's allowed to influence recommendations.
- **One Gemini/Houtini-LM call at a time.** Parallel calls queue server-side and stack timeouts.
- **No code in this repo until Phase 4 verdicts are written.** This is a discipline thing — the temptation to start coding before the audit is done is exactly how the current fragmented state happened.

## Things explicitly out of scope (for now)

- Building a UI.
- Multi-tenant / SaaS concerns.
- Anything that requires paid API credit beyond what DataForSEO and GSC already give us.
- Rewriting `geo-analyzer` — we decide its fate in Phase 2/5, we don't fix it here.

## Quick references

- Existing crawler: `C:\MCP\seo-crawler-mcp\src`
- Existing GSC MCP: `C:\MCP\better-search-console\src`
- Existing GEO scorer: `C:\MCP\geo-analyzer\src`
- House conventions for Houtini MCPs: `C:\MCP\CLAUDE.md` (badge row, Glama, GitHub topics, repo/npm naming).
- Owned test property: `simracingcockpit.gg`
- GSC properties: list via `mcp__better-search-console__list_properties` at the start of Phase 3.

## Definition of done for this workspace

A reader who has never seen the project can, in 30 minutes:

1. Read `research/` and understand the modern technical SEO surface.
2. Read `audit/` and know what we have, what's broken, what's worth keeping.
3. Read `crawl-tests/` and trust (or distrust) the crawl data with evidence.
4. Read `findings/` and see the gap between where we are and where we need to be.
5. Read `plan/` and start writing the consolidated MCP from a clear spec.

If any of those five reads leaves the reader guessing, the phase isn't done.
