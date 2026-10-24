# Stitch rounds: portfolio and domain overview (24 Oct 2026)

**What this is:** design intent only. Every figure is a `[figure]` placeholder, and no copy or number from Stitch reaches the product.

**Setup:**
- Same project (`3979271944933978503`) and design system (`d173f3cd…`) as the summary round, so the screens inherit that visual language.
- `GEMINI_3_8_FLASH`, desktop 1440, light.
- The runner is `visualysed/tools/stitch/run.mjs`, copied to a temp folder (visualysed untouched), with the `=w1440` screenshot fix applied.
- Prompts: `portfolio-r1.txt`, `portfolio-r2.txt`, `domain-r1.txt`. Raw output stays in the ignored `out/`.

## Portfolio table: keep
- **The refresh status strip:**
  - weekly data captured, monthly history captured, schedule + budget + spent;
  - a "Copy refresh prompt" link;
  - the sidebar note "System: read-only. Data refreshes are started from chat". That's the right posture.
- **Tabs with a counted "Needs attention"**, and a group filter on the right.
- **Grouped header bands** (r2): "Search Console (measured)" over clicks, "DataForSEO (estimated)" over the estimates. That's the honesty rule made visible, and the best idea in the round.
- **The attention reason as a full-width sub-row** under its domain (r2), on a pale tint, so rows keep one height.
- **"Comparing [month] with [month] (last complete months)"** under the subline (r2). That's the partial-month rule stated in words.
- **Empty-reason text in the cell:** "not fetched yet", "no data at this location", "Backlinks API not enabled". Italic and muted, never a 0.
- **Paid keywords and traffic merged** into one stacked cell (r2).
- **The footnote** naming the estimate source, and that Domain Rank isn't an Authority Score.

## Portfolio table: change in the build
- **It still overflows at 1440** with all columns. The `[figure]` placeholders are much wider than real compact numbers ("16.2K"), so real data helps. The build also:
  - uses compact numbers;
  - puts value and change chip on one line with the sparkline under them;
  - hides the paid column below 1500px, behind a "Show paid" toggle;
  - truncates the domain at about 200px.
- **Sparklines:** r1 coloured them by direction. The build uses a single neutral line (r2 asked for this, but Stitch kept green/red chips plus coloured lines). Direction lives in the chip only.
- **"Owned properties" sidebar list:** it duplicates the table. The property switcher stays where it is (the property dashboard). The portfolio sidebar shows only Domains plus the read-only note.

## Domain overview: keep (r1 was strong)
- **Two blocks, side by side:**
  - "Search (estimated)", 6 tiles, each "vs [month]";
  - "Search Console (measured)", 3 tiles, with the caption "Measured by Google, all countries".
  - A traffic-share bar among the chosen domains sits underneath.
- **AI search:**
  - a platform toggle "AI Overviews | ChatGPT (US)";
  - three tiles;
  - the mentions bars + AI-search-volume line combo with a **hollow "to date" current month**;
  - the footnote "AI Mode, Gemini and Perplexity are not measured by this data source".
  - No score gauge (as briefed).
- **The rank × citation keyword table**, with yes / no / grey **unknown** pills, beside the **quadrant** (Ranks and cited / Ranks, not cited / Cited, not ranking / Neither).
- **Top cited pages** with crawl-status pills (200 indexable / noindex / 301), and **Sources cited alongside** with share bars and the caption "Sources, not competitors".
- **The traffic trend:** estimated solid, measured dashed on its own axis, legend says which is which.
- **Keyword positions** as a stacked area; **search results mix** as a donut with counts and %.
- **Countries** with inline share bars; **backlinks** as new (up) vs lost (down) bars with a total line.
- **Top pages, by links**, with the red row "Linked page returns 404 in our crawl". That's our crawl join, visible.

## Domain overview: cut (invented chrome)
- **"Verified API"** badge and **"Sync status: Fresh"**. Not payload fields.
- **"Methodology: Automated daily synthetic SERP capture"**. False: the data is monthly, from DataForSEO's database. Never imply a measurement we didn't take.
- **Filler captions:** "Synthetic search synthesis, citation triggers…", "Geographic traffic dispersion…", "24-month longitudinal trajectory…". Captions follow the copy rules, not Stitch.
- **"8 target keywords" / "Sample: [figure] tracked phrases"**: replaced by the real recon row count, or nothing.
- **Footer tagline.**

## Learned from the live data while building (feeds the UI labels)
- **Two different mention counts.** LLM `multi_target_metrics` "mentions" is a total across DataForSEO's whole dataset (simracingcockpit.gg 1,698). `historical` is per month (Sep 2026: 866). The table cell is labelled "AI mentions (all data)"; trend and change use the monthly series.
- **ETV depends on location.** ehi.com.au: AU 5,170 vs US 258. Rows always show their country chip.
- **domain_pages `rank`** is on the 0-1000 scale (169 for the homepage). The page table shows referring domains, not page rank.
