# The check registry

All 143 checks `run_audit` evaluates, grouped by category. This list is generated from the registry in `src/audit/checks.ts` - if the code and this page ever disagree, the code wins, and `list_checks` always returns the live list.

## Reading the labels

- **D** - deterministic. The finding cites bytes: a status code, a missing tag, a recorded redirect. If it fires, the thing is true.
- **G** - the evidence comes from Google's own data (Search Console or URL Inspection) rather than the crawl. Still hard numbers, just Google's numbers.
- **N** - judgement. A heuristic that can be wrong, so it only runs when you ask for it (`includeJudgement:true`, or *"include the judgement findings"*). Each carries a certainty figure below 1 that discounts its priority.

A check can carry more than one label - `noindex-with-traffic` is D+G because the noindex is in your bytes and the traffic is in Google's.

Every finding is priced the same way: priority = (traffic at stake × expected yield × certainty) / effort hours. So the list you get back is ordered by expected clicks per developer-hour, not by how alarming the check sounds.

Traffic at stake is the page's own real clicks - the traffic the fix protects or recovers. (The curve-implied "what the impressions could earn at this position" is used only by the CTR and page-2 opportunity checks, `ctr-below-expected`, `title-missing-top-query` and `striking-distance`, and there it's the *recoverable gap*, impressions times expected-CTR minus the clicks already earned. Pricing every check at the curve let a well-ranking page with a SERP-feature CTR gap claim its whole curve traffic for, say, an oversized image - up to 75 times the page's real clicks.) One further adjustment, since 0.16.1: **page-experience findings stake a tenth of the page's clicks, not all of them.** The asset checks (`image-oversized`, `image-legacy-format`, `static-asset-uncached`, `render-blocking-head-resources`, `broken-image`) and the accessibility checks are about one file or element of a page, and they're keyed to the page with the most clicks. Before 0.16.1 that gave an oversized image on your top page the page's full click count, so it outranked a high-severity CTR or traffic-decay finding on the same page. Fixing one image or one cache header doesn't put a page's clicks at stake the way a snippet, indexation or content fix does: page experience is a light ranking signal next to relevance, accessibility isn't one, and the file is one of many the page loads. The right share would be the part of the page's weight or LCP the file accounts for, but the crawl doesn't download bodies or know the LCP element, so 10% is a stated assumption (`PAGE_EXPERIENCE_STAKE_SHARE` in `src/audit/stakes.ts`), shown on each finding as `stakeShare`. It changes the order only: every finding is still reported, and a perf problem on a genuinely big page still ranks high. `high-yield-cwv-fail`, which reads measured field data per page, keeps the full stake.

Zero findings from a check normally means it passed. The exception is a check whose source table is empty because the data was never collected (the asset checks read `page_resources`, `resource_assets` and `image_assets`; `soft-404-handling` and `host-variant-split` read the crawl's site probes; the four JS-render divergence checks read `render_audit`, filled by `render_pages`): `run_audit` lists those under **Not collected** with the step that collects the data, so an empty table never reads as a clean bill of health.

## Thresholds we chose

Most thresholds here are Google's (Core Web Vitals bands, snippet rules, redirect behaviour) or a plain fact (a status code). Two are house defaults, picked by us because Google publishes no number, and approved as the 0.16.0 defaults (17 Oct 2026). Treat them as a starting point, not a rule:

| Check | Fires when | Why that number |
|---|---|---|
| `render-blocking-head-resources` | 3 or more render-blocking stylesheets in `<head>` (any parser-blocking script fires on its own) | A styled page needs its own stylesheet, and a font or plugin sheet beside it is the usual floor, so 1-2 aren't reported. |
| `hydration-content-loss` | The rendered main content keeps 50% or less of the raw main content's words, where the raw had at least 200 | Below 200 words the ratio is noise (a short page swings on one block); losing more than half is past any template difference. |

## Crawlability (21)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `broken-internal-links` | D | Internal links pointing at 4xx/5xx URLs | Repoint them to a live, canonical URL (`fix_finding` writes the 301). |
| `broken-subresource` | D | A CSS, JavaScript or font file pages load that answers 4xx/5xx (a 429/503 or a failed probe is unknown), one finding per file with the pages loading it. Needs a crawl with `headResources:true`; images are `broken-image`'s | Restore the file or fix the reference - the page renders without it, for Googlebot too. |
| `content-only-in-rendered-dom` | D | Content or internal links that exist only after JavaScript runs (needs `render_pages`) | Server-side render or pre-render the critical content and in-site links so they're in the initial HTML - don't rely on client-side JS for primary navigation or copy. |
| `redirect-chain` | D | Redirects of 2+ hops that stay on the site and resolve (keyed by the final page, whose row records the chain). Chains that leave the site, never resolve, loop, or run through a login/account/cart flow are not counted: a Shopify store's OAuth bounces used to read as ~1,300 chains | Collapse to a single hop to the final URL. |
| `redirect-to-non-indexable` | D | An internal redirect whose final URL is a 4xx/5xx (not a 429/503 or a rate-limited fetch, which are unknown), a noindex page or a page canonicalised elsewhere. Excluded: a non-HTML target (a PDF), an http->https hop onto the same URL, and a backlinked source landing on a dead page (that's `backlinks-to-404`) | Point the redirect at the live, indexable, self-canonical replacement. |
| `redirect-loop` | D | A redirect chain that revisits a URL, or is still redirecting after the crawler's 5-hop cap. Internal chains only; login/account/cart flows excluded | Fix the disagreeing rules so the URL resolves to a 200 in one hop. |
| `temporary-redirect-with-equity` | D+G | A 302/303/307 first hop on a URL with equity: GSC clicks >= 1 or impressions >= 10 over the history held, a backlink, or an internal link from another page. Excluded: the homepage (a geo/locale 302 is deliberate), off-site and login/cart flows | Make it a 301/308 if the move is permanent, and repoint the internal links. |
| `redirect-retired` | D+G | A URL that answered 200 in an earlier crawl's snapshot and now answers 404/410 with no redirect, with equity (same rule as above). A URL the latest crawl didn't reach is not "gone"; store products go to `product-gone-404`. Needs two crawls on different dates | 301 it to the closest live equivalent, or restore it. |
| `internal-links-to-redirects` | D | Internal links that travel through a redirect | Repoint to the final URL - saves crawl budget and equity. |
| `meta-nofollow` | D | Pages with meta robots nofollow | Remove it unless you mean to drop all link equity from the page. |
| `deep-pages` | D | Pages 4+ body-link clicks from the homepage | Add in-content links from higher-level pages. |
| `backlinks-to-404` | D | External backlinks hitting a dead page (needs `pull_backlinks`). Status comes from the latest crawl first (backlinked URLs are seeded); a URL that now redirects to a live page isn't flagged | 301 the URL to its best live equivalent - that equity is already earned. |
| `orphan-no-links` | D | Indexable pages with zero inlinks and no backlinks | Add internal links; the page currently depends on the sitemap alone. |
| `ipr-bleed-by-status` | D | Internal PageRank flowing into non-200 URLs | Repoint or 301 the links - high-authority pages are wasting equity on dead targets. |
| `faceted-spider-trap` | D+G | Indexable multi-parameter filter URLs earning zero search traffic | noindex, disallow or canonicalise them - they burn crawl budget for nothing. |
| `pagination-canonical-to-page-1` | D | Page 2+ canonicalising back to page 1 | Make each paginated page self-canonical, or items linked only from deep pages drop out of the crawl. |
| `sitemap-orphan` | D | Sitemap URLs nothing on the site links to | Add internal links - sitemap discovery alone earns little authority. |
| `robots-blocked-with-traffic` | D+G | robots.txt-disallowed URLs Google still shows and users still land on | Unblock it so it can rank properly, or unblock AND noindex (a blocked page can never see the noindex). |
| `ai-search-bot-blocked` | D | robots.txt (as the latest crawl fetched it) blocks an AI **search** crawler - OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, DuckAssistBot - from the whole site or from any of your top 50 pages by clicks. One site-level finding listing each bot and the group that blocks it. Training crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended, Bytespider...) are listed for context only: blocking them is a choice, not an issue | Allow the search bots so assistants can cite you; keep the training-bot Disallow lines if you want to opt out of training. |
| `discover-crawl-waste` | D | Too much of the crawl going to redirects and non-indexable URLs (site-level - Discover leans on fast discovery) | Aim for almost everything Google crawls to be an indexable 200 - repoint links off redirects/404s and prune faceted/parameter URLs. |
| `entity-internal-link-gap` | N (0.5) | Topically related pages (per Wikidata) with no link between them | Link the broader page to the more specific one - after verifying the entity match. Needs `resolve_entities`. |

## Indexation (29)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `site-wide-indexing-alarm` | D+G | **Critical, one site-level finding.** Any of: the homepage carries noindex; more than half of the sitemap's crawled 200 URLs (min 5) carry noindex; robots.txt disallows `/` for Googlebot (RFC 9309 most-specific group); or the number of distinct pages earning impressions fell more than 40% week on week (last 7 finalised GSC days vs the 7 before, prior week at least 50 pages; smaller weekly dips are ordinary variation, and a shipped noindex removes half or more within days). Each trigger cites its rows | Usually a staging setting that shipped - remove it today, resubmit the sitemap and request indexing of the homepage. |
| `snippet-restricted` | D | Indexable pages with `nosnippet` or `max-snippet:0` in the robots meta tag, or in an X-Robots-Tag header that applies to Google (a header scoped to another bot doesn't count). Google documents that these also keep the page out of AI Overviews and AI Mode | Remove the directive (or use `max-snippet:-1`); hide a single passage with `data-nosnippet` instead. |
| `canonical-relative` | D | Canonicals declared as relative URLs | Use an absolute https URL - relative canonicals are error-prone. |
| `multiple-canonical` | D | More than one rel=canonical on a page | Keep exactly one; conflicting canonicals let Google pick, or ignore both. |
| `noindex-with-traffic` | D+G | A noindexed page still earning clicks | Remove the noindex if the page should rank - it demonstrably does. |
| `canonical-ignored` | D+G | A page canonicalised elsewhere that Google ranks anyway | Decide which URL you want indexed, then align the canonical and the internal links to it. |
| `indexed-junk-url` | D+G | Internal-search / faceted / tracking-param URLs that got indexed and rank | noindex or block them, canonicalise filter URLs - the query footprint proves the accident. |
| `coverage-not-indexed` | G | Pages Google crawled and chose not to index | Investigate quality and duplication - Google looked and declined. |
| `canonical-conflict` | G | Google chose a different canonical than you declared | Align your declared canonical with the page Google indexes. |
| `index-bloat` | D+G | Indexable pages with no impressions in 90 days | Consolidate, improve, or noindex/prune - after confirming it isn't seasonal or new. |
| `broken-canonical-target` | D | Canonicals pointing at broken, redirecting, noindexed or chained targets | Point the canonical at a live, indexable, self-canonical HTTPS URL. |
| `soft-404-shell` | D+G | Pages serving 200 that Google flags as soft 404 | Populate the page with real content, or return a true 404/410. |
| `soft-404-handling` | D | The site answers 200 for URLs that don't exist, or redirects them to the homepage or another 200 page. At the end of every crawl two random URLs that can't exist are requested (one at the root, one under the busiest section): one site-level finding. Also each crawled 200 page whose title (any segment around a `|`/`-` separator) or H1 is wholly a not-found message ("404", "Page not found", "Nothing found"...; an article about 404s doesn't match), highest equity first. A probe that was rate limited or got no answer is unknown | Answer 404 (or 410) for unknown URLs, not 200 and not a homepage redirect; on a single-page app, have the server 404 unknown routes. |
| `canonical-changed-by-js` | D | The rel=canonical in the rendered DOM differs from the raw HTML's: JS added, removed or rewrote it (normalised URLs, so a trailing slash alone doesn't count). Google may use either. Needs `render_pages`; rows rendered before 0.16.0 report the change without both values | Put the final canonical in the server HTML and keep client code off it. |
| `noindex-changed-by-js` | D | noindex (robots meta, or the X-Robots-Tag header, which holds on both sides) in the raw HTML and not after JS, or the reverse. A raw noindex removed by JS doesn't work: Google can skip rendering a raw-noindex page. Needs `render_pages` rows from 0.16.0 on; older rows report not collected | Decide, and set it server-side with no client-side change. |
| `host-variant-split` | D | An http/https or www/apex twin of the homepage or of the most-linked deep page answers 200, a temporary redirect (302/307), a chain, or lands on a different URL, instead of one 301/308 to the same path on the canonical host. One finding per page, listing every failing twin in its evidence. At most three requests per crawl; a twin that doesn't resolve is unknown, not a finding; not run for an IP address, localhost or a host with a port | Redirect every twin in one permanent hop at the CDN or server, keeping the path and query. |
| `broken-hreflang-target` | D | hreflang alternates that are 4xx/5xx, noindex, or a URL that redirected in the latest crawl (from `redirect_sources`; before #55 group C redirecting alternates were skipped). A rate-limited fetch or a legacy stored 429/503 is unknown, not broken; alternates on hosts we didn't crawl are not judged | Point every alternate at a live, indexable URL - one bad alternate drops the whole cluster. |
| `hreflang-no-return-tag` | D | hreflang annotations a crawled, live, indexable target never reciprocates (x-default is not required to return). Alternates that canonicalise elsewhere, and pages that are themselves canonicalised, are left to `hreflang-canonical-conflict` | Add the return tag - Google ignores one-way hreflang. |
| `canonical-cross-host` | D | A 200 page whose canonical names a different host (an old domain, staging, a CDN or sister host, a subdomain). The www/apex twin and an http/https switch don't count. Pages with equity (GSC clicks >= 1 or impressions >= 10, a backlink, or an internal link) are listed first | Make the canonical self-referencing on this host, or redirect if the move is real. |
| `hreflang-invalid-code` | D | hreflang values Google can't read: not `x-default` or a two-letter ISO 639-1 language with an optional ISO 3166-1 alpha-2 region, hyphenated (`en-uk`, `en_US`, `eng`, `es-419`, `en-EU`). Checked against the platform's ICU data; a four-letter script subtag (`zh-Hant`) is accepted | Use codes like `en-GB`, `pt-BR`, `x-default`. |
| `hreflang-missing-self` | D | A 200 page whose hreflang set doesn't list the page itself | Add the self-referencing annotation to the template. |
| `hreflang-duplicate-locale` | D | One locale value (case-insensitive) pointing at two different URLs in a page's set; the same URL listed twice is not counted | Keep one URL per locale. |
| `hreflang-canonical-conflict` | D | A page declaring hreflang that canonicalises elsewhere (Google ignores its annotations), or a crawled 200 alternate that canonicalises elsewhere. Broken, noindex and redirecting alternates are `broken-hreflang-target`'s | Point alternates at canonical URLs and keep every locale page self-canonical. |
| `sitemap-non-indexable` | D | Sitemaps listing dead, redirected, noindexed or blocked URLs | List only canonical, indexable pages, or Google loses trust in the sitemap. |
| `indexable-not-in-sitemap` | D | Indexable pages the sitemap omits | Add them so Google discovers and prioritises them. |
| `image-preview-restricted` | D | max-image-preview capped below large | Set max-image-preview:large - Discover strongly favours it - unless licensing forbids. |
| `sitemap-lastmod-untrustworthy` | D | lastmod dates that are generator stamps, future-dated, or claim changes that didn't happen | Make lastmod reflect genuine content changes, or drop it - dishonest dates teach Google to ignore yours. |
| `redirect-to-homepage` | D | A deep URL redirected to the bare homepage, which Google treats as a soft 404. `/index.html`-style aliases and locale roots (`/en`, `/en-au`) don't count; URLs with clicks or links are listed first | Redirect to the closest equivalent page, or let it 404/410. |
| `product-gone-404` | D+G | A store product (Shopify `/products/`, WooCommerce `/product/`, or Product schema in the earlier snapshot) that answered 200 in an earlier crawl and now answers 404/410, with equity (GSC clicks >= 1 or impressions >= 10 over the history held, a backlink, or an internal link). Ranked by the clicks it earned. A product the latest crawl didn't reach, or a rate-limited fetch, is not reported | 301 to the replacement or parent category; keep an out-of-stock product live at 200 marked OutOfStock. |

## On-page (24)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `missing-title` | D | No title tag | Add a unique, descriptive title (~50-60 chars). |
| `duplicate-title` | D | The same title on multiple indexable pages | Make each one unique. |
| `title-changed-by-js` | D | The `<title>` after JS differs from a non-empty raw title, or JS empties it (a title only present after JS is `content-only-in-rendered-dom`). Needs `render_pages` | Render the final title on the server; if the client sets it, make it the same text. |
| `title-too-long` | D | Titles over ~60 chars | Trim so the primary keyword sits inside the visible length. |
| `missing-meta-description` | D | No meta description | Add a unique one (~120-155 chars). |
| `meta-description-length` | D | Meta descriptions over ~160 chars | Tighten so it isn't truncated. |
| `duplicate-meta-description` | D | The same meta description on multiple pages | Give each indexable page its own. |
| `missing-h1` | D | No H1 | Add a single descriptive one. |
| `multiple-h1` | D | More than one H1 | Use one per page. |
| `title-h1-mismatch` | D | Title and H1 sharing no significant words | Align them - the mismatch blurs the page's topic signal. |
| `image-alt` | D | Content images without alt text | Add descriptive alt text (empty alt only for decorative images). |
| `broken-image` | D | An `<img>` src answering 4xx/5xx, or answering 200 with an HTML page (a redirect to the homepage, a soft 404). From `image_assets`, the 500 most-used images sampled after each crawl | Fix the src or restore the file. |
| `external-broken` | D (0.9) | Outbound links whose target is dead (4xx/5xx, DNS, timeout, refused, TLS), per linking page. Bot walls (401/403/429, Cloudflare challenges) are "unverifiable" and never counted | Replace or remove each dead link: the current page on that site, a better source, or nothing. |
| `external-redirected` | D (0.9) | Outbound links that permanently redirect, per linking page; a deep link now landing on the site's homepage is flagged as likely removed | Update each link to its final URL; find a replacement where the target page is gone. |
| `images-missing-dimensions` | D | Images without width/height attributes | Add them (or CSS aspect-ratio) so the browser reserves space - but confirm with field CLS first; if your CSS already reserves space there's nothing to fix. |
| `heading-hierarchy` | D | Skipped heading levels (h1 → h3) | Use headings in order - it keeps the outline accessible and parseable. |
| `missing-social-tags` | D | No Open Graph or Twitter Card tags | Add them so shared links render a rich preview. |
| `missing-viewport` | D | No viewport meta | Add the standard width=device-width tag. |
| `missing-lang` | D | No lang attribute on the html element | Declare it (e.g. lang="en-GB") - usually one template edit. |
| `excessive-links` | D | Hundreds of links on one page | Trim the boilerplate link blocks so the links that matter stand out. |
| `favicon-missing` | D | No favicon declared | Add one - Google shows it beside your result on mobile. |
| `analytics-missing` | D | No analytics or tag-manager snippet found anywhere on the site | Install one (or ignore if you measure server-side) - you can't make SEO decisions blind. |
| `discover-max-image-preview` | D | Article-template pages without `max-image-preview:large` (no large Google Discover card) | Add the directive via meta robots or an X-Robots-Tag header - usually one site-wide template change. |
| `discover-missing-og` | D | Article-template pages missing `og:title` or `og:image` (Discover builds cards straight from Open Graph) | Add both; size og:image ≥1200px wide at 16:9, and write og:title for click-through. |

## Content (7)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `thin-content` | D+N (0.6) | Pages under ~200 words of body text | Expand or consolidate. |
| `hydration-content-loss` | D | The rendered main content (`<main>` or `[role=main]`, else the body without nav/header/footer/aside) keeps at most 50% of the raw main content's words, where the raw had at least 200. The threshold is ours; Google publishes none. Rows rendered before 0.16.0 use whole-body words, labelled. Needs `render_pages` | Fix the client so it keeps the server's content (look for hydration errors, failed client fetches, a script that replaces the copy). |
| `near-duplicate-content` | N (0.7) | Pages that are semantically near-identical (local embedding cosine ≥ threshold) | Consolidate to one canonical page or genuinely differentiate them. Populate with `find_duplicates` first; verify each pair before merging. |
| `poor-chunkability` | D | 400+ words with no heading structure | Break the copy into headed sections - AI search and snippets lift self-contained passages, and a wall of text gives them nothing to quote. |
| `low-extractability` | D+N (0.5) | Sections that open with "it / this / they" and never name their subject | Open key sections by naming the entity - lifted out of context, these passages read as meaningless. |
| `content-bloat` | D+N (0.6) | Very long unbroken sections | Split into focused, headed passages - AI grounding has sharp diminishing returns past a certain length, and density beats length. |
| `ai-slop-signals` | N (0.5) | Copy tripping statistical tells of generic AI text (stock filler, uniform sentence lengths, identical section openers) | Rewrite the flagged sections with specifics only you can supply - and verify by reading first; competent human writing can trip these tells. |

## Structured data (14)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `missing-structured-data` | D | No JSON-LD at all | Add the relevant type (Article, Product, Organization...). |
| `invalid-schema` | D | JSON-LD that doesn't parse or lacks @context/@type | Fix it so each block parses with a valid type (`fix_finding` writes the block from your own page data). |
| `missing-required-fields` | D | Schema missing Google-required properties for its type | Add the cited properties - the validator covers ~30 rich-result types and flags required fields only, never optional noise. |
| `schema-value-errors` | D | Relative URLs, malformed dates, bad currency or price values in JSON-LD | Use absolute URLs, ISO-8601 dates and ISO-4217 currency codes. |
| `forbidden-schema` | D+N (0.7) | FAQPage/HowTo markup on pages that no longer qualify | Remove it unless the page fits the narrow remaining eligibility - it risks no benefit or a manual action. |
| `homepage-missing-org-schema` | D | Homepage without Organization/WebSite schema | Add it - it underpins the knowledge panel, logo and sitelinks search box. |
| `breadcrumb-schema-inconsistent` | D | Breadcrumb schema on most of the site but missing from some pages | Add BreadcrumbList to the stragglers. |
| `rich-result-issues` | D+G | Rich-result issues Google itself reports via URL Inspection | Fix the listed issues - this is Google's own validation, not ours, so it's authoritative. |
| `article-date-illogical` | D | Article dateModified earlier than datePublished | Fix the dates - an impossible pair undermines trust in the markup. |
| `article-no-author` | D | Article schema where no Article node names an author (an `@id` reference to a named Person counts) | Add a Person author and a visible byline - AI-search guidance rewards a demonstrable first-hand point of view. |
| `merchant-listing-incomplete` | N (0.5) | Product markup on a store page missing what [Google's merchant listings](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing) use. Required: `image`, an `Offer` (an `AggregateOffer` alone isn't accepted), `price` and `priceCurrency` (directly or in `priceSpecification`). Recommended: `availability`, `itemCondition`. Store product pages with no offers at all roll up into one site-level finding, because a quote-only product has no price and is not a merchant listing. A review page's Product without offers is skipped | Fix the product template once; ignore it for quote-only products. |
| `duplicate-article-entities` | D (0.9) | More than one Article entity on one URL, typically an SEO plugin's graph plus a theme- or block-embedded Article | Emit one Article per page: remove the second source or merge it into the graph with the same `@id`. |
| `discover-generic-article-type` | D+N (0.5) | Article schema using only the generic `Article` type where a more specific one fits | Use `NewsArticle` / `LiveBlogPosting` / `ProfilePage` where it genuinely applies - it unlocks richer Discover/News treatment. |
| `discover-image-schema` | D | Article schema that declares no `image` (Discover cards need a large image) | Add an `image` (≥1200px wide, ideally 16:9 / 4:3 / 1:1 crops), matching the main visible image. |

## Security (3)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `mixed-content` | D | http subresources on https pages | Serve every subresource over https. |
| `non-https` | D | Pages served over HTTP | Serve over HTTPS and 301 the HTTP version. |
| `missing-hsts` | D | No Strict-Transport-Security header | Add it with a sensible max-age. |

## Performance (14)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `slow-response` | D | Server responses over ~1.5s (TTFB proxy) | Investigate caching, CDN or backend - slow responses hurt CWV and crawl rate. |
| `large-html` | D | Oversized HTML, measured on estimated **transferred** bytes | Trim the payload (often huge inline SVG/CSS/JSON) - behind a compressing CDN, raw size matters far less, which is why we measure transfer. |
| `uncompressed-html` | D | HTML served without gzip/brotli | Enable compression - usually a one-line server or CDN setting. |
| `no-304-revalidation` | D | Servers that advertise Last-Modified/ETag but re-serve full 200s to conditional requests | Configure the server to answer 304 Not Modified - it saves bandwidth on every revalidating crawler and signals stability to Googlebot. |
| `high-yield-cwv-fail` | D+G | Pages earning real clicks while failing lab Core Web Vitals (needs `page_lighthouse`) | Prioritise CWV work here - this is where engineering effort has measurable ROI. |
| `crux-field-lcp` | G | Real-user Largest Contentful Paint at p75 over Google's 2.5 s "good" line (poor above 4 s), latest 28-day CrUX window, origin and URL level, phone and desktop separately (needs `sync_crux`) | Use the LCP sub-parts (TTFB, load delay, load duration, render delay) to pick the fix. |
| `crux-field-inp` | G | Real-user Interaction to Next Paint at p75 over 200 ms (poor above 500 ms) - the field-only Core Web Vital no lab tool measures (needs `sync_crux`) | Break up long tasks, defer third-party scripts, lighten input handlers. |
| `crux-field-cls` | G | Real-user Cumulative Layout Shift at p75 over 0.1 (poor above 0.25) (needs `sync_crux`) | Give media and ad slots dimensions; reserve space for late content. |
| `crux-regression` | G | A Core Web Vital whose p75 moved into a worse band (good, needs improvement, poor) between the 4th-newest and the newest CrUX window (needs `sync_crux` history) | Find what shipped when it started and roll it back or fix it. |
| `discover-slow-response` | D+N (0.5) | Article-template pages whose fetch wall-time exceeds ~600ms (a proxy, not a measured TTFB) | Aim for server response under 600ms - ideal under 200ms - since Discover favours freshly-crawlable content; confirm with a real TTFB before prioritising. |
| `render-blocking-head-resources` | D | Pages with 1+ parser-blocking `<script src>` in `<head>` (no async, defer or type=module, not a preload hint) or 3+ render-blocking stylesheets (media absent, `all` or `screen`). The stylesheet threshold is ours: 1-2 sheets are the normal floor. Rolled up per identical set of blocking files (one finding per template). Reads `page_resources` (every crawl since 0.15.0); inline scripts and styles aren't counted | `defer` head scripts; inline critical CSS and load the rest without blocking. |
| `static-asset-uncached` | D | First-party CSS/JS/font files with no Cache-Control, no max-age, no-store/no-cache, or max-age under one day (86,400 s). Third-party files are left out; `Expires` isn't recorded. Needs a crawl with `headResources:true` | Serve hashed static files with a long max-age (a year, plus `immutable`). |
| `image-oversized` | D | An `<img>` over 300,000 bytes (Content-Length, the dashboard's 300 KB line). The probe sends a browser's image `Accept`, so a CDN that negotiates WebP/AVIF is measured as browsers see it; images sampled by older crawls (no Accept recorded) are not judged until a re-crawl | Resize, compress, serve WebP/AVIF, use `srcset`. |
| `image-legacy-format` | D | A JPEG/PNG/GIF/BMP `<img>` of 32 KiB to 300 KB. WebP is 25-34% smaller than JPEG (Google's WebP study), so each saves at least the 8 KiB Lighthouse counts; bigger images are `image-oversized`'s. Same Accept rule as above | Convert to WebP/AVIF at build time, or turn on format negotiation at the CDN. |

## Accessibility (7)

A deterministic subset of the [axe-core](https://github.com/dequelabs/axe-core) rules - the ones decidable from the raw HTML, no render needed. The rest of axe-core needs a rendered page and isn't run (`render_pages` diffs content and links, not accessibility). These sit alongside the on-page `image-alt`, `heading-hierarchy` and `missing-lang` checks.

`a11y-link-name`, `a11y-button-name` and `a11y-duplicate-id` are rolled up by template (since 0.16.1). A theme's nameless icon links and buttons appear on every page, so one finding per page reported the same few elements hundreds of times. The crawl now records which elements failed (a short selector such as `button.menu-toggle`, and for links the shape of the href, so a share link's per-page `?u=` doesn't split it), and the check reports one finding per set of elements shared by 3 or more pages (`scope: "template"`, with the page count, sample pages and the elements), plus a finding for each page with nameless elements of its own on top (`scope: "page"`). Pages crawled before 0.16.1 have no element record and keep one finding per page until the next crawl. `image-empty-alt-content` isn't rolled up: it only counts images inside the main content, which are the page's own.

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `a11y-link-name` | D | Links with no discernible accessible name (empty anchor, icon-only, no aria-label) | Give the link visible text, an aria-label, or an `<img>` with real alt text (axe link-name). |
| `a11y-button-name` | D | Buttons / `role=button` / `type=button` inputs with no accessible name | Add text, a value, or an aria-label - submit/reset self-name, so they're never flagged (axe button-name). |
| `a11y-form-label` | D | Visible form fields with no `<label>`, wrapping label or aria-label | Associate each field with a label (axe label). |
| `a11y-viewport-zoom-disabled` | D | `<meta viewport>` blocking pinch-zoom (`user-scalable=no` / `maximum-scale<2`) | Remove the zoom restriction - a WCAG 1.4.4 failure (axe meta-viewport). |
| `a11y-duplicate-id` | D | `id` values used more than once | Make every id unique - duplicates break label/for, aria-labelledby and in-page anchors (axe duplicate-id). |
| `a11y-positive-tabindex` | D | Elements with `tabindex` greater than 0 | Use `tabindex="0"`/`-1` and order the DOM instead - positive values break keyboard focus order (axe tabindex). |
| `image-empty-alt-content` | N (0.5) | Images with `alt=""` inside the main content (main/article/figure, outside nav/header/footer) | Give content images descriptive alt text; keep `alt=""` only for genuinely decorative ones. |

## The merged checks (24)

These are the ones that need both datasets - your crawl (what the site says) joined to Search Console (what Google did about it). In my experience this family is where most of the recoverable traffic hides.

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `striking-distance` | G | Queries ranking on page 2 | A small on-page and internal-link push could reach page 1 (`fix_finding` ranks the donors). |
| `keyword-cannibalisation` | G | Multiple URLs in real competition for one query (thresholds tuned so incidental long-tail overlap doesn't count) | Consolidate or differentiate, on numbers rather than vibes. |
| `ctr-below-expected` | G | Pages ranking well but clicked far below what the position predicts | Rewrite the title and meta - the snippet is the problem. |
| `traffic-decay` | G | Pages whose clicks fell sharply against the previous 28 days | Refresh the content and check for lost rankings. |
| `lost-queries` | G | Queries that drove clicks last period and drive none now | Find the page that ranked and win it back. |
| `position-slipping` | G | Page-1 rankings that worsened by 3+ positions | Investigate before the clicks follow the position down. |
| `nonbrand-decline-masked` | G | Total clicks flat or up (no more than 5% down) while non-brand clicks fell more than 15% on the prior 28 days (finalised days, prior non-brand at least 100 clicks). Brand = whole-token match of the domain label, the same heuristic as the dashboard's branded split, named in the evidence; a day holding both GSC row shapes is counted once | Brand demand is hiding a ranking loss - work through traffic-decay, lost-queries and position-slipping. |
| `rising-pages` | G | Pages gaining clicks fast | Reinforce with internal links and related content while the momentum is there. |
| `stale-content` | D+G | Pages unmodified for over a year with clicks down year-on-year | Refresh and expand it, and re-date only once the content has changed. |
| `traffic-to-dead-url` | D+G | Google still sending traffic to a URL that returns 4xx/5xx | Recover the page or 301 it - you rank for a page that no longer works. |
| `impressions-rising-clicks-flat` | G | Google showing a page more while clicks stay flat | A stale snippet or a SERP feature is taking the clicks - rewrite the snippet or target the feature. |
| `ghost-pages` | D+G | URLs Google ranks that the crawl can't reach | Add internal links so your own site can find the page Google already sends people to. |
| `orphan-with-impressions` | D+G | Pages earning impressions that the site barely links to | Add internal links - and if it drives real traffic, protect it before any cleanup or migration. |
| `title-missing-top-query` | D+G | The page's top-ranking query absent from its title | Work the query in - Google already half-trusts the page for it. |
| `h1-missing-top-query` | D+G | The top query absent from the H1 | Same again, in the main heading. |
| `body-missing-top-query` | D+G | The top query's terms appearing nowhere on the page at all | Add a section that covers the topic - or accept the page is too thin to hold the ranking. |
| `anchor-text-incoherent` | D+G | In-content internal anchors that never mention the page's top query | Re-anchor the key links with descriptive text instead of "read more" and brand-only labels. Only genuine editorial anchors are counted, so nav chrome can't trigger it. |
| `underlinked-high-demand` | D+G | Pages with real search demand but little internal PageRank | Add links from your high-authority pages. |
| `underlinked-editorial` | D+G | Pages with demand reached mainly via nav/footer links | Add descriptive in-content links - body links pass more topical context than templated ones. |
| `high-ipr-no-traffic` | D+G | High internal authority spent on pages that earn impressions but zero clicks | Fix the snippet or the page, or repoint the authority somewhere that converts it. |
| `rag-answer-gap` | G+N (0.6) | Multi-term queries whose terms exist on the page but never together in one passage | Add one self-contained passage that answers the query directly - AI answers lift a single chunk. |
| `weak-passage-answer` | G+N (0.8) | Pages where the local reranker finds no passage that confidently answers the top query (needs `score_passages`) | Add a focused passage: a heading that states the question and a direct ~50-word answer. |
| `answer-not-front-loaded` | G+N (0.6) | Pages that answer their query, but buried below the fold | Move a direct answer into the first section - Google weights the opening, and AI answers front-load. |
| `intent-vs-pagetype-mismatch` | G+N (0.7) | Page templates that don't match their query's intent - a product page ranking for a how-to, an article for a "buy" query (needs `search_intent`) | Reformat or retarget the page. |

## Extending the registry

Each check is a pure read over the joined data returning findings with evidence, so adding one is fairly self-contained - see the Contributing section of the [README](../README.md).
