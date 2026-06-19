# Phase 5 — Consolidation plan

Only start once Phases 1–4 are credible.

## Files to produce
- `architecture.md` — module shape: crawler, GSC client, SERP/DFS client, analyser, recommender, where Gemini grounding plugs in.
- `tool-surface.md` — MCP tool list with input/output schemas (contract only, not impl).
- `migration.md` — keep / rewrite / delete per existing MCP. Repo + npm naming under houtini-ai.
- `recommendation-engine.md` — scoring model, evidence citation format, priority ordering.
- `open-questions.md` — anything that needs the user's decision before code starts.

Code lives elsewhere (likely a new `houtini-ai/seo-audit` repo). This dir is the spec.
