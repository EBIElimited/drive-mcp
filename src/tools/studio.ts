/**
 * Studio app: productions, story/dialog documents, scenes and their renders.
 * Studio ids are opaque strings (not UUIDs) — pass them exactly as returned.
 */

import { z } from 'zod'
import { READ, WRITE, imageContent, toolkit, type Register } from '../helpers.js'

const documentId = z.string().min(1).describe('Studio document id from list_studio_projects → documents[].id (opaque string, not a UUID).')

export const register: Register = (server, client) => {
  const { tool, rawTool } = toolkit(server)

  tool(
    'list_studio_projects',
    'List Studio productions',
    'Start here for Studio work. Returns {projects:[{id,name,teamId}]} when the user has several productions — call again with projectId to open one — or, for a single production, {project, documents, mediaRefs}: the document list (story, dialogs, library, …) with the ids the other studio tools take.',
    { projectId: z.string().optional().describe('Production id from a previous call, to open that one when there are several.') },
    READ,
    (args) => client.listStudioProjects(args),
  )

  tool(
    'get_studio_scene',
    'Get one Studio scene',
    'One scene in reading order — description blocks, image beats, choice prompts and every dialog line, each with its text and the renders assigned to it (title, fileId, role, usage, sortOrder, previewUrl). Use it to review whether renders match the writing; look at a render with view_studio_render.',
    {
      sceneId: z.string().min(1).describe('Scene id from the story document (opaque string, not a UUID).'),
      projectId: z.string().optional().describe('Production id from list_studio_projects. Needed when the user has several productions.'),
    },
    READ,
    ({ sceneId, projectId }) => client.getStudioScene(sceneId, { projectId }),
  )

  rawTool(
    'view_studio_render',
    'Look at a Studio render',
    'Return a render (or any Drive image file) as a downscaled JPEG in MCP image content so you can actually see it. Use the fileId of a render from get_studio_scene. Read-only.',
    {
      fileId: z.string().uuid().describe('Drive file UUID of the render (renders[].fileId in get_studio_scene).'),
      maxWidth: z.number().int().min(256).max(2048).default(1280).describe('Width of the preview in pixels (256–2048). Smaller costs less context.'),
    },
    READ,
    async ({ fileId, maxWidth }) => ({ content: [imageContent(await client.readFilePreview(fileId, { maxWidth }))] }),
  )

  tool(
    'list_studio_versions',
    'List Studio document versions',
    'Saved versions of one Studio document, newest first. Each version is the document as it was BEFORE that write, with action, actor and reason; payloads are omitted. Use it to see who changed a document and when.',
    { documentId },
    READ,
    ({ documentId }) => client.listStudioVersions(documentId),
  )

  tool(
    'get_studio_document',
    'Get a Studio document',
    'One Studio document (story, dialog pack, library, …) with its full payload and updatedAt. Read it right before update_studio_document: you need its updatedAt, and for a story each scene\'s updatedAt.',
    { documentId },
    READ,
    ({ documentId }) => client.getStudioDocument(documentId),
  )

  tool(
    'update_studio_document',
    'Update a Studio document',
    [
      'Save a Studio document; the previous state is kept as a version first.',
      'Send expectedUpdatedAt = the document.updatedAt you read, plus payload and/or title, and a reason.',
      'Story saves are checked per scene: pass sceneBase {sceneId: that scene.updatedAt as you read it} for the scenes you edited.',
      'The server stamps scene.updatedAt — do not bump it yourself.',
      'If a scene changed since you read it the save is refused with 409 SCENE_CONFLICT and nothing is written: re-read with get_studio_document, re-apply your edit, save again.',
      'The response lists sceneChanges {updated, added, removed}. Full rules: GET /studio/api-docs → storySaves.',
    ].join(' '),
    {
      documentId,
      expectedUpdatedAt: z.string().describe('document.updatedAt exactly as returned by get_studio_document (ISO 8601 timestamp).'),
      payload: z.record(z.string(), z.unknown()).optional().describe('The complete new document payload (not a partial patch). Omit to change only the title.'),
      title: z.string().optional().describe('New document title.'),
      sceneBase: z.record(z.string(), z.string()).optional().describe('Stories only: {sceneId: scene.updatedAt as you read it} for each scene you edited.'),
      reason: z.string().min(1).describe('Why this save, e.g. "Expanded scene dialog". Stored on the version.'),
    },
    WRITE,
    ({ documentId, ...body }) => client.updateStudioDocument(documentId, body),
  )
}
