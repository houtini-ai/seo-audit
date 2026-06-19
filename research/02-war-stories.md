---
name: War stories — specific, deterministically-detectable failure modes
description: The deep-tail technical SEO failure modes that have tanked real sites and that an automated crawl/header check can catch. These are the rules that justify a senior audit; most OSS tools miss them ([07-prior-art] gap #10).
type: research
phase: 1
---

# War stories — the deep-tail failure modes

**Why this file:** anyone can check title length. The value of a senior audit is the long tail of specific, known-killer failure modes. Each below is **deterministic (D)** — same site/UA/time → same answer — with a concrete detection method. These map into the checklist §1.5/§1.6 and become individual checks in `plan/tool-surface.md`.

## Already in the master checklist (§1.6)
iframe in `<head>` (#51), invalid HTML closing `<head>` early (#52), `Vary: User-Agent` + cache (#54), `If-Modified-Since` 304 loops (#55), soft-404 (200 for not-found) (#47), CDN stale-404 cache (#60), robots-blocked CSS/JS (#57), 503 to Googlebot without `Retry-After` (#58), hreflang reciprocity (#182).

## Additional war stories (to add as checks)

| # | Failure | Why it kills rankings | Detection |
|---|---------|----------------------|-----------|
| W1 | **Header `X-Robots-Tag: noindex` contradicting on-page `meta robots index`** | engines take the most restrictive → silent deindex invisible in page source | parse BOTH HTTP headers and HTML meta; flag header-more-restrictive mismatch (checklist #67) |
| W2 | **Relative canonical without leading slash** (`href="category"`) | infinite-depth crawl trap `/category/category/…`, equity dilution | flag canonical `href` with no protocol/domain/leading slash (checklist #136) |
| W3 | **Production carrying a staging `<base href>`** | all relative links/assets resolve to (blocked) staging → site looks broken/linkless to crawler | extract `<base>`; flag host ≠ crawl target host |
| W4 | **Paginated pages canonicalising to page 1** | deep paginated items deindexed → products/articles orphaned out of index | flag URL with pagination param canonical→ same URL without it |
| W5 | **HTTP `Link:` header alternate pointing to broken/legacy mobile URL** | engines process `Link` headers like `<link>`; broken alternate breaks mobile indexing | scan `Link:` headers; validate destination status + index rules |
| W6 | **`Content-Encoding` mismatch** (header says gzip/br, body is plain — or vice versa) | strict crawlers decompress, fail, read garbage → drop as empty | compare `Content-Encoding` vs payload magic bytes |
| W7 | **0-second meta refresh to a robots-blocked URL** | treated as 301; signals hit the block; origin dropped | extract `http-equiv=refresh` ≤5s; check destination against robots |
| W8 | **`x-default` hreflang that IP-redirects** | Googlebot (US) gets 302'd off the selector page → hreflang cluster breaks | crawl the `x-default` URL; flag 30x instead of 200 |
| W9 | **Canonical to a hash fragment** (`…/page#section`) | hash ignored for indexing → canonical invalid → unpredictable algo canonicalisation | flag canonical `href` containing `#` |
| W10 | **Missing/incorrect `Content-Type`** (absent, or `application/json` for HTML) | crawler may treat as download/API, refuse to render | assert every page `Content-Type` starts `text/html` |
| W11 | **Cookie-gated 200s** (no-cookie request gets an "enable cookies" page at 200) | stateless Googlebot sees boilerplate sitewide → thin/dupe deindex | crawl stateless (no cookie jar); diff text/DOM hash vs cookie'd render |
| W12 | **Case-sensitivity duplicate trap** (`/About-Us` and `/about-us` both 200, no self-canonical) | exponential dupes, equity split, crawl-budget waste | request case-flipped sample; flag 200 without canonical→ canonical case |
| W13 | **Conditional Googlebot cloaking** (different content/status to Googlebot UA vs Chrome UA) | content mismatch / hidden cloaking | fetch sample as Googlebot UA vs vanilla; diff (checklist #7, #85) |

## Notes
- W1, W2, W4, W9 are **canonical/indexation** bugs — high false-negative cost; they silently deindex revenue pages.
- W3, W6, W10, W11 are **delivery** bugs — they make a perfectly good page look broken to the crawler only.
- Several need a **second targeted request** beyond the main crawl (case-flip W12, stateless-vs-cookie W11, Googlebot-UA W13, conditional-request W6/W10) → these belong in the `core/conditional-probe.ts` post-crawl pass, not the main fetch loop.

## Sources
- Gemini (`gemini-3.1-pro-preview`, grounded) — W1–W12 failure modes + detection, this session.
- [01-modern-technical-seo-checklist.md](01-modern-technical-seo-checklist.md) §1.5–1.6; [07-prior-art.md](07-prior-art.md) gap #10 (war-story rules absent from OSS tools).
- Protocol refs: MDN 304 Not Modified; RFC 9309 (robots); RFC 8288 (`Link` headers).
