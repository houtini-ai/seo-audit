# The standard crawler-driven audit workflow — task map + article skeleton

The de-facto industry workflow for a crawler-led technical SEO audit (the "60+ uses" pattern every
agency guide follows). Tasks below are in the workflow's own order. Mapping: our check ids
(`src/audit/checks.ts`) / tools, **gap**, or **n/a** (crawler configuration or out-of-scope, not a finding).

## 0. Prioritisation framing (the workflow's own advice)
Start with crawl + indexation, cross-reference GSC ("discovered/crawled, not indexed"), then crawl-budget
waste (404s, redirect chains, parameters), then speed-of-indexation. **This is our core thesis, built in:**
GSC×crawl merge, `coverage-not-indexed`, `inspect_urls`, the (T×Y×C)/E yield model.

## 1. Task list + coverage

| # | Task (workflow order) | Ours |
|---|---|---|
| 1 | Crawl the entire site (incl. all subdomains) | `start_crawl` (single host; subdomains treated external via `isInternalHost`) — **partial** |
| 2 | Crawl a single subdirectory only | **gap** — no include/exclude scoping on `start_crawl` |
| 3 | Crawl a specific set of subdomains/subdirs via regex include/exclude | **gap** (built-in skip-list only, not user-configurable) |
| 4 | Get a list of all pages on the site | `pages` table, `query_audit`, dashboard |
| 5 | List pages in a specific subdirectory | partial — query the DB; no scoped crawl |
| 6 | Find all subdomains + verify their links | **gap** |
| 7 | Crawl a large/ecommerce site (DB storage, memory) | n/a (crawler-config) — SQLite + batched writes handle it |
| 8 | Clean crawl of parameterised/faceted ecommerce URLs | `faceted-spider-trap`, url-key param normalisation, skip-list |
| 9 | Throttle crawl speed for fragile servers | n/a (crawler-config) — adaptive throttling built in |
| 10 | Crawl a site requiring cookies | **gap** |
| 11 | Crawl with a different user agent (Googlebot Smartphone spoof) | **gap** — fixed identifiable UA |
| 12 | Crawl pages behind authentication | **gap** (deliberate: owned-site, polite crawling) |
| 13 | Export all internal/external links + anchor text + directives | `links` table, `query_audit`, `anchor-text-incoherent` |
| 14 | Find broken internal links | `broken-internal-links` |
| 15 | Find broken *outbound/external* links | **gap** — we don't status-check external targets |
| 16 | Find links pointing at redirects (+ chains) | `internal-links-to-redirects`, `redirect-chain` |
| 17 | Find internal linking opportunities | `underlinked-high-demand`, `underlinked-editorial`, `entity-internal-link-gap`, iPR + `fix_finding` donor suggestions |
| 18 | Identify thin content | `thin-content` (+ `content-bloat`, `poor-chunkability` beyond it) |
| 19 | List image links on a page | image data captured per page (`image-alt` evidence) — partial |
| 20 | Images missing alt text / over-long alt | `image-alt` (over-long alt not flagged — minor gap) |
| 21 | Find every CSS file | **gap** — HTML-only crawl (deliberate; no resource crawling) |
| 22 | Identify JS files/plugins and where they load | **gap** — same |
| 23 | Find embedded Flash | n/a (obsolete; the workflow itself says so) |
| 24 | Find internally linked PDFs | partial — non-HTML links recorded in `links`; no dedicated report |
| 25 | Segment content via custom HTML footprint search | partial — `list_templates` clusters by URL+schema; no free-text source search |
| 26 | Find pages with social sharing buttons (custom filter) | n/a; adjacent: `missing-social-tags` |
| 27 | Find pages using iframes | **gap** (custom-search family) |
| 28 | Find pages with embedded video/audio | **gap** (custom-search family; schema-opportunity roadmap touches it) |
| 29 | Over-long titles / meta descriptions / URLs | `title-too-long`, `meta-description-length` (URL length skipped as noise) |
| 30 | Duplicate titles / meta descriptions / URLs | `duplicate-title`, `duplicate-meta-description`; dup URLs via url-key normalisation |
| 31 | Duplicate content; URLs needing rewrite/redirect/canonicalisation (case, underscores, params, page-hash dupes) | partial — url-key + canonical checks; **exact/near-duplicate body detection = gap** (deferred in roadmap) |
| 32 | List all pages carrying meta directives (noindex/nofollow/canonical…) | `meta-nofollow`, `noindex-with-traffic`, `canonical-*` family, `query_audit` |
| 33 | Verify robots.txt behaves as intended | `robots-blocked-with-traffic` + RFC-9309 parser; no interactive rule tester — partial |
| 34 | Find and validate schema/structured data | `missing-structured-data`, `invalid-schema`, `missing-required-fields`, `schema-value-errors`, `forbidden-schema`, `homepage-missing-org-schema`, `breadcrumb-schema-inconsistent` |
| 35 | Generate an XML sitemap from the crawl | **gap** — we audit sitemaps, don't generate them |
| 36 | Generate a sitemap from an uploaded URL list | **gap** |
| 37 | Audit the existing sitemap vs crawl (errors, missing pages) | `sitemap-non-indexable`, `indexable-not-in-sitemap`, `sitemap-orphan`, `sitemap-lastmod-untrustworthy` |
| 38 | Find issues GSC won't surface: >2MB HTML truncation; orphan pages | `large-html`; `orphan-no-links`, `orphan-with-impressions` (GSC-seeded discovery goes further) |
| 39 | Diagnose why a section isn't indexed/ranking (robots/noindex/orphaned, merge GA+GSC) | `coverage-not-indexed`, `inspect_urls`, `ghost-pages`, orphan family |
| 40 | Verify a migration: re-check old URLs in list mode | partial — `traffic-to-dead-url`, `backlinks-to-404`, `detect_changes`; **no arbitrary URL-list ingest ("list mode") = gap** |
| 41 | Find slow-loading pages | `slow-response`, `high-yield-cwv-fail`, `page_lighthouse` |
| 42 | Find malware/spam via footprint search | **gap** (custom-search family) |
| 43 | Verify analytics tag on every page | `analytics-missing` |
| 44 | Bulk-validate a list of PPC/landing URLs | **gap** (list mode again) |
| 45 | Scrape metadata for a URL list | partial — crawled pages only |
| 46 | Scrape pages matching a custom footprint / extraction | **gap** — no custom extraction rules |
| 47 | Strip session ids/parameters from crawled URLs | n/a — url-key normalisation does this automatically |
| 48 | Rewrite/lowercase crawled URLs | n/a — same |
| 49 | Competitor: most internally-linked pages | **gap** — owned-site-only crawling (adjacent: `competitors_domain`, `page_intersection`) |
| 50 | Competitor: internal anchor text | **gap** — same constraint |
| 51 | Competitor: meta keywords | n/a (obsolete signal) |
| 52–56 | Link-building ops: vet prospect lists, broken-link outreach, verify/monitor backlinks, link-network check | mostly n/a (outreach); backlink verify = partial via `pull_backlinks` (counts + live status, no per-link anchor text) |
| 57 | Edit metadata / preview SERP snippets in bulk | partial — `fix_finding` emits paste-ready fixes; no visual SERP preview |
| 58 | Crawl JavaScript-rendered sites; compare raw vs rendered HTML (the LLM-visibility angle) | **gap** — HTTP-only by design (deferred render tier). Flip side: our crawl sees exactly what non-rendering LLM crawlers see |
| 59 | View original vs rendered HTML side by side | **gap** — same |
| 60 | Query crawl data via AI/MCP instead of exports | **covered natively — this is the whole product** (`run_audit`, `query_audit`, conversation-first) |
| 61 | Use AI to triage exports and produce prioritised recommendations | covered — the yield-model priority score, dashboard, `fix_finding` |

**Score:** ~24 fully covered, ~11 partial, ~15 genuine gaps, ~11 n/a. The gaps cluster into four families:
crawl scoping/list-mode, custom search/extraction, resource crawling (CSS/JS), JS rendering, competitor crawling.

## 2. Article skeleton — "How to do a technical SEO audit" (told through our tool)

Follow the standard workflow's order, but every step is a conversation prompt, not a menu screenshot.

1. **Setup & first crawl** — "Refresh simracingcockpit.gg" → one prompt replaces crawler config: GSC sync + crawl (sitemap + GSC-seeded discovery, so orphans are found *by default*, not via API bolt-ons) + URL inspection + ranks.
2. **Indexation first** (the workflow's own priority advice) — "What's stopping pages being indexed?" → coverage, noindex-with-traffic, robots-blocked-with-traffic, ghost-pages. Point of difference: GSC history is *in the join*, not a cross-reference you do by hand in Excel.
3. **Crawl-budget waste** — broken links, redirect chains, links-to-redirects, faceted traps, soft-404s. VLOOKUP step from the classic workflow → `fix_finding` writes the 301 map for you.
4. **On-page & duplication** — titles/metas/H1s, duplicates, canonical family, title-vs-top-query parity (something a crawler alone *cannot* do — needs GSC).
5. **Structured data** — validate + required-fields, not just "find pages with itemtype=".
6. **Sitemap reconciliation** — three-way crawl × sitemap × GSC diff instead of list-mode re-crawls.
7. **Internal links & architecture** — iPR vs traffic (equity-vs-reality), deep pages, underlinked-high-demand; the "internal linking opportunities" step with donor pages named.
8. **Beyond the crawler** (our additions, absent from the classic workflow): prioritisation by expected clicks/dev-hour; period-over-period decay/rising checks; cannibalisation; AI-search readiness (body chunks, passage scoring, `check_agent_readiness`) — the modern answer to the raw-vs-rendered-HTML step; change monitoring (`detect_changes`); paste-ready fixes.
9. **Deliverable** — dashboard + `export_report` instead of 15 CSV exports.

Framing thread: the classic workflow is 60 manual recipes; ours is one prompt per question, with the
GSC merge and priority model doing the filtering the workflow says is "the real skill".
