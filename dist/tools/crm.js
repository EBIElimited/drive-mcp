/** CRM app: boards, contact records, versions. */
import { z } from 'zod';
import { READ, WRITE, WRITE_IDEMPOTENT, teamId, teamIdWith, toolkit } from '../helpers.js';
const boardId = z.string().uuid().describe('Board UUID from list_crm_boards.');
const recordId = z.string().uuid().describe('Record UUID from list_crm_records.');
const recordFields = {
    handle: z.string().optional().describe('Social handle, e.g. "@name".'),
    company: z.string().optional(),
    role: z.string().optional().describe('The job: voice actor, Hausverwaltung, banker, artist, …'),
    email: z.string().optional(),
    phone: z.string().optional(),
    platform: z.string().optional().describe('Where the handle lives, e.g. "x", "instagram".'),
    profileUrl: z.string().optional(),
    followers: z.union([z.number(), z.string()]).optional().describe('Follower count as shown on the profile. Do not invent.'),
    stage: z.string().optional().describe('Pipeline stage; use the stage names the board already has (get_crm_stats).'),
    fields: z.record(z.unknown()).optional().describe('Extra board-specific fields as key → value.'),
};
export const register = (server, client) => {
    const { tool } = toolkit(server);
    tool('list_crm_boards', 'List CRM boards', 'List CRM boards in a space, with the board ids the record tools take. Omit teamId for personal.', { teamId }, READ, (args) => client.listCrmBoards(args));
    tool('create_crm_board', 'Create a CRM board', 'Create a CRM board. Default template is generic contacts (name, company, role, followers if social).', {
        title: z.string().describe('Board name.'),
        teamId: teamIdWith('Creates the board in that space.'),
        template: z.enum(['outreach', 'blank']).optional().describe('outreach (default) = contact columns and stages; blank = no defaults.'),
    }, WRITE, (args) => client.createCrmBoard(args));
    tool('list_crm_records', 'List CRM records', 'List the contact records on one CRM board, optionally filtered by a text query. Use it to find a record id before update_crm_record.', { boardId, q: z.string().optional().describe('Text to match in name, company, handle, ….') }, READ, (args) => client.listCrmRecords(args));
    tool('create_crm_record', 'Create a CRM contact', 'Create a CRM contact. Use role for the job (voice actor, Hausverwaltung, banker, artist). Do not invent followers, country, email, or phone.', {
        boardId,
        name: z.string().describe('Person or organisation name.'),
        ...recordFields,
        versionReason: z.string().optional().describe('Why the record is created; stored with its history.'),
    }, WRITE, (args) => client.createCrmRecord(args));
    tool('update_crm_record', 'Update a CRM contact', 'Patch a CRM record; pass only the fields to change. Snapshots a version first (undo with restore_crm_record). Pass versionReason.', {
        id: recordId,
        name: z.string().optional(),
        ...recordFields,
        archived: z.boolean().optional().describe('true hides the record from the board; false brings it back.'),
        versionReason: z.string().optional().describe('Always pass this: why the write happens. Stored on the snapshot.'),
    }, WRITE_IDEMPOTENT, ({ id, ...body }) => client.updateCrmRecord(id, body));
    tool('get_crm_stats', 'Get CRM board stats', 'CRM stats for a board: records, followers, by role / country / stage.', { boardId }, READ, ({ boardId }) => client.getCrmStats(boardId));
    tool('refresh_crm_x_profile', 'Refresh a contact from X', 'Read the public X profile for a CRM contact. Updates followers and fills country when the profile states one. Does not invent country.', { id: recordId }, 
    // Fetches a public profile from X, so this one does reach outside Achi.
    { ...WRITE_IDEMPOTENT, openWorldHint: true }, ({ id }) => client.refreshCrmXProfile(id));
    tool('list_crm_record_versions', 'List CRM record versions', 'Version history for a CRM record (newest first). Use restore_crm_record to go back to one.', { id: recordId }, READ, ({ id }) => client.listCrmRecordVersions(id));
    tool('restore_crm_record', 'Restore a CRM record version', 'Restore a CRM record to a prior version snapshot.', { id: recordId, versionId: z.string().uuid().describe('Version UUID from list_crm_record_versions.') }, WRITE, ({ id, versionId }) => client.restoreCrmRecord(id, versionId));
};
