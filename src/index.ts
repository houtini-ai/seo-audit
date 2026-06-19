#!/usr/bin/env node
// Copyright 2026 Richard Baxter — Apache-2.0
// seo-audit-console — MCP server entry point.
import { createServer } from './server.js';

const { run } = createServer();
run().catch((err: unknown) => {
  console.error('[seo-audit-console] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
