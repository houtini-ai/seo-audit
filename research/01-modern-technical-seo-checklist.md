---
name: Master technical SEO checklist (2026)
description: The "checklist of all checklists" — every modern technical SEO check organised by category, with deterministic/non-deterministic labels, severity hints, and the data source each one needs
type: research
phase: 1
---

# Master technical SEO checklist (2026, agent-ready)

**Purpose:** the canonical surface of checks our consolidated MCP must be able to perform — or knowingly skip. This is the spec for `plan/tool-surface.md` later.

**Source synthesis:** SEOmator's 251-rule taxonomy (MIT, our seed) + DigitalApplied's 200-item checklist + 2026 industry sources (DebugBear, NoGood, Yotpo, Wellows, Neuronwriter, SearchEngineLand) + Cloudflare's Agent Readiness Score + WCAG/axe-core + RFCs/MDN for protocol-level rules + classic war-story knowledge.

**Labels:**
- **D** — deterministic. Same site, same UA, same time → same answer. (E.g. "title length is 71 chars".)
- **N** — non-deterministic / judgement. Requires LLM or heuristic. Must be gated behind a flag and cite its evidence. (E.g. "this page's intent doesn't match the queries it ranks for".)
- **L** — log-derived. Needs a server-access-log sample to evaluate.
- **G** — needs GSC connection.
- **S** — needs a SERP/DataForSEO query.
- **A** — agent-readiness, often via `isitagentready.com/scan_site`.

**Severity hints** in `[brackets]`: `[crit] [high] [med] [low] [info]`.

---

## 0. Crawl integrity gates (do these FIRST or nothing else is trustworthy)

Without these green, the rest of the audit is fiction.

1. **Status code parity** [crit] D — crawler-reported status == `curl -I` status, for a sample of 20+ URLs.
2. **Header parity** [crit] D — `Content-Type`, `Content-Encoding`, `Vary`, `Cache-Control`, `X-Robots-Tag`, `Link`, `Last-Modified`, `ETag` all match raw-HTTP source.
3. **Body parity (no-JS)** [crit] D — raw HTML title/H1/canonical/meta-description match view-source, byte-for-byte.
4. **Render parity (post-JS)** [high] D — post-render DOM differences captured; any SEO-critical content visible only after JS flagged.
5. **Sitemap parsing parity** [crit] D — crawler's interpretation of `sitemap.xml` (and nested indices) matches a deterministic XML parser.
6. **Robots interpretation parity** [crit] D — crawler's allow/disallow matches Google's robots tester for the *same UA*.
7. **UA spoofing test** [high] D — site returns the same content to crawler-UA vs `Googlebot` vs `GPTBot` (cloaking detection).
8. **Render parity vs Googlebot** [high] D — render output for `Googlebot` UA == render output for vanilla Chrome UA.

---

## 1. Crawlability foundation

### 1.1 robots.txt
9. `robots.txt` present at root, returns 200 [crit] D
10. Parseable, no syntax errors / malformed directives [crit] D
11. No accidental global `Disallow: /` in production [crit] D
12. Sitemap directive present and points to a valid file [high] D
13. AI crawler policy declared per bot [high] D — GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended, OAI-SearchBot, ChatGPT-User, Amazonbot, Applebot-Extended, Bytespider, anthropic-ai (12-bot baseline)
14. **Content Signals** declared (e.g. `Content-Signal: ai-train=no, search=yes, ai-input=yes`) [med] D A
15. No conflicting `Allow`/`Disallow` rules for the same path [high] D
16. Crawl-delay only used if intentional; absent for Googlebot [low] D
17. Wildcards used correctly; no accidental over-blocks [high] D

### 1.2 XML sitemap(s)
18. Reachable at declared URL, 200 status, `Content-Type: application/xml` [crit] D
19. ≤ 50MB uncompressed and ≤ 50,000 URLs per file [high] D
20. Sitemap index used when scaled; child sitemaps split by section [med] D
21. `<lastmod>` reflects real content changes (not page-load timestamp) [high] D
22. Only canonical URLs in sitemap (no redirects, noindex, 404, parameter dupes) [crit] D
23. URLs use absolute, indexable, HTTPS form [crit] D
24. `<priority>` and `<changefreq>` either sensible or absent — Google ignores them either way but conflicting values look amateur [low] D
25. Image, video, news sitemaps where applicable [med] D
26. Submitted in GSC and Bing WMT; no errors in coverage report [high] D G
27. **hreflang sitemap** (if multilingual) referenced via `xhtml:link` [high] D
28. Discovered via robots.txt *and* GSC submission (belt + braces) [med] D G

### 1.3 Sitemap ↔ GSC ↔ crawl reconcile (3-way)
29. Indexed-URL count reconciles with sitemap, gap < 30% [high] D G
30. URLs in sitemap but not in GSC indexed report [high] D G — investigate quality/budget
31. URLs in GSC indexed report but not in sitemap [med] D G — fix omission or add
32. URLs in crawl but neither in sitemap nor GSC ("ghost pages") [high] D G
33. URLs in sitemap but no internal links pointing to them ("orphans") [high] D — see §8
34. "Crawled — currently not indexed" review [high] G
35. "Discovered — currently not indexed" review [high] G

### 1.4 Internal link reachability
36. Every indexable URL reachable within 3–4 clicks of homepage [high] D
37. No crawl traps: faceted nav, infinite calendars, session IDs in URLs [crit] D
38. Pagination crawlable (rel=prev/next is dead, but URLs must be linked) [high] D
39. Search-result pages not indexable (`noindex` or `Disallow`) [high] D
40. Tag/archive pages handled deliberately, not by accident [med] D

### 1.5 HTTPS, redirects, response stability
41. HTTPS with valid certificate, no expired chain, no mixed content [crit] D
42. HSTS header (`Strict-Transport-Security`) with sensible max-age [high] D
43. www / non-www resolved with single 301 [crit] D
44. Trailing-slash consistency, single 301 [high] D
45. Redirect chains ≤ 2 hops [high] D
46. No redirect loops [crit] D
47. 4xx pages return real 4xx, not 200 with "page not found" text (soft-404) [crit] D
48. Permanently removed content returns 410, not 404 [med] D
49. Server returns stable status codes under Googlebot load (no intermittent 5xx) [crit] D L
50. Googlebot verified via reverse DNS lookup (no fake Googlebots in logs) [high] L

### 1.6 War-story rules (specific known failure modes)
51. **No `<iframe>` in `<head>`** [crit] D — historically kills rankings, breaks parser
52. **No invalid HTML between `<head>` start and parsed end** (a stray `</p>` ends head prematurely) [high] D
53. **`<meta charset>` within first 1024 bytes** [med] D
54. **`Vary: User-Agent` with cached responses** [high] D — Googlebot may see stale variant
55. **`If-Modified-Since` returning 304 indefinitely** for actively updated pages [high] D L — Googlebot stops re-indexing
56. **`Cache-Control: no-store`** on indexable pages is suspicious [med] D
57. **Robots-blocked CSS/JS** that prevents render [high] D
58. **Server returning 503 to Googlebot** during deploys without `Retry-After` [crit] D L
59. **Hosting-provider firewall rate-limiting Googlebot** [crit] D L
60. **CDN serving stale 404 cache** for now-live URLs [crit] D

---

## 2. Indexation

61. Canonical tags self-referential by default [high] D
62. No conflicting canonical signals across `rel=canonical`, hreflang, sitemap, internal links [high] D
63. No canonical pointing to a noindex or redirected URL [crit] D
64. No external canonical unless deliberately syndicating [crit] D
65. `noindex` only where intended; not on revenue pages [crit] D
66. `noindex` + `Disallow` combination handled correctly (Disallow blocks reading the noindex) [crit] D
67. `X-Robots-Tag` header doesn't contradict on-page meta robots [crit] D
68. Parameter handling deliberate; not blanket-blocked, not all-indexed [high] D
69. Faceted nav: rel-canonical to category root, or noindex, or rules-based [high] D
70. Staging/dev environments password-protected or fully `Disallow`ed [crit] D
71. No `nofollow` on internal navigation links [high] D
72. Thin / duplicate content consolidated or improved [med] D N
73. Pagination self-canonical [high] D
74. Manual actions checked monthly [crit] G

---

## 3. Rendering & JavaScript

75. Initial HTML contains primary content before JS executes [high] D
76. Critical navigation links present in static HTML [high] D
77. No content hidden behind `onclick` without crawlable equivalent [high] D
78. Client-side routing emits real HTTP status codes (real 404 for missing routes) [crit] D
79. Hydration does not strip SEO content from server HTML [high] D
80. Third-party scripts deferred / async [med] D
81. JS errors do not block rendering (crawler still gets content on error) [high] D
82. Web Components / Shadow DOM render to light DOM for content [med] D
83. AI-crawler render tested as `GPTBot`, `PerplexityBot`, `OAI-SearchBot` [high] D
84. CSP headers allow critical resources (fonts, JS, CSS) [high] D
85. No `User-Agent` cloaking detected [crit] D
86. Lazy-loaded content above the fold uses `loading="eager"` or `fetchpriority="high"` [med] D
87. Native `loading="lazy"` on below-fold images [med] D
88. Infinite scroll has paginated `<a href>` fallback [high] D

---

## 4. Core Web Vitals & performance

(All thresholds at p75 mobile unless noted.)

89. **LCP < 2.5s** [high] D
90. **INP < 200ms** [high] D — replaced FID in 2024; 2026 baseline
91. **CLS < 0.1** [high] D
92. **TTFB < 800ms** [med] D
93. LCP element identified; not hidden behind JS hydration [high] D
94. Hero image `fetchpriority="high"` [med] D
95. AVIF / WebP with fallback [med] D
96. Responsive `srcset` + `sizes` [med] D
97. Critical fonts preloaded; `font-display: swap` [med] D
98. Main-thread tasks < 50ms each [med] D
99. JS code-split by route [low] D
100. Unused CSS purged [low] D
101. Ads/embeds with reserved dimensions (no CLS) [med] D
102. CrUX field data checked monthly [med] D G
103. RUM deployed (`web-vitals.js` or commercial) [low] D
104. Static assets cacheable with sensible `Cache-Control: max-age` [med] D
105. HTML response cacheable but revalidatable (`s-maxage` + `stale-while-revalidate`) [med] D
106. Brotli or gzip encoding active [med] D
107. HTTP/2 or HTTP/3 [low] D
108. No render-blocking JS in `<head>` without `defer`/`async` [med] D

---

## 5. Structured data (schema.org)

109. JSON-LD format (not Microdata or RDFa) [high] D
110. Validates in schema.org validator + Google Rich Results Test [crit] D
111. `Article` / `BlogPosting` on editorial: `headline`, `datePublished`, `dateModified`, `author` (with `sameAs`), `image` [high] D
112. `Product` on commerce: `offers` (`price`, `priceCurrency`, `availability`), `aggregateRating`, `review` [high] D
113. `Organization` on homepage: `name`, `logo`, `url`, `sameAs` social profiles [high] D
114. `BreadcrumbList` on hierarchical pages [med] D
115. `WebSite` + `SearchAction` for sitelinks search [low] D
116. `Event`, `Recipe`, `VideoObject`, `JobPosting`, `LocalBusiness`, `Course` where applicable [high] D
117. **Author entity** with `sameAs` to authoritative profiles (E-E-A-T signal) [high] D
118. Schema matches visible content (no markup for hidden text) [crit] D — penalty-grade
119. **No forbidden schemas** (FAQPage, HowTo on most sites, Review/QAPage outside applicable contexts) [high] D
120. Image URLs in schema absolute and indexable [med] D
121. Dates ISO 8601 with timezone offset [med] D
122. Schema covers Knowledge Graph entity if one exists [med] D
123. `mainEntity`, `about`, `mentions` used to bind page to entities [med] D

---

## 6. On-page elements

### 6.1 Title / meta description / H1
124. `<title>` present, ≤ ~60 chars, unique site-wide [high] D
125. `<meta name="description">` present, ≤ ~155 chars, unique [med] D
126. Exactly one `<h1>` per page (or zero if title serves) [med] D
127. H1 not duplicating title verbatim [low] D
128. Heading hierarchy intact (no `<h3>` before `<h2>`) [med] D — accessibility AND SEO
129. Title matches dominant query intent (judgement) [high] N S G

### 6.2 URLs
130. URL hyphen-separated, lowercase, ASCII [med] D
131. No spaces, underscores, repeated slashes, capital letters [med] D
132. Length < 115 chars (rule of thumb) [low] D
133. Reflects topic hierarchy (e.g. `/blog/topic/post-slug`) [low] D
134. No tracking params (`utm_*`, `gclid`, `fbclid`) in canonical [high] D
135. No session IDs in URL [high] D
136. **Relative URLs in `<link rel=canonical>` or `<a href>` should be absolute** [med] D — common cause of canonical bugs

### 6.3 Open Graph / Twitter Cards
137. `og:title`, `og:description`, `og:image`, `og:url`, `og:type` present [med] D
138. `og:image` absolute, ≥ 1200×630, accessible to crawlers [med] D
139. `twitter:card`, `twitter:title`, `twitter:image` for X/Twitter [low] D

### 6.4 Internal anchor text
140. Descriptive anchors (no "click here", "read more" without context) [med] D
141. Concentration check — same anchor text pointing to many different URLs (anchor spam internal) [med] D
142. No empty `<a>` anchors / image-only links without alt [med] D

---

## 7. Images & media

143. Every content `<img>` has descriptive `alt` (decorative images: `alt=""`) [high] D — a11y + SEO
144. Filenames human-readable, hyphenated (`hero-blue-sneaker.jpg`, not `IMG_8473.jpg`) [low] D
145. Modern formats (AVIF/WebP) with `<picture>` fallback [med] D
146. Explicit `width` and `height` to prevent CLS [med] D
147. Native `loading="lazy"` below the fold [med] D
148. Image CDN where applicable [low] D
149. EXIF data stripped (privacy + size) [low] D
150. `<video>` with `<track kind="captions">` (a11y + indexability) [med] D
151. Audio/video has transcript on-page (huge crawl/AI signal) [high] D
152. `srcset` covers common viewport sizes [med] D
153. Schema for video (`VideoObject` with `contentUrl`, `thumbnailUrl`, `duration`) [high] D

---

## 8. Internal link graph & site architecture (mini Screaming Frog)

This is where we go beyond what most OSS tools do.

154. **Orphan pages** (in sitemap or GSC but no internal links) [high] D G — list explicitly
155. **Dead-end pages** (no outbound internal links) [med] D
156. **Hub pages** (high in-degree) identified [info] D
157. **Click-depth distribution** — how many indexable URLs sit at depth 1, 2, 3, 4+ [med] D
158. **PageRank-style internal authority flow** (approximate) — high-authority pages with few internal outbound links (waste) [med] D
159. **Anchor-text matrix** — for each target URL, the distribution of incoming internal anchor texts [info] D
160. **Cluster integrity** — topic clusters (pillar + spokes) hold together bidirectionally [med] D N
161. **Footer-link bloat** — pages with 200+ outbound internal links [med] D
162. **Reciprocal-internal-link discipline** — pillar pages link out to spokes; spokes link back up [med] D
163. **External-link audit** — outbound to spammy/expired domains [high] D
164. **Broken internal links (4xx/5xx)** [crit] D
165. **Internal redirects** — internal links pointing through 301s waste equity [med] D
166. **Internal links to noindex/canonical-other pages** [med] D
167. **Pages reached only via sitemap (not via internal nav)** [high] D L — partial orphans
168. **Pages reached only via Googlebot but no internal nor sitemap path** [high] L — sketchy
169. **Breadcrumb internal-link consistency** [low] D

---

## 9. Mobile

170. Viewport meta tag present and sensible [crit] D
171. Mobile-friendly per GSC URL Inspection / Lighthouse [crit] D
172. Tap targets ≥ 48×48px with 8px spacing [med] D
173. Body font ≥ 16px [low] D
174. No horizontal scroll at 360/390/412px viewports [med] D
175. Mobile CWV tracked separately [med] D G
176. Content parity desktop ↔ mobile (no critical content hidden in mobile) [crit] D
177. Mobile forms: correct input types, `autocomplete` attributes [low] D
178. No intrusive interstitials above the fold [high] D
179. Mobile nav crawlable in HTML, not click-only [high] D
180. No legacy `m.` subdomain unless 1:1 mapping + correct redirects [med] D

---

## 10. International (hreflang)

181. `hreflang` annotations present (link headers, on-page link tags, or sitemap) [high] D
182. Bidirectional: every alternate references back [crit] D
183. Self-referential `hreflang` on every page [high] D
184. `x-default` defined [med] D
185. ISO 639-1 language codes (`en`, `de`, `fr`) [crit] D
186. ISO 3166-1 alpha-2 region codes (`US`, `GB`, `DE`) [crit] D
187. URL structure consistent (subfolders OR subdomains, not mixed) [high] D
188. Geotargeting set in GSC for ccTLDs [med] D G
189. Currency/locale-appropriate content on the right URL [high] D N
190. No IP-based auto-redirect (offer user choice) [high] D
191. Translated metadata per locale (not English everywhere) [high] D
192. Duplicate content across locales handled by canonical or content distinction [high] D

---

## 11. Security & trust

193. HTTPS-only, no mixed content [crit] D
194. HSTS preload if appropriate [med] D
195. `Content-Security-Policy` present and not overly permissive [high] D
196. `X-Frame-Options` or `frame-ancestors` CSP directive [high] D
197. `X-Content-Type-Options: nosniff` [med] D
198. `Referrer-Policy` set sensibly [med] D
199. `Permissions-Policy` set [low] D
200. No exposed `.env`, `.git`, backup files at root [crit] D
201. No PII in URLs [crit] D
202. No mixed-case `Set-Cookie` flags missing `Secure`/`HttpOnly` [med] D
203. Server fingerprinting reduced (no verbose `Server:` header) [low] D
204. **Compromise check** — pages with hidden links, foreign-language injected content, defacement [crit] D N — common after WP plugin compromise

---

## 12. Accessibility (a11y) — overlap with SEO

Lighthouse runs ~50 WCAG criteria. Automated checks catch ~30–40% of issues; the rest need manual. We cover the automatable ones AND flag candidates for manual review.

205. `<html lang="...">` declared [crit] D
206. Image `alt` present (covered in §7) [high] D
207. Form inputs have associated `<label>` [high] D
208. Buttons have accessible text or `aria-label` [high] D
209. Links have accessible text (no empty anchors, no naked URLs) [high] D
210. Heading hierarchy proper [med] D
211. **Colour contrast** ≥ 4.5:1 normal text, 3:1 large text (axe-core check) [high] D
212. Focus visible on interactive elements [med] D
213. `<title>` and skip-to-content link [low] D
214. ARIA used correctly (no `role="button"` on a `<button>`, etc.) [med] D
215. Tables have headers; data tables use `<th>` [med] D
216. No `tabindex > 0` (creates unexpected focus order) [med] D
217. PDFs linked from indexable pages are themselves tagged + accessible [med] D
218. Video has captions / transcript [high] D
219. Documents flagged for **manual a11y review** (we name what we can't test) [info] D

---

## 13. AI / GEO / LLM readiness

This is the new frontier — overlaps with §14 below.

220. AI crawler policy in robots.txt (covered §1.1 #13) [high] D
221. `llms.txt` present at root, H1 site title, parseable [med] D — emerging standard
222. `llms-full.txt` present for documentation-heavy sites [med] D
223. Markdown content negotiation: server responds with `text/markdown` on `Accept: text/markdown` [med] D A — Cloudflare reports 3.9% adoption baseline
224. `.md` URL variants (`page.html.md` or `page.md`) returning clean markdown [low] D
225. Pages cite-friendly: clear claim → support structure [med] N
226. Entity coverage: page references named entities present in Wikidata / Google KG [med] N
227. Factual freshness signals: `dateModified` accurate [high] D
228. Author E-E-A-T: `author` schema with `sameAs` to authoritative profiles (covered §5 #117) [high] D
229. Q&A coverage for the page's primary query (without forbidden `FAQPage` schema misuse) [med] N
230. No `User-Agent: GPTBot Disallow: /` unless intentional [high] D

---

## 14. Agent readiness (WebMCP, MCP discovery, A2A) — Cloudflare's score

Most of these are **A** — we'll prefer wrapping `isitagentready.com/scan_site` over reimplementing.

### 14.1 Discoverability
231. `robots.txt` (RFC 9309) — covered §1.1 [high] D A
232. `sitemap.xml` — covered §1.2 [high] D A
233. **Link headers** (RFC 8288) for resource discovery — e.g. `Link: </.well-known/api-catalog>; rel="api-catalog"` [med] D A

### 14.2 Content
234. Markdown content negotiation — covered §13 #223 [med] D A

### 14.3 Bot access control
235. **Content Signals** in robots.txt (covered §1.1 #14) [med] D A
236. **Web Bot Auth** — HTTP message signatures, `/.well-known/http-message-signatures-directory` [low] D A

### 14.4 Capabilities (the truly new stuff)
237. **MCP Server Card** at `/.well-known/mcp/server-card.json` [med] D A
238. **WebMCP** support (Chrome 146+ — `data-mcp-tool` HTML annotations on forms/actions) [med] D A — opt-in, but a strong signal
239. **Agent Skills** discovery at `/.well-known/agent-skills/index.json` [low] D A
240. **API Catalog** (RFC 9727) at `/.well-known/api-catalog` [low] D A
241. **OAuth server discovery** (RFC 8414) [low] D A
242. **OAuth Protected Resource** (RFC 9728) [low] D A

### 14.5 Commerce (non-scoring on Cloudflare, but flag)
243. x402 (HTTP 402 Payment Required protocol) [info] D A
244. Universal Commerce Protocol [info] D A
245. Agentic Commerce Protocol [info] D A

---

## 15. Content syndication / feed opportunities (Richard's specific ask)

Surprisingly absent from every OSS tool I surveyed. Easy wins.

246. **RSS or Atom feed present** for any chronological content type (blog, news, podcast, releases) [med] D
247. **Feed autodiscovery `<link rel="alternate" type="application/rss+xml">`** in `<head>` of the index page [med] D
248. Feed validates against W3C feed validator [med] D
249. Feed includes `<lastBuildDate>`, `<pubDate>`, `<atom:link rel="self">`, namespaces correct [med] D
250. **Podcast-specific:** `<itunes:*>` tags complete (`category`, `image` ≥ 1400×1400, `summary`, `explicit`, `author`) [high] D — applies to anything publishing audio
251. **YouTube channel ↔ site:** site exposes channel via `sameAs` schema [low] D
252. **Sitemap-news** for news sites [high] D
253. **Sitemap-video** for video pages [high] D
254. **JSON Feed v1.1** as an additional format (light, well-supported) [low] D
255. **WebSub / PubSubHubbub `<atom:link rel="hub">`** for push-syndication of fast-moving feeds [med] D
256. **Content type detection → recommend feed:** if we detect a `/blog/`, `/news/`, `/releases/`, `/podcast/`, `/changelog/` content type AND no feed exists, raise an opportunity [high] N — recommendation engine territory
257. **Feed → schema cross-check:** each feed item should correspond to a page with matching `Article` or `PodcastEpisode` schema [med] D
258. **Bing IndexNow** ping endpoint configured for fast indexing of new URLs [med] D

---

## 16. GSC-derived checks (need a connected property)

All **G**.

259. Top declining queries (28d vs prior 28d) by impressions × CTR loss [high] G
260. Top declining pages [high] G
261. Position changes for tracked terms [high] G
262. CTR < expected-for-position by ≥ 30% (title/snippet opportunity) [high] G
263. Pages with impressions but no clicks (intent mismatch) [high] G N
264. Pages with clicks but no impressions in current period (de-ranked) [crit] G
265. Queries with impressions but no dedicated landing page (content gap) [high] G N
266. Country/device breakdown anomalies [med] G
267. Average position vs CTR curve (which positions are over- or under-performing) [med] G
268. Search appearance: AMP, sitelinks, FAQ rich result counts [med] G
269. Index Coverage report errors / warnings [crit] G
270. Mobile Usability errors (if still surfaced) [med] G
271. Page Experience / CWV report [high] G
272. Manual Actions [crit] G
273. Security Issues [crit] G

---

## 17. SERP / DataForSEO checks (need API)

All **S**.

274. For each target URL, fetch live SERP for its target query [info] S
275. SERP feature presence (PAA, AI Overview, knowledge panel, sitelinks, image pack) [info] S
276. Competitor SERP overlap (which 10 sites we share the SERP with) [info] S
277. SERP intent classification (informational / commercial / navigational / transactional) [med] S N
278. Page intent vs SERP intent mismatch [high] S N
279. AI Overview citation tracking (are we cited?) [high] S
280. Query fan-out: variants of a target query, do we cover them? [med] S N

---

## 18. Log file analysis (separates senior from junior audits)

All **L**.

281. Access logs collected, ≥ 90 days retained [info] L
282. Googlebot share of bot traffic [info] L
283. Crawl rate per template / per section [info] L
284. 404s and 5xx Googlebot encounters, trended weekly [high] L
285. Redirect crawling waste (% of Googlebot hits to redirected URLs) [med] L
286. Parameter URL waste — % of Googlebot hits to parameter URLs vs canonical [high] L
287. **Stale-content crawl** — URLs Googlebot stopped visiting [high] L
288. **Crawl budget priority alignment** — high-revenue URLs crawled at least weekly [crit] L
289. AI crawler share (GPTBot, PerplexityBot, ClaudeBot, OAI-SearchBot) [info] L
290. Bot vs human traffic separation [info] L
291. Soft-404 detection (200 returned for "page not found" content) cross-ref with logs [high] L
292. Pages reached only by bots (no human traffic) [med] L
293. Pages reached only by humans (bots don't crawl them — orphan-from-bot-view) [high] L

---

## 19. Local & specialised verticals

294. `LocalBusiness` schema with NAP (name, address, phone), `geo`, `openingHours` [high] D
295. NAP consistency across web (Google Business Profile, Yelp, Apple, etc.) [high] N — usually external tool
296. Google Business Profile linked from homepage `sameAs` [med] D
297. Multi-location pages have unique content per location [high] D N
298. Reviews schema only on pages with actual on-page reviews [high] D

---

## 20. Reporting & ops hygiene (the audit *about* the audit)

299. Every finding cites its evidence (URL, header, line, screenshot, log row) [crit] D
300. Every finding labelled D or N [crit] D
301. Severity assigned with a documented threshold [high] D
302. Recommendations ordered by est-impact ÷ est-effort [high] D N
303. Re-audit cadence recommended (monthly / quarterly per category) [med] D
304. Diff vs prior audit [med] D
305. Changes correlated with deployment markers if available [med] D

---

## How this maps to our MCP

When we write `plan/tool-surface.md`, every numbered check above should map to:
- A **tool input** (URL, sitemap path, property ID, log file path, API credential),
- A **deterministic test function** (D items) OR **prompt template + grounding** (N items),
- An **evidence payload** (what we serialise back: header, screenshot path, log row, GSC API response),
- A **severity rule**,
- A **citation** to the spec / blog / war story that justifies it.

That's our spec contract.

---

## Open questions

1. Do we ship all 305 checks at v1, or split into "core (≈150)" + "deep dive (≈150)"? Probably the latter — gate the rest behind explicit opt-in flags.
2. For log analysis, do we accept raw log files (Combined Log Format) or require Cloudflare/AWS analytics API integration? Both, ideally — raw is the lowest common denominator.
3. Do we bundle `axe-core` for accessibility, or shell out to Lighthouse, or implement WCAG checks ourselves? Probably `axe-core` — it's MPL-2.0 and the industry standard.
4. WebMCP detection: do we look only for the HTML annotation pattern, or also try to *invoke* `/.well-known/mcp/server-card.json` and parse the tools? Both are useful.
5. How do we handle the *recommendation* phase? Templated text per rule, or one Gemini grounded call per group of findings? Probably mixed — templates for D findings, grounded LLM for the priority ordering and N-finding narratives.

---

## Sources

### 2026 industry checklists (cross-validation)
- [DigitalApplied — Technical SEO Audit Checklist 2026: 200+ Items to Fix](https://www.digitalapplied.com/blog/technical-seo-audit-checklist-200-items)
- [Yotpo — Full Technical SEO Checklist: The 2026 Guide](https://www.yotpo.com/blog/full-technical-seo-checklist/)
- [DebugBear — Technical SEO Checklist: The Complete Guide For 2026](https://www.debugbear.com/blog/technical-seo-checklist)
- [NoGood — Technical SEO Checklist 2026: What Really Matters](https://nogood.io/blog/technical-seo-checklist/)
- [Wellows — Technical SEO Checklist: SERP & AI Visibility (2026)](https://wellows.com/blog/technical-seo-checklist-for-agencies/)
- [SEOlogist — Technical SEO Checklist for 2026 (Prioritized & Practical)](https://www.seologist.com/knowledge-sharing/technical-seo-checklist/)
- [Neuronwriter — The Technical SEO Checklist for 2026: Managing LLMs, Bots, and Crawl Budgets](https://neuronwriter.com/technical-seo-checklist-2026-llm-bots-crawl-budget/)
- [KwameTech Labs — Technical SEO Checklist for AI-First Indexing | 2026](https://www.kwametechlabs.com/blog/technical-seo-checklist-ai-first-indexing-2026)
- [SearchEngineLand — Technical SEO for generative search: Optimizing for AI agents](https://searchengineland.com/technical-seo-generative-search-optimizing-ai-agents-473039)
- [Over The Top SEO — Enterprise SEO Audit Checklist 2026: The 47-Point Framework](https://www.overthetopseo.com/enterprise-seo-audit-checklist-2026/)

### Agent readiness
- [Cloudflare — Introducing the Agent Readiness score](https://blog.cloudflare.com/agent-readiness/)
- [isitagentready.com](https://isitagentready.com/)
- [SearchEngineLand — Why now is the time to prepare for WebMCP](https://searchengineland.com/webmcp-prepare-now-477548)
- [SearchEngineLand — WebMCP explained: Inside Chrome 146's agent-ready web preview](https://searchengineland.com/webmcp-explained-inside-chrome-146s-agent-ready-web-preview-470630)
- [Semrush — WebMCP: What It Is, Why It Matters](https://www.semrush.com/blog/webmcp/)
- [LogRocket — How to make your website agent-ready with Google's Web MCP](https://blog.logrocket.com/google-web-mcp/)
- [TechPullers — Google's WebMCP: The Agentic Web Protocol That Changes Technical SEO in 2026](https://techpullers.com/blogs/google-webmcp-agentic-web-seo.php)

### llms.txt
- [Mintlify — What is llms.txt?](https://www.mintlify.com/blog/what-is-llms-txt)
- [ScaleMath — LLMs.txt: The Emerging Standard Reshaping AI-First Content Strategy](https://scalemath.com/blog/llms-txt/)
- [GetPublii — The Complete Guide to llms.txt](https://getpublii.com/blog/llms-txt-complete-guide.html)
- [hitlseo.ai — llms.txt vs llms-full.txt: The Complete 2025 Guide](https://hitlseo.ai/blog/llms.txt-vs-llms-full.txt-the-complete-2025-guide-to-ai-friendly-documentation/)

### Accessibility ↔ SEO
- [Chrome for Developers — Lighthouse accessibility score](https://developer.chrome.com/docs/lighthouse/accessibility/scoring)
- [Deque — Axe color-contrast rule](https://dequeuniversity.com/rules/axe/2.2/color-contrast?application=lighthouse)
- [JumpFly — How to Use Accessibility as an SEO Advantage](https://www.jumpfly.com/blog/how-to-use-accessibility-as-an-seo-advantage/)
- [Deque — Will Accessibility Become Increasingly Important for SEO?](https://www.deque.com/blog/accessibility-importance-for-seo/)
- [Unlighthouse — Lighthouse Accessibility Audit Guide](https://unlighthouse.dev/learn-lighthouse/accessibility)

### Orphan pages & internal links
- [SiteChecker — Orphan Page Checker](https://sitechecker.pro/orphan-page-checker/)
- [Gracker — Mastering Orphan Page Identification](https://gracker.ai/seo-101/orphan-page-identification-seo)
- [Magnet — Fix Orphan Pages: Automate Internal Links with AI & Python](https://magnet.co/articles/automating-internal-link-architecture)
- [PushLeads — Log file orphan detection with Splunk/ELK](https://pushleads.com/seo/the-orphan-pages-killing-your-local-business-seo/)
- [InLinks — Orphaned Pages: How to fix them](https://inlinks.com/insight/orphan-pages/)

### Syndication / feeds
- [Mark Nottingham — RSS and Atom Feed Tutorial (feed autodiscovery)](https://mnot.net/rss/tutorial/)
- [Ryte Wiki — Atom Feed (search engines discovering new content)](https://en.ryte.com/wiki/Atom_Feed/)
- [Adobe — Podcast RSS feeds](https://podcast.adobe.com/en/guides/podcast-rss-feeds)
- [ClickRank — What is a Feed (RSS/Atom) in SEO?](https://www.clickrank.ai/seo-glossary/f/what-is-a-feed-rss-atom-in-seo/)
- [FasterCapital — Atom feeds: structured data and SEO discoverability](https://fastercapital.com/topics/an-overview-of-rss-and-atom-feeds.html/1)

### Log file analysis
- [SearchEngineLand — Log file analysis for SEO guide](https://searchengineland.com/guide/log-file-analysis)
- [Astrak — SEO Log Analysis 2026](https://astrak.agency/en/seo-log-analysis/)
- [w3era — Log File Analysis for SEO: How Google Crawls Your Site 2026](https://www.w3era.com/blog/seo/log-file-analysis-seo-guide/)
- [Visively — Log File Analysis for Technical SEO](https://visively.com/kb/algorithms/log-file-analysis)
- [Stackmatix — Log File Analysis for SEO: How to Read Googlebot's Behavior](https://www.stackmatix.com/blog/log-file-analysis-seo-insights)

### War stories — protocol-level
- [MDN — 304 Not Modified](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/304)
- [Kinsta — How to Fix an HTTP 304 Not Modified](https://kinsta.com/knowledgebase/http-304/)
- [Webmasters Stack Exchange — Vary headers and 304 crawler issues](https://webmasters.stackexchange.com/questions/25342/headers-to-prevent-304-if-modified-since-head-requests)

### Specifications
- RFC 9309 (robots.txt) · RFC 8288 (Link headers) · RFC 9727 (API catalog) · RFC 8414 (OAuth discovery) · RFC 9728 (OAuth protected resource) · sitemaps.org (sitemap protocol) · schema.org (structured data) · WCAG 2.2 (accessibility) · ISO 639-1 / 3166-1 (hreflang) · ISO 8601 (dates)

### Prior-art rule catalogues (for cross-check)
- [SEOmator (seo-skills/seo-audit-skill) — 251 rules / 20 categories](https://github.com/seo-skills/seo-audit-skill)
- [puneetindersingh/open-seo-crawler — Ahrefs/Moz-cited rule explanations](https://github.com/puneetindersingh/open-seo-crawler)
- [janreges/siteone-crawler — weighted 5-category model](https://github.com/janreges/siteone-crawler)
