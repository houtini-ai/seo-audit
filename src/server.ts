import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { urlKey, hostFormForProperty } from './core/url-key.js';

const SERVER_NAME = 'seo-audit-console';
// Derive the version from package.json so the MCP handshake + banner can't drift.
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/** Resolve the data directory (one SQLite DB per property lives here). */
export function dataDir(): string {
  return process.env.SAC_DATA_DIR ?? path.join(homedir(), 'seo-audits', 'seo-audit-console');
}

/** The audit check categories (the surface the tool can evaluate). */
const CHECK_CATEGORIES = [
  'integrity', 'crawlability', 'indexation', 'onpage',
  'schema', 'performance', 'war-stories', 'agentic', 'merged',
] as const;

export function createServer(): { server: McpServer; run: () => Promise<void> } {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // list_checks — works with no data; advertises the audit surface.
  server.registerTool(
    'list_checks',
    {
      title: 'List audit checks',
      description: 'List the technical-SEO check categories this server can evaluate.',
      inputSchema: { category: z.enum(CHECK_CATEGORIES).optional() },
    },
    async ({ category }) => {
      const categories = category ? [category] : [...CHECK_CATEGORIES];
      return {
        content: [{ type: 'text', text: `Audit categories: ${categories.join(', ')}` }],
        structuredContent: { categories },
      };
    },
  );

  // normalize_url — exposes the join key; useful for debugging the GSC↔crawl join.
  server.registerTool(
    'normalize_url',
    {
      title: 'Normalise a URL to its join key',
      description: 'Return the canonical url_key used to join GSC data to crawl data. Optionally pass the GSC property to fix the www/apex host form.',
      inputSchema: { url: z.string(), siteUrl: z.string().optional() },
    },
    async ({ url, siteUrl }) => {
      const hostForm = siteUrl ? hostFormForProperty(siteUrl) : 'asis';
      const key = urlKey(url, { hostForm });
      return {
        content: [{ type: 'text', text: key }],
        structuredContent: { url, key, hostForm },
      };
    },
  );

  const run = async (): Promise<void> => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (data: ${dataDir()})`);
  };

  return { server, run };
}
