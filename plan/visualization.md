---
name: Visualisation strategy — the agency-grade deliverable
description: How seo-audit-console presents data so it replaces an agency audit deliverable. ECharts as the primary library (matches houtini-site, single-file friendly), the 9 flagship visualisations mapped to chart types + data sources, houtini design tokens, and the two surfaces (rich app dashboard vs inline chat widgets).
type: plan
phase: 5
---

# Visualisation strategy — make it feel like the agency deliverable

**The point:** an agency SEO audit's perceived value is largely its *presentation* — the deck of charts that makes the data legible and the recommendations feel earned. To replace it, our output has to look at least as good, but be **live, interactive, and conversational**. Data-viz is therefore a first-class concern, not decoration.

## Two surfaces (different libraries, same design language)

1. **The MCP app dashboard** (ext-apps iframe, Vite single-file HTML). The rich, agency-grade deliverable. **Primary library: Apache ECharts.**
2. **Inline chat widgets** (when Claude answers conversationally and wants a quick visual). Follows the **"Imagine" data-viz skill** design system — Chart.js/D3 from the CSP allowlist (`cdnjs`, `jsdelivr`, `unpkg`, `esm.sh`), flat aesthetic, CSS-variable theming, dark-mode-mandatory, no gradients/shadows, sentence case, Tabler outline icons.

Both reuse the **houtini design language** (tokens.css — Schibsted Grotesk, cooler-blue accent, Linear dark surfaces). The dashboard imports tokens.css directly; inline widgets map to the Imagine CSS variables (`--color-*`, `--border-radius-*`) which auto-adapt to the host theme.

## Why ECharts for the dashboard
- Handles **every** agency chart type out of the box — force-directed **network graph**, **sankey**, **treemap**, **sunburst**, calendar **heatmap**, **radar**, bubble/scatter, time series — with no plugins. Chart.js can't do graph/sankey/treemap natively; D3 can but at 5× the boilerplate.
- **Single CDN `<script>` / single bundle** → `vite-plugin-singlefile` base64-inlines it into the self-contained HTML (the mechanism we proved with Chart.js + fonts in better-search-console).
- **Already in the houtini stack** (`echarts@6` in houtini-site) — consistent house choice.
- Reads CSS variables at render time → re-theme on `onhostcontextchanged` (the chart-recolour-on-theme pattern from better-search-console; note the same `color-mix()`→concrete-rgba caveat for canvas).

## The 9 flagship visualisations (the deliverable)

| # | Visualisation | ECharts type | Data source | Insight it sells |
|---|---------------|--------------|-------------|------------------|
| 1 | **Ranking position distribution** | stacked area (buckets 1–3 / 4–10 / 11–20 / 21+) | GSC history | top-3 dominance vs page-2 decay over time |
| 2 | **Striking-distance keywords** | bubble scatter (x=position 11–20, y=impressions, size=CTR) | GSC (+DataForSEO volume) | the low-effort, high-return wins |
| 3 | **Keyword cannibalisation** | sankey (query → competing URLs) | GSC ([research/05](../research/05-gsc-and-dataforseo-overlap.md) B2) | authority split across pages for one intent |
| 4 | **Content decay** | calendar/matrix heatmap (URL clusters × months, colour = click Δ) | GSC history (C-series) | which strong pages are bleeding traffic |
| 5 | **Internal PageRank flow** | force-directed network graph (node size = iPR, edges = links) | crawl link graph ([research/14](../research/14-internal-link-graph.md)) | architecture bottlenecks, orphans, mis-routed authority |
| 6 | **Search performance** | dual-axis time series (bars = clicks/impr, line = avg position) | GSC history | ranking loss vs seasonal demand shift |
| 7 | **Crawl health** | sunburst (indexable→status→subdirectory) | crawl | proportional view of where crawling breaks |
| 8 | **Issue prioritisation** | treemap (size = affected URLs, colour = severity) | recommendation engine ([recommendation-engine.md](recommendation-engine.md)) | where to point dev effort first |
| 9 | **Core Web Vitals lab vs field** | overlay radar (LCP, INP, CLS, TTFB) | CWV ([research/13](../research/13-performance-cwv.md)) | real-user UX vs lab, hidden bottlenecks |

Each chart is **drill-downable**: clicking a node/segment calls back to Claude (`sendPrompt`-style in chat, or a tool call from the app) to explain or generate a fix — turning a static agency chart into a conversation ("why did /pricing decay?" → the C1 decline diagnosis + a generated fix).

## User-requested charts (this session) + interactions

Confirmed: the dashboard **reuses the better-search-console framework** (houtini `tokens.css`, ext-apps `App` + `onhostcontextchanged` host-theme wiring, Vite single-file build) with **ECharts** added for the chart types Chart.js can't do.

- **Rank-over-time line** — per query/page average position across time. **Data: we have it** — `SELECT date, AVG(position) FROM search_analytics WHERE page_key=? GROUP BY date`. (GSC average position; invert the y-axis so "up = better rank".) Multi-line for top N queries on a page.
- **Keyword performance, stock/candlestick style (red=down, green=up)** — top keywords as OHLC candles of rank within each period (open=first day's position, close=last day's, high/low = best/worst), or simpler up/down-coloured bars of period-over-period change. **Colour semantics (documented to avoid the rank inversion trap):** green = *improved* (clicks up OR position number down), red = *declined*. ECharts `candlestick` + `click` event.
  - **Click-through → related terms:** clicking a keyword fires `sendPrompt`/a tool call to `related_terms` → **People Also Ask + related searches** (DataForSEO SERP, cached 20 days; verified live: 4 PAA + 24 related for "technical seo audit"). Surfaces expansion/cluster opportunities right off the chart.

These join the 9 flagship visualisations above; multi-row/column table outputs (top queries/pages, findings) render as houtini-styled tables alongside.

## Design rules (carried from the Imagine skill)
- Flat surfaces, no gradients/shadows/glow; **colour encodes meaning, not sequence** (severity ramps, status categories — ≤2–3 ramps + a legend).
- **Dark mode mandatory** — every colour works in both; charts re-render on theme change.
- **Round every displayed number**; sentence case everywhere; Tabler outline icons; min font 11px.
- Accessibility: each chart gets a visually-hidden one-line summary + `aria-label`; never colour alone — pair with shape/dash/pattern + legend.
- Metric cards (the GSC hero numbers) above each chart cluster; no card wrapper on the chart canvas itself.

## How this serves the north star
An agency hands over a static PDF once a quarter. seo-audit-console hands over the **same chart set, live, on the user's data, every time they ask** — and each chart is a doorway into Claude's explanation + a generated fix. The visualisation is what makes "ask Claude instead of hiring the agency" feel credible rather than a downgrade.

## Sources
- "Imagine" data-viz skill (`mcp__visualize__read_me`, this session) — design system: flat aesthetic, CSS variables, dark-mode, CSP allowlist, Chart.js/D3 for inline widgets, accessibility + number-rounding rules.
- Gemini (`gemini-3.1-pro-preview`, grounded) — the 9-visualisation set + chart types + the ECharts recommendation, this session.
- houtini-site (`echarts@6`, `d3`) — house library precedent; better-search-console — the single-file-inline + houtini tokens + theme-rewire pattern.
- Data sources: research [05](../research/05-gsc-and-dataforseo-overlap.md)/[13](../research/13-performance-cwv.md)/[14](../research/14-internal-link-graph.md), [recommendation-engine.md](recommendation-engine.md).
