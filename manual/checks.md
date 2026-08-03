# The check registry

All 93 checks `run_audit` evaluates, grouped by category. This list is generated from the registry in `src/audit/checks.ts` - if the code and this page ever disagree, the code wins, and `list_checks` always returns the live list.

## Reading the labels

- **D** - deterministic. The finding cites bytes: a status code, a missing tag, a recorded redirect. If it fires, the thing is true.
- **G** - the evidence comes from Google's own data (Search Console or URL Inspection) rather than the crawl. Still hard numbers, just Google's numbers.
- **N** - judgement. A heuristic that can be wrong, so it only runs when you ask for it (`includeJudgement:true`, or *"include the judgement findings"*). Each carries a certainty figure below 1 that discounts its priority.

A check can carry more than one label - `noindex-with-traffic` is D+G because the noindex is in your bytes and the traffic is in Google's.

Every finding is priced the same way: priority = (traffic at stake × expected yield × certainty) / effort hours. So the list you get back is ordered by expected clicks per developer-hour, not by how alarming the check sounds.

## Crawlability (13)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `broken-internal-links` | D | Internal links pointing at 4xx/5xx URLs | Repoint them to a live, canonical URL (`fix_finding` writes the 301). |
| `redirect-chain` | D | Redirects of 2+ hops | Collapse to a single hop to the final URL. |
| `internal-links-to-redirects` | D | Internal links that travel through a redirect | Repoint to the final URL - saves crawl budget and equity. |
| `meta-nofollow` | D | Pages with meta robots nofollow | Remove it unless you mean to drop all link equity from the page. |
| `deep-pages` | D | Pages 4+ body-link clicks from the homepage | Add in-content links from higher-level pages. |
| `backlinks-to-404` | D | External backlinks hitting a dead page (needs `pull_backlinks`) | 301 the URL to its best live equivalent - that equity is already earned. |
| `orphan-no-links` | D | Indexable pages with zero inlinks and no backlinks | Add internal links; the page currently depends on the sitemap alone. |
| `ipr-bleed-by-status` | D | Internal PageRank flowing into non-200 URLs | Repoint or 301 the links - high-authority pages are wasting equity on dead targets. |
| `faceted-spider-trap` | D+G | Indexable multi-parameter filter URLs earning zero search traffic | noindex, disallow or canonicalise them - they burn crawl budget for nothing. |
| `pagination-canonical-to-page-1` | D | Page 2+ canonicalising back to page 1 | Make each paginated page self-canonical, or items linked only from deep pages drop out of the crawl. |
| `sitemap-orphan` | D | Sitemap URLs nothing on the site links to | Add internal links - sitemap discovery alone earns little authority. |
| `robots-blocked-with-traffic` | D+G | robots.txt-disallowed URLs Google still shows and users still land on | Unblock it so it can rank properly, or unblock AND noindex (a blocked page can never see the noindex). |
| `entity-internal-link-gap` | N (0.5) | Topically related pages (per Wikidata) with no link between them | Link the broader page to the more specific one - after verifying the entity match. Needs `resolve_entities`. |

## Indexation (16)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
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
| `broken-hreflang-target` | D | hreflang alternates that are 4xx/5xx, redirected or noindex | Point every alternate at a live, indexable URL - one bad alternate drops the whole cluster. |
| `hreflang-no-return-tag` | D | hreflang annotations the target never reciprocates | Add the return tag - Google ignores one-way hreflang. |
| `sitemap-non-indexable` | D | Sitemaps listing dead, redirected, noindexed or blocked URLs | List only canonical, indexable pages, or Google loses trust in the sitemap. |
| `indexable-not-in-sitemap` | D | Indexable pages the sitemap omits | Add them so Google discovers and prioritises them. |
| `image-preview-restricted` | D | max-image-preview capped below large | Set max-image-preview:large - Discover strongly favours it - unless licensing forbids. |
| `sitemap-lastmod-untrustworthy` | D | lastmod dates that are generator stamps, future-dated, or claim changes that didn't happen | Make lastmod reflect genuine content changes, or drop it - dishonest dates teach Google to ignore yours. |

## On-page (18)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `missing-title` | D | No title tag | Add a unique, descriptive title (~50-60 chars). |
| `duplicate-title` | D | The same title on multiple indexable pages | Make each one unique. |
| `title-too-long` | D | Titles over ~60 chars | Trim so the primary keyword sits inside the visible length. |
| `missing-meta-description` | D | No meta description | Add a unique one (~120-155 chars). |
| `meta-description-length` | D | Meta descriptions over ~160 chars | Tighten so it isn't truncated. |
| `duplicate-meta-description` | D | The same meta description on multiple pages | Give each indexable page its own. |
| `missing-h1` | D | No H1 | Add a single descriptive one. |
| `multiple-h1` | D | More than one H1 | Use one per page. |
| `title-h1-mismatch` | D | Title and H1 sharing no significant words | Align them - the mismatch blurs the page's topic signal. |
| `image-alt` | D | Content images without alt text | Add descriptive alt text (empty alt only for decorative images). |
| `images-missing-dimensions` | D | Images without width/height attributes | Add them (or CSS aspect-ratio) so the browser reserves space - but confirm with field CLS first; if your CSS already reserves space there's nothing to fix. |
| `heading-hierarchy` | D | Skipped heading levels (h1 → h3) | Use headings in order - it keeps the outline accessible and parseable. |
| `missing-social-tags` | D | No Open Graph or Twitter Card tags | Add them so shared links render a rich preview. |
| `missing-viewport` | D | No viewport meta | Add the standard width=device-width tag. |
| `missing-lang` | D | No lang attribute on the html element | Declare it (e.g. lang="en-GB") - usually one template edit. |
| `excessive-links` | D | Hundreds of links on one page | Trim the boilerplate link blocks so the links that matter stand out. |
| `favicon-missing` | D | No favicon declared | Add one - Google shows it beside your result on mobile. |
| `analytics-missing` | D | No analytics or tag-manager snippet found anywhere on the site | Install one (or ignore if you measure server-side) - you can't make SEO decisions blind. |

## Content (5)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `thin-content` | D+N (0.6) | Pages under ~200 words of body text | Expand or consolidate. |
| `poor-chunkability` | D | 400+ words with no heading structure | Break the copy into headed sections - AI search and snippets lift self-contained passages, and a wall of text gives them nothing to quote. |
| `low-extractability` | D+N (0.5) | Sections that open with "it / this / they" and never name their subject | Open key sections by naming the entity - lifted out of context, these passages read as meaningless. |
| `content-bloat` | D+N (0.6) | Very long unbroken sections | Split into focused, headed passages - AI grounding has sharp diminishing returns past a certain length, and density beats length. |
| `ai-slop-signals` | N (0.5) | Copy tripping statistical tells of generic AI text (stock filler, uniform sentence lengths, identical section openers) | Rewrite the flagged sections with specifics only you can supply - and verify by reading first; competent human writing can trip these tells. |

## Structured data (10)

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
| `article-no-author` | D | Article schema with no author | Add a Person author and a visible byline - AI-search guidance rewards a demonstrable first-hand point of view. |

## Security (3)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `mixed-content` | D | http subresources on https pages | Serve every subresource over https. |
| `non-https` | D | Pages served over HTTP | Serve over HTTPS and 301 the HTTP version. |
| `missing-hsts` | D | No Strict-Transport-Security header | Add it with a sensible max-age. |

## Performance (5)

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `slow-response` | D | Server responses over ~1.5s (TTFB proxy) | Investigate caching, CDN or backend - slow responses hurt CWV and crawl rate. |
| `large-html` | D | Oversized HTML, measured on estimated **transferred** bytes | Trim the payload (often huge inline SVG/CSS/JSON) - behind a compressing CDN, raw size matters far less, which is why we measure transfer. |
| `uncompressed-html` | D | HTML served without gzip/brotli | Enable compression - usually a one-line server or CDN setting. |
| `no-304-revalidation` | D | Servers that advertise Last-Modified/ETag but re-serve full 200s to conditional requests | Configure the server to answer 304 Not Modified - it saves bandwidth on every revalidating crawler and signals stability to Googlebot. |
| `high-yield-cwv-fail` | D+G | Pages earning real clicks while failing lab Core Web Vitals (needs `page_lighthouse`) | Prioritise CWV work here - this is where engineering effort has measurable ROI. |

## The merged checks (23)

These are the ones that need both datasets - your crawl (what the site says) joined to Search Console (what Google did about it). In my experience this family is where most of the recoverable traffic hides.

| Check | Labels | What it catches | The fix, in one line |
|---|---|---|---|
| `striking-distance` | G | Queries ranking on page 2 | A small on-page and internal-link push could reach page 1 (`fix_finding` ranks the donors). |
| `keyword-cannibalisation` | G | Multiple URLs in real competition for one query (thresholds tuned so incidental long-tail overlap doesn't count) | Consolidate or differentiate, on numbers rather than vibes. |
| `ctr-below-expected` | G | Pages ranking well but clicked far below what the position predicts | Rewrite the title and meta - the snippet is the problem. |
| `traffic-decay` | G | Pages whose clicks fell sharply against the previous 28 days | Refresh the content and check for lost rankings. |
| `lost-queries` | G | Queries that drove clicks last period and drive none now | Find the page that ranked and win it back. |
| `position-slipping` | G | Page-1 rankings that worsened by 3+ positions | Investigate before the clicks follow the position down. |
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
