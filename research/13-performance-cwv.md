---
name: Performance & Core Web Vitals — lab vs field measurement
description: How seo-audit-console measures performance honestly — cheap deterministic proxies from the HTTP pass, lab CWV from the render tier (web-vitals/Lighthouse), and the authoritative FIELD data from CrUX + GSC. The lab-vs-field distinction is the dependability crux.
type: research
phase: 1
---

# Performance & Core Web Vitals

**The dependability crux: lab ≠ field, and only field ranks.** Google ranks on **field data** (real Chrome users, 28-day p75, surfaced via CrUX + GSC's Core Web Vitals report). Our headless renders produce **lab data** — reproducible, great for *diagnosis*, but not the ranking signal. A dependable tool reports both and never claims a ranking effect from lab numbers alone. (checklist §4)

## 1. Three measurement layers

### A. Cheap proxies — from the HTTP pass (D, every page, no browser)
These don't measure CWV but deterministically flag the *causes*:
- **TTFB** (response timing), **Content-Encoding** (brotli/gzip present?), **HTTP/2 or /3**, **transfer + decoded size** of the HTML.
- **Render-blocking** — parse `<head>` for synchronous `<script>` (no `defer`/`async`) and blocking `<link rel=stylesheet>`.
- **Image hygiene** — formats (AVIF/WebP vs JPEG/PNG), missing `width`/`height` (CLS risk), missing `loading="lazy"` below fold, missing `fetchpriority="high"`/preload on the likely LCP image.
- **Asset weight** — sizes of referenced JS/CSS/img (the "resources of excessive size" check the user named) via HEAD/`Content-Length` (use Crawlee `skipNavigation`+`sendRequest` to size assets without full navigation).
- **Cache policy** — `Cache-Control`/`s-maxage`/`stale-while-revalidate` on assets + HTML.

### B. Lab CWV — from the render tier (D-ish, sampled/flagged pages, browser)
On the pages we already render for parity ([research/12](12-rendering-and-js-seo.md)):
- Inject **`web-vitals`** (Google's library, the same logic Chrome reports) — use the **attribution build** so we get not just the number but the *cause*: **LCP element** (which node + whether it's lazy/hydration-delayed), **CLS sources** (which shifting elements), **INP target**. That turns "CLS 0.3" into "this hero image with no dimensions causes it" — actionable.
- **Caveat: synthetic INP is unreliable** (INP needs real user interaction; a headless load can't reproduce it). Report lab INP as an estimate or skip it; trust field INP from CrUX.
- Lighthouse-style scoring optional, but `web-vitals` attribution is lighter and more targeted for our diff model.
- Throttle to a defined profile (Slow-4G/mid-tier mobile) for reproducibility; report the profile with the number.

### C. Field CWV — the authoritative signal (G/external)
- **CrUX** — free public API, real-user p75 LCP/INP/CLS by origin + URL (where available). This is closest to what Google ranks on.
- **GSC Core Web Vitals / Page Experience report** — already in our GSC reach; per-URL-group pass/fail.
- **Reconcile lab vs field:** lab green + field red ⇒ the lab profile doesn't match the real audience (device/geo/network) — investigate, don't dismiss. Field is truth; lab explains *why*.

## 2. What we report per page
`{ url_key, field: {lcp,inp,cls, source:'crux'|'gsc'}, lab: {lcp,cls, profile, lcpElement, clsSources}, proxies: {ttfb, renderBlocking[], oversizedAssets[], imageIssues[]} }` — with thresholds LCP<2.5s, INP<200ms, CLS<0.1 @ p75 mobile.

## 3. Dependability rules
- **Label honestly:** proxies + lab = `D` (reproducible, but diagnostic); field = `G`/external (the ranking signal). Never present lab as the ranking signal.
- **Attribution over scores:** a number with no cause is not actionable — always emit the LCP element / CLS source / blocking resource, so it feeds the recommendation engine's effort estimate.
- **Sampled, not universal:** lab CWV runs on the render sample + flagged pages (cost), like §12; field data is cheap per-URL and can cover more.

## Sources
- context7 — Google `web-vitals` (`/googlechrome/web-vitals`): attribution build (LCP element, CLS sources, INP target), matches Chrome's CrUX reporting; web.dev CWV guidance.
- [01-checklist](01-modern-technical-seo-checklist.md) §4 (CWV & performance, #89–108); [12-rendering-and-js-seo](12-rendering-and-js-seo.md) (the render tier these reuse).
- CrUX API; GSC Core Web Vitals report; thresholds per web.dev (LCP 2.5s / INP 200ms / CLS 0.1, p75).
