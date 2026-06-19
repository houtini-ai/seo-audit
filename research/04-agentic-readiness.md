---
name: Agentic / AI readiness — the new audit frontier
description: The AI/GEO/agent-readiness checks (llms.txt, AI-bot policy, markdown negotiation, WebMCP, MCP server card, agent skills) and the decision to WRAP Cloudflare's isitagentready scanner rather than rebuild protocol scanning.
type: research
phase: 1
---

# Agentic / AI readiness — the new frontier

**Why it matters:** this is the least-covered area in OSS ([07-prior-art](07-prior-art.md) tier 4) and the fastest-moving. Checklist §13–14 holds the full list; this file sets the *approach* — what we test ourselves vs what we wrap.

## What to check (from checklist §13–14)

**AI-bot access policy (D):** robots.txt rules per the 12-bot baseline — GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended, OAI-SearchBot, ChatGPT-User, Amazonbot, Applebot-Extended, Bytespider, anthropic-ai, Bingbot/others. Flag accidental `Disallow: /` for a bot the owner wants, or no policy at all. (Cross-ref `core/robots-sitemap.ts`.)

**Content Signals (D):** `Content-Signal: ai-train=…, search=…, ai-input=…` in robots.txt.

**llms.txt / llms-full.txt (D):** present at root, 200, parseable, H1 site title; `llms-full.txt` for docs-heavy sites. Emerging standard — flag presence/absence, don't penalise hard.

**Markdown content negotiation (D):** does the server return `text/markdown` on `Accept: text/markdown`? `.md` URL variants returning clean markdown? (Cloudflare reports ~3.9% adoption — low bar, easy win to flag.)

**Render-without-JS for AI crawlers (D):** primary content present in static HTML; tested as GPTBot/PerplexityBot/OAI-SearchBot UAs (overlaps crawl-integrity G7 and §3 rendering).

**Capabilities / .well-known (D, mostly A):** MCP Server Card (`/.well-known/mcp/server-card.json`), WebMCP HTML annotations (`data-mcp-tool`), Agent Skills (`/.well-known/agent-skills/index.json`), API Catalog (RFC 9727), OAuth discovery (RFC 8414/9728), Web Bot Auth.

**GEO/citability (N):** clear claim→support structure, entity coverage vs Wikidata/Google KG, author E-E-A-T with `sameAs`, factual-freshness `dateModified`. These are judgement → gated + grounded (see [03](03-deterministic-vs-not.md)).

## Build vs wrap

- **WRAP Cloudflare's `isitagentready.com` `scan_site`** for the protocol/well-known capability scanning (§14). It's Cloudflare-maintained and **already exposed as an MCP tool** (`/.well-known/mcp.json`, Streamable HTTP). Don't out-Cloudflare Cloudflare on protocol discovery — call their tool, merge findings, and keep a minimal local fallback for offline use. (Decision from [07-prior-art](07-prior-art.md) tier 4.)
- **BUILD ourselves** the things tied to our own crawl/GSC data: AI-bot robots policy (we parse robots anyway), llms.txt presence, markdown negotiation probe, no-JS render check for AI UAs. These are cheap deterministic checks on data we already fetch.
- **N (gated):** citability / entity-coverage / E-E-A-T judgements — Gemini-grounded, behind the judgement flag.

## The wedge angle
Agent-readiness is where incumbents are weakest and where being **MCP-native** is thematically perfect — an audit tool that is itself an MCP, checking whether *your* site is agent-ready. Strong story for [08-saas-disruption](08-saas-disruption-and-features.md). But keep it honest: most of §14 is emerging/low-adoption — flag as opportunity/info, not critical, until the standards settle.

## Sources
- [01-checklist](01-modern-technical-seo-checklist.md) §13–14; [07-prior-art](07-prior-art.md) tier 4 (Cloudflare agent-readiness, isitagentready as MCP tool).
- Cloudflare Agent Readiness score; isitagentready.com; llms.txt ecosystem; WebMCP (Chrome 146) — see checklist §14 source list.
