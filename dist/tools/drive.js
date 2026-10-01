/** Identity + Drive: files, folders, content. */
import { z } from 'zod';
import { AchiApiError, INLINE_UPLOAD_MAX_BYTES } from '../client.js';
import { DESTRUCTIVE_IDEMPOTENT, READ, WRITE, WRITE_IDEMPOTENT, contentBytesToMcp, imageContent, teamIdWith, toolkit, } from '../helpers.js';
// Default limits — keep tool responses small enough for the agent's context
const DEFAULT_READ_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
const ABSOLUTE_READ_MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard cap per call
const fileId = z.string().uuid().describe('File UUID (from list_files, search or list_folder_children).');
const folderId = z.string().uuid().describe('Folder UUID (from list_files, search or list_folder_children).');
/**
 * Metadata and a byte window [start, end] in parallel. The window does not need
 * the file size: the server clamps the end, so one round trip is saved.
 * `partial` is true when the window is smaller than the file.
 */
async function readWindow(client, id, start, end) {
    const [info, body] = await Promise.all([
        client.getFile(id),
        client.readContent(id, { rangeStart: start, rangeEnd: end }).catch((err) => ({ err })),
    ]);
    if ('err' in body) {
        // An empty file has no satisfiable byte range; it is still a valid read.
        const emptyFile = body.err instanceof AchiApiError && body.err.status === 416 && info.sizeBytes === 0 && start === 0;
        if (!emptyFile)
            throw body.err;
        return { info, content: { mimeType: info.mimeType, bytes: new Uint8Array(0), size: 0, partial: false } };
    }
    return { info, content: { ...body, partial: body.size < info.sizeBytes } };
}
export const register = (server, client) => {
    const { tool, rawTool } = toolkit(server);
    // ── Identity / discovery ──────────────────────────────────────────────────
    tool('whoami', 'Who am I', 'Show the authenticated Achi user, the auth method, and whether the token has file-content access. Call it first to check the token works.', {}, READ, () => client.me());
    tool('list_teams', 'List spaces (teams)', "List every team space the user is a member of, with id, name and role. Use a returned id as the `teamId` argument of other tools to work inside that space; omit teamId for the personal space.", {}, READ, () => client.teams());
    // ── Listing ───────────────────────────────────────────────────────────────
    tool('list_files', 'List files and folders', 'List files and folders. Omit parentFolderId for the root. For a team folder, parentFolderId is enough — teamId is inherited. Pass teamId only to list a team space root. Supports cursor-based pagination via the returned nextCursor.', {
        parentFolderId: z.string().uuid().optional().describe('Folder UUID to list inside. Omit for root. Team folders do not need teamId.'),
        teamId: teamIdWith('Only needed for a team space root, not inside a team folder.'),
        limit: z.number().int().min(1).max(500).default(100).describe('Items per page (1–500).'),
        cursor: z.string().optional().describe('nextCursor from the previous response.'),
        trashed: z.boolean().default(false).describe('If true, lists trashed items (parent filter ignored).'),
    }, READ, (args) => client.listFiles(args));
    tool('get_file', 'Get file metadata', 'Get metadata for a single file (name, mimeType, sizeBytes, parent folder, team, starred/trashed, timestamps). Does NOT return content — use read_file for that.', { id: fileId }, READ, ({ id }) => client.getFile(id));
    tool('get_folder', 'Get folder metadata', 'Get metadata for one folder (name, parentFolderId, teamId, starred/trashed, timestamps). Use it to find a folder\'s parent or space; use list_folder_children for what is inside.', { id: folderId }, READ, ({ id }) => client.getFolder(id));
    tool('list_folder_children', 'List folder contents', 'List the immediate children (files + subfolders) of a folder, paginated via nextCursor. Works for team Drive folders without passing teamId — the folder’s space is used.', {
        id: folderId,
        limit: z.number().int().min(1).max(500).default(100).describe('Items per page (1–500).'),
        cursor: z.string().optional().describe('nextCursor from the previous response.'),
    }, READ, ({ id, limit, cursor }) => client.listFolderChildren(id, { limit, cursor }));
    tool('search', 'Search Drive by name', 'Search files and folders by name (case-insensitive substring match; not full-text content search). Scans up to 5,000 items per scope; `truncated` is true when a huge drive was cut off.', {
        q: z.string().min(1).max(200).describe('Part of the file or folder name.'),
        teamId: teamIdWith('Searches that space instead of the personal drive.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Maximum results (1–200).'),
    }, READ, (args) => client.search(args));
    // ── Content read ──────────────────────────────────────────────────────────
    rawTool('read_file', 'Read file content', [
        'Download a file and return its content inline.',
        `Default cap: ${DEFAULT_READ_MAX_BYTES / 1024 / 1024} MB; absolute cap: ${ABSOLUTE_READ_MAX_BYTES / 1024 / 1024} MB.`,
        'For larger files, pass rangeStart/rangeEnd to fetch a specific byte range.',
        'Text mime types return as text. Images return as MCP image content. Other binaries return as embedded resource.',
    ].join(' '), {
        id: fileId,
        rangeStart: z.number().int().min(0).optional().describe('Byte offset to start at (inclusive).'),
        rangeEnd: z.number().int().min(0).optional().describe('Byte offset to end at (inclusive). Omit for end-of-file.'),
        maxBytes: z.number().int().min(1).max(ABSOLUTE_READ_MAX_BYTES).default(DEFAULT_READ_MAX_BYTES).describe('Cap on returned size. Combined with rangeStart for sliding-window reads.'),
    }, READ, async ({ id, rangeStart, rangeEnd, maxBytes }) => {
        const start = rangeStart ?? 0;
        const { info, content } = await readWindow(client, id, start, Math.min(rangeEnd ?? Infinity, start + maxBytes - 1));
        return {
            content: [
                { type: 'text', text: `Read ${info.name} (${content.mimeType}, ${content.size} bytes${content.partial ? ', partial' : ''})` },
                ...contentBytesToMcp(content, `achi://files/${info.id}`),
            ],
        };
    });
    rawTool('read_file_text', 'Read file as text', 'Read a file as plain text, decoded as UTF-8, with a default 1 MB cap (a longer file is truncated and says so). Returns an error if the bytes are not valid UTF-8 (PDF, image, zip, …) — use read_file for those.', {
        id: fileId,
        maxBytes: z.number().int().min(1).max(ABSOLUTE_READ_MAX_BYTES).default(DEFAULT_READ_MAX_BYTES).describe('Cap on returned bytes.'),
    }, READ, async ({ id, maxBytes }) => {
        const { info, content } = await readWindow(client, id, 0, maxBytes - 1);
        let text;
        try {
            // stream:true tolerates a multi-byte character cut in half by the cap.
            text = new TextDecoder('utf-8', { fatal: true }).decode(content.bytes, { stream: content.partial });
        }
        catch {
            throw new Error(`${info.name} (${info.mimeType}) is not UTF-8 text. Use read_file for binary files.`);
        }
        return {
            content: [{
                    type: 'text',
                    text: content.partial
                        ? `${info.name} (truncated to ${content.size}/${info.sizeBytes} bytes)\n\n${text}`
                        : text,
                }],
        };
    });
    rawTool('read_thumbnail', 'Read file thumbnail', 'Get the JPEG thumbnail of a file (if it has one). Returns MCP image content. Useful for previewing images/videos without downloading the full file.', { id: fileId }, READ, async ({ id }) => ({ content: [imageContent(await client.readThumbnail(id))] }));
    // ── Mutations ─────────────────────────────────────────────────────────────
    tool('upload_file_from_path', 'Upload a file from disk', 'THE large-file uploader. Pass a local disk path (zips, videos, anything). Streams 5 MiB plaintext chunks. Use this for anything over a few MB — never base64 a zip.', {
        path: z.string().min(1).describe('Absolute path on this machine.'),
        name: z.string().min(1).max(512).optional().describe('Drive filename. Defaults to the path basename.'),
        mimeType: z.string().optional().describe('e.g. "application/zip". Omit to let the server decide.'),
        parentFolderId: z.string().uuid().optional().describe('Folder UUID to upload into. Omit for root.'),
        teamId: teamIdWith('Uploads into that space.'),
    }, WRITE, (args) => client.uploadFileFromPath(args));
    tool('upload_file', 'Upload a small file', `SMALL FILES ONLY (under ${INLINE_UPLOAD_MAX_BYTES} bytes). Text or base64 notes. Refuses larger blobs — use upload_file_from_path. Never base64 a zip.`, {
        name: z.string().min(1).max(512).describe('Filename including extension, e.g. "notes.md".'),
        content: z.string().describe('UTF-8 text or base64 of a SMALL file only. For disk files use upload_file_from_path.'),
        contentEncoding: z.enum(['text', 'base64']).default('text').describe('How `content` is encoded.'),
        mimeType: z.string().default('application/octet-stream').describe('e.g. "text/markdown".'),
        parentFolderId: z.string().uuid().optional().describe('Folder UUID to upload into. Omit for root.'),
        teamId: teamIdWith('Uploads into that space.'),
    }, WRITE, async ({ name, content, contentEncoding, mimeType, parentFolderId, teamId }) => {
        if (content.length > INLINE_UPLOAD_MAX_BYTES * 2) {
            throw new AchiApiError(413, 'USE_UPLOAD_FILE_FROM_PATH', `upload_file refuses large blobs (${content.length} chars). Write the file to disk and call upload_file_from_path. Do not base64 a zip.`);
        }
        const bytes = contentEncoding === 'base64'
            ? new Uint8Array(Buffer.from(content, 'base64'))
            : new TextEncoder().encode(content);
        return client.uploadFile({ name, bytes, mimeType, parentFolderId, teamId });
    });
    tool('update_file', 'Rename / move / trash a file', 'Rename, move, star/unstar, trash/restore a file in one call. Pass only the fields you want to change.', {
        id: fileId,
        name: z.string().min(1).max(512).optional().describe('New filename including extension.'),
        starred: z.boolean().optional(),
        trashed: z.boolean().optional().describe('true = move to trash, false = restore from trash.'),
        parentFolderId: z.string().uuid().nullable().optional().describe('Folder UUID to move into; null moves to root.'),
    }, WRITE_IDEMPOTENT, ({ id, ...patch }) => client.patchFile(id, patch));
    tool('delete_file', 'Delete a file', 'Move a file to trash, or delete it permanently (irreversible). Default is trash.', {
        id: fileId,
        permanent: z.boolean().default(false).describe('If true, deletes ciphertext from R2 and removes the DB record. Cannot be undone.'),
    }, DESTRUCTIVE_IDEMPOTENT, ({ id, permanent }) => client.deleteFile(id, { permanent }));
    tool('create_folder', 'Create a folder', 'Create a new Drive folder and return its metadata (the id is what you pass as parentFolderId when uploading into it). Omit parentFolderId for the root; inside a team folder teamId is inherited.', {
        name: z.string().min(1).max(512).describe('Folder name.'),
        parentFolderId: z.string().uuid().optional().describe('Parent folder UUID. Omit for root.'),
        teamId: teamIdWith('Creates the folder in that space.'),
    }, WRITE, (args) => client.createFolder(args));
    tool('update_folder', 'Rename / move / trash a folder', 'Rename, move, star/unstar, trash/restore a folder. Pass only the fields you want to change; trashing a folder trashes everything inside it.', {
        id: folderId,
        name: z.string().min(1).max(512).optional().describe('New folder name.'),
        starred: z.boolean().optional(),
        trashed: z.boolean().optional().describe('true = move to trash, false = restore from trash.'),
        parentFolderId: z.string().uuid().nullable().optional().describe('Folder UUID to move into; null moves to root.'),
    }, WRITE_IDEMPOTENT, ({ id, ...patch }) => client.patchFolder(id, patch));
    tool('delete_folder', 'Delete a folder', 'Move a folder to trash (recursive — all descendants trashed) or delete it permanently (also recursive — all contents wiped from R2 + DB). Permanent delete is irreversible.', {
        id: folderId,
        permanent: z.boolean().default(false).describe('If true, wipes the folder and everything in it. Cannot be undone.'),
    }, DESTRUCTIVE_IDEMPOTENT, ({ id, permanent }) => client.deleteFolder(id, { permanent }));
};
