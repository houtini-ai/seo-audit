---
name: Hobo Technical SEO 2025 + Dejan grounding-chunk research — study & scope mapping
description: What we can build, what's out of scope, from Shaun Anderson's leak-informed framework and Dejan AI's grounding-chunk economics. Maps each idea to the MCP's current capabilities.
type: research
studied: 2026-06-24
sources:
  - research/reference/Hobo-Technical-SEO.pdf  (Shaun Anderson / Hobo, "Technical SEO 2025", ~250k words)
  - https://dejan.ai/blog/how-big-are-googles-grounding-chunks/
  - https://dejan.ai/i/gss/  (Google Snippet Selection simulator — BERT/Passage-Ranking/SMITH)
---

# Hobo + Dejan — study & scope mapping

## 1. The two sources, in a paragraph each

**Hobo "Technical SEO 2025" (Shaun Anderson).** A senior-level framework built on *evidence* rather than inference: the 2024 Content Warehouse API leak + the DOJ v. Google trial. Its spine is a "Maslow's Hierarchy of SEO Needs" (Foundation → Content → Authority → UX), each level mapped to specific leaked attributes. The thesis: stop trying to please a black box; engineer a digital asset that aligns with the now-documented ranking pipeline — a CompositeDoc consolidated from clean signals, scored for query-independent quality (Q*) and proven by query-dependent user satisfaction (T* / NavBoost).

**Dejan AI — grounding chunks / snippet selection.** Empirical study of how Google's AI grounding selects passages. Hard numbers (below) and a model of the pipeline: segment → retrieve (bi-encoder) → re-rank (cross-encoder / SMITH for long docs). Implication: AI search lifts *short, self-contained, front-loaded passages*, and there's a fixed grounding budget per query so **density beats length**.

## 2. Dejan's numbers (directly actionable for our content-cluster layer)
- Grounding budget ≈ **2,000 words per query**, split by ranking position (#1 ≈ 531 words / 28% share, 2× the #5 source).
- Per page selected: **median 377 words (2,427 chars)**; 77% of pages contribute 200–600 words; max ~1,769.
- Average chunk ≈ **15.5 words** (sentence-grain segmentation).
- **Diminishing returns:** <1k-word pages → 61% of content grounded; 1–2k → 35%; 3k+ → only 13%. Past ~1,500 words extra length is barely grounded.
- Pipeline favours: logical semantic breaks, self-contained passages that answer one question, **front-loaded** answers, clean DOM.

## 3. Mapping — Hobo's hierarchy × our MCP
Legend: ✅ already do · ⚠️ partial · 🟢 feasible new build (we have the data) · ❌ out of scope (need data we don't have).

### Level 1 — Foundation: Accessibility & Canonicalisation
- Indexability (robots/noindex) → ✅ noindex-with-traffic, robots-disallowed, indexability breakdown.
- HTTPS / `badSslCertificate` → ⚠️ we flag non-https + mixed-content, but NOT cert validity/expiry. 🟢 **cert-expiry probe** is a cheap HTTP/TLS check we could add.
- Single source of truth / CompositeDoc consolidation → ✅ strong: broken-canonical-target, canonical-ignored, canonical-conflict, redirect-chain, internal-links-to-redirects, sitemap-non-indexable.

### Level 2 — Content: Quality, Relevance & Structure
- `OriginalContentScore` (uniqueness) → ⚠️ only duplicate-title/meta today. Near-duplicate *body* detection (shingling over body_chunks) is now feasible since we store chunks — but heavy; keep deferred.
- `contentEffort` (labour/expertise) → ❌ not directly measurable. Weak proxies only (word count, multimedia, original data) — skip claiming it.
- **Signal Coherence (title ↔ H1 ↔ inbound internal-anchor) → "Goldmine"** → ⚠️→🟢 We do title-h1-mismatch + title/h1-missing-top-query, but NOT *inbound anchor coherence*. **NEW: anchor-text coherence** — for each page, do the internal anchors pointing AT it share significant terms with its title/H1/top-query? We have `links.anchor_text` + `pages`. High-value, novel, deterministic.
- Structure for machines (Schema → `richsnippet`, headings → `EntityAnnotations`) → ✅ schema checks + heading-hierarchy + **poor-chunkability (just shipped)**.

### Level 3 — Authority: Link Equity & Trust
- `onsiteProminence` (importance via simulated traffic flow) → ✅ this IS our internal PageRank (iPR) + equity-vs-traffic scatter + underlinked-high-demand. Reframe UI copy in Hobo's language.
- `predictedDefaultNsr` "algorithmic momentum" / freshness / `lastSignificantUpdate` / FreshnessTwiddler → ⚠️→🟢 We have traffic-decay + drift snapshots + JSON-LD dates. **NEW: stale-content** — Article `dateModified` old AND traffic declining → a refresh candidate (the lastSignificantUpdate proxy).
- `spamrank` / outbound link neighbourhood → ❌ needs a link-quality dataset; skip (or a thin "outbound to known-bad TLD/pattern" heuristic — low confidence, probably skip).

### Level 4 — Enhancement: User Satisfaction
- NavBoost / `lastLongestClicks` / `badClicks` / satisfied click → ❌ needs clickstream we don't have. Our CTR-below-expected + impressions-rising-clicks-flat are the legitimate GSC-only proxies — already shipped. Don't pretend to measure NavBoost.
- `clutterScore` (ad clutter) → ❌/⚠️ could count ad-network scripts/iframes but noisy + privacy-ish; borderline, low priority.
- Page experience / CWV → ⚠️ high-yield-cwv-fail exists (needs page_lighthouse run).

### Topical (cross-cutting)
- `siteFocusScore` / `siteRadius` (topical focus & breadth) → ⚠️→🟢 We have templates + Wikidata entities. **NEW (heuristic): topical-focus proxy** — entity/template concentration vs spread; flag sites/sections drifting off-topic. Interesting, heuristic, lower priority.

### Dejan grounding economics → content-cluster refinements
- 🟢 **Chunk-model alignment:** our 1,500-char (~250-word) chunk cap is sane, but the *grounded passage* is ~377 words / 2,427 chars. Keep chunk granularity; the value is in the checks, not the cap.
- 🟢 **NEW: content-density / grounding-bloat** — pages >~2,500–3,000 words where AI grounding coverage collapses to ~13% ("density beats length"): recommend tightening or splitting into focused, headed sections. We have `word_count`.
- 🟢 **NEW: answer front-loading** — extend rag-answer-gap with position: is the answer to the top query in the intro / first chunk, or buried? Grounding is ranking-weighted and front-loaded; a buried answer is missed.

## 4. Net recommendation — what to build (priority order)
1. **anchor-text coherence** (Signal Coherence / Goldmine) — deterministic, novel, data in hand. *Highest value.*
2. **stale-content** (lastSignificantUpdate proxy) — JSON-LD dateModified + traffic-decay.
3. **content-density / grounding-bloat** (Dejan "density beats length") — word_count threshold + low headed-chunk ratio.
4. **answer front-loading** — extend rag-answer-gap (is the top-query answer in chunk 0–1?).
5. (Optional, heuristic) **cert-expiry probe**; **topical-focus proxy**. Lower priority.

**Explicitly OUT OF SCOPE** (the leaked *scores* themselves are Google-internal and unmeasurable from outside; we approximate, we don't fake): siteAuthority / Q* / NSR / contentEffort / OriginalContentScore (true), NavBoost / lastLongestClicks / clutterScore, spamrank. Framing UI/recommendation copy in these documented terms is fair; *claiming to compute them* is not — stay strict ("a wrong finding is worse than none").

## 5. Big-picture takeaway
Hobo validates the architecture we already lean on: internal prominence (iPR), signal coherence (title/H1/anchor), clean canonicalisation, structured data, and GSC-satisfaction proxies. The two genuinely *new, in-scope* moves are **(a) inbound anchor-text coherence** and **(b) the AI-grounding content checks** (front-loading + density), which sit right on top of the chunk layer we just shipped — and almost nobody else automates them.

## 6. Gemini SOTA refinements (consulted 2026-06-24, before scoping)

**1. Anchor-text coherence.** Sound — the leak confirms `anchor_mismatch` / `phrase_anchor_spam`, and internal+external anchors are pooled. SOTA op: aggregate unique inbound anchors to URL X **weighted by source-page iPR**; compare to the page's top GSC query. *FP guard:* isolate IN-CONTENT links only — strip header/footer/aside + any block identical across >15% of pages. **We already have `links.placement` (body/navigation/footer) → filter `placement='body'`, no boilerplate detection needed.** Threshold: flag when significant-term overlap is empty AND the primary query intent is absent from the body-anchor pool. (Gemini suggests a bi-encoder cosine <0.35; we'll ship the deterministic term-overlap version first to stay dependency-free + strict, ML optional later.)

**2. Stale-content.** Sound but volatile (`freshness_twiddler` on `SemanticDate`, often JSON-LD). *FP guard: MUST use Year-over-Year windows* to negate seasonality + zero-click-SERP CTR loss. Threshold: `dateModified` >12mo old AND clicks down >25% YoY AND **impressions** down >15% YoY (impressions confirm ranking decay, not just CTR) AND baseline >100 clicks/mo. **DATA DEPENDENCY: needs ~13 months of GSC; our default sync is 90 days → requires a deeper `startDate` sync or this defers.** Without YoY it's seasonality-prone — don't ship the same-period-vs-prior version.

**3. Density / front-loading.** Critical ("lost in the middle"; base IR still weights the first ~512 tokens). *FP guard:* parse `<main>`, strip nav/ul/ol ToC, evaluate only the first contiguous ~300 words of `<p>` text, and apply only to informational-intent queries. Threshold: word_count >1,500 AND top-query terms absent from the first ~15%/300 words. We already capture the intro chunk (chunk before the first heading) → front-loading is a short hop on the existing layer.

### The bigger play Gemini flagged — **cross-encoder Max-Passage Score** (the real "RAG snippetability" test)
Neural retrieval ranks a doc by its **single highest-scoring passage**, not document-average relevance. Our current RAG-gap uses deterministic term-overlap (bi-encoder-ish at best). SOTA: run a local **cross-encoder** (`cross-encoder/ms-marco-MiniLM-L-6-v2`) over `[GSC top query, 300-word sliding-window chunk (stride 100)]`, take the **max score across chunks**; flag if it falls below the model's confidence (≈ logit 3.0) **even when keyword presence is high** — i.e. the page rambles, no dense extractable answer, will bleed in AI SERPs.
- **Decision for the user:** this needs an ML runtime in a currently pure-TS/SQLite MCP — `transformers.js` + an ONNX model (~80MB download, CPU inference per page×query). Powerful and differentiating, but a real architectural step (dependency, model weights, inference time, possibly a Python sidecar). Everything else above stays deterministic/dependency-free.

### Net scoping call
Build the deterministic trio first (anchor-coherence → front-loading → stale-content-if-we-deepen-sync), since they're strict, cheap, and need no ML. Treat the cross-encoder Max-Passage Score as a separate, higher-ceiling initiative to decide on explicitly (ML runtime trade-off) — it would supersede the deterministic RAG-gap as the flagship AI-search check.

## 7. Build status (2026-06-24, end of session)
SHIPPED + committed: anchor-text-incoherent (#20); cross-encoder Max-Passage `score_passages` tool + `weak-passage-answer` check on a local ms-marco-MiniLM reranker (GPU via DirectML, CPU fallback) (#23); answer-not-front-loaded + content-bloat (#22); stale-content (#21, YoY-guarded). 81 checks total, E2E 0 errors.
- **stale-content validation is data-blocked, not built-blocked:** needs a property with ≥13 months of GSC history AND Article JSON-LD dates. ehi has neither (its sc-domain GSC only goes back ~104 days — `full+startDate` fetched 91k rows but GSC simply has no older data for this property; and as a Shopify product site only ~10 pages carry a date field). simracing (content site, has Article dates) is the right validation target but would need a heavy ~13-month sync. The check is sound + guarded; it stays silent until such data exists.
- **NEW research (#24):** a LOCAL GENERATIVE model alongside the MCP (vs the cross-encoder *scorer*) to enrich analysis — richer prose summaries, draft fixes (rewritten title/meta, front-loaded answer passages), topic/intent extraction. Either embed via transformers.js/ONNX (same GPU harness) or call the existing houtini-lm endpoint. Hard constraint: strictly grounded — deterministic checks + reranker stay the source of truth; the LLM only phrases/drafts verified findings, never invents. Evaluate before building.
