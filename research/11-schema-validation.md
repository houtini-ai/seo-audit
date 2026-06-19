---
name: Schema / structured-data validation & generation — approach
description: How seo-audit-console validates existing JSON-LD (no public Google API → maintain Rich-Results required-field rules) and GENERATES type-correct JSON-LD via schema-dts (the agent-native remediation feature).
type: research
phase: 1
---

# Schema validation & generation — approach

Two distinct jobs: **validate** what's on the page (audit) and **generate** what's missing (remediation, the agent-native wedge). Different tools for each.

## Part A — Validating existing structured data (deterministic audit)

Pipeline on each crawled page:
1. **Extract** all `<script type="application/ld+json">` blocks (+ optionally Microdata/RDFa). Crawler already has the HTML.
2. **Syntax** (D): valid JSON? parseable? (Common real failure: trailing commas, HTML-escaped quotes.)
3. **Shape** (D): `@context` present and = `https://schema.org`; `@type` present and a real schema.org type.
4. **Required + recommended properties** (D): per detected `@type`, check Google's **Rich Results required/recommended fields**. **Key constraint: Google has NO public Rich Results Test / validation API** — so we **maintain a versioned required-field map** for the supported types and validate against it ourselves. Supported set (v1): `Article`/`BlogPosting`, `Product`+`Offer`, `Organization`, `WebSite`+`SearchAction`, `BreadcrumbList`, `FAQPage`, `Recipe`, `Event`, `LocalBusiness`, `VideoObject`, `JobPosting`.
5. **Value sanity** (D): image URLs absolute + indexable, dates ISO-8601 with offset, prices have `priceCurrency`, etc.
6. **Forbidden / misused schemas** (D/N): `FAQPage`/`HowTo` outside Google's now-restricted eligibility; `Review`/`aggregateRating` on pages with no on-page reviews (penalty-grade). (checklist #118–119)
7. **Markup-vs-visible-content** (N, gated): does the JSON-LD describe what's actually rendered? Judgement — flag for review, cite both.

**Library decision:**
- Don't depend on `schema-dts` for *validation* — it's **compile-time TypeScript types only** (per context7: discriminated unions catch bad `@type`/property names at compile time, **no runtime library**). It can't validate arbitrary scraped JSON at runtime.
- So validation = our own **required-field rule map** (a small, maintained JSON keyed by `@type`) + JSON-schema-style value checks. Optionally cross-check with an OSS linter (schema.org SHACL shapes / structured-data-linter) but the maintained Rich-Results map is the source of truth (it's what Google actually rewards).

## Part B — Generating JSON-LD (agent-native remediation — the wedge)

This is the feature from [08-saas-disruption](08-saas-disruption-and-features.md) #5 / [09](09-seogets-and-check-coverage.md): Claude reads the crawled page content and **emits ready-to-paste JSON-LD**.

- **Use `schema-dts`** here — it's exactly right for generation: type-safe construction with `WithContext<T>` (forces `@context: 'https://schema.org'`), and the discriminated unions mean a generated object with a misspelled property or wrong `@type` **won't compile**. So the generator's output is structurally correct by construction.
- **Safe HTML injection:** use the documented `safeJsonLd()` serializer (escapes `<`, `>`, `&`, `'`) before wrapping in `<script type="application/ld+json">`.
- **Agent flow:** crawl page → detect missing/eligible schema type → Claude drafts the JSON-LD from page content → validate it through Part A's rules → present as a **dry-run diff / copy block, never a silent write** (same safety contract as auto-PRs). The agent fills real values from the page (title, author, dates, price); the human approves.
- This is uniquely ours: incumbents flag "missing schema"; we **hand you the correct, validated snippet**, generated from your actual content, on your machine.

## Labels
Part A checks are **D** (cite the offending JSON + the missing field), except markup-vs-content (#7) which is **N**. Part B output is generated-then-D-validated; the *decision to apply* is the user's.

## Sources
- context7 — `google/schema-dts`: `WithContext<T>`, compile-time-only validation, `safeJsonLd` serializer, no runtime deps.
- [01-checklist](01-modern-technical-seo-checklist.md) §5 (#109–123); Google Rich Results required-fields (maintained map, no public API).
- [08-saas-disruption](08-saas-disruption-and-features.md) #5, [09-seogets-and-check-coverage](09-seogets-and-check-coverage.md) (generators/json-ld).
