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
import { AchiClient, AchiApiError, type ContentBytes } from './client.js'

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

// ── Properties / Mail / Agent / letters ─────────────────────────────────────

server.tool(
  'list_units',
  'List Properties (Vermietung) apartments the user can see. Pass teamId for a space such as Chi Ross. scope=all lists every space. financing filters by loanStatus.',
  {
    teamId: z.string().optional(),
    scope: z.enum(['all']).optional(),
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
    category: z.string().optional().describe('lease | deposit | hausgeld | nebenkosten | deed | repair | energy | insurance | tax | correspondence | other'),
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
        }),
      )
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.tool(
  'update_unit_document',
  'Patch a trail document’s title, documentDate (YYYY-MM-DD or DD.MM.YYYY), or notes. Use this for a wrong letter date — do not ask the user to edit the UI.',
  {
    unitId: z.string().uuid(),
    docId: z.string().uuid(),
    title: z.string().optional(),
    documentDate: z.string().optional().describe('YYYY-MM-DD or DD.MM.YYYY — the letter/receipt date, not 31 Dec of the settlement year'),
    notes: z.string().nullable().optional(),
  },
  async (args) => {
    try {
      return jsonText(
        await client.updateUnitDocument(args.unitId, args.docId, {
          title: args.title,
          documentDate: args.documentDate,
          notes: args.notes,
        }),
      )
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
  'Bank-statement payment trail for an apartment (cold/warm/NK). Source of rent-paid truth.',
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
    q: z.string().optional(),
    mailbox: z.string().optional().describe('INBOX or SENT'),
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
  'Read one mail message including plaintext body. No passwords.',
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
