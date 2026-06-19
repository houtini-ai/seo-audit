# Phase 3 — Crawl integrity testing

Validate that crawler output is trustworthy *before* it drives an audit.

## Test properties
- `simracingcockpit.gg` (owned, small)
- 1–2 small properties from GSC — list first via `mcp__better-search-console__list_properties`.

## Files to produce
- `simracingcockpit.gg-baseline.md`
- `<gsc-property>-baseline.md`
- `render-parity.md` — raw HTML vs rendered for a JS-heavy page.
- `integrity-report.md` — summary of trustworthy vs not, with patch list.

## Validation gates (must pass 100% on sample before Phase 4)
- Status codes match `curl -I`.
- Canonical, title, meta description, H1 match view-source.
- Sitemap parsing matches `sitemap.xml` (and nested sitemaps).
- Robots interpretation matches Google's robots tester for the same UA.

## Etiquette
- ≤ 1 rps.
- Respect `robots.txt`.
- Identifiable UA.
- Owned sites only.
