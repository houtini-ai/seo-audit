---
name: Implementation plan — validated against the current MCP SDK
description: The concrete build plan for seo-audit-console on the latest stable MCP TypeScript SDK (1.x) + ext-apps 1.7, validated via context7. Confirms the exact APIs, the zod posture, the build pipeline, and what we reuse verbatim from better-search-console.
type: plan
phase: 5
---

# Implementation plan — on the current MCP SDK (validated)

**North star:** make Claude the go-to technical-SEO advisor that *replaces the agency audit*. That means: conversational (MCP), trustworthy (the D/N contract + evidence), and presented like a premium deliverable (the viz layer — see [visualization.md](visualization.md)).

All API claims below were validated via context7 against `@modelcontextprotocol/typescript-sdk` **v1.29.0** and confirmed against the `@modelcontextprotocol/ext-apps@1.7.4` exports.

## 1. SDK targets (pinned, validated)
- **`@modelcontextprotocol/sdk` `^1.29.0`** (stable). **Do NOT adopt `2.0.0-alpha`** — it switches to `zod/v4` + Standard Schema + `fromJsonSchema`; the SDK `main` examples already show `import * as z from 'zod/v4'`, which is the 2.x path. Stay on 1.x until 2.x is stable; migration is mechanical when it is.
- **`zod` `^3.25.x`** — SDK 1.x converts zod schemas to JSON Schema 2020-12 internally. (Same posture we validated and shipped for better-search-console.)
- **`@modelcontextprotocol/ext-apps` `^1.7.4`** — server: `registerAppTool`, `registerAppResource`, `getUiCapability`, `RESOURCE_MIME_TYPE`; client: `App`, `applyDocumentTheme`, `applyHostStyleVariables`, `getDocumentTheme`.
- **`better-sqlite3` `^12.x`**, **`crawlee` `^3.x`** (HttpCrawler + PlaywrightCrawler/Adaptive), **`cheerio`**, **`googleapis`**, **`echarts` `^6`** (UI). Node `>=18` (Playwright render tier needs a modern Node; confirm 20 LTS).

## 2. Server skeleton (validated API)
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const SERVER_VERSION = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version; // never hardcode

const server = new McpServer({ name: 'seo-audit-console', version: SERVER_VERSION });

// Plain tool — registerTool is the current high-level API (server.tool still works but registerTool is canonical)
server.registerTool('run_audit',
  { title: 'Run SEO audit', description: '…',
    inputSchema: { siteUrl: z.string(), scope: z.enum(['core','full']).optional() },
    outputSchema: { runId: z.string(), findings: z.array(z.any()) } },
  async ({ siteUrl, scope }) => {
    const result = await runAudit(siteUrl, scope);
    return { content: [{ type: 'text', text: summarise(result) }], structuredContent: result };
  });

// UI-enabled tool — ext-apps adds the _meta.ui.resourceUri that renders the dashboard
registerAppTool(server, 'get_dashboard',
  { title: 'SEO Dashboard', description: '…', inputSchema: { siteUrl: z.string() },
    _meta: { ui: { resourceUri: 'ui://dashboard/main.html' } } },
  async ({ siteUrl }) => ({ content: [{ type:'text', text:'…' }], structuredContent: await dashboardData(siteUrl) }));

const transport = new StdioServerTransport();
await server.connect(transport);
```
Validated points: `registerTool(name, config, handler)` with zod `inputSchema`/`outputSchema` and `{ content, structuredContent }` returns; `StdioServerTransport` + `await server.connect(transport)`; `registerAppTool` carries `_meta.ui.resourceUri`.

## 3. UI resources (ext-apps + houtini design)
- `registerAppResource(server, name, 'ui://…', {}, async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }] }))` — serves the built single-file HTML (read from `dist/...`).
- Client entry: `new App({ name, version })` → set `app.ontoolresult` + **`app.onhostcontextchanged`** (theme) **before** `app.connect()`, then apply initial theme from `app.getHostContext()` (the pattern we proved in better-search-console; the first context arrives in the connect handshake).
- Reuse the **houtini `tokens.css`** verbatim (Schibsted Grotesk + JetBrains Mono embedded via `@fontsource-variable`, cooler-blue accent, Linear dark mode) — single source of truth across all UI entries.

## 4. Build pipeline (proven)
- `build:server` = `tsc` (ES2022, `moduleResolution: bundler`, `resolveJsonModule`, `rootDir: src`, `outDir: dist`).
- `build:ui` = Vite + `vite-plugin-singlefile` per UI entry → self-contained HTML at `dist/...`. `viteSingleFile` sets a huge `assetsInlineLimit`, so **ECharts + fonts base64-inline** into each dashboard (verified mechanism in better-search-console).
- Copy `analyzers/queries/*.sql` into `dist` (cpSync step, as seo-crawler-mcp does).
- `SERVER_VERSION` derived from `package.json` at runtime; `server.json` version kept in sync (the drift bug we fixed in both prior repos).

## 5. Reuse map (don't rebuild what's proven)
| From | Reuse verbatim | Adapt |
|------|----------------|-------|
| **better-search-console** | GscClient, GscSync (async job+poll), per-property SQLite, App UI + tokens.css + host-theme wiring, version-from-package.json | extend dashboard data with audit findings |
| **seo-crawler-mcp** | extractors, 28 SQL queries, whitelist-by-name read-only security | async-job-ify the crawl (the §0 fix), `url_key`, redirect/orphan/errors fixes |

## 6. MCP registry / repo hygiene (from day one)
- `server.json`: `$schema`, `mcpName: io.github.houtini-ai/seo-audit-console`, `registryType: npm`, `transport: stdio`, env vars (`GOOGLE_APPLICATION_CREDENTIALS`, optional `BSC_DATA_DIR`/`OUTPUT_DIR`, `DATAFORSEO_*`) inside `packages[0].environmentVariables`; **icon → a tracked file with the matching mimeType** (the .jpg/.png 404 lesson). Version fields aligned to `package.json`.
- `.gitignore` from the start: `.secrets/`, `.claude/`, `*.db`, `node_modules`, `dist`, credentials. (Already in place.)

## Sources
- context7 — `@modelcontextprotocol/typescript-sdk` v1.29.0: `registerTool` + zod inputSchema→JSON-Schema-2020-12, `StdioServerTransport`, `server.connect`; `main` examples confirm `zod/v4` is the 2.x path (avoid).
- ext-apps 1.7.4 exports (verified this session). Proven patterns from better-search-console + seo-crawler-mcp (this session's reviews/builds).
- [architecture.md](architecture.md), [tool-surface.md](tool-surface.md), [visualization.md](visualization.md).
