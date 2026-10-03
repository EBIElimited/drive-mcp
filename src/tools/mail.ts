/** Mail app: mailboxes, search, read, drafts, triage. Agents never send and never see passwords. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { z } from 'zod'
import { DESTRUCTIVE_IDEMPOTENT, READ, WRITE, contentBytesToMcp, jsonText, teamIdWith, toolkit, type Register } from '../helpers.js'

const messageId = z.string().uuid().describe('Message UUID from search_mail.')
const draftId = z.string().uuid().describe('Draft UUID (draftMessageId from create_mail_draft).')

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip',
  '.doc': 'application/msword', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

const fileAttachments = {
  filePaths: z.array(z.string()).max(10).optional().describe('Local files to attach (read by this MCP server).'),
  driveFileIds: z.array(z.string().uuid()).max(10).optional().describe('Achi Drive file UUIDs to attach (needs a content-access key).'),
}

/** Local paths → { filename, mimeType, contentBase64 } for the API. */
async function attachmentsFromPaths(paths: string[] | undefined) {
  if (!paths?.length) return undefined
  return Promise.all(paths.map(async (path) => ({
    filename: basename(path),
    mimeType: MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream',
    contentBase64: (await readFile(resolve(path))).toString('base64'),
  })))
}

const SHOW_DRAFT = 'The result is a preview (from, to, cc, subject, text, attachments): show it to the user. Agents cannot send; the user sends it from Achi → Mail → Drafts.'
const accountId = z.string().uuid()

export const register: Register = (server, client) => {
  const { tool, rawTool } = toolkit(server)

  tool(
    'list_mail_accounts',
    'List mailboxes',
    'Mailboxes the user can read, with the account ids other mail tools take. Never returns passwords.',
    { teamId: teamIdWith('Lists the mailboxes of that space.') },
    READ,
    (args) => client.listMailAccounts(args),
  )

  tool(
    'search_mail',
    'Search mail',
    'Search mail the user can read (subject/from/snippet), newest first. Page with `before` = nextBefore of the previous page. Read a body with read_mail. No passwords.',
    {
      teamId: teamIdWith('Searches the mailboxes of that space.'),
      accountId: accountId.optional().describe('Limit to one mailbox (UUID from list_mail_accounts).'),
      q: z.string().optional().describe('Subject, sender, recipients or preview text'),
      mailbox: z.enum(['INBOX', 'SENT', 'DRAFTS', 'TRASH']).optional(),
      from: z.string().optional().describe('Sender address or name contains'),
      unread: z.boolean().optional().describe('true = only unread.'),
      flagged: z.boolean().optional().describe('true = only flagged.'),
      hasAttachments: z.boolean().optional().describe('true = only mails with attachments.'),
      since: z.string().optional().describe('Received on or after this date, inclusive. YYYY-MM-DD or a full ISO 8601 timestamp.'),
      until: z.string().optional().describe('Received before this date, exclusive. YYYY-MM-DD or a full ISO 8601 timestamp.'),
      before: z.string().optional().describe('nextBefore from the previous page'),
      limit: z.number().int().min(1).max(100).optional().describe('Messages per page (1–100).'),
    },
    READ,
    (args) => client.searchMail(args),
  )

  tool(
    'read_mail',
    'Read a mail',
    'Read one mail message: plain-text body (converted from HTML when needed) and its attachment list. No passwords.',
    { id: messageId },
    READ,
    ({ id }) => client.readMail(id),
  )

  tool(
    'create_mail_draft',
    'Save a mail draft',
    `Save a draft in Achi → Mail → Drafts, with files from local paths or Achi Drive. With replyToMessageId, to and "Re: subject" default from that message and the reply stays in the thread. ${SHOW_DRAFT}`,
    {
      accountId: accountId.describe('Mailbox UUID to draft from (list_mail_accounts)'),
      text: z.string().min(1).describe('Plain-text body'),
      replyToMessageId: z.string().uuid().optional().describe('Message UUID from search_mail / read_mail to reply to'),
      to: z.array(z.string()).optional().describe('Recipient addresses. Optional when replying.'),
      cc: z.array(z.string()).optional(),
      subject: z.string().optional().describe('Optional when replying.'),
      ...fileAttachments,
    },
    WRITE,
    async ({ filePaths, ...args }) => client.createMailDraft({ ...args, attachments: await attachmentsFromPaths(filePaths) }),
  )

  tool(
    'read_mail_draft',
    'Read a mail draft',
    `A draft as it would be sent. ${SHOW_DRAFT}`,
    { id: draftId },
    READ,
    ({ id }) => client.readMailDraft(id),
  )

  tool(
    'update_mail_draft',
    'Change a mail draft',
    `Change any of to, cc, subject, text. filePaths / driveFileIds replace the draft's files; removeAttachments drops them. ${SHOW_DRAFT}`,
    {
      id: draftId,
      to: z.array(z.string()).optional(),
      cc: z.array(z.string()).optional(),
      subject: z.string().optional(),
      text: z.string().min(1).optional(),
      removeAttachments: z.boolean().optional(),
      ...fileAttachments,
    },
    WRITE,
    async ({ id, filePaths, ...args }) => client.updateMailDraft(id, { ...args, attachments: await attachmentsFromPaths(filePaths) }),
  )

  tool(
    'delete_mail_draft',
    'Delete a mail draft',
    'Delete a draft and its files. Drafts only: received and sent mail cannot be deleted.',
    { id: draftId },
    DESTRUCTIVE_IDEMPOTENT,
    ({ id }) => client.deleteMailDraft(id),
  )

  tool(
    'read_mail_thread',
    'Read a mail conversation',
    'The conversation a message belongs to (same mailbox, same subject without Re:/Fwd:), oldest first. Read bodies with read_mail.',
    { id: z.string().uuid().describe('UUID of any message in the conversation') },
    READ,
    ({ id }) => client.readMailThread(id),
  )

  rawTool(
    'read_mail_attachment',
    'Open a mail attachment',
    'Open a mail attachment (id from read_mail). Text and images come back inline; pass saveTo to write the file (e.g. a PDF) to a local path instead (an existing file at that path is overwritten).',
    {
      id: z.string().uuid().describe('Attachment UUID from read_mail → attachments.'),
      saveTo: z.string().optional().describe('Local file or folder path to save the attachment to'),
    },
    // Not read-only: saveTo writes a local file. Nothing changes in Achi.
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id, saveTo }) => {
      const file = await client.readMailAttachment(id)
      const name = (file.filename || `attachment-${id}`).replace(/[\\/]/g, '_')
      if (saveTo) {
        const target = /[\\/]$/.test(saveTo) ? resolve(saveTo, name) : resolve(saveTo)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.bytes)
        return jsonText({ saved: target, filename: name, mimeType: file.mimeType, sizeBytes: file.size })
      }
      return { content: contentBytesToMcp(file, `achi://files/${id}`) }
    },
  )

  tool(
    'manage_mail',
    'Triage mail',
    'Triage mail in Achi: mark read/unread, flag/unflag, move to Trash or back to Inbox. Up to 100 message ids per call. Needs manage access to the mailbox. Changes Achi, not the mail server.',
    {
      ids: z.array(z.string().uuid()).min(1).max(100).describe('Message UUIDs from search_mail'),
      seen: z.boolean().optional().describe('true = mark read, false = mark unread.'),
      flagged: z.boolean().optional(),
      mailbox: z.enum(['TRASH', 'INBOX']).optional().describe('TRASH to delete, INBOX to restore'),
    },
    DESTRUCTIVE_IDEMPOTENT,
    (args) => client.manageMail(args),
  )
}
