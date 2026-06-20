---
name: Published checklists to mine + agency report patterns
description: Curated list of authoritative public SEO audit checklists worth mining (Gemini-sourced), a note on Moz's coverage, and report-feature ideas captured from a community n8n GSC-report workflow video — mapped to buildable dashboard additions.
type: research
phase: 1
---

# Published checklists to mine + report patterns

## 1. Authoritative published checklists (mining list)

Gemini-sourced, credible, public. **B** = likely to yield checks beyond our 305-list; **D** = mostly confirms what we have.

| Source | URL | Why mine it |
|---|---|---|
| **Aleyda Solis — LearningSEO.io** | learningseo.io/seo-execution/seo-audits/ | **B** battle-tested templates mapped to execution phases + business impact |
| **Annie Cushing — Annielytics** | annielytics.com/blog/seo/comprehensive-seo-audit-checklist/ | **B** legendary granular mega-spreadsheet; bridges technical SEO with GA data hygiene + tag management |
| **Builtvisible** (Richard's own) | builtvisible.com/technical-seo/ | **B** developer-centric: SSR, JS SEO, log-file analysis |
| **Screaming Frog tutorial** | screamingfrog.co.uk/seo-spider/tutorials/how-to-do-a-technical-seo-audit/ | **B** maps issues to crawler config + custom XPath/regex extractions |
| **Lumar (DeepCrawl)** | lumar.io/learn/seo/website-audits/ultimate-technical-seo-audit-guide/ | **B** architecture, rendering limits, million-URL scale |
| Ahrefs | ahrefs.com/blog/seo-audit/ | D 80/20 focus on issues that move rankings |
| Backlinko | backlinko.com/seo-site-audit | D CWV/UX + content pruning quick-wins |
| Search Engine Journal | searchenginejournal.com/seo-audit/ | D enterprise scale, governance |
| Semrush | semrush.com/blog/seo-audit/ | D site-health score, backlink toxicity, local |
| ContentKing (Conductor) | contentkingapp.com/academy/technical-seo-audit/ | D continuous-monitoring framing |
| Sterling Sky | sterlingsky.ca/local-seo-audit/ | D local SEO + GBP + local schema |

**Moz** (moz.com/seo-audit-checklist): scraped + reviewed — covers the standard surface (pagination, hreflang, breadcrumb, alt text, faceted nav, CWV, anchor text, orphans, noindex, robots, broken links, duplicate content). All already in [01-checklist](01-modern-technical-seo-checklist.md); **no net-new buildable check** beyond our current 23. Confirms the foundation.

**Highest-value to mine next:** Annielytics (granularity + GA hygiene), Builtvisible (log files / JS / SSR), Screaming Frog tutorial (crawler-config-driven checks). These map mostly to our **deferred** modules (render tier, log ingestion) rather than new GSC/crawl checks.

## 2. Report-feature ideas (from a community n8n GSC-report workflow video)

A workflow that turns the GSC BigQuery bulk export into an HTML report. Its sections we **don't yet surface but can, on GSC data we already store** (free, no DataForSEO):

| Feature | Data we have | Build note |
|---|---|---|
| **Device breakdown** (desktop/tablet/mobile, current vs prior) | `search_analytics.device` | a metric-by-device table/chart; flags device-specific decline (mobile CWV signal) |
| **Country breakdown** + device×country filter | `search_analytics.country` | report section + interactive filter (the "Looker" feel) |
| **Page performance + categorisation** | clicks/impr/ctr/pos per `page_key`, current vs prior | categorise each page: top-performer / improve-CTR / improve-visibility / stable / declining / low-performer. **High value, very actionable** — "which pages to update". |
| **Keyword ranking movement** | per-query first-seen vs last-seen `position` | entered/dropped/stayed top-3, stayed top-10; the agency "wins & losses" table. Free GSC alternative to DataForSEO rank tracking. |
| Table pagination (load N rows) | — | UI perf for large sites (load 10/page) |

Already covered by us: period-over-period summary, ranking distribution, CSV export, cannibalisation (now a check), striking-distance.

**Recommended additions (priority):** (1) **page-performance categorisation table** (the video's "crucial part" — directly actionable), (2) **device + country breakdown** (standard agency report sections), (3) **keyword movement** table. All GSC-only, all fit the existing dashboard.

## Sources
- Gemini (`gemini-3.1-pro-preview`, grounded) — authoritative-checklist source list, this session.
- Moz checklist (firecrawl) — coverage confirmation.
- Community n8n GSC-report workflow video (user-supplied) — report-feature patterns.
- Cross-ref: [01-checklist](01-modern-technical-seo-checklist.md), [05-gsc-and-dataforseo-overlap](05-gsc-and-dataforseo-overlap.md), [plan/visualization](../plan/visualization.md), [plan/actionability](../plan/actionability.md).
