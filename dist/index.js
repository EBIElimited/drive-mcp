#!/usr/bin/env node
/**
 * Achi MCP Server
 *
 * Exposes the Achi REST API as MCP tools so AI agents (Claude Code, Claude
 * Desktop, Cursor, etc.) can work in the user's Drive, Properties, Mail, CRM,
 * Financials and Studio. The tools live in src/tools/<domain>.ts; this file
 * only reads the configuration and wires them up.
 *
 * Environment:
 *   ACHI_API_TOKEN  — achi_pat_* token from Settings → AI
 *   ACHI_API_URL    — optional, defaults to https://worker.achiapp.com
 *
 * Usage:
 *   npx @achi/drive-mcp
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AchiClient } from './client.js';
import { register as agent } from './tools/agent.js';
import { register as crm } from './tools/crm.js';
import { register as drive } from './tools/drive.js';
import { register as financials } from './tools/financials.js';
import { register as mail } from './tools/mail.js';
import { register as properties } from './tools/properties.js';
import { register as studio } from './tools/studio.js';
const token = process.env.ACHI_API_TOKEN;
if (!token) {
    console.error('ERROR: ACHI_API_TOKEN environment variable is required.\n' +
        'Create a token at Achi → Settings → AI (with content access enabled).');
    process.exit(1);
}
const apiUrl = process.env.ACHI_API_URL?.trim() || 'https://worker.achiapp.com';
const client = new AchiClient(apiUrl, token);
// package.json sits one level above both src/ (tsx) and dist/ (built).
const { version } = createRequire(import.meta.url)('../package.json');
const server = new McpServer({ name: 'achi', version });
const domains = [drive, properties, mail, agent, crm, financials, studio];
for (const register of domains)
    register(server, client);
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Log to stderr — stdout is reserved for MCP protocol messages.
    console.error(`[achi-drive-mcp] v${version} connected. API=${apiUrl}`);
}
main().catch((err) => {
    console.error('[achi-drive-mcp] fatal:', err);
    process.exit(1);
});
