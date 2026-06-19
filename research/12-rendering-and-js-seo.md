---
name: Rendering & JavaScript SEO — the render-parity strategy
description: How seo-audit-console sees what Googlebot's renderer sees. The HTTP-first hybrid crawl, when to escalate to headless render, the raw-vs-rendered diff, and the JS/SPA failure modes a dependable audit must catch. This is the core that makes the tool credible on modern (JS) sites.
type: research
phase: 1
---

# Rendering & JavaScript SEO — render-parity strategy

**Why this is the make-or-break:** Google indexes in two waves — it reads the **raw HTML first**, then queues the page for the **Web Rendering Service (WRS)** which executes JS later (minutes to weeks). Anything that only exists after JS is *delayed or missed*, and anything that *changes* between raw and rendered (canonical, robots, content) creates volatile, hard-to-debug indexing. A tool that only reads raw HTML (fast, like our current `HttpCrawler`) is blind to half of modern SEO; a tool that renders everything is too slow for the MCP model. The answer is a **hybrid: HTTP-first, render selectively, and make the raw-vs-rendered *diff* a first-class output.**

## 1. Hybrid crawl architecture (cheap by default, render when it matters)

Three tiers, escalating cost:

1. **HTTP pass (default, all pages)** — `HttpCrawler` + cheerio, as today. Fast, captures raw HTML / headers / status. This is the bulk of the crawl and stays within the async-job budget.
2. **Render-parity sample (a subset)** — headless render (Playwright) of a representative sample + every page the HTTP pass flags as **JS-dependent** (heuristic below). Produces the raw-vs-rendered diff and CWV ([research/13](13-performance-cwv.md)).
3. **Targeted probes (handful)** — conditional-request / case-flip / UA-cloaking checks ([research/02](02-war-stories.md), [06](06-crawl-integrity.md)) — separate light requests, not full renders.

**JS-dependent heuristic (decide render escalation without rendering everything):** flag a page for render if the raw HTML is an **app-shell** — e.g. body text below a threshold, `<a href>` count near zero, presence of known SPA roots (`<div id="root">`, `<div id="__next">`, `<app-root>`), or a `<noscript>` "enable JavaScript" block. This is the spirit of Crawlee's **`AdaptivePlaywrightCrawler`** ("render only when needed"): cheap HTTP first, escalate to browser only when the static result looks incomplete. We either use it directly or implement the same gate.

**Render performance levers (Crawlee):** low `maxConcurrency` for the browser tier (browsers are heavy); **block images/fonts/media** during render (route abort) so we get the DOM fast without downloading assets — unless the check needs them (CWV/LCP does, so a CWV render is a separate, unblocked pass); `requestHandlerTimeoutSecs` modelled on **WRS's ~5s budget** so we flag what Google would miss.

## 2. The raw-vs-rendered diff (the core deliverable)

For each rendered page, capture **two DOM states** — raw HTML (pre-JS) and post-render DOM (network-idle, capped at the WRS timeout) — and diff:

| Surface | What we compare | Why |
|---------|-----------------|-----|
| `<head>` SEO tags | title, `meta robots`, `canonical`, `hreflang`, `meta description` raw vs rendered | JS-injected/overwritten tags index differently in wave 1 vs 2 (W-series, §3 below) |
| `<body>` text | primary content present in raw? | content only-after-JS is delayed/missed |
| internal links | `<a href>` set raw vs rendered | JS-only links delay discovery, waste crawl budget |
| status semantics | HTTP 200 but rendered DOM says "not found" | SPA soft-404 |
| final URL | requested URL vs post-load URL with no 3xx | JS redirect |

## 3. JS/SPA failure modes a dependable audit must catch

(Detection = raw-vs-rendered diff unless noted. These become checks; severities in the check map.)

1. **Content/links only after JS** — missing text nodes + `<a href>` in raw `<body>`. Delays discovery; crawl-budget risk.
2. **Hydration mismatch** — SSR HTML structure ≠ CSR DOM; high DOM-mutation volume before network-idle → WRS race, content can be missed mid-rebuild. Detect: diff raw vs DOM at `DOMContentLoaded`.
3. **JS-injected/overwritten head tags** — title/canonical/robots/hreflang differ raw vs rendered. **Highest-priority diff** — silent canonicalisation/indexing bugs.
4. **SPA soft-404** — server 200 + client-rendered "not found". Detect: request known-bad URLs, check 200 while rendered DOM shows not-found / late `noindex`. Wastes budget, thin-content dilution.
5. **JS redirect** (`window.location`) — final URL ≠ requested, no 3xx. Equity not passed reliably.
6. **Content behind interaction** (tabs/accordions/click-to-load) — absent from both raw and *initial* rendered DOM. Crawlers don't click → never indexed. Detect: keyword presence in rendered DOM; optionally trigger clickables and diff.
7. **Infinite scroll, no paginated fallback** — DOM grows on scroll, no `<a href>`/`rel=next` pagination. Items beyond viewport undiscovered.
8. **Lazy-loaded primary content** — JS lazy-load (not native `loading=lazy`) gated on scroll. Detect: diff initial DOM vs post-synthetic-scroll.
9. **Shadow DOM / Web Components** — content in closed shadow roots or unupgraded custom elements (`<my-el></my-el>` empty after JS error).
10. **Render-blocking / slow third-party APIs** — primary content not present within the ~5s WRS budget. Detect: snapshot DOM at 5s under throttle; diff vs network-idle DOM.
11. **Streaming / RSC partial-hydration failure** — Suspense/streamed chunks leave skeletons/spinners in final DOM. Detect: rendered DOM has loading state while raw inline data has real content.
12. **Late-injected `noindex`** — raw has no restriction, JS injects `noindex` (geo/UA/state-based). Volatile: indexed in wave 1, deindexed in wave 2. **Alert hard.**

(#3 and #12 are the silent killers — emit at crit. #1/#4/#7 are crawl-budget/discovery. All **D** — they're byte/DOM diffs.)

## 4. Dependability rules

- **Always report which tier saw a finding** — a finding from the HTTP pass vs the rendered DOM is labelled, because they answer different questions (wave 1 vs wave 2 indexing).
- **Model the WRS budget** — snapshot at ~5s (configurable) so "Google would miss this" is grounded, not "given infinite time it renders."
- **Render is sampled + flagged-only by default** — full-site render is opt-in (`render:true`), because it blows the time/cost budget. The JS-dependent heuristic ensures the *pages that need rendering* get it without rendering everything.
- This satisfies "[capable of] js / html website seo": HTML sites cost one cheap HTTP pass; JS sites auto-escalate to render where it matters, and the diff *explains* the wave-1-vs-wave-2 gap no raw-only tool can.

## Sources
- context7 — Crawlee (`/websites/crawlee_dev_js`): `PlaywrightCrawler` (JS rendering, auto-wait locators), `HttpCrawler` (concurrency/timeout), skip-navigation/`sendRequest` (fetch assets without full nav, basis for asset-blocking); AdaptivePlaywrightCrawler ("render only when needed").
- Gemini (`gemini-3.1-pro-preview`, grounded) — the 12 JS/SPA render-parity failure modes + detection, this session.
- [01-checklist](01-modern-technical-seo-checklist.md) §3 (rendering & JS), §0 G4 (render parity); [06-crawl-integrity](06-crawl-integrity.md); [02-war-stories](02-war-stories.md).
- Google two-wave indexing / WRS budget (web.dev / Google Search Central rendering docs).
