---
name: Internal link graph — authority flow, depth, and the GSC-powered linking move
description: The directed-graph analysis almost no OSS tool exposes (prior-art gap #6) — internal PageRank, click depth, hubs/dead-ends/orphans, anchor-text concentration, link-equity waste, and the flagship GSC×graph move: which high-authority page should link to which striking-distance page.
type: research
phase: 1
---

# Internal link graph — authority flow & the linking money-move

**Why cutting-edge:** most tools detect orphans by sitemap-vs-crawl diff and stop. Almost none expose the **full directed internal-link graph as a queryable object** ([07-prior-art](07-prior-art.md) gap #6). We already store it (`links`: source_url, target_url, anchor_text, is_internal, placement). Computing authority flow on it — then joining to GSC — produces the single highest-ROI recommendation an SEO can act on.

## 1. Internal PageRank (iPR) — authority flow
- **Power iteration** on the internal graph: `PR(u) = (1−d)/N + d · Σ_{v∈In(u)} PR(v)/OutDeg(v)`, `d=0.85`, init `1/N`, halt at `Δ<1e-6` or 20 iterations.
- **Placement weighting:** down-weight `nav`/`footer` links (×0.2) vs `body` (×1.0) — boilerplate links shouldn't dominate contextual authority.
- Normalise to a log 0–100 `iPR` score per page.
- **Insight:** `iPR > 80 AND gsc_clicks < 10` → high internal authority, zero ROI → repurpose/redirect/relink. `D` (graph) + `G` (GSC).

## 2. Click-depth distribution (BFS from homepage)
- BFS shortest path; **two passes** — Pass A all links; Pass B excluding `nav`/`footer` → *contextual* depth (the honest one).
- **Alert:** `body_depth ≥ 4` → too deep; flatten via hub pages. Histogram of URLs per depth is the architecture health view.

## 3. Hubs / dead-ends / orphans
- **Hubs:** `body` out-degree `> μ+2σ` AND in-degree `> μ` → topic-cluster parent candidates.
- **Dead-ends:** out-degree 0 excluding boilerplate → user-journey traps; suggest related/lateral links.
- **Orphans:** in-degree 0 → add ≥1 internal link or remove from sitemap. (Cross-ref [05](05-gsc-and-dataforseo-overlap.md) D1 — orphans *with GSC impressions* are top priority.)

## 4. Anchor-text concentration matrix
- Per target: `freq`/`total_inlinks` → `share_pct`; distinct-anchor count (or Gini).
- **Over-optimisation:** `top_anchor_pct > 0.60 AND total_inlinks > 10` (excluding brand/nav) → flag.
- **Under-optimisation:** top anchor ∈ {"click here","read more", empty, image-no-alt} → rewrite to contextual anchor. (checklist #140–142)

## 5. Link-equity waste
- Join `links.target_url(url_key) = pages.url_key` where target `status ≠ 200` OR `noindex` OR `canonical ≠ self`.
- Output `source_url, target_url, anchor, waste_reason` (301 / 404 / canonicalised / noindex). **Action:** repoint internal links to the final 200/canonical. Prioritise fixes by the **source page's iPR** (waste from a high-authority page matters most). (checklist #165–166)

## 6. The money-move — GSC×graph internal-link opportunity
The flagship. Match high-authority **donors** to high-potential **receivers** that aren't yet linked:
- **Donors:** `iPR > 70`.
- **Receivers:** `gsc_position BETWEEN 11 AND 25` (striking distance) AND `gsc_impressions > median` (proven demand) AND (`iPR < 40` OR `body_depth ≥ 3`) — pages Google *almost* ranks but that the site under-links.
- **Unlinked pairs:** donors × receivers where no `links` row already connects them.
- **Relevance filter:** TF-IDF/BM25 (or local embeddings) on donor content vs receiver's top GSC query → keep topically-relevant pairs only.
- **Output:** `Donor → Receiver, suggested_anchor = receiver.top_gsc_query`, sorted by receiver impressions. "Add a contextual link on [Donor] with anchor '[query]' to push [Receiver] onto page 1." `D` (graph) + `G` (GSC) + `N` (relevance/anchor judgement).

This is impossible with GSC alone (no link graph) or crawl alone (no demand signal) — the exact GSC×crawl thesis, and a recommendation an SEO will act on immediately.

## Implementation notes
- iPR + BFS run **in-process over the SQLite `links` table** after a crawl completes (bounded compute, no external cost); cache scores on `pages`.
- All of this depends on the shared `url_key` join ([plan/architecture](../plan/architecture.md) §2) — raw-URL mismatches corrupt the graph (false orphans/dead-ends). The crawler's current raw-string link joins (code review) must move to `url_key` first.

## Sources
- Gemini (`gemini-3.1-pro-preview`, grounded) — iPR power-iteration with placement weighting, two-pass BFS depth, hub/dead-end thresholds, anchor matrix, equity-waste join, and the donor→receiver opportunity algorithm, this session.
- [01-checklist](01-modern-technical-seo-checklist.md) §8 (#154–169); [07-prior-art](07-prior-art.md) gap #6; [05-gsc-and-dataforseo-overlap](05-gsc-and-dataforseo-overlap.md) D1.
