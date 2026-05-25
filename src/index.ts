#!/usr/bin/env node
/**
 * Achi Drive MCP Server
 *
 * Exposes the Achi Drive /v1 REST API as MCP tools so AI agents
 * (Claude Code, Claude Desktop, Cursor, etc.) can list, read, search,
 * upload, and manage files in the user's encrypted drive.
 *
 * Environment:
 *   ACHI_API_TOKEN  — achi_pat_* token from Settings → Developer
 *   ACHI_API_URL    — optional, defaults to https://api.achi.cc
 *
 * Usage:
 *   npx @achi/drive-mcp
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AchiClient, AchiApiError, type ContentBytes } from './client.js'

// ── Configuration ───────────────────────────────────────────────────────────

const token = process.env.ACHI_API_TOKEN
if (!token) {
  console.error(
    'ERROR: ACHI_API_TOKEN environment variable is required.\n' +
      'Create a token at Achi → Settings → Developer API tokens (with content access enabled).',
  )
  process.exit(1)
}

const apiUrl = process.env.ACHI_API_URL?.trim() || 'https://api.achi.cc'
const client = new AchiClient(apiUrl, token)

// Default limits — keep tool responses small enough for the agent's context
const DEFAULT_READ_MAX_BYTES = 1 * 1024 * 1024 // 1 MB
const ABSOLUTE_READ_MAX_BYTES = 5 * 1024 * 1024 // 5 MB hard cap per call
const TEXT_MIME_PATTERN = /^(text\/|application\/(json|xml|x-ndjson|yaml|x-yaml|javascript|typescript|x-sh|sql|toml|csv))/

// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  const apiErr = err instanceof AchiApiError ? { status: err.status, code: err.code } : undefined
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: apiErr ? `API ${apiErr.status} ${apiErr.code}: ${message}` : `Error: ${message}`,
    }],
  }
}

function bytesToBase64(b: Uint8Array): string {
  // Avoid stack overflow for large buffers: chunk into 32KB blocks
  let s = ''
  const CHUNK = 32 * 1024
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, Math.min(i + CHUNK, b.length)))
  }
  return Buffer.from(s, 'binary').toString('base64')
}

/**
 * Convert a downloaded file body to an MCP content array.
 * - text-ish mime: returns as plain text
 * - image mime: returns as MCP image content
 * - everything else: returns as embedded blob resource
 */
function contentBytesToMcp(c: ContentBytes, filename: string, fileId: string) {
  if (TEXT_MIME_PATTERN.test(c.mimeType)) {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: false }).decode(c.bytes)
    } catch {
      text = `[binary content, ${c.size} bytes, mime=${c.mimeType} — could not decode as UTF-8]`
    }
    return [
      { type: 'text' as const, text: c.partial ? `(partial, ${c.size} bytes)\n${text}` : text },
    ]
  }
  if (c.mimeType.startsWith('image/')) {
    return [
      { type: 'image' as const, data: bytesToBase64(c.bytes), mimeType: c.mimeType },
    ]
  }
  // Generic blob — return as embedded resource (agents can pass it along)
  return [
    {
      type: 'resource' as const,
      resource: {
        uri: `achi://files/${fileId}`,
        mimeType: c.mimeType,
        blob: bytesToBase64(c.bytes),
      },
    },
  ]
}

// ── Server setup ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'achi-drive',
  version: '1.0.0',
})

// ── Identity / Discovery ────────────────────────────────────────────────────

server.tool(
  'whoami',
  'Show the authenticated Achi Drive user, auth method, and whether the token has file-content access.',
  {},
  async () => {
    try {
      return jsonText(await client.me())
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_teams',
  "List all teams the user is a member of, with their roles. Use the returned team IDs as the `teamId` arg to other tools to operate inside a team's space.",
  {},
  async () => {
    try {
      return jsonText(await client.teams())
    } catch (err) {
      return errorResult(err)
    }
  },
)

// ── Listing ─────────────────────────────────────────────────────────────────

server.tool(
  'list_files',
  'List files and folders. Omit parentFolderId for the root. Pass teamId to list inside a team. Supports cursor-based pagination via the returned nextCursor.',
  {
    parentFolderId: z.string().uuid().optional().describe('Folder ID to list inside. Omit for root.'),
    teamId: z.string().optional().describe("Team ID to list inside that team's drive."),
    limit: z.number().int().min(1).max(500).default(100),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
    trashed: z.boolean().default(false).describe('If true, lists trashed items (parent filter ignored).'),
  },
  async (args) => {
    try {
      return jsonText(await client.listFiles(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_file',
  'Get metadata for a single file (name, mimeType, sizeBytes, etc.). Does NOT return content — use read_file for that.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      return jsonText(await client.getFile(id))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_folder',
  'Get metadata for a folder.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      return jsonText(await client.getFolder(id))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_folder_children',
  'List the immediate children (files + subfolders) of a folder.',
  {
    id: z.string().uuid(),
    limit: z.number().int().min(1).max(500).default(100),
    cursor: z.string().optional(),
  },
  async ({ id, limit, cursor }) => {
    try {
      return jsonText(await client.listFolderChildren(id, { limit, cursor }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'search',
  'Search files and folders by name (case-insensitive substring match). Scans up to 5,000 items per scope; results may be truncated for huge drives.',
  {
    q: z.string().min(1).max(200),
    teamId: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async (args) => {
    try {
      return jsonText(await client.search(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

// ── Content read ────────────────────────────────────────────────────────────

server.tool(
  'read_file',
  [
    'Download a file and return its content inline.',
    `Default cap: ${DEFAULT_READ_MAX_BYTES / 1024 / 1024} MB; absolute cap: ${ABSOLUTE_READ_MAX_BYTES / 1024 / 1024} MB.`,
    'For larger files, pass rangeStart/rangeEnd to fetch a specific byte range.',
    'Text mime types return as text. Images return as MCP image content. Other binaries return as embedded resource.',
  ].join(' '),
  {
    id: z.string().uuid(),
    rangeStart: z.number().int().min(0).optional().describe('Byte offset to start at (inclusive).'),
    rangeEnd: z.number().int().min(0).optional().describe('Byte offset to end at (inclusive). Omit for end-of-file.'),
    maxBytes: z.number().int().min(1).max(ABSOLUTE_READ_MAX_BYTES).default(DEFAULT_READ_MAX_BYTES).describe('Cap on returned size. Combined with rangeStart for sliding-window reads.'),
  },
  async (args) => {
    try {
      // First peek at file metadata to decide whether to truncate
      const info = await client.getFile(args.id)
      const start = args.rangeStart ?? 0
      let end = args.rangeEnd
      const wantedEnd = end ?? info.sizeBytes - 1
      const cappedEnd = Math.min(wantedEnd, start + args.maxBytes - 1, info.sizeBytes - 1)
      const useRange = start !== 0 || cappedEnd !== info.sizeBytes - 1

      const content = await client.readContent(args.id, {
        rangeStart: useRange ? start : undefined,
        rangeEnd: useRange ? cappedEnd : undefined,
      })

      return {
        content: [
          { type: 'text' as const, text: `Read ${info.name} (${content.mimeType}, ${content.size} bytes${content.partial ? ', partial' : ''})` },
          ...contentBytesToMcp(content, info.name, info.id),
        ],
      }
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'read_file_text',
  'Read a file as plain text, decoded as UTF-8. Convenience wrapper around read_file with a default 1 MB cap. Returns an error if the file is not text-encodable.',
  {
    id: z.string().uuid(),
    maxBytes: z.number().int().min(1).max(ABSOLUTE_READ_MAX_BYTES).default(DEFAULT_READ_MAX_BYTES),
  },
  async ({ id, maxBytes }) => {
    try {
      const info = await client.getFile(id)
      const end = Math.min(maxBytes - 1, info.sizeBytes - 1)
      const content = await client.readContent(id, {
        rangeStart: end < info.sizeBytes - 1 ? 0 : undefined,
        rangeEnd: end < info.sizeBytes - 1 ? end : undefined,
      })
      const text = new TextDecoder('utf-8', { fatal: false }).decode(content.bytes)
      return {
        content: [{
          type: 'text' as const,
          text: content.partial
            ? `${info.name} (truncated to ${content.size}/${info.sizeBytes} bytes)\n\n${text}`
            : text,
        }],
      }
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'read_thumbnail',
  'Get the JPEG thumbnail of a file (if it has one). Returns MCP image content. Useful for previewing images/videos without downloading the full file.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      const content = await client.readThumbnail(id)
      return {
        content: [{ type: 'image' as const, data: bytesToBase64(content.bytes), mimeType: content.mimeType }],
      }
    } catch (err) {
      return errorResult(err)
    }
  },
)

// ── Mutations ───────────────────────────────────────────────────────────────

server.tool(
  'upload_file',
  'Upload a new file. Provide content as base64 (for binaries) or text. Set mimeType for proper handling.',
  {
    name: z.string().min(1).max(512).describe('Filename including extension, e.g. "notes.md".'),
    content: z.string().describe('File content. Either UTF-8 text or base64 (use contentEncoding to specify).'),
    contentEncoding: z.enum(['text', 'base64']).default('text'),
    mimeType: z.string().default('application/octet-stream'),
    parentFolderId: z.string().uuid().optional().describe('Folder to upload into. Omit for root.'),
    teamId: z.string().optional().describe('Team space to upload into. Omit for personal drive.'),
  },
  async ({ name, content, contentEncoding, mimeType, parentFolderId, teamId }) => {
    try {
      const bytes =
        contentEncoding === 'base64'
          ? new Uint8Array(Buffer.from(content, 'base64'))
          : new TextEncoder().encode(content)
      const result = await client.uploadFile({ name, bytes, mimeType, parentFolderId, teamId })
      return jsonText(result)
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'update_file',
  'Rename, move, star/unstar, trash/restore a file in one call. Pass only the fields you want to change.',
  {
    id: z.string().uuid(),
    name: z.string().min(1).max(512).optional(),
    starred: z.boolean().optional(),
    trashed: z.boolean().optional().describe('true = move to trash, false = restore from trash.'),
    parentFolderId: z.string().uuid().nullable().optional().describe('null moves to root.'),
  },
  async ({ id, ...patch }) => {
    try {
      return jsonText(await client.patchFile(id, patch))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'delete_file',
  'Move a file to trash, or delete it permanently (irreversible). Default is trash.',
  {
    id: z.string().uuid(),
    permanent: z.boolean().default(false).describe('If true, deletes ciphertext from R2 and removes the DB record. Cannot be undone.'),
  },
  async ({ id, permanent }) => {
    try {
      return jsonText(await client.deleteFile(id, { permanent }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_folder',
  'Create a new folder.',
  {
    name: z.string().min(1).max(512),
    parentFolderId: z.string().uuid().optional().describe('Parent folder. Omit for root.'),
    teamId: z.string().optional().describe('Team to create the folder in. Omit for personal.'),
  },
  async (args) => {
    try {
      return jsonText(await client.createFolder(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'update_folder',
  'Rename, move, star/unstar, trash/restore a folder.',
  {
    id: z.string().uuid(),
    name: z.string().min(1).max(512).optional(),
    starred: z.boolean().optional(),
    trashed: z.boolean().optional(),
    parentFolderId: z.string().uuid().nullable().optional(),
  },
  async ({ id, ...patch }) => {
    try {
      return jsonText(await client.patchFolder(id, patch))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'delete_folder',
  'Move a folder to trash (recursive — all descendants trashed) or delete it permanently (also recursive — all contents wiped from R2 + DB). Permanent delete is irreversible.',
  {
    id: z.string().uuid(),
    permanent: z.boolean().default(false),
  },
  async ({ id, permanent }) => {
    try {
      return jsonText(await client.deleteFolder(id, { permanent }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Log to stderr — stdout is reserved for MCP protocol messages.
  console.error(`[achi-drive-mcp] connected. API=${apiUrl}`)
}

main().catch((err) => {
  console.error('[achi-drive-mcp] fatal:', err)
  process.exit(1)
})
