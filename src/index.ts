#!/usr/bin/env node
/**
 * Achi Drive MCP Server
 *
 * Exposes the Achi Drive /v1 REST API as MCP tools so AI agents
 * (Claude Code, Claude Desktop, Cursor, etc.) can list, read, search,
 * upload, and manage files in the user's encrypted drive.
 *
 * Environment:
 *   ACHI_API_TOKEN  — achi_pat_* token from Settings → AI
 *   ACHI_API_URL    — optional, defaults to https://api.achi.cc
 *
 * Usage:
 *   npx @achi/drive-mcp
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { AchiClient, AchiApiError, INLINE_UPLOAD_MAX_BYTES, type ContentBytes } from './client.js'

// ── Configuration ───────────────────────────────────────────────────────────

const token = process.env.ACHI_API_TOKEN
if (!token) {
  console.error(
    'ERROR: ACHI_API_TOKEN environment variable is required.\n' +
      'Create a token at Achi → Settings → AI (with content access enabled).',
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
  name: 'achi',
  version: '1.1.0',
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
  'List files and folders. Omit parentFolderId for the root. For a team folder, parentFolderId is enough — teamId is inherited. Pass teamId only to list a team space root. Supports cursor-based pagination via the returned nextCursor.',
  {
    parentFolderId: z.string().uuid().optional().describe('Folder ID to list inside. Omit for root. Team folders do not need teamId.'),
    teamId: z.string().optional().describe("Team space root only. Not required when listing inside a team folder."),
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
  'List the immediate children (files + subfolders) of a folder. Works for team Drive folders without passing teamId — the folder’s space is used.',
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
  'upload_file_from_path',
  'THE large-file uploader. Pass a local disk path (zips, videos, anything). Streams 5 MiB plaintext chunks. Use this for anything over a few MB — never base64 a zip.',
  {
    path: z.string().min(1).describe('Absolute path on this machine.'),
    name: z.string().min(1).max(512).optional().describe('Drive filename. Defaults to the path basename.'),
    mimeType: z.string().optional(),
    parentFolderId: z.string().uuid().optional().describe('Folder to upload into. Omit for root.'),
    teamId: z.string().optional().describe('Team space. Omit for personal drive.'),
  },
  async ({ path, name, mimeType, parentFolderId, teamId }) => {
    try {
      const result = await client.uploadFileFromPath({
        path,
        name,
        mimeType,
        parentFolderId,
        teamId,
      })
      return jsonText(result)
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'upload_file',
  `SMALL FILES ONLY (under ${INLINE_UPLOAD_MAX_BYTES} bytes). Text or base64 notes. Refuses larger blobs — use upload_file_from_path. Never base64 a zip.`,
  {
    name: z.string().min(1).max(512).describe('Filename including extension, e.g. "notes.md".'),
    content: z.string().describe('UTF-8 text or base64 of a SMALL file only. For disk files use upload_file_from_path.'),
    contentEncoding: z.enum(['text', 'base64']).default('text'),
    mimeType: z.string().default('application/octet-stream'),
    parentFolderId: z.string().uuid().optional().describe('Folder to upload into. Omit for root.'),
    teamId: z.string().optional().describe('Team space to upload into. Omit for personal drive.'),
  },
  async ({ name, content, contentEncoding, mimeType, parentFolderId, teamId }) => {
    try {
      if (content.length > INLINE_UPLOAD_MAX_BYTES * 2) {
        throw new AchiApiError(
          413,
          'USE_UPLOAD_FILE_FROM_PATH',
          `upload_file refuses large blobs (${content.length} chars). Write the file to disk and call upload_file_from_path. Do not base64 a zip.`,
        )
      }
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

// ── Properties / Mail / Agent / letters ─────────────────────────────────────

server.tool(
  'list_units',
  'List Properties apartments. Pass teamId for a space such as Chi Ross. scope=all lists every space. buildingId / kind=etw|building for MFH vs ETW. financing filters by loanStatus. summary.remainingDebtEuros counts each building loan once — never SUM remainingDebt across units of the same building.',
  {
    teamId: z.string().optional(),
    scope: z.enum(['all']).optional(),
    buildingId: z.string().uuid().optional(),
    kind: z.enum(['etw', 'building']).optional(),
    financing: z
      .enum(['debt_free', 'active', 'unknown', 'fixed_rate_soon', 'all'])
      .optional()
      .describe('Filter: debt_free, active, unknown, or fixed_rate_soon (Zinsbindung in 24 months)'),
  },
  async (args) => {
    try {
      return jsonText(await client.listUnits(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_buildings',
  'List MFH buildings (one purchase + one loan + Wohnungen + garage spaces). Pass teamId for Chi Ross. Do not SUM remainingDebt across the nested units.',
  {
    teamId: z.string().optional(),
    scope: z.enum(['all']).optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.listBuildings(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_building',
  'One MFH with units, garage spaces, and sums (Kalt, Warm, Rate, Überschuss, Leerstand). House loan is building.loan — not on each Wohnung.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      return jsonText(await client.getBuilding(id))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_building',
  'Create an MFH. name required. Optional address, city, teamId, purchasePriceEuros, nested loan (bank, remainingDebtEuros, monthlyPaymentEuros, loanStatus), unitIds[], spaces[{kind,label,occupancyUnitId}]. Never invent remaining debt.',
  {
    name: z.string().min(1).max(200),
    address: z.string().optional(),
    city: z.string().optional(),
    teamId: z.string().optional(),
    purchasePriceEuros: z.number().optional(),
    loan: z
      .object({
        bank: z.string().optional(),
        account: z.string().optional(),
        remainingDebtEuros: z.number().optional(),
        monthlyPaymentEuros: z.number().optional(),
        fixedRateEnd: z.string().optional(),
        ratePercent: z.string().optional(),
        loanStatus: z.enum(['debt_free', 'active', 'in_prolongation', 'unknown']).optional(),
        notes: z.string().optional(),
      })
      .optional(),
    unitIds: z.array(z.string().uuid()).optional(),
    spaces: z
      .array(
        z.object({
          kind: z.enum(['garage', 'parking']).optional(),
          label: z.string(),
          occupancyUnitId: z.string().uuid().optional(),
          notes: z.string().optional(),
          rentEuros: z.number().optional(),
        }),
      )
      .optional(),
  },
  async (body) => {
    try {
      return jsonText(await client.createBuilding(body))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'update_building',
  'Patch an MFH including the single house loan. Never invent remaining debt.',
  {
    id: z.string().uuid(),
    name: z.string().min(1).max(200).optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    purchasePriceEuros: z.number().nullable().optional(),
    remainingDebtEuros: z.number().nullable().optional(),
    monthlyPaymentEuros: z.number().nullable().optional(),
    bankName: z.string().optional(),
    loanStatus: z.enum(['debt_free', 'active', 'in_prolongation', 'unknown']).optional(),
    loanNotes: z.string().optional(),
    nonRecoverableCostsEuros: z.number().nullable().optional(),
  },
  async ({ id, ...patch }) => {
    try {
      return jsonText(await client.updateBuilding(id, patch))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_building_documents',
  'List MFH building trail files (Kaufvertrag, Nutzungsänderung, Exposé). Not unit leases.',
  { buildingId: z.string().uuid() },
  async ({ buildingId }) => {
    try {
      return jsonText(await client.listBuildingDocuments(buildingId))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_building_document',
  'Add a building-level trail file (Kaufvertrag, Nutzungsänderung, Exposé). Do not hang these on a Wohnung. JSON contentBase64 or fileName+mimeType.',
  {
    buildingId: z.string().uuid(),
    title: z.string().optional(),
    category: z.string().optional().describe('deed | energy | other | …'),
    documentDate: z.string().optional(),
    notes: z.string().optional(),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
    contentBase64: z.string().optional(),
  },
  async ({ buildingId, ...body }) => {
    try {
      return jsonText(await client.createBuildingDocument(buildingId, body))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'download_building_document',
  'Download a building trail file (bytes).',
  { buildingId: z.string().uuid(), docId: z.string().uuid() },
  async ({ buildingId, docId }) => {
    try {
      const content = await client.downloadBuildingDocument(buildingId, docId)
      return {
        content: [
          { type: 'text' as const, text: `Downloaded ${content.size} bytes (${content.mimeType})` },
          ...contentBytesToMcp(content, 'document', docId),
        ],
      }
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_building_space',
  'Add a garage or Stellplatz on an MFH. occupancyUnitId = with-rented to a Wohnung (Cretu 3+4).',
  {
    buildingId: z.string().uuid(),
    label: z.string().min(1),
    kind: z.enum(['garage', 'parking']).optional(),
    occupancyUnitId: z.string().uuid().optional(),
    notes: z.string().optional(),
    rentEuros: z.number().optional(),
  },
  async ({ buildingId, ...body }) => {
    try {
      return jsonText(await client.createBuildingSpace(buildingId, body))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_unit_financing',
  'Document-based financing suggestions, named loans, and event history for one apartment. Apply a suggestion only after the user confirms. Never invent remaining debt.',
  { unitId: z.string().uuid() },
  async ({ unitId }) => {
    try {
      return jsonText(await client.getUnitFinancing(unitId))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'apply_financing_suggestion',
  'Apply one financing suggestion from get_unit_financing after the user confirmed. Writes loanStatus / Grundschuld / remainingDebt only when the document supports it.',
  { unitId: z.string().uuid(), key: z.string() },
  async ({ unitId, key }) => {
    try {
      return jsonText(await client.applyFinancingSuggestion(unitId, key))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'dismiss_financing_suggestion',
  'Dismiss a financing suggestion so it is not offered again.',
  { unitId: z.string().uuid(), key: z.string() },
  async ({ unitId, key }) => {
    try {
      return jsonText(await client.dismissFinancingSuggestion(unitId, key))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'extract_loan_from_docs',
  'Read Restschuld from a Tilgungsplan PDF in the property trail. Use dryRun=true first. Does not invent an amount if the PDF has no labeled Restschuld.',
  {
    unitId: z.string().uuid(),
    dryRun: z.boolean().optional(),
    force: z.boolean().optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.extractLoanFromDocs(args.unitId, { dryRun: args.dryRun, force: args.force }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_unit_loans',
  'Named loans on a unit (more than one bank).',
  { unitId: z.string().uuid() },
  async ({ unitId }) => {
    try {
      return jsonText(await client.listUnitLoans(unitId))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_unit_loan',
  'Add a named loan on a unit. Never invent remaining debt.',
  {
    unitId: z.string().uuid(),
    bankName: z.string().optional(),
    status: z.enum(['debt_free', 'active', 'in_prolongation', 'unknown']).optional(),
    remainingDebtEuros: z.number().nullable().optional(),
    monthlyPaymentEuros: z.number().nullable().optional(),
    fixedRateEndDate: z.string().optional(),
    notes: z.string().optional(),
  },
  async ({ unitId, ...body }) => {
    try {
      return jsonText(await client.createUnitLoan(unitId, body))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_unit',
  'Load one apartment: tenant, rent, address, financing (loanStatus, hasActiveLoan, Grundschuld), trail folder. Does not invent Anschrift, IBAN, or remaining debt.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      return jsonText(await client.getUnit(id))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'update_unit',
  'Write Properties fields (squareMeters, rooms, rent, tenant, loanStatus, bankName, remainingDebtEuros, grundschuldExists, notes, …). Snapshots the current row first so restore_unit can undo a bad write. Always pass versionReason. Never invent remaining debt. Use ifUpdatedAt from get_unit.updatedAt to avoid clobbering.',
  {
    id: z.string().uuid(),
    squareMeters: z.string().optional(),
    rooms: z.string().optional(),
    name: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    rentEuros: z.number().optional(),
    nebenkostenEuros: z.number().optional(),
    hausgeldEuros: z.number().optional(),
    tenantName: z.string().optional(),
    tenantEmail: z.string().optional(),
    leaseStart: z.string().optional(),
    purchasePriceEuros: z.number().nullable().optional(),
    purchaseDate: z.string().optional(),
    marketValueEuros: z.number().nullable().optional(),
    marketValueDate: z.string().optional(),
    marketValueSource: z.string().optional(),
    notes: z.string().optional(),
    todo: z.string().optional(),
    extras: z.string().optional(),
    rentAgreementNotes: z.string().optional(),
    propertyManagement: z.string().optional(),
    coOwnershipShare: z.string().optional(),
    garage: z.string().optional(),
    buildingYear: z.string().optional(),
    heating: z.string().optional(),
    energy: z.string().optional(),
    lastRentIncrease: z.string().optional(),
    loanStatus: z
      .enum(['debt_free', 'active', 'in_prolongation', 'unknown'])
      .optional()
      .describe('Structured financing status. Never invent remaining debt.'),
    hasActiveLoan: z.boolean().optional(),
    bankName: z.string().optional(),
    loanBank: z.string().optional(),
    remainingDebtEuros: z.number().nullable().optional(),
    loanBalanceEuros: z.number().nullable().optional(),
    monthlyPaymentEuros: z.number().nullable().optional(),
    loanMonthlyPaymentEuros: z.number().nullable().optional(),
    fixedRateEndDate: z.string().optional(),
    loanFixedUntil: z.string().optional(),
    grundschuldExists: z.boolean().nullable().optional(),
    grundschuldAmountEuros: z.number().nullable().optional(),
    loanNotes: z.string().optional(),
    versionReason: z.string().optional().describe('Why this write — stored on the snapshot'),
    ifUpdatedAt: z.string().optional().describe('ISO updatedAt from get_unit — 409 if stale'),
  },
  async (args) => {
    try {
      const { id, ...body } = args
      const payload: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) payload[k] = v
      }
      return jsonText(await client.updateUnit(id, payload))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_unit_versions',
  'List Properties unit snapshots (newest first). Use restore_unit if an earlier write was wrong.',
  {
    unitId: z.string().uuid(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.listUnitVersions(args.unitId, { limit: args.limit }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'restore_unit',
  'Revert a Properties unit to a prior snapshot. The live row is snapshotted first so this restore can also be undone.',
  {
    unitId: z.string().uuid(),
    versionId: z.string().uuid(),
  },
  async ({ unitId, versionId }) => {
    try {
      return jsonText(await client.restoreUnit(unitId, versionId))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_unit_documents',
  'List the Properties document trail for an apartment (HV, heating, tax, prior NK letters).',
  { unitId: z.string().uuid() },
  async ({ unitId }) => {
    try {
      return jsonText(await client.listUnitDocuments(unitId))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_unit_document',
  'Create a Properties trail document (NK letter, HV file, …). Send contentBase64 for the PDF/file. Use this instead of asking the user to re-attach. Uploading into Achi Properties/{unit} also creates a trail row.',
  {
    unitId: z.string().uuid(),
    title: z.string().optional(),
    category: z.string().optional().describe('lease | rent_increase | addendum | deposit | hausgeld | nebenkosten | deed | repair | energy | insurance | tax | correspondence | other'),
    documentDate: z.string().optional().describe('YYYY-MM-DD or DD.MM.YYYY — the letter/receipt date, not 31 Dec of the settlement year'),
    notes: z.string().optional(),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
    contentBase64: z.string().optional().describe('Raw file bytes as base64'),
    driveFileId: z.string().uuid().optional(),
    occupancyId: z.string().uuid().optional(),
    periodFrom: z.string().optional(),
    periodTo: z.string().optional(),
    year: z.number().int().optional(),
    effectiveOn: z.string().optional().describe('When the rent in this document starts (YYYY-MM-DD)'),
    rentEurosAfter: z.number().optional().describe('Nettokalt after this document. Required for Proof of Revenue.'),
    isCurrentLease: z.boolean().optional(),
    supersedesDocumentId: z.string().uuid().optional(),
  },
  async (args) => {
    try {
      return jsonText(
        await client.createUnitDocument(args.unitId, {
          title: args.title,
          category: args.category,
          documentDate: args.documentDate,
          notes: args.notes,
          fileName: args.fileName,
          mimeType: args.mimeType,
          contentBase64: args.contentBase64,
          driveFileId: args.driveFileId,
          occupancyId: args.occupancyId,
          periodFrom: args.periodFrom,
          periodTo: args.periodTo,
          year: args.year,
          effectiveOn: args.effectiveOn,
          rentEurosAfter: args.rentEurosAfter,
          isCurrentLease: args.isCurrentLease,
          supersedesDocumentId: args.supersedesDocumentId,
        }),
      )
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'update_unit_document',
  'Patch a trail document’s title, documentDate, category, effectiveOn, rentEurosAfter, isCurrentLease, or notes. Use this to tag a lease/increase for Proof of Revenue — do not ask the user to edit the UI.',
  {
    unitId: z.string().uuid(),
    docId: z.string().uuid(),
    title: z.string().optional(),
    documentDate: z.string().optional().describe('YYYY-MM-DD or DD.MM.YYYY — the letter/receipt date, not 31 Dec of the settlement year'),
    notes: z.string().nullable().optional(),
    category: z.string().optional(),
    effectiveOn: z.string().optional(),
    rentEurosAfter: z.number().nullable().optional(),
    isCurrentLease: z.boolean().optional(),
    supersedesDocumentId: z.string().uuid().nullable().optional(),
  },
  async (args) => {
    try {
      return jsonText(
        await client.updateUnitDocument(args.unitId, args.docId, {
          title: args.title,
          documentDate: args.documentDate,
          notes: args.notes,
          category: args.category,
          effectiveOn: args.effectiveOn,
          rentEurosAfter: args.rentEurosAfter,
          isCurrentLease: args.isCurrentLease,
          supersedesDocumentId: args.supersedesDocumentId,
        }),
      )
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_proof_of_revenue',
  'Build Mietaufstellung.pdf + Vertragstrail.zip from the written trail. Ist-Kalt is rentEurosAfter on lease/increase/addendum as of asOf — never invent rent. Default scope is occupied ETW; pass buildingId for one MFH. dryRun=true to preview. No bank mail. Share links expire in 14 days.',
  {
    teamId: z.string().uuid().optional(),
    buildingId: z.string().uuid().optional(),
    unitIds: z.array(z.string().uuid()).optional(),
    asOf: z.string().optional().describe('YYYY-MM-DD. Default today. Hadamar 456 € only on/after 2026-12-01 if tagged.'),
    writtenOnly: z.boolean().optional().describe('Default true — skip units without rentEurosAfter'),
    includeVacant: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    password: z.string().optional(),
    pdfOnly: z.boolean().optional().describe('Light: Mietaufstellung.pdf only, no ZIP'),
    includeFinancing: z.boolean().optional(),
    includeTenants: z
      .boolean()
      .optional()
      .describe('Default true. False omits tenant names (privacy for financing advisors).'),
    includeMarket: z
      .boolean()
      .optional()
      .describe('Extra table: market value, remaining debt, source; then totals. MFH loan once.'),
  },
  async (args) => {
    try {
      return jsonText(await client.createProofOfRevenue(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'download_unit_document',
  'Download one trail document (PDF/ODT). Use this instead of asking the user to re-attach HV or heating files.',
  { unitId: z.string().uuid(), docId: z.string().uuid() },
  async ({ unitId, docId }) => {
    try {
      const content = await client.downloadUnitDocument(unitId, docId)
      return {
        content: [
          { type: 'text' as const, text: `Downloaded ${content.size} bytes (${content.mimeType})` },
          ...contentBytesToMcp(content, 'document', docId),
        ],
      }
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_unit_payments',
  'Bank-statement payment trail for an apartment (cold/warm/NK). GET only — do not PATCH. Amount corrections belong in Achi Zahlungen / the matching job.',
  {
    unitId: z.string().uuid(),
    from: z.string().optional().describe('YYYY-MM'),
    to: z.string().optional().describe('YYYY-MM'),
  },
  async (args) => {
    try {
      return jsonText(await client.listUnitPayments(args.unitId, { from: args.from, to: args.to }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_landlord_profile',
  'Stored Vermieter letterhead for a space. Empty fields stay empty — never invent legal name, street, or IBAN.',
  { teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.landlordProfile(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_bank_transactions',
  'Kontoauszug lines for a team space. Requires teamId.',
  {
    teamId: z.string(),
    from: z.string().optional(),
    to: z.string().optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.listBank(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_mail_accounts',
  'Mailboxes the user can read. Never returns passwords.',
  { teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.listMailAccounts(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'search_mail',
  'Search mail the user can read (subject/from/snippet). No passwords.',
  {
    teamId: z.string().optional(),
    accountId: z.string().optional(),
    q: z.string().optional().describe('Subject, sender, recipients or preview text'),
    mailbox: z.enum(['INBOX', 'SENT', 'DRAFTS', 'TRASH']).optional(),
    from: z.string().optional().describe('Sender address or name contains'),
    unread: z.boolean().optional(),
    flagged: z.boolean().optional(),
    hasAttachments: z.boolean().optional(),
    since: z.string().optional().describe('ISO date, inclusive'),
    until: z.string().optional().describe('ISO date, exclusive'),
    before: z.string().optional().describe('nextBefore from the previous page'),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.searchMail(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'read_mail',
  'Read one mail message: plain-text body (converted from HTML when needed) and its attachment list. No passwords.',
  { id: z.string() },
  async ({ id }) => {
    try {
      return jsonText(await client.readMail(id))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_mail_draft',
  'Save a draft in Achi → Mail → Drafts. Agents cannot send; the user reviews and sends it. With replyToMessageId, to and "Re: subject" default from that message and the reply stays in the thread.',
  {
    accountId: z.string().describe('Mailbox to draft from (list_mail_accounts)'),
    text: z.string().min(1).describe('Plain-text body'),
    replyToMessageId: z.string().optional().describe('Message id from search_mail / read_mail to reply to'),
    to: z.array(z.string()).optional(),
    cc: z.array(z.string()).optional(),
    subject: z.string().optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.createMailDraft(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'read_mail_thread',
  'The conversation a message belongs to (same mailbox, same subject without Re:/Fwd:), oldest first. Read bodies with read_mail.',
  { id: z.string().describe('Any message id in the conversation') },
  async ({ id }) => {
    try {
      return jsonText(await client.readMailThread(id))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'read_mail_attachment',
  'Open a mail attachment (id from read_mail). Text and images come back inline; pass saveTo to write the file (e.g. a PDF) to a local path instead.',
  {
    id: z.string(),
    saveTo: z.string().optional().describe('Local file or folder path to save the attachment to'),
  },
  async ({ id, saveTo }) => {
    try {
      const file = await client.readMailAttachment(id)
      const name = (file.filename || `attachment-${id}`).replace(/[\\/]/g, '_')
      if (saveTo) {
        const target = /[\\/]$/.test(saveTo) ? resolve(saveTo, name) : resolve(saveTo)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.bytes)
        return jsonText({ saved: target, filename: name, mimeType: file.mimeType, sizeBytes: file.size })
      }
      return { content: contentBytesToMcp(file, name, id) }
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'manage_mail',
  'Triage mail in Achi: mark read/unread, flag/unflag, move to Trash or back to Inbox. Up to 100 message ids per call. Needs manage access to the mailbox. Changes Achi, not the mail server.',
  {
    ids: z.array(z.string()).min(1).max(100).describe('Message ids from search_mail'),
    seen: z.boolean().optional(),
    flagged: z.boolean().optional(),
    mailbox: z.enum(['TRASH', 'INBOX']).optional().describe('TRASH to delete, INBOX to restore'),
  },
  async (args) => {
    try {
      return jsonText(await client.manageMail(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_agent_notes',
  'List Drive /Agent notes in a space (agent.md, learnings/letters.md, …). Requires a content-access token.',
  { teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.listAgentNotes(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_git_folders',
  'List Drive folders that mirror a private git repo. Agents read the Drive copy — never ask for a GitHub token.',
  { teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.listGitFolders(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_skills',
  'List SKILL.md files mirrored from git folders in this space (e.g. novel-dialogue). Then read_file on the fileId.',
  { teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.listSkills(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'read_skill',
  'Find one mirrored skill by name (novel-dialogue) and return its Drive fileId. Use read_file next.',
  { name: z.string(), teamId: z.string().optional() },
  async ({ name, teamId }) => {
    try {
      return jsonText(await client.getSkill(name, { teamId }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_nk_letter',
  [
    'Compile a tenant Nebenkostenabrechnung PDF on the Achi server (no browser pdf.js).',
    'Pass recoverable line items only. Do not invent amounts, Anschrift, or IBAN.',
    'Do not include Eigentümerkosten leftovers or Quellenangabe — the server strips them.',
    'If tenants changed mid-year, pass occupancyId + periodFrom + periodTo so this letter does not overwrite the other stay.',
    'Returns a PDF. Also files the unit trail and a settlement (x-achi-nk-settlement-id).',
  ].join(' '),
  {
    unitId: z.string().uuid(),
    year: z.number().int().min(2000).max(2100),
    occupancyId: z.string().uuid().optional(),
    periodFrom: z.string().optional().describe('YYYY-MM-DD stay start in this settlement year'),
    periodTo: z.string().optional().describe('YYYY-MM-DD stay end in this settlement year'),
    createSettlement: z.boolean().optional(),
    prepaidEuros: z.number().optional(),
    greeting: z.string().optional(),
    title: z.string().optional(),
    notes: z.array(z.string()).optional(),
    items: z
      .array(
        z.object({
          posten: z.string(),
          schluessel: z.string().optional(),
          gesamt: z.string().optional(),
          ihrAnteilEinheiten: z.string().optional(),
          betrag: z.string().optional(),
          ihrAnteil: z.string(),
        }),
      )
      .min(1),
  },
  async (args) => {
    try {
      const pdf = await client.createNkLetter(args)
      return {
        content: [
          {
            type: 'text' as const,
            text: `NK letter PDF ${pdf.size} bytes.${pdf.settlementId ? ` settlement=${pdf.settlementId}` : ''}${pdf.documentId ? ` document=${pdf.documentId}` : ''}`,
          },
          {
            type: 'resource' as const,
            resource: {
              uri: `achi://letters/nk/${args.unitId}/${args.year}`,
              mimeType: 'application/pdf',
              blob: bytesToBase64(pdf.bytes),
            },
          },
        ],
      }
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_nk_settlements',
  'List tenant NK settlements for an apartment and year. Mid-year move-out → two rows, not one.',
  {
    unitId: z.string().uuid(),
    year: z.number().int().min(2000).max(2100).optional(),
  },
  async ({ unitId, year }) => {
    try {
      return jsonText(await client.listNkSettlements(unitId, { year }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'update_nk_settlement',
  'Patch one NK settlement (status, amounts, notes). Does not change other tenants in the same year.',
  {
    unitId: z.string().uuid(),
    nkId: z.string().uuid(),
    status: z.enum(['draft', 'ready_to_send', 'sent', 'paid', 'disputed']).optional(),
    prepaidEuros: z.number().nullable().optional(),
    totalCostsEuros: z.number().nullable().optional(),
    balanceEuros: z.number().nullable().optional(),
    notes: z.string().nullable().optional(),
    documentId: z.string().uuid().optional(),
  },
  async (args) => {
    try {
      return jsonText(
        await client.updateNkSettlement(args.unitId, args.nkId, {
          status: args.status,
          prepaidEuros: args.prepaidEuros,
          totalCostsEuros: args.totalCostsEuros,
          balanceEuros: args.balanceEuros,
          notes: args.notes,
          documentId: args.documentId,
        }),
      )
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_property_visits',
  'List Besichtigungsfahrten (viewing trips). Year totals count completed trips only. Never invent kilometres.',
  {
    teamId: z.string().optional(),
    year: z.number().int().min(2000).max(2100).optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.listPropertyVisits(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_property_visit',
  'Log a viewing trip. distanceKm is one-way. roundTrip defaults true (Hin- und Rückfahrt, deductible ×2). Never invent kilometres. Default rate 0.30 €/km.',
  {
    teamId: z.string().optional(),
    visitedOn: z.string().optional().describe('YYYY-MM-DD'),
    title: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    startAddress: z.string().optional(),
    distanceKm: z.number().nullable().optional().describe('One-way kilometres. Do not invent.'),
    roundTrip: z.boolean().optional().describe('Default true: count there and back.'),
    kmRateEuros: z.number().optional().describe('Default 0.30'),
    purpose: z.enum(['viewing', 'follow_up', 'handover', 'other']).optional(),
    status: z.enum(['planned', 'done', 'cancelled']).optional(),
    notes: z.string().optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.createPropertyVisit(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'update_property_visit',
  'Update a viewing trip (status, distanceKm, roundTrip, notes). Never invent kilometres.',
  {
    id: z.string().uuid(),
    visitedOn: z.string().optional(),
    title: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    startAddress: z.string().optional(),
    distanceKm: z.number().nullable().optional().describe('One-way kilometres.'),
    roundTrip: z.boolean().optional(),
    kmRateEuros: z.number().optional(),
    purpose: z.enum(['viewing', 'follow_up', 'handover', 'other']).optional(),
    status: z.enum(['planned', 'done', 'cancelled']).optional(),
    notes: z.string().optional(),
  },
  async ({ id, ...body }) => {
    try {
      return jsonText(await client.updatePropertyVisit(id, body))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_crm_boards',
  'List CRM boards in a space. Omit teamId for personal.',
  { teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.listCrmBoards(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_crm_board',
  'Create a CRM board. Default template is generic contacts (name, company, role, followers if social).',
  {
    title: z.string(),
    teamId: z.string().optional(),
    template: z.enum(['outreach', 'blank']).optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.createCrmBoard(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_crm_records',
  'List CRM records on a board.',
  { boardId: z.string().uuid(), q: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.listCrmRecords(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_crm_record',
  'Create a CRM contact. Use role for the job (voice actor, Hausverwaltung, banker, artist). Do not invent followers, country, email, or phone.',
  {
    boardId: z.string().uuid(),
    name: z.string(),
    handle: z.string().optional(),
    company: z.string().optional(),
    role: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    platform: z.string().optional(),
    profileUrl: z.string().optional(),
    followers: z.union([z.number(), z.string()]).optional(),
    stage: z.string().optional(),
    fields: z.record(z.unknown()).optional(),
    versionReason: z.string().optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.createCrmRecord(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'update_crm_record',
  'Patch a CRM record. Snapshots a version first. Pass versionReason.',
  {
    id: z.string().uuid(),
    name: z.string().optional(),
    handle: z.string().optional(),
    company: z.string().optional(),
    role: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    platform: z.string().optional(),
    profileUrl: z.string().optional(),
    followers: z.union([z.number(), z.string()]).optional(),
    stage: z.string().optional(),
    fields: z.record(z.unknown()).optional(),
    archived: z.boolean().optional(),
    versionReason: z.string().optional(),
  },
  async ({ id, ...body }) => {
    try {
      return jsonText(await client.updateCrmRecord(id, body))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_crm_stats',
  'CRM stats for a board: records, followers, by role / country / stage.',
  { boardId: z.string().uuid() },
  async ({ boardId }) => {
    try {
      return jsonText(await client.getCrmStats(boardId))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'refresh_crm_x_profile',
  'Read the public X profile for a CRM contact. Updates followers and fills country when the profile states one. Does not invent country.',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      return jsonText(await client.refreshCrmXProfile(id))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_crm_record_versions',
  'Version history for a CRM record (newest first).',
  { id: z.string().uuid() },
  async ({ id }) => {
    try {
      return jsonText(await client.listCrmRecordVersions(id))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'restore_crm_record',
  'Restore a CRM record to a prior version snapshot.',
  { id: z.string().uuid(), versionId: z.string().uuid() },
  async ({ id, versionId }) => {
    try {
      return jsonText(await client.restoreCrmRecord(id, versionId))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_financials_book',
  'Open the space\'s USD books: chart of accounts, bank pots (ids for import_bank_csv), coding rules, flags. Never invent FX rates.',
  { teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.getFinancialsBook(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_book_transactions',
  'Financials books: list bank lines with their receipts (documents[]). state: uncategorized | suggested | categorized | excluded | transfer. missingReceipt: only expenses still needing an invoice.',
  { teamId: z.string().optional(), state: z.string().optional(), missingReceipt: z.boolean().optional() },
  async (args) => {
    try {
      return jsonText(await client.listBankTransactions(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'import_bank_csv',
  'Import a Mercury or Wise CSV export as-is. Idempotent. dryRun previews. A Wise rate counts only for conversions to/from USD; other foreign lines are flagged missing_usd_rate with USD left null (use set_transaction_rate).',
  {
    bankId: z.string().uuid(),
    csv: z.string(),
    dryRun: z.boolean().optional(),
    teamId: z.string().optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.importBankCsv(args.bankId, args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'categorize_transaction',
  'Post a balanced USD journal for a bank line, once (409 ALREADY_POSTED on retry). Fails with missing_rate if a foreign line has no rate. dryRun previews.',
  {
    id: z.string().uuid(),
    teamId: z.string().optional(),
    accountId: z.string().uuid().optional(),
    accountCode: z.string().optional(),
    departmentCode: z.string().optional().describe('Department inside the company (e.g. NH, EGS); omit for company-level'),
    dryRun: z.boolean().optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.categorizeTransaction(args.id, args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'exclude_transaction',
  'Exclude an open line that belongs to another entity (e.g. Chi Ross / DE rentals in the Elania books).',
  { id: z.string().uuid(), teamId: z.string().optional() },
  async ({ id, teamId }) => {
    try {
      return jsonText(await client.excludeTransaction(id, { teamId }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'set_transaction_rate',
  'Record a USD rate (USD per 1 unit of the line currency) on an open foreign line, e.g. from the Wise app or invoice. Stored as a manual rate and audited. Only from a real source — never guess.',
  { id: z.string().uuid(), rate: z.string().describe('e.g. "1.0850"'), teamId: z.string().optional() },
  async ({ id, rate, teamId }) => {
    try {
      return jsonText(await client.setTransactionRate(id, { rate, teamId }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'upload_receipt',
  'Upload a receipt or invoice (PDF/JPEG/PNG/HEIC/WebP, max 25 MB) from a local path into the books. Same file twice is stored once. Pass transactionId to attach it, or read the receipt and pass amount/date/vendor to get matches[] (autoMatch attaches only a single clear match).',
  {
    path: z.string().min(1).describe('Absolute path on this machine.'),
    transactionId: z.string().uuid().optional(),
    amount: z.string().optional().describe('Receipt total as printed, e.g. "59.99"'),
    currency: z.string().optional(),
    date: z.string().optional().describe('Receipt date YYYY-MM-DD'),
    vendor: z.string().optional(),
    autoMatch: z.boolean().optional(),
    filename: z.string().optional(),
    mimeType: z.string().optional(),
    teamId: z.string().optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.uploadReceipt(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'attach_receipt',
  'Attach an uploaded receipt (documentId from upload_receipt or list_receipts) to a bank line. Idempotent; clears missing_invoice_pdf.',
  { transactionId: z.string().uuid(), documentId: z.string().uuid(), teamId: z.string().optional() },
  async ({ transactionId, documentId, teamId }) => {
    try {
      return jsonText(await client.attachReceipt(transactionId, documentId, { teamId }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'detach_receipt',
  'Remove a receipt from a bank line (the file stays in the books).',
  { transactionId: z.string().uuid(), documentId: z.string().uuid(), teamId: z.string().optional() },
  async ({ transactionId, documentId, teamId }) => {
    try {
      return jsonText(await client.detachReceipt(transactionId, documentId, { teamId }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_receipts',
  'List receipts in the books, or the ones on one transaction. hasFile=false means only a sha256 was registered.',
  { transactionId: z.string().uuid().optional(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.listReceipts(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'find_receipt_matches',
  'Bank lines a receipt belongs to. Read the receipt yourself and pass its total, date and vendor; returns ranked matches and a confident id when one clearly fits.',
  { amount: z.string(), currency: z.string().optional(), date: z.string().optional(), vendor: z.string().optional(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.findReceiptMatches(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'find_transfer_matches',
  'Open lines in the book\'s other accounts that look like the other side of this transfer (Mercury → Wise, Wise EUR → USD).',
  { id: z.string().uuid(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.findTransferMatches(args.id, args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'post_transfer',
  'Post two bank lines as one transfer between own accounts (no P&L). A currency conversion\'s USD gap goes to Exchange Gain/Loss; dryRun previews the journal.',
  { id: z.string().uuid(), counterTransactionId: z.string().uuid(), dryRun: z.boolean().optional(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.postTransfer(args.id, args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'unpost_transaction',
  'Undo a posted bank line or transfer: reverses its journal (kept for audit) and returns the line(s) to the inbox. Give a memo saying why.',
  { id: z.string().uuid(), memo: z.string().optional(), occurredOn: z.string().optional(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.unpostTransaction(args.id, args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'reverse_journal',
  'Reverse any journal (manual, opening, bank, transfer) with a mirror entry. occurredOn is needed only when the original period is locked.',
  { id: z.string().uuid(), memo: z.string().optional(), occurredOn: z.string().optional(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.reverseJournal(args.id, args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'post_journal',
  'Post a balanced manual journal in USD. kind "opening" enters opening balances (once per book). EUR accounts need nativeAmount per line. Use dryRun first.',
  {
    occurredOn: z.string(),
    memo: z.string(),
    kind: z.enum(['manual', 'opening']).optional(),
    lines: z.array(z.object({
      accountCode: z.string(),
      debit: z.string().optional(),
      credit: z.string().optional(),
      nativeAmount: z.string().optional(),
      departmentCode: z.string().optional(),
    })).min(2),
    dryRun: z.boolean().optional(),
    teamId: z.string().optional(),
  },
  async (args) => {
    try {
      return jsonText(await client.postJournal(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_journals',
  'General ledger: journals with lines, newest first. Filter by date range or account code.',
  { from: z.string().optional(), to: z.string().optional(), accountCode: z.string().optional(), limit: z.number().int().optional(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.listJournals(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_trial_balance',
  'Trial balance in USD as of a date; balanced must be true.',
  { asOf: z.string().optional(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.getTrialBalance(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_report_pnl',
  'P&L from posted journals only. Never invent.',
  { teamId: z.string().optional(), from: z.string().optional(), to: z.string().optional(), department: z.string().optional().describe('Department code, or none for company-level lines') },
  async (args) => {
    try {
      return jsonText(await client.getReportPnl(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'list_departments',
  'Departments (classes) inside the company\'s books, e.g. EGS Elania Game Studio, NH NeonHappi. Untagged = the company itself.',
  { teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.listDepartments(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'create_department',
  'Add a department to the company\'s books.',
  { code: z.string(), name: z.string(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.createDepartment(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'set_transaction_department',
  'Tag a bank line with a department (null untags); a posted line\'s journal follows. Only tag when the source says which product.',
  { id: z.string().uuid(), departmentCode: z.string().nullable(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.setTransactionDepartment(args.id, args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_pnl_by_department',
  'P&L per department plus company-level lines; columns add up to the company P&L.',
  { from: z.string().optional(), to: z.string().optional(), teamId: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.getPnlByDepartment(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)


server.tool(
  'get_report_bs',
  'Balance sheet as-of. Opening may be incomplete until a 1 Jan 2025 TB is posted.',
  { teamId: z.string().optional(), asOf: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.getReportBs(args))
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'get_report_cash',
  'Cash per bank pot in native currency. USD (amountHome) only when every line has a rate; otherwise null with missingRateCount.',
  { teamId: z.string().optional(), asOf: z.string().optional() },
  async (args) => {
    try {
      return jsonText(await client.getReportCash(args))
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
