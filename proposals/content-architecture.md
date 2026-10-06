# Proposal: a "Content architecture" view (topic clusters, gaps, funnel, linking)

_Design proposal, 2026-10-06. A direction to review before building - no code yet._

## 1. The idea

Present the site as its **topical architecture**, built from the pages it already has, rather than as a flat list of URLs or an isolated keyword report. The topic-cluster / pillar-content model, made concrete and actionable:

1. Group the site's demand and pages into **content clusters** - a **pillar** topic with **supporting** topics around it, each mapped to the pages that cover it, plus the **funnel role** (top / middle / bottom of funnel).
2. Per cluster, flag **gaps grounded in the site's own structure** - not "what do competitors rank for that I don't," but *"given what this site already covers, what would logically strengthen this topic next."*
3. A gap can be a **new page** *or* a concept to fold into an **existing** page (strengthen coverage without creating overlapping URLs).
4. Use the cluster relationships to drive **internal linking** (pillar <-> supporting, related <-> related), so links follow the topical architecture rather than being added opportunistically.
5. Make it a **living roadmap** that grows as pages are published, rather than something regenerated from scratch each time.

The reframed question: not "what could I write about?" but **"based on what my site already covers, what should I improve or create next, and where does it fit?"**

## 2. We already have most of the ingredients

| Capability | Our existing equivalent |
|---|---|
| Entity resolution per page | `page_entity` (Wikidata QID via H1/title) + `entity_edge` (P279 subclass-of / P361 part-of), `resolve_entities`; the **entity & topic graph** view |
| Topical clustering + gaps + the page to link from | `src/audit/opportunities.ts` / `suggest_pages` - GSC demand (rank 11+), dedup, **lexical clusters scored by impressions x intent, with the nearest existing page to link from** |
| Template/section clustering | `src/audit/templates.ts` (`list_templates`) - clusters by URL morphology + JSON-LD @type |
| Funnel role | `keyword_intent` (`search_intent`) - informational / navigational / commercial / transactional |
| Internal linking by topic | `entity-internal-link-gap` (judgement) + `linkGraph` iPR donors + `fix_finding` internal-link generator |
| Content/co-occurrence substrate | `pages.body_chunks` (heading-segmented body text) + the cross-encoder (`passageScore`) |
| "Living roadmap" | `page_snapshots` (drift) + the audit re-runs on each refresh |

We are closer than it looks: **`suggest_pages` already does demand-cluster -> gap -> nearest-page-to-link.** What we lack is the **unified cluster map** that ties clusters + coverage + gaps + funnel + linking into one view.

## 3. Honest constraints (what shapes the design)

- **Our entity layer is thin.** `resolve_entities` is a heuristic H1 -> Wikidata QID resolve; it typically resolves only a handful of entities per site (e.g. ~4 on a 400-page test site), and the edges point to broad parent concepts that aren't themselves page-entities. We do not run full NLP entity extraction over page bodies. So an **entity-first** clustering would be sparse on our data.
- **Therefore: cluster GSC-first, enrich with entities.** We have deep, real demand data (hundreds of thousands of GSC rows) and the lexical clustering already written. Build the clusters from **GSC query demand + the pages that serve it**, and layer entities on top where they resolve. This plays to our strengths and stays honest about what we can actually compute.
- **Entity co-occurrence** (the "which concepts appear together for this topic" step) is the most novel piece and the hardest. We can approximate it from `body_chunks` term co-occurrence + the reranker, but a faithful version needs richer entity extraction - a later phase, not V1.

## 4. Proposed feature: the "Content architecture" view

A view (new **Topics** tab, or a card cluster on an upgraded Architecture tab) that presents the site as topic clusters, each actionable.

### Data model (payload sketch)
```
contentArchitecture?: {
  clusters: {
    id: string;
    pillar: { label: string; page: string | null; impressions: number };   // the cluster's main topic + its best covering page
    funnel: 'informational' | 'commercial' | 'transactional' | 'mixed';     // from keyword_intent of the cluster's queries
    members: {
      topic: string;                 // a sub-topic / query group in the cluster
      page: string | null;           // the page covering it, or null = gap
      impressions: number;
      status: 'covered' | 'thin' | 'gap';
      entity: { qid: string; label: string } | null;  // entity enrichment where resolved
    }[];
    gaps: { topic: string; impressions: number; nearestPage: string | null; reason: string }[];  // grounded in our structure (reuse opportunities.ts)
    linkSuggestions: { from: string; to: string; anchor: string }[];        // pillar<->supporting, from the link graph + entity mesh
    coverage: number;                // % of the cluster's demand with a real covering page
  }[];
  totalClusters: number;
}
```

### How it's built (reuse, don't reinvent)
- **Clusters**: extend `opportunities.ts`' lexical demand clustering to return the *whole* cluster (pillar + members + the pages serving each), not only the new-page proposals.
- **Coverage / gap / thin**: a cluster member is `covered` when a page ranks/serves it, `thin` when it ranks poorly (striking distance) or the page's passage score is weak (reuse `max_passage_score`), `gap` when there's demand and no covering page (already what `suggest_pages` finds).
- **Funnel**: aggregate `keyword_intent` across the cluster's queries (persist via `search_intent`).
- **Entity enrichment**: join `page_entity` to label the pillar/members where an entity resolved.
- **Link suggestions**: pillar <-> supporting from the link graph (missing in-content links between cluster pages) + `entity-internal-link-gap`.

### The view
- A cluster map: each cluster a pillar node with supporting nodes (reuse the force-graph component from the structure map / entity graph), node colour = coverage status (green covered / amber thin / red gap), funnel badge on the cluster.
- A ranked cluster list: pillar, coverage %, funnel, top gaps, with the one-click `fix_finding` link suggestion.
- Every number keeps its D/N label and its window; gaps cite the GSC demand behind them (traceability).

## 5. What makes ours distinctive (lead with the moat)
- **Grounded in first-party GSC**, not a third-party index - gaps are real demand *this* site already sees or is close to.
- **Impact / effort prioritisation** on each gap (recoverable clicks per dev-hour), not a flat idea list.
- **D/N honesty + traceability** - every cluster and gap traces to the datapoint.
- **AI answerability + the equity view** sit alongside, so a cluster can be judged for both topical completeness *and* whether its pages actually carry extractable answers.

## 6. Phasing
1. **V1 - Content architecture view (GSC-first).** Clusters + coverage/thin/gap + funnel + link suggestions, from GSC demand + crawl + intent, reusing `opportunities.ts`. Entity labels where resolved. The unified view, on data we already hold.
2. **V2 - entity enrichment + co-occurrence.** Richer entity extraction over `body_chunks` (beyond H1->QID), the cluster-optimise co-occurrence step (missing concepts to fold into existing pages), and "add to existing page vs new page" guidance.
3. **V3 - living roadmap.** Track cluster coverage over time (`page_snapshots`), mark gaps as addressed when a page ships, surface newly-emerged clusters.

## 7. Open questions for review
- New **Topics** tab, or fold into the Architecture tab as a cluster section?
- V1 clustering: lexical (what `opportunities.ts` does today) only, or also group by shared resolved entity where available?
- Is the heuristic H1->QID entity layer worth deepening now (V2 body-text extraction), or keep entities as a thin enrichment and let GSC demand carry the clustering?
