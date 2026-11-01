#!/usr/bin/env node
/**
 * TimeTree MCP server entry.
 *
 * Reads a local session cookie or email/password from env, connects to TimeTree's
 * (unofficial) internal web API, and exposes four tools over MCP stdio:
 *   - list_calendars
 *   - create_event
 *   - list_events
 *   - update_event
 *
 * DISCLAIMER: This MCP uses reverse-engineered endpoints. TimeTree's official
 * API was shut down on 2023-12-22. The internal endpoints may change at any
 * time and using them may violate TimeTree's Terms of Service. Use only with
 * a dedicated account that you can afford to lose access to.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TimeTreeClient, logger } from './timetree.js';
import { buildTools } from './tools.js';

const VERSION = '0.1.0';

/**
 * Load `<project-root>/.env` into process.env at startup.
 *
 * Why we do this here instead of using `claude mcp add -e KEY=VAL`:
 * the `-e` form writes the credential into shell history (PowerShell's
 * PSReadLine, bash history, etc). Reading from a `.env` file that lives
 * in the project directory and is gitignored keeps the credential out
 * of history while still being explicit about where it comes from.
 *
 * Existing process env vars win — so Claude Code's `-e` overrides still
 * work if you set them, and CI environments can inject without touching .env.
 */
function loadEnvFile(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/index.js sits one level under the project root.
  const envPath = resolve(here, '..', '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnvFile();

async function main(): Promise<void> {
  // All tools require the account session; discovery works without a pinned ID.
  const email = process.env.TIMETREE_EMAIL || '';
  const password = process.env.TIMETREE_PASSWORD || '';
  const sessionCookie = process.env.TIMETREE_SESSION_COOKIE || '';
  if (!sessionCookie && (!email || !password)) {
    logger.warn('Set TIMETREE_SESSION_COOKIE or TIMETREE_EMAIL / TIMETREE_PASSWORD to use calendar tools');
  }

  const client = new TimeTreeClient({ email, password, sessionCookie, calendarId: process.env.TIMETREE_CALENDAR_ID });
  const tools = buildTools(client);

  const server = new Server(
    { name: 'timetree-mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    logger.info('Tool invoked', { name });
    return await tool.handler(req.params.arguments);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('TimeTree MCP server ready', {
    version: VERSION,
    tools: tools.map((t) => t.name),
  });

  const shutdown = async (signal: string) => {
    logger.info('Shutting down', { signal });
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error('Fatal error during startup', { error: (e as Error).message });
  console.error('[timetree-mcp] Fatal:', e);
  process.exit(1);
});
