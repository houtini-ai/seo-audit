#!/usr/bin/env node
// Copyright (c) 2026 Richard Baxter / Houtini — Source-Available (see LICENSE)
// seo-audit-console — MCP server entry point.
import { createServer } from './server.js';

const { run } = createServer();
run().catch((err: unknown) => {
  console.error('[seo-audit-console] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
