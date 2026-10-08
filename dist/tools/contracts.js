/** Contracts app: templates, contracts sent for e-signature, audit trails. */
import { z } from 'zod';
import { READ, WRITE, WRITE_IDEMPOTENT, toolkit } from '../helpers.js';
const teamId = z.string().uuid().describe('Space id from list_contract_spaces.');
const contractId = z.string().uuid().describe('Contract id from list_contracts.');
export const register = (server, client) => {
    const { tool } = toolkit(server);
    tool('list_contract_spaces', 'List Contracts spaces', 'Spaces where you can use the Contracts app, with your role (admin, signatory, manager). Managers never receive legal names, addresses or other sensitive signer data.', {}, READ, () => client.contractAccess());
    tool('list_contract_templates', 'List contract templates', 'Studios and their contract templates in a space, with versions (draft / active / retired). Use the active version id to create a contract.', { teamId }, READ, async ({ teamId: id }) => ({ studios: await client.listContractStudios(id), templates: await client.listContractTemplates(id) }));
    tool('get_contract_template_version', 'Get a template version', 'Body text (Markdown with {{field}} placeholders) and field schema of one template version: which fields the company fills and which the signer fills.', { versionId: z.string().uuid() }, READ, ({ versionId }) => client.getContractTemplateVersion(versionId));
    tool('list_contracts', 'List contracts', 'Contracts in a space with credit name, handle, signer email, status and template version. Status: draft, sent, opened, signed (waiting for countersign), returned, completed, voided, expired. q searches credit name, handle and email.', {
        teamId,
        studioId: z.string().uuid().optional(),
        status: z.string().optional(),
        q: z.string().optional(),
    }, READ, (args) => client.listContracts(args));
    tool('list_contracts_waiting', 'Contracts waiting for countersign', 'Contracts the signer has signed that wait for the company countersignature. Countersigning itself is only possible in the Achi app.', { teamId: teamId.optional() }, READ, (args) => client.listWaitingContracts(args));
    tool('get_contract', 'Get a contract', 'One contract with its fields, values and status. Sensitive values (legal name, address, …) are only returned to admins and signatories, and every such view is written to the audit trail — fetch only when needed.', { contractId }, READ, ({ contractId: id }) => client.getContract(id));
    tool('get_contract_audit', 'Get a contract audit trail', 'Every event on a contract: created, sent, opened, code verified, consent, signed, returned, countersigned, completed, downloads and sensitive-data views, with time, actor and IP.', { contractId }, READ, ({ contractId: id }) => client.getContractAudit(id));
    tool('create_contract', 'Create and send a contract', 'Create a contract from an ACTIVE template version for one signer and (send: true, default) email them a private signing link. Returns the signingUrl to paste into Discord/X too. Company fields come from the studio; override the signatory name only if asked. Confirm the signer email with the user before sending.', {
        teamId,
        templateVersionId: z.string().uuid(),
        signerEmail: z.string().email(),
        displayName: z.string().optional().describe('How the team refers to the person (credit name or handle). Never a legal name.'),
        privateNote: z.string().optional().describe('Internal note, never shown to the signer.'),
        signatoryName: z.string().optional().describe('Override the studio default company signatory name.'),
        send: z.boolean().default(true),
    }, WRITE, ({ signatoryName, ...rest }) => client.createContract({ ...rest, ...(signatoryName ? { companyValues: { 'company.signatory_name': signatoryName } } : {}) }));
    tool('contract_action', 'Resend, renew, void or return a contract', 'resend: email the same link again. renew: new 14-day link (old one stops working) — returns signingUrl. void: cancel with a reason. return: send a signed contract back to the signer with a comment so they can fix their details. send: send a draft. Countersigning is not available here; it happens in the Achi app.', {
        contractId,
        action: z.enum(['send', 'resend', 'renew', 'void', 'return']),
        reason: z.string().optional().describe('Required for void.'),
        comment: z.string().optional().describe('Required for return: what the signer must fix.'),
    }, WRITE, ({ contractId: id, action, reason, comment }) => client.contractAction(id, action, action === 'void' ? { reason } : action === 'return' ? { comment } : {}));
    tool('update_contract', 'Update contract settings', 'Turn automatic signer reminders (after 3 and 7 days) on or off, or change the internal note / display name.', {
        contractId,
        reminders: z.boolean().optional(),
        privateNote: z.string().optional(),
        displayName: z.string().optional(),
    }, WRITE_IDEMPOTENT, ({ contractId: id, ...body }) => client.updateContract(id, body));
};
