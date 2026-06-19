---
name: Crawl integrity — the gates that must be green before any audit is trustworthy
description: The parity/validation checks that prove our crawler saw what Googlebot sees. Without these, every downstream finding is fiction. Doubles as the acceptance-test spec for the crawler rewrite.
type: research
phase: 1
---

# Crawl integrity — gates before the audit means anything

**Principle (checklist §0):** "Without these green, the rest of the audit is fiction." An audit built on a crawl that silently differs from what Googlebot sees is worse than no audit — it's confidently wrong. This file is both a **research topic** and the **acceptance-test spec** for the crawler (it tests *our* crawler, not just the target site).

## The integrity gates (run first, gate the rest)

| Gate | What it proves | How |
|------|----------------|-----|
| **G1 Status-code parity** | our crawler's status == raw HTTP | re-fetch a sample of ≥20 URLs with a plain HTTP client (`curl -I` equivalent); diff status |
| **G2 Header parity** | we recorded the real headers | diff `Content-Type`, `Content-Encoding`, `Vary`, `Cache-Control`, `X-Robots-Tag`, `Link`, `Last-Modified`, `ETag` vs raw |
| **G3 Body parity (no-JS)** | our extracted title/H1/canonical/meta == raw view-source, byte-for-byte | compare extractor output to a raw GET of the same URL |
| **G4 Render parity (post-JS)** | we know what JS changes | optional Playwright pass; diff post-render DOM vs static; flag SEO-critical content that only appears after JS |
| **G5 Sitemap parse parity** | our sitemap reading == a deterministic XML parser (incl. nested indices) | parse with an independent parser; diff URL sets |
| **G6 Robots parity** | our allow/disallow == Google's robots tester for the same UA | RFC 9309 parser; spot-check against known cases |
| **G7 UA-consistency** | the site isn't cloaking | fetch sample as crawler-UA vs Googlebot vs GPTBot; diff |
| **G8 Redirect capture** | we actually record 3xx hops | **this is a current crawler BUG** — `processPage` hardcodes `redirects:[]` and HttpCrawler collapses 3xx (code review). G8 fails today → must fix before redirect/canonical findings are trustworthy |

## Why this is also our crawler's test suite

The code review of seo-crawler-mcp found integrity gaps that this spec turns into failing tests:
- **G8 fails** — redirects never stored (`redirects.sql` dead). Fix: capture pre-redirect hops (no-follow / manual redirect walk).
- **Join integrity** — `links.target_url` vs `pages.url` raw-string mismatch causes false orphans/missed broken links. Fixed by the shared `url_key` (see [plan/architecture](../plan/architecture.md) §2). Add a test: every internal link target that 200s must join to a `pages` row.
- **Errors not persisted** — failed URLs survive only as a count (`db.saveError()` uncalled). Without the `errors` table, G1/G2 failures are invisible. Fix + test.
- **Empty-body skip** — `if (!response||!body) return` silently drops 200-with-empty-body pages; integrity gate should *record* them, not skip.

## Operating rules (owned sites only, polite)
Per CLAUDE.md: integrity testing runs on **owned properties** (`simracingcockpit.gg`, and small ones from the GSC list), **≤1 rps, respect robots, identifiable UA**. Never hammer. The integrity sample is small (≥20 URLs) by design — it validates the crawler, it isn't itself a full crawl.

## Output
Crawl-integrity results are a **pre-flight block** on every audit: if G1–G3/G5/G6/G8 aren't green, downstream findings are emitted with an explicit "⚠ crawl integrity not verified" banner (or withheld). This is the §0 discipline made operational.

## Sources
- [01-checklist](01-modern-technical-seo-checklist.md) §0 (crawl integrity gates), §1.2–1.3 (sitemap/robots).
- Code review of seo-crawler-mcp (this session): redirect capture bug, raw-URL joins, errors table, empty-body skip.
- RFC 9309 (robots), sitemaps.org (sitemap protocol).
