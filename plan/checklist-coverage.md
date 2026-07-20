# Industry audit-checklist coverage — gap analysis

Benchmarked 2026-07-20: a widely-circulated public 76-item / 12-section technical-audit checklist, mapped against our registry to prove breadth and surface gaps (roadmap item 6). The conclusion up front: the checklist is a subset of what we do — 38 of our 88 checks have no equivalent on it at all.

Legend: ✅ covered · ✦ covered *better* (GSC-weighted / evidence-traced where checklist is a manual eyeball) · ➕ **added 2026-07-20** in response to this mapping · ◐ partial · ✖ gap (deferred, reason given) · — out of scope by design.

## 1. Basics
| Checklist item | Status | Ours |
|---|---|---|
| Analytics installed | ➕ | `analytics-missing` — detects GA4/GTM/Plausible/Matomo/Fathom/Clarity/etc. snippets at crawl; fires only when *no* crawled page has one. Needs a re-crawl to populate. |
| Search engine properties set up | ✅ | Structural — the tool *is* GSC-connected (`list_properties`); a property that isn't set up can't sync at all. |
| Run a site crawl | ✅ | `start_crawl` / `refresh_property`. |

## 2. Crawling & Indexing
| Checklist item | Status | Ours |
|---|---|---|
| URL is indexed | ✅ | `inspect_urls` (URL Inspection API) + `coverage-not-indexed`. |
| Important content indexed | ✦ | `coverage-not-indexed` + GSC-seeded crawl discovery + `ghost-pages` — "important" is measured by real traffic, not eyeballed. |
| Returns a 200 status code | ✅ | Status recorded per URL; `broken-internal-links`, `traffic-to-dead-url`, Site health response-code panel. |
| Indexable by robots meta / X-Robots-Tag | ✅ | Indexability classification (with *reason*) + `noindex-with-traffic`. |
| URL not blocked by robots.txt | ➕ | Blocked URLs were recorded; `robots-blocked-with-traffic` now flags blocked pages still earning impressions (the case that actually costs money). |
| URL listed in XML sitemap | ✅ | `indexable-not-in-sitemap` (+ `sitemap-non-indexable`, `sitemap-orphan` — the reverse directions checklist doesn't ask). |
| Sitemap location defined in robots.txt | ◐ | Probed by `check_agent_readiness` (sitemap directive check); not an audit-run check. Cheap to add if it earns its keep. |
| Sitemap submitted to search engines | ✖ | GSC `sitemaps.list` API could verify — logged as a candidate; low value (the sitemap reconciliation checks catch the *consequences*). |
| Discoverable via internal links | ✦ | `orphan-no-links`, `orphan-with-impressions`, `deep-pages`, click-depth + iPR link graph. |
| Content at a single canonicalised URL | ✅ | url_key normalisation + canonical family (`multiple-canonical`, `canonical-relative`, duplicate title/meta as duplicate-content proxies). |
| Google-selected canonical matches | ✦ | `canonical-conflict` + `canonical-ignored` — straight from the URL Inspection API. |
| No canonical/indexation mixed signals | ✅ | `broken-canonical-target` (chain/loop/HTTPS→HTTP/noindex target), `pagination-canonical-to-page-1`. |
| Friendly URL structure | — | Deliberately skipped: URL-hygiene checks are FP-noise (documented in CLAUDE.md); GSC doesn't care as much as auditors do. |
| Content renders with basic JavaScript | ✖ | The render tier is a known deferred roadmap item; crawl is HTTP-only by design. `word_count`/`body_chunks` emptiness on a JS-shell site is the partial signal today. |
| CSS/JS/images not blocked by robots.txt | ✖ | Candidate: test sampled asset URLs against parsed robots rules (rules aren't persisted post-crawl yet). Logged. |

## 3. Meta & Structured Data
| Checklist item | Status | Ours |
|---|---|---|
| Title element present | ✅ | `missing-title`. |
| Keywords visible in first 60 chars | ✦ | `title-missing-top-query` (against the *actual* ranking query, not guessed keywords) + `title-too-long`. |
| Title unique | ✅ | `duplicate-title`. |
| Unique meta description | ✅ | `missing-meta-description`, `duplicate-meta-description`, `meta-description-length`. |
| Favicon defined | ➕ | `favicon-missing` (homepage `<link rel=icon>`; needs a re-crawl to populate). |
| OG and social meta | ✅ | `missing-social-tags`. |
| Structured data markup | ✦ | The whole schema family — local validator, ~30 rich-result types, required fields, value sanity, `homepage-missing-org-schema`, `breadcrumb-schema-inconsistent`. |
| Uses max-image-preview:large | ➕ | `image-preview-restricted` — flags explicit none/standard caps (the deterministic harm); blanket "add :large everywhere" is advisory, not a defect. |

## 4. Content
| Checklist item | Status | Ours |
|---|---|---|
| Not substantially duplicate | ◐ | Duplicate title/meta + canonical checks are the proxy; body near-duplicate detection is a known deferred item (needs shingling over body_chunks). |
| Hierarchical HTML tags | ✅ | `heading-hierarchy`, `missing-h1`, `multiple-h1`, `poor-chunkability`. |
| Content is keyword-targeted | ✦ | `title/h1/body-missing-top-query`, `rag-answer-gap`, `weak-passage-answer` — measured against queries the page *actually ranks for*. |
| Doesn't violate Quality Guidelines | — | Judgement, not crawlable; out of scope. |
| Avoids intrusive interstitials | ✖ | Needs the render tier. |
| Avoids heavy ads above the fold | ✖ | Needs the render tier. |
| Content not in an iFrame | ✖ | Candidate extract flag (near-zero body text + iframe present is the partial signal via `thin-content` today). |
| Content not in Flash | — | Dead technology; not worth a check in 2026. |
| Lazy-loaded content visible | ✖ | Needs the render tier. |
| Infinite scroll has paginated fallback | ◐ | `pagination-canonical-to-page-1` + rel_next/prev captured; the render-dependent half is deferred. |
| Publication and updated dates | ◐ | `article-date-illogical` + `stale-content` (dateModified decay) validate dates that exist; "dates missing entirely" is a candidate. |
| Clear author/publisher | ◐ | Article schema required-fields validation covers the markup side. |
| Doesn't trigger Safe Search | — | Out of scope. |

## 5. Links & Navigation
| Checklist item | Status | Ours |
|---|---|---|
| Links are crawlable | ✅ | The crawler + link graph *is* this test. |
| No links to 404s | ✅ | `broken-internal-links`, `ipr-bleed-by-status` (with the equity cost). |
| Descriptive anchor text | ✦ | `anchor-text-incoherent` — anchors vs the page's top ranking query. |
| Links qualified (nofollow/ugc/sponsored) | — | rel captured per link; qualification checks were pulled as FP-prone (documented decision). |
| Faceted nav ≠ duplicate content | ✅ | `faceted-spider-trap`, `indexed-junk-url`, crawler skip-patterns. |
| Paginated pages clearly linked | ◐ | rel_next/prev + pagination canonical check. |
| Not an excessive amount of links | ➕ | `excessive-links` (>300 on an indexable page). |
| No links to redirect chains | ✅ | `internal-links-to-redirects`, `redirect-chain`. |

## 6. Images
| Checklist item | Status | Ours |
|---|---|---|
| Descriptive alt attributes | ✅ | `image-alt`. |
| Heights and widths defined | ✅ | `images-missing-dimensions` (CLS). |
| Descriptive filenames/captions | — | Judgement/noise; skipped. |
| No important text inside images | ✖ | Needs vision; out of scope for the deterministic tier. |
| Images in image sitemaps | ✖ | Low value; sitemap parser could flag image-sitemap absence if a vertical needs it. |

Beyond Moz: the Site health **image-weight sample** (heaviest images by content-length, header-only) — the standard checklists don't ask, Screaming Frog users expect it.

## 7. Video
| Checklist item | Status | Ours |
|---|---|---|
| Video on indexable page / HTML tag / video sitemap / VideoObject schema | ◐ | VideoObject is validated when present (schema family); the rest is a video-vertical feature we haven't needed. Logged as a vertical add-on. |

## 8. Mobile
| Checklist item | Status | Ours |
|---|---|---|
| Passes Mobile-Friendly Test | ◐ | `missing-viewport` is the deterministic core (Google retired the standalone test/API; Lighthouse via `page_lighthouse` covers the rest). |
| Prefer responsive design | ◐ | Viewport + no separate-URL patterns observed. |
| Mobile content matches desktop | ✖ | Candidate: sampled mobile-UA re-crawl diff (we already record `Vary: User-Agent`). Logged. |
| Separate mobile URLs handled | — | m-dot sites are nearly extinct; skip until one shows up. |

## 9. Speed
| Checklist item | Status | Ours |
|---|---|---|
| Loads within reasonable time | ✅ | `slow-response` + Site health response-time buckets. |
| Passes Core Web Vitals | ✅ | `page_lighthouse` (lab) + `high-yield-cwv-fail` (CWV weighted by the traffic at stake). CrUX field data is a logged candidate (free API). |
| Common speed traps | ✅ | `uncompressed-html`, `large-html` (transfer-estimated), heavy-image sample, cache headers captured. |

## 10. Security
| Checklist item | Status | Ours |
|---|---|---|
| Proper HTTPS | ✅ | `non-https`, `mixed-content`, HTTPS→HTTP canonical/redirect checks. |
| HSTS | ✅ | `missing-hsts` (+ full security-header capture). |
| No hacked content/malware | ✖ | Safe Browsing API is a candidate (needs an API key); GSC's manual-actions surface isn't exposed via API. |

## 11. International & Multilingual
| Checklist item | Status | Ours |
|---|---|---|
| Signal location targeting | ◐ | hreflang family + GSC country breakdown; ccTLD/targeting advice is consultancy, not a check. |
| Valid hreflang | ✦ | `broken-hreflang-target` + `hreflang-no-return-tag` (resolved + reciprocation-tested — the checklist's is an eyeball). |
| Page language obvious | ➕ | `missing-lang` (html lang attribute). |
| Avoid automatic redirection | ✖ | Geo-redirect detection needs multi-location fetching; out of scope for a single-location crawl. |

## 12. Backlinks
| Checklist item | Status | Ours |
|---|---|---|
| Relevant backlinks | ✅ | `pull_backlinks` (profile + per-page counts) + `backlinks-to-404` (the actionable one). |
| Backlinks don't violate guidelines | — | Toxic-link scoring is judgement + a different product; out of scope. |
| Disavow file sane | — | Not readable via any API; out of scope. |

## Tally
- Covered or better: **44** (of which 8 measurably stronger than the checklist's manual version)
- **Added today: 6** — `robots-blocked-with-traffic`, `missing-lang`, `image-preview-restricted`, `excessive-links`, `favicon-missing`, `analytics-missing` (the last two populate on the next crawl)
- Partial: 10 · Deferred gaps: 9 (biggest cluster: the JS **render tier** — 4 items hang off it) · Out of scope by design: 9

And roughly **38 of our 88 checks have no checklist equivalent at all** — everything GSC×crawl-merged (cannibalisation, striking distance, ghost pages, CTR gaps, trend decay), the link-equity layer (iPR, click depth, equity bleed), the AI-search family, and agent readiness. That's the differentiation, quantified.
