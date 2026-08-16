# Majestic functions

DataForSEO's own link data sorts on **domain rank**, a link-*volume* metric — so directories, aggregators and syndicated-press domains float straight to the top. Technically authoritative, worthless to pitch. [Majestic](https://majestic.com) fixes that: it re-sorts link prospects by **editorial authority** instead of link count.

Majestic is **optional** and **separate** from DataForSEO. It enriches exactly one tool — [`link_intersect`](dataforseo.md#link_intersect) — and everything else works without it. Set `MAJESTIC_API_KEY` to switch it on.

## What it adds

### Trust Flow (0–100)
Editorial authority, propagated from a seed set of trusted sites. It measures who *vouches* for a domain rather than how many links it has managed to accumulate — the directory killer. In testing, a domain DataForSEO ranked **#227** came back **Trust Flow 0**; a volume metric simply can't see that.

### Topical Trust Flow
The same authority, broken down by topic — so a domain that's authoritative in *your* niche is ranked ahead of a generic domain with the same overall score.

## How it's used

`link_intersect` builds the prospect list from DataForSEO's `domain_intersection` (your competitors' links, minus yours). Then, **if `MAJESTIC_API_KEY` is set**, it calls Majestic's `GetIndexItemInfo` on the prospect domains and **re-sorts by Trust Flow / Topical Trust Flow**, dropping the directory noise.

Without the key, `link_intersect` still runs and still sorts followed-first by DataForSEO domain trust — Majestic just sharpens the priority order so you email the right prospect first.

- Endpoint: `https://api.majestic.com/api/json` (`cmd=GetIndexItemInfo`)
- Host override: `MAJESTIC_API_HOST` (defaults to the standard API host)
- **Privacy:** Majestic only ever receives the prospect **domain names** — nothing else about your site.

## Setup

Grab a key from Majestic's [plans and pricing](https://majestic.com/plans-pricing) (the tier that exposes Trust Flow), then add `MAJESTIC_API_KEY` to your env — see [getting-started](getting-started.md#environment-variables). The full link-intersect workflow is in [competitive.md](competitive.md#link-intersect-link_intersect).

---
*Trust Flow and Topical Trust Flow are trademarks of Majestic (Majestic-12 Ltd).*
