# SEO-Audit MCP — Investigation Workspace

Planning and research workspace for consolidating `seo-crawler-mcp`, `better-search-console`, and parts of `geo-analyzer` / DataForSEO into a single **SEO-Audit MCP**.

**This is not yet an MCP server.** It's the investigation that precedes one. See [CLAUDE.md](CLAUDE.md) for the full brief, phases, and definition of done.

## Layout

| Dir | Phase | Purpose |
|---|---|---|
| `research/` | 1 | Grounded research on modern technical SEO, war stories, agentic readiness. Sources mandatory. |
| `audit/` | 2 | Code review of existing MCPs — keep / refactor / replace verdicts. |
| `crawl-tests/` | 3 | Live crawl-integrity tests on owned properties (simracingcockpit.gg + GSC sample). |
| `findings/` | 4 | Security, transportability, data quality, missing-checks gap list. |
| `plan/` | 5 | Architecture, tool surface, migration, recommendation engine spec. |

## Hard rules

- No consolidation code until Phase 4 verdicts exist.
- Owned-site testing only. Polite crawl budgets.
- Sources or it didn't happen.
- One LLM call at a time (Gemini / houtini-lm queue server-side).
