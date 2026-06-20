---
name: Actionability — turning findings into work an SEO will actually do
description: Deep thinking on what makes an audit finding actionable (not just true), and how seo-audit-console's output is shaped to it. The difference between a report that gets filed and one that gets worked.
type: plan
phase: 5
---

# Actionability — findings an SEO will actually act on

A finding can be perfectly *correct* and still useless. Agencies get paid not for detecting issues but for making them **prioritised, justified, and doable**. This is the bar the output has to clear to replace the agency deliverable.

## What makes a finding actionable (the eight tests)

1. **Prioritised, never a flat list.** An SEO's first question is "what do I do *first*?". Every finding carries `priority = (severity × certainty × traffic-value) ÷ effort` — so the canonical bug on a 5,000-impression page outranks a missing meta on a dead page. *Built:* findings ranked by P; treemap shows where issues cluster by category/severity.
2. **A business case, not a checklist tick.** SEOs justify work by traffic/revenue. Each finding shows **clicks + impressions at risk** for the affected URL. "Fix this → protect 97 clicks/mo" gets sign-off; "missing canonical" doesn't. *Built:* `traffic_at_risk` per finding, in the table and CSV.
3. **What / where / why / fix — on one row.** what = issue title; where = the exact URL; why = severity + the rationale; fix = the specific remediation. *Built:* the ranked table is exactly these columns; `recommendation` stores `{title, text}`.
4. **Portable — it leaves the tool.** SEOs live in spreadsheets, Looker Studio, and client decks. A finding trapped behind a paywalled UI is half-dead. **CSV export** of findings (and keywords, striking-distance) lets them sort, filter, pivot, and drop into a report. This is the anti-walled-garden wedge ([research/08](../research/08-saas-disruption-and-features.md)). *Built:* `⬇ CSV` buttons via `app.downloadFile`.
5. **Routable by who fixes it.** A dev fixes broken links / canonicals / headers; content fixes thin pages / titles; the SEO *judges* intent. The D/N split + category tell you which queue a finding belongs in (the 4-tier model in [recommendation-engine.md](recommendation-engine.md): Quick Wins / Strategic / SEO-review / Backlog). *Partly built* (category + certainty); the explicit 4-tier grouping is the next UI step.
6. **Drillable into the doing — the conversational edge.** The thing an agency PDF *can't* do: you click a finding and **ask Claude** "why did this happen / fix it for me," and it explains (e.g. the decline diagnosis) and **generates the fix** — JSON-LD snippet, redirect block, internal-link suggestion. That turns a finding into a completed task. *Partly built* (keyword→related on click); finding→explain/generate is the high-value next wire-up (the `generators/` from architecture).
7. **Diffable over time.** "What changed since last audit / since the fix" makes it a workflow, not a one-off. `audit_runs` already stamps each run; surfacing the delta is a near-term add.
8. **Honest about certainty.** A deterministic "this returns 404" is do-it-now; a judgement "this reads thin" needs a human look. Mixing them erodes trust. *Built:* the D/N label + certainty weighting; N findings are gated behind `includeJudgement`.

## The one that matters most
Tests 1–4 make it a *good report*. **Test 6 — drill-down into a conversation that explains and fixes — is what makes it a replacement for the agency**, not a cheaper report. A Looker dashboard shows you the number; it can't tell you *why /pricing decayed* and hand you the redirect to fix it. That's the product. Everything else is table stakes we now meet; #6 is the moat, and it's where the generators (`json-ld`, `redirects`, internal-link suggestions) plug into the findings next.

## Status against the tests
Built: 1, 2, 3, 4, 8. Partial: 5 (category/certainty, not yet 4-tier UI), 6 (click→related, not yet finding→generate), 7 (runs stamped, no diff UI). Next priorities: finding→explain/generate (#6), then 4-tier grouping (#5), then audit diff (#7).

## Sources
- [recommendation-engine.md](recommendation-engine.md) (scoring + 4-tier), [research/08](../research/08-saas-disruption-and-features.md) (data portability / agent-native remediation wedge), [research/03](../research/03-deterministic-vs-not.md) (D/N honesty).
