---
name: Deterministic vs non-deterministic — the honesty contract
description: The labelling discipline that is our core differentiator. Defines D (deterministic), N (judgement), L (log), G (GSC), S (SERP) precisely, the rules for emitting each, and how N findings must be gated and grounded.
type: research
phase: 1
---

# Deterministic vs non-deterministic — the honesty contract

**Thesis (from CLAUDE.md):** the differentiator is **honesty about what is deterministic vs not**, and **traceability** from recommendation → finding → datapoint. Every existing tool blends them ([07-prior-art](07-prior-art.md) gap #5). We label every output.

## The labels (canonical definitions)

| Label | Meaning | Rule for emitting |
|-------|---------|-------------------|
| **D** — deterministic | Same site, same UA, same time → identical answer. Pure function of observed bytes/headers/DOM. | Emit unconditionally. Must cite the exact evidence (header line, DOM node, status). No model involved. |
| **N** — non-deterministic / judgement | Requires heuristic or LLM reasoning (intent, quality, "needs a rework"). | **Gated behind an explicit flag.** Must cite its grounding inputs and state confidence. Never presented as fact. |
| **L** — log-derived | Needs a server-access-log sample. | Only when a log file is supplied; degrade gracefully when absent. |
| **G** — needs GSC | Needs the connected GSC history. | Available since we store it; mark staleness if the sync is old. |
| **S** — needs SERP/DataForSEO | Live, external, **costs money**. | Behind opt-in + budget; cite SERP `check_url`+datetime. |

A check can carry multiple labels (e.g. "intent mismatch" = `G N S`).

## Rules of the contract

1. **Every finding declares its label(s)** in the payload — no unlabelled output (checklist #300).
2. **D findings are reproducible** — include the raw evidence so the user (or a re-run) can verify byte-for-byte. A D finding with no quotable evidence is a bug.
3. **N findings are gated + grounded + humble** — they require `--include-judgement` (or equivalent), must list the inputs the judgement used, and must phrase as assessment not fact. An N finding that can't cite its inputs is suppressed.
4. **N never silently masquerades as D.** If a check *could* be done deterministically, it must be — only genuinely judgement-bound things get `N` (the "altitude" rule: don't bolt a heuristic onto something a parser can answer exactly).
5. **Severity ≠ certainty.** A high-severity D finding (deindexed revenue page) and a high-severity N finding (intent drift) are both surfaced, but the N one carries its confidence and reasoning.

## Classification of the major check groups

- **Almost entirely D:** status/redirects/canonicals/robots/sitemap parsing, headers, hreflang reciprocity, schema *presence + required-field* validation, the war-stories ([02](02-war-stories.md)), resource sizes, link graph / orphans (D + G when reconciled with GSC).
- **G (deterministic given GSC):** the merged GSC×crawl queries ([05](05-gsc-and-dataforseo-overlap.md)) A1–A2, B2–B3, C1–C3, D1–D5 are deterministic *calculations* over GSC+crawl — they're `G D`, not `N`. Only the *interpretation* ("rewrite the intro to target X") is `N`.
- **Genuinely N:** intent match/mismatch, thin-vs-valuable content quality, topic-cluster integrity, recommendation prose, priority ordering narratives, schema-vs-visible-content "does the markup describe what's actually here" (#118 — needs judgement), compromise/defacement detection (#204).
- **S:** the live-SERP checks ([10](10-dataforseo-and-serp-layer.md)).
- **L:** the log-file analysis (checklist §18).

## Why this is the moat
A technical SEO can sign off a `D` finding without re-checking (it cites bytes). They can *consider* an `N` finding knowing it's a model's opinion with stated grounding. Incumbents that blur the two force the user to trust or re-verify everything. Our audit is **defensible** precisely because it's honest about its own certainty.

## Sources
- CLAUDE.md (the thesis); [01-checklist](01-modern-technical-seo-checklist.md) labels + §20; [07-prior-art](07-prior-art.md) gap #5 (no tool separates D/N).
