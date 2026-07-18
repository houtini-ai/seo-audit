# The Definitive Technical SEO Audit — HTML Source & Crawl-Layer Specification

**Version 0.1 — 2026-07-18**
Built to feed an automated auditor: every check states the defect, the mechanical consequence (what the parser/crawler actually does), and programmatic detection.

Severity key: **P0** silently deindexes or hides content · **P1** corrupts signals or wastes crawl budget · **P2** degrades quality/clarity.

---

## A. Fetch & HTTP layer

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| A1 | P0 | `X-Robots-Tag` header conflicts with meta robots | Google combines directives and honours the **most restrictive** — a stray header `noindex` beats an HTML `index` | Compare header vs parsed meta on every fetch |
| A2 | P1 | HTTP `Link: <…>; rel="canonical"` header diverges from HTML canonical | Two canonical signals → Google ignores both and falls back to algorithmic selection | Compare header canonical vs DOM canonical |
| A3 | P0 | Soft 404s — error/empty pages returning 200 | Wastes crawl budget; Google may classify as soft-404 and drop, or index junk | Fetch a randomised path (`/x7f3q9…`) — must not be 200; flag 200 pages with error-title patterns or content volume ≪ site median |
| A4 | P1 | Redirect chains > 1 hop, loops, mixed 301/302 in one chain | Each hop delays discovery; loops burn the crawler's hop limit; mixed types muddy canonicalisation | Trace 3xx chains; flag length > 1 (fail > 3), any cycle, any 301+302 mix |
| A5 | P1 | Wrong `Content-Type` for HTML (text/plain, application/octet-stream) | The document is never parsed as a web page | Header check on every 200 HTML response |
| A6 | P1 | Response > ~15 MB, or > 1 MB of inline script/style/base64 before `<body>` content | Googlebot truncates fetches around 15 MB — links/content past the cut don't exist; front-loaded inline payloads push content toward it | Byte-size of raw response; byte offset of first meaningful body content |
| A7 | P2 | `Vary: User-Agent` without actual dynamic serving | Cache fragmentation, doubled crawl cost | Diff desktop vs mobile Googlebot fetches; flag identical bodies with the header present |
| A8 | P1 | Charset in HTTP header conflicts with meta charset | Header wins; the meta is dead code and the divergence hides mojibake bugs | Compare header charset vs first in-document declaration |
| A9 | P2 | Missing HSTS / HTTP not redirecting to HTTPS / mixed content | Split crawl equity across schemes; browser warnings | Fetch http:// variant, expect single 301 to https; scan rendered DOM for http:// subresources |

## B. Document validity & parser behaviour

The checks most auditors never run — where the DOM Google indexes diverges from the source your CMS wrote.

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| B1 | **P0** | **Premature `<head>` termination** — flow content (`<img>`, `<iframe>`, `<div>`, text) inside head | HTML5 parser implicitly closes `<head>` and opens `<body>` at the first non-head-legal token. Every `<meta>`, `<link rel=canonical>`, hreflang after it is hoisted into body — **and Google ignores robots/canonical/hreflang in body**. The page looks fine in a browser. | Lex the raw source: inside head, allow only `title, base, link, meta, script, style, template, noscript` and whitespace. Flag the first offender and every SEO-critical tag after it |
| B2 | P0 | Unclosed or malformed comment (`<!--` never closed, `--!>` typo) | The parser consumes the rest of the head — or the page — as comment text. Google sees an empty head | Track comment open/close state through the source; flag EOF or `</head>` reached inside a comment |
| B3 | P0 | BOM (`EF BB BF`) anywhere except byte 0; null bytes before `</head>` | Mid-document BOM/null becomes a text node → premature head close (see B1); some WAFs/parsers truncate at null | Byte scan: BOM at offset > 0, any `\x00` |
| B4 | P1 | Missing/late doctype, or junk before it | Quirks mode changes layout and historically parser behaviour; whitespace/comment before doctype is safe but real content isn't | First non-whitespace bytes must be `<!doctype html` (case-insensitive) |
| B5 | P1 | Meta charset after byte 1024 | The pre-scanner only reads 1 KB; late charset forces a re-parse and can garble non-ASCII titles/descriptions | Byte offset of charset declaration; also flag anything bulky (comments, http-equiv padding) pushing it down |
| B6 | P1 | Multiple/conflicting charset declarations | First-within-1024 wins; the rest are dead and mask encoding bugs | Collect all declarations; flag > 1 distinct value |
| B7 | P1 | `<noscript>` in head containing anything but `link/meta/style` | With scripting off, its content is parsed — flow content closes the head early; creates raw-vs-rendered divergence | Parse noscript contents in head against the allowlist |
| B8 | P2 | Multiple `<html>`/`<body>` tags, `<head>` absent entirely | Parsers merge attributes from duplicates unpredictably; attribute conflicts (e.g. two `lang` values) become ambiguous | Count occurrences; diff attribute sets |
| B9 | P2 | `-->` inside inline scripts / templating leftovers (`{{ }}`, `<% %>`) in output | Can terminate a surrounding comment or leak template source into indexed text | Pattern scan inside script bodies and visible text |

## C. `<head>` directives

### C-i. Robots meta

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| C1 | P0 | `robots` vs `googlebot` meta conflict | Most restrictive combination wins — `googlebot=index` does not rescue `robots=noindex` | Parse both; union the directives; flag conflicts |
| C2 | P0 | Robots meta outside head (incl. via B1 hoisting) | Only head placement is honoured — a body `noindex` is ignored (page indexes against intent); conversely a *hoisted* `noindex` might be your only one | Position check against the *real* (parser-computed) head boundary |
| C3 | P1 | Typo/unknown directives (`no-index`, `noindex,nofollow` run-ons, stray values) | Unrecognised tokens are silently dropped → page defaults to index,follow | Validate each comma-split token against the allowlist (noindex, nofollow, none, all, noarchive, nosnippet, max-snippet, max-image-preview, max-video-preview, notranslate, noimageindex, unavailable_after, indexifembedded, data-nosnippet is attr-level) |
| C4 | P1 | Directives duplicated across meta + `X-Robots-Tag` with different scopes (`unavailable_after` dates disagreeing, etc.) | Union of all sources applies; stale dates in one source override intent | Cross-source diff |

### C-ii. Canonical

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| C5 | P0 | Multiple canonicals (incl. header + HTML) | All are ignored; Google picks its own | Count across HTML + headers |
| C6 | P0 | Canonical hoisted into body (B1) | Body canonicals are ignored | Parser-computed position |
| C7 | P1 | Relative canonical | Resolves against current URL or `<base>` — on staging/http/parameter variants it points somewhere unintended | Require absolute `https?://`; resolve and compare |
| C8 | P1 | Canonical + noindex on the same page | Contradictory (consolidate-here vs remove-me); Google usually honours noindex, equity is lost | Co-occurrence flag |
| C9 | P1 | Canonical to 3xx/4xx/5xx target, or to a noindexed/blocked URL | The assignment is dropped; expect "Duplicate, Google chose different canonical" | HEAD the canonical target; status must be 200 and target must be indexable |
| C10 | P1 | Canonical containing `#fragment` or unnormalised encoding (spaces, uppercase %-escapes, non-sorted params) | Fragments invalidate the canonical; encoding mismatches split clusters | Syntax validation + normalisation diff against final URL |
| C11 | P2 | Canonical-to-page-1 on paginated series | Declares pages 2+ duplicates of page 1 — strands everything deep-linked from them | Detect pagination params/paths whose canonical target is page 1 |

### C-iii. Hreflang

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| C12 | P1 | Invalid codes (`en-UK`, `gb`, `eu`, underscores) | The entry is silently discarded — no error anywhere | ISO 639-1 + ISO 3166-1 alpha-2 validation (`en-GB` not `en-UK`) |
| C13 | P1 | Missing return links | Mutual confirmation required; one-way declarations are ignored | Cluster fetch: every target must link back to every member |
| C14 | P1 | Relative hreflang URLs | Spec requires absolute; relative entries are dropped | Absolute-URL check |
| C15 | P1 | Hreflang to redirected/noindexed/404 targets | Broken cluster member degrades or voids the whole cluster | Status + indexability check per target |
| C16 | P2 | Multiple `x-default`, or x-default missing on selector pages | Signal ignored when duplicated; without it, geo-guessing rules | Count per page; presence check where a language selector exists |
| C17 | P2 | `<html lang>` disagrees with the page's own hreflang self-reference; hreflang duplicated across head, header, and sitemap with different values | Conflicting language signals; the three delivery channels must agree | Cross-channel diff |

### C-iv. Title, base, and the rest

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| C18 | P1 | Multiple `<title>`; empty title; title after head-break | First usually wins in browsers, but Google rewrites low-confidence titles; a hoisted title competes with SVG titles | Count in parser-computed head; length > 0 |
| C19 | P1 | SVG `<title>` pollution | After a head-break, an inline SVG's `<title>Icon</title>` can become the document title candidate — snippets titled "Icon" | Flag `<title>` inside `svg` namespace when document title is missing/hoisted |
| C20 | P1 | `<base href>` present with any relative canonical/hreflang/og URL | Every relative URL in the document re-resolves against it — canonicals silently 404 | If base exists, re-resolve all relative SEO URLs and verify status |
| C21 | P1 | `meta refresh` with delay > 0 (soft redirect); refresh chains | `0;url=` is treated as a redirect; delayed refreshes get the *interstitial* indexed | Parse `http-equiv=refresh` content values |
| C22 | P2 | Unknown/deprecated http-equiv pragmas padding the head | Mostly inert — but they push charset past 1024 (B5) and bloat the pre-scan window | Allowlist: content-type, refresh, x-ua-compatible, content-security-policy, default-style |
| C23 | P2 | Viewport missing/broken (`user-scalable=no`, fixed width) | Mobile-first indexing (100% complete since July 2024) evaluates the mobile experience | Parse viewport content |

## D. Body & content layer

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| D1 | P1 | Hidden content: `display:none`/`visibility:hidden`/`opacity:0`/offscreen/`font-size:0`/colour-on-same-colour | Discounted, and the stuffing patterns are classic spam signals | Computed styles on rendered DOM; compare text volume hidden vs visible |
| D2 | P1 | Critical content only in `<template>` or `<noscript>` | Template content doesn't render until JS instantiates it; Google usually ignores noscript bodies | Diff raw template/noscript content against rendered DOM |
| D3 | P2 | H1 count ≠ 1; heading level skips (H2→H4) | Diluted/absent topical anchor; broken outline for a11y and extraction | Heading sequence walk |
| D4 | P1 | Core content inside iframes; sandboxed iframes without needed allowances; nested iframes | Iframe content is attributed to its own src URL, not the host page | Text-volume diff host vs frames; sandbox attr audit |
| D5 | P2 | Duplicate `id` attributes | Fragment anchors (`#section`, scroll-to-text fallbacks) bind to the first occurrence only | Count duplicate ids |
| D6 | P2 | Boilerplate dominance — nav/footer text ≫ main content | Extraction sees a template with no page | Text ratio main-content-container vs page |

## E. Links & crawl architecture

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| E1 | P1 | Internal `rel=nofollow/sponsored/ugc` | Sculpting hasn't worked since 2009 — it just evaporates equity and can strand pages | Rel audit on internal hrefs |
| E2 | P0 | Links without crawlable href: `onclick` navigation, `href="#"`, `javascript:void(0)`, `<button>`-as-link, router `<div>`s | Google extracts URLs from `href` on `<a>` — nothing else. These paths don't exist | Flag interactive elements that navigate without a real href |
| E3 | P1 | Fragment-routing for distinct content (`#/products/x`) | Fragments are discarded — one URL, one document as far as Google is concerned | Hash-router pattern detection |
| E4 | P1 | Faceted nav / infinite spaces (calendars, sort/session params) without canonical+robots strategy | Spider traps: infinite URL space, finite crawl budget | Parameter-combination growth analysis on crawl; session-id patterns in hrefs |
| E5 | P2 | Empty anchors; image-links with no alt (alt *is* the anchor text); generic anchors at scale | Zero relevance transfer | Anchor text extraction incl. img alt fallback |
| E6 | P2 | Orphan pages (in sitemap, no internal links in) | Crawlable but unranked — no internal equity | Sitemap vs crawl-graph diff |

## F. Images & media

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| F1 | P1 | `data-src` lazy-load with no `src`/no fallback | Crawlers don't scroll; the image may never exist for them | Raw-source img audit |
| F2 | P2 | `loading="lazy"` on above-fold/LCP images | Delays LCP — hurts CWV assessment | Position of lazy images vs viewport |
| F3 | P2 | LQIP placeholder in source, upgrade only via JS | Index gets the blurry base64 if rendering is late/fails | Raw src is `data:` and rendered src differs |
| F4 | P2 | Content imagery via CSS background only; broken `srcset` (missing descriptors, duplicate widths) | Invisible to image indexing; wrong candidate selection | CSS/DOM audit; srcset grammar validation |

## G. JavaScript rendering divergence

The December 2025 Google guidance makes this explicit: serve canonical, robots, title, and structured data in the initial HTML.

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| G1 | P0 | Raw vs rendered disagreement on canonical/robots/title | Google "may use either" for canonical conflicts; a raw-HTML noindex may stick even if JS removes it | Field-by-field diff raw vs headless-rendered |
| G2 | P0 | Meta tags injected via JS on non-200 pages | Google does not render JS on non-200 responses — the injected tags are invisible | Status + injection audit |
| G3 | P1 | Content/links only after user events or IntersectionObserver fetches | Googlebot clicks nothing and scrolls approximately nothing | Compare idle-rendered DOM vs post-interaction DOM |
| G4 | P1 | Client-side redirects (`window.location`) | No equity, slow discovery, soft-404/cloaking ambiguity | Navigation monitoring in headless trace |
| G5 | P1 | Hydration wipes server HTML (empty-shell flash) | If rendering is deferred/fails, the indexed version is the shell | DOM thrash detection in first ~2s |
| G6 | P2 | Critical text in shadow DOM / web components without light-DOM fallback | Indexable in modern rendering but fragile; diverges from raw source entirely | Rendered-DOM extraction incl. shadow roots vs raw |

## H. Structured data

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| H1 | P1 | JSON-LD syntax errors (trailing commas, unescaped quotes, HTML entities in JSON) | One character voids the whole block — and every rich result it carried | Strict JSON parse of every block |
| H2 | P1 | Markup describing content not visible on page (prices, reviews, events) | Spam-policy violation; manual-action surface | Cross-reference marked-up values against rendered text |
| H3 | P2 | Multiple top-level entities with no `@id`/mainEntity linkage; duplicate conflicting blocks (plugin + theme both emitting Organization) | Ambiguous primary entity | Graph parse; duplicate-type detection |
| H4 | P2 | Time-sensitive markup (Product/offer) injected only via JS | Delayed processing per Google's Dec-2025 guidance — stale prices in results | Raw-vs-rendered presence check |

## I. Site-level: robots.txt & sitemaps

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| I1 | P0 | robots.txt served 5xx persistently | Google treats persistent 5xx as *unavailable* → after ~30 days may crawl as if no robots exists (behaviour differs by engine); short-term it means **crawl nothing** | Status monitoring, not just one fetch |
| I2 | P1 | BOM in robots.txt | First directive (usually `User-agent`) fails to parse — the group silently applies to nobody | Byte check on first line |
| I3 | P1 | Case traps (`Disallow: /Admin/` vs `/admin/`); wildcard patterns matching more than intended (`Disallow: /*?` killing all parameters) | Paths are case-sensitive; wildcards are greedy | Simulate the matcher against the real URL inventory |
| I4 | P0 | Blocking CSS/JS needed for render | Google can't establish mobile-friendliness or see content — renders the naked HTML | Cross-reference rendered-page resource URLs against the matcher |
| I5 | P2 | Cross-domain `Sitemap:` declarations without verification; sitemap URLs that are non-canonical, redirected, noindexed, or dead | The sitemap lies — Google learns to distrust it (and your `lastmod`) | Sample-fetch sitemap URLs; compare against canonical set |
| I6 | P2 | `lastmod` values that are all identical / regenerated on every build | Ignored once proven unreliable — you lose the recrawl hint | Distribution analysis of lastmod values |
| I7 | P2 | AI-crawler policy unreviewed (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Bytespider) | Blocking Google-Extended doesn't affect Search/AI Overviews; blocking GPTBot doesn't stop ChatGPT-User browsing — policy should be deliberate, not default | Parse robots groups against the known-agent table; report the effective policy |

## J. Rendering infrastructure & delivery

| ID | Sev | Check | Mechanism | Detection |
|----|-----|-------|-----------|-----------|
| J1 | P0 | Service worker serving a stale/offline shell to the renderer | Google's Web Rendering Service executes service workers — a cache-first SW can feed WRS an empty app shell forever while users see fresh content | Fetch with SW bypassed vs registered; diff rendered output; verify in GSC live test |
| J2 | P0 | Main thread / network never idles (polling loops, WebSockets, heavy sync JS) | WRS snapshots at network-idle; a page that never idles gets snapshotted blank or partial | Performance trace: flag pages not reaching idle within ~5s of load |
| J3 | P1 | Text/navigation drawn on `<canvas>`/WebGL only | No OCR — pixels aren't content; canvas-routed links don't exist | Flag visible text absent from DOM text nodes |
| J4 | **P0** | CDN/WAF/bot-management blocking Google's ASN or geofencing datacenter IPs | Users see a healthy site; Googlebot gets silent 403s/TCP resets/geo-redirects — pages drop with no on-page defect at all | Fetch from a datacenter IP (GCP US) with Googlebot UA; GSC URL Inspection live test; server-log verification of actual Googlebot hits |

---

## Execution model (how an auditor should run this)

1. **Byte layer** — raw response: BOM/null scan, doctype, charset offset, size (A, B3–B6).
2. **Lexical layer** — tokenizer with head-boundary tracking: this is where B1/B2/C2/C6 live, and it must use the *parser's* head, not the source's `</head>`.
3. **DOM layer** — parsed document: directive extraction, link graph, headings, structured data (C, D, E, H).
4. **Rendered layer** — headless pass: computed styles, raw-vs-rendered diffs, shadow DOM, interaction gating (D1, G).
5. **Network layer** — headers, redirect traces, canonical/hreflang target verification, robots simulation, sitemap sampling (A, C9, C13, I).
6. **Site layer** — crawl-graph aggregation: orphans, facets, parameter growth, anchor-text distribution (E4–E6).

Raw-vs-rendered is not one check — it's a *dimension* that applies to every directive-bearing element. Audit both, diff always.

## What this deliberately excludes

Content quality, E-E-A-T, backlinks, rankings, Core Web Vitals field data — those are adjacent audits with their own orchestration. This spec is the layer beneath: **does the document, as actually parsed, say what you think it says?**
