---
name: Recommendation engine — scoring, prioritisation, evidence
description: How seo-audit-console turns findings into a prioritised, defensible action list — impact÷effort scoring that uses real GSC traffic-at-risk + DataForSEO volume, the D/N certainty weighting, deterministic effort estimation, and the four-tier output. This is what makes the audit actionable, not just a wall of issues.
type: plan
phase: 5
---

# Recommendation engine — scoring, prioritisation, evidence

**Goal:** never present a flat wall of 10,000 issues. Order by **likely impact ÷ effort**, grounded in *real traffic at risk* (GSC) and *market potential* (DataForSEO), honest about certainty (D vs N). This is the layer incumbents do shallowly and the reason a senior SEO would trust the output.

## 1. Priority score

Per finding (aggregated per issue-type for output):

```
P = (S × C × V) / E
```

- **S — severity weight:** crit 1.0 · high 0.8 · med 0.5 · low 0.2 · info 0.05.
- **C — certainty (ties to [research/03](../research/03-deterministic-vs-not.md)):** D = 1.0 · N = 0.5. N is damped because it carries implicit investigation cost and must be human-verified first.
- **V — value / traffic-at-risk** (log-normalised so one huge page can't bury hundreds of mid-tier issues):
  ```
  V_url = log10( clicks×10 + impressions + searchVolume×0.2 + 10 )
  ```
  clicks (GSC 28d) ×10 = realised high-intent value; impressions = visibility at risk; DataForSEO searchVolume ×0.2 = discounted potential; +10 floor so zero-traffic URLs still compute. Site-wide issues: `V_group = Σ V_url`.
- **E — effort** (deterministic, from a rule→effort map, not guessed):
  ```
  E = E_base × M_scale
  ```
  `E_base` (Fibonacci, per check id): 1 trivial (robots/sitemap/meta toggle) · 3 small (H1/alt) · 5 medium (new copy/internal links) · 8 hard (template/schema) · 13 epic (CWV/architecture). `M_scale`: global/template fix 1.0 · automated/regex (301 maps) 1.2 · per-page manual `log10(affectedUrls + 9)` (bulk workflows make it sub-linear).

Worked: homepage broken canonical → S1.0 × C1.0 × V(high) ÷ E(1×1.0) = very high → Tier 1. Thin content on 500 low-traffic pages → S0.5 × C0.5 × V(low sum) ÷ E(5 × log-scale) = low → backlog.

## 2. Output — four tiers (not a flat list)

Aggregate by issue-type, score `P_group`, bucket:

1. **Quick Wins ("do now"):** `P_group > threshold`, `E ≤ 3`, `C = 1.0`. High traffic-at-risk, trivial, deterministic. (Broken homepage canonical, missing title on a top page.)
2. **Strategic ("sprint planning"):** high `ΣV`, `E ≥ 5`, `C = 1.0`. Big ROI, needs dev tickets. (Template-wide CLS on product pages.) Sorted desc by `P_group`.
3. **SEO Review ("judgement queue"):** all `C = 0.5` (N) findings, sorted by `ΣV`. **Isolated from the dev queue** — SEO clicks Verify/Dismiss; on Verify, `C→1.0` and the finding re-routes into Tier 1/2 by its `E`.
4. **Backlog / info:** below threshold or `S ≤ 0.2`. Hidden by default.

This keeps deterministic engineering work separate from judgement work — the D/N honesty contract made operational in the UX.

## 3. Evidence & traceability (non-negotiable)

Every finding carries (checklist §20):
```
{ checkId, category, severity:S, label:[D|N|L|G|S], certainty:C,
  urlKeys:[...], affectedCount,
  evidence: { /* the proof: header line, DOM node, raw-vs-rendered diff,
               SERP check_url+datetime, GSC datapoint, screenshot path */ },
  trafficAtRisk: { clicks, impressions, position, searchVolume },
  effort: { base, scaleModifier, fixType },
  priority: P,
  recommendation: { text, generated?: /* json-ld / redirect block, dry-run */ } }
```
- **D findings** quote the byte-level evidence — verifiable without rerun.
- **N findings** cite the grounding inputs + confidence, phrased as assessment (the Gemini-grounded narrative), never fact.
- **The chain holds:** recommendation → finding → raw datapoint. That traceability is the product (CLAUDE.md thesis).

## 4. How the recommendation text is produced
- **D findings:** templated per check id (fix text + a cited "why it matters" panel, the `open-seo-crawler` pattern from [research/07](../research/07-prior-art.md)). Deterministic, no LLM.
- **N findings + priority narratives:** Gemini-grounded (mixed model per [research/01](../research/01-modern-technical-seo-checklist.md) open-Q5) — one grounded call per finding *group*, not per finding, citing the data it used.
- **Generators** ([research/11](../research/11-schema-validation.md), [09](../research/09-seogets-and-check-coverage.md)): JSON-LD / redirect blocks attached to the relevant finding as a dry-run artifact the user approves.

## Sources
- Gemini (`gemini-3.1-pro-preview`, grounded) — the P=(S×C×V)/E model, log-normalised V, Fibonacci effort + scale modifier, four-tier sequencing, this session.
- [research/03 — determinism contract](../research/03-deterministic-vs-not.md) (C weighting), [research/05](../research/05-gsc-and-dataforseo-overlap.md) + [10](../research/10-dataforseo-and-serp-layer.md) (V inputs), [research/07](../research/07-prior-art.md) (severity+citation pattern), [01-checklist](../research/01-modern-technical-seo-checklist.md) §20.
