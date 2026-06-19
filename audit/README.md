# Phase 2 — Audit of existing MCPs

Read the code, not the READMEs.

## Files to produce
- `seo-crawler-mcp.md`
- `better-search-console.md`
- `geo-analyzer.md`
- `dataforseo-usage.md`

Each ends with a **Keep / Refactor / Replace** verdict and a one-paragraph justification citing specific files and line ranges.

## What to look for
- **Security:** SSRF surface, secret/token storage, log hygiene, MCP transport choice, dep tree CVEs.
- **Transportability:** hardcoded Windows paths, env assumptions, native deps, OS-specific behaviour.
- **Correctness:** does the tool do what it claims? Where does it silently fail?
- **Test coverage:** what's tested, what isn't.
