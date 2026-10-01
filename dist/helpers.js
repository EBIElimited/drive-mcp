/**
 * Shared plumbing for the tool modules in src/tools/*: one registration helper
 * (error wrapper + compact JSON), annotation presets, common parameter schemas
 * and the bytes → MCP content converters.
 */
import { z } from 'zod';
import { AchiApiError } from './client.js';
// ── Results ─────────────────────────────────────────────────────────────────
/** Compact JSON: indentation only costs the agent context. */
export function jsonText(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
export function errorResult(err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
        isError: true,
        content: [{
                type: 'text',
                text: err instanceof AchiApiError ? `API ${err.status} ${err.code}: ${message}` : `Error: ${message}`,
            }],
    };
}
export function bytesToBase64(b) {
    return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');
}
export function imageContent(c) {
    return { type: 'image', data: bytesToBase64(c.bytes), mimeType: c.mimeType };
}
const TEXT_MIME_PATTERN = /^(text\/|application\/(json|xml|x-ndjson|yaml|x-yaml|javascript|typescript|x-sh|sql|toml|csv))/;
/**
 * Convert a downloaded body to MCP content:
 * text-ish mime → text, image → MCP image, everything else → embedded blob resource.
 */
export function contentBytesToMcp(c, uri) {
    if (TEXT_MIME_PATTERN.test(c.mimeType)) {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(c.bytes);
        return [{ type: 'text', text: c.partial ? `(partial, ${c.size} bytes)\n${text}` : text }];
    }
    if (c.mimeType.startsWith('image/'))
        return [imageContent(c)];
    return [{ type: 'resource', resource: { uri, mimeType: c.mimeType, blob: bytesToBase64(c.bytes) } }];
}
// ── Annotations ─────────────────────────────────────────────────────────────
// Everything talks to the user's own Achi account, so openWorldHint is false
// unless a tool says otherwise.
/** list / get / read / search: changes nothing. */
export const READ = { readOnlyHint: true, openWorldHint: false };
/** Adds or changes data in a way that can be undone; repeating it adds again. */
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Like WRITE, and repeating the same call leaves the same state. */
export const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Removes data or writes something that cannot be taken back. */
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const DESTRUCTIVE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
export function toolkit(server) {
    /** A tool that builds its own MCP content (images, files). Errors still become errorResult. */
    function rawTool(name, title, description, shape, annotations, handler) {
        const cb = async (args) => {
            try {
                return await handler(args);
            }
            catch (err) {
                return errorResult(err);
            }
        };
        server.registerTool(name, { title, description, inputSchema: shape, annotations }, cb);
    }
    /** The common case: the handler returns data, the tool returns it as compact JSON. */
    function tool(name, title, description, shape, annotations, handler) {
        rawTool(name, title, description, shape, annotations, async (args) => jsonText(await handler(args)));
    }
    return { tool, rawTool };
}
// ── Common parameters ───────────────────────────────────────────────────────
const TEAM = 'Space/team UUID from list_teams. Omit for the personal space.';
/** Optional space selector, same wording everywhere. */
export const teamId = z.string().uuid().optional().describe(TEAM);
export const teamIdWith = (extra) => z.string().uuid().optional().describe(`${TEAM} ${extra}`);
/** A calendar day. Format is described, not enforced — the API is the judge. */
export const day = (what) => z.string().describe(`${what} Format YYYY-MM-DD.`);
/** A calendar month. */
export const month = (what) => z.string().describe(`${what} Format YYYY-MM.`);
export const LOAN_STATUS = z.enum(['debt_free', 'active', 'in_prolongation', 'unknown']);
