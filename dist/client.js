/**
 * Thin HTTP client over the Achi Drive /v1 REST API.
 * Translates JSON responses to typed objects; throws on non-2xx.
 */
/** MCP upload_file (text/base64) hard cap. Larger files: upload_file_from_path. */
export const INLINE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const RECEIPT_MAX_BYTES = 25 * 1024 * 1024;
function jsonPost(body) {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
export class AchiApiError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'AchiApiError';
    }
}
export class AchiClient {
    apiUrl;
    token;
    constructor(apiUrl, token) {
        this.apiUrl = apiUrl;
        this.token = token;
        if (!apiUrl)
            throw new Error('apiUrl is required');
        if (!token)
            throw new Error('token is required');
        if (!token.startsWith('achi_pat_')) {
            throw new Error('token must start with "achi_pat_" (create one in Settings → AI)');
        }
    }
    // ── Internals ───────────────────────────────────────────────────────────
    url(path, query) {
        const u = new URL(this.apiUrl.replace(/\/+$/, '') + path);
        if (query) {
            for (const [k, v] of Object.entries(query)) {
                if (v === null || v === undefined)
                    continue;
                u.searchParams.set(k, String(v));
            }
        }
        return u.toString();
    }
    async request(path, init = {}, query) {
        const url = this.url(path, query);
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${this.token}`);
        if (!headers.has('User-Agent'))
            headers.set('User-Agent', '@achi/drive-mcp');
        const resp = await fetch(url, { ...init, headers });
        if (!resp.ok) {
            // Try to parse JSON error envelope { error, code, requestId }
            let code = 'HTTP_' + resp.status;
            let message = `Achi API ${resp.status} on ${path}`;
            try {
                const body = (await resp.json());
                if (body.code)
                    code = body.code;
                if (body.error)
                    message = body.error;
            }
            catch {
                // Non-JSON error body
            }
            throw new AchiApiError(resp.status, code, message);
        }
        return resp;
    }
    async json(path, init = {}, query) {
        const resp = await this.request(path, init, query);
        return resp.json();
    }
    // ── Identity ────────────────────────────────────────────────────────────
    async me() {
        return this.json('/v1/me');
    }
    async teams() {
        return this.json('/v1/teams');
    }
    // ── List + Get ──────────────────────────────────────────────────────────
    async listFiles(opts = {}) {
        return this.json('/v1/files', {}, {
            parentFolderId: opts.parentFolderId,
            teamId: opts.teamId,
            limit: opts.limit,
            cursor: opts.cursor,
            trashed: opts.trashed ? '1' : undefined,
        });
    }
    async getFile(id) {
        return this.json(`/v1/files/${encodeURIComponent(id)}`);
    }
    async getFolder(id) {
        return this.json(`/v1/folders/${encodeURIComponent(id)}`);
    }
    async listFolderChildren(id, opts = {}) {
        return this.json(`/v1/folders/${encodeURIComponent(id)}/children`, {}, opts);
    }
    async search(opts) {
        return this.json('/v1/search', {}, opts);
    }
    // ── Content ─────────────────────────────────────────────────────────────
    async readContent(id, opts = {}) {
        const headers = {};
        let useRange = opts.rangeStart !== undefined || opts.rangeEnd !== undefined || opts.maxBytes !== undefined;
        if (useRange) {
            const start = opts.rangeStart ?? 0;
            const end = opts.rangeEnd ?? (opts.maxBytes !== undefined ? start + opts.maxBytes - 1 : '');
            headers['Range'] = `bytes=${start}-${end}`;
        }
        const resp = await this.request(`/v1/files/${encodeURIComponent(id)}/content`, { headers });
        const buf = new Uint8Array(await resp.arrayBuffer());
        return {
            mimeType: resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
            bytes: buf,
            size: buf.length,
            partial: resp.status === 206,
        };
    }
    async readThumbnail(id) {
        const resp = await this.request(`/v1/files/${encodeURIComponent(id)}/thumbnail`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        return {
            mimeType: resp.headers.get('content-type') || 'image/jpeg',
            bytes: buf,
            size: buf.length,
            partial: false,
        };
    }
    // ── Mutations ───────────────────────────────────────────────────────────
    async uploadFile(opts) {
        if (opts.bytes.byteLength > INLINE_UPLOAD_MAX_BYTES) {
            throw new AchiApiError(413, 'USE_UPLOAD_FILE_FROM_PATH', `upload_file is for small text/base64 only (max ${INLINE_UPLOAD_MAX_BYTES} bytes). This payload is ${opts.bytes.byteLength} bytes. Use upload_file_from_path with a local disk path — it PUTs 5 MiB plaintext chunks. Do not base64 a zip.`);
        }
        const headers = {
            'Content-Type': opts.mimeType || 'application/octet-stream',
            'Content-Length': String(opts.bytes.byteLength),
        };
        return this.json('/v1/files', { method: 'POST', body: opts.bytes, headers }, { name: opts.name, parentFolderId: opts.parentFolderId, teamId: opts.teamId });
    }
    async uploadFileFromPath(opts) {
        const { open, stat } = await import('node:fs/promises');
        const { basename } = await import('node:path');
        const st = await stat(opts.path);
        if (!st.isFile())
            throw new Error(`Not a file: ${opts.path}`);
        const name = (opts.name ?? basename(opts.path)).trim();
        const fh = await open(opts.path, 'r');
        try {
            return await this.uploadFileChunked({
                name,
                sizeBytes: st.size,
                mimeType: opts.mimeType,
                parentFolderId: opts.parentFolderId,
                teamId: opts.teamId,
                readChunk: async (index, chunkSize) => {
                    const buf = Buffer.alloc(chunkSize);
                    const { bytesRead } = await fh.read(buf, 0, chunkSize, index * chunkSize);
                    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
                },
            });
        }
        finally {
            await fh.close();
        }
    }
    async uploadFileChunked(opts) {
        const session = await this.json('/v1/files/uploads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: opts.name,
                sizeBytes: opts.sizeBytes,
                mimeType: opts.mimeType,
                parentFolderId: opts.parentFolderId ?? null,
                teamId: opts.teamId ?? null,
            }),
        });
        const concurrency = Math.min(4, session.chunkCount);
        let next = 0;
        const workers = Array.from({ length: concurrency }, async () => {
            while (true) {
                const i = next++;
                if (i >= session.chunkCount)
                    return;
                const chunk = await opts.readChunk(i, session.chunkSize);
                await this.request(`/v1/files/uploads/${session.uploadId}/chunks/${i}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': String(chunk.byteLength),
                    },
                    body: chunk,
                });
            }
        });
        await Promise.all(workers);
        return this.json(`/v1/files/uploads/${session.uploadId}/complete`, {
            method: 'POST',
        });
    }
    async patchFile(id, body) {
        return this.json(`/v1/files/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
        });
    }
    async deleteFile(id, opts = {}) {
        return this.json(`/v1/files/${encodeURIComponent(id)}`, { method: 'DELETE' }, {
            permanent: opts.permanent ? '1' : undefined,
        });
    }
    async createFolder(body) {
        return this.json('/v1/folders', {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
        });
    }
    async patchFolder(id, body) {
        return this.json(`/v1/folders/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
        });
    }
    async deleteFolder(id, opts = {}) {
        return this.json(`/v1/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }, {
            permanent: opts.permanent ? '1' : undefined,
        });
    }
    // ── Properties / Mail / Agent / letters ────────────────────────────────
    async listUnits(opts = {}) {
        return this.json('/v1/properties/units', {}, opts);
    }
    async listBuildings(opts = {}) {
        return this.json('/v1/properties/buildings', {}, opts);
    }
    async getBuilding(id) {
        return this.json(`/v1/properties/buildings/${encodeURIComponent(id)}`);
    }
    async createBuilding(body) {
        return this.json('/v1/properties/buildings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async updateBuilding(id, body) {
        return this.json(`/v1/properties/buildings/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async createBuildingSpace(buildingId, body) {
        return this.json(`/v1/properties/buildings/${encodeURIComponent(buildingId)}/spaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async listBuildingDocuments(buildingId) {
        return this.json(`/v1/properties/buildings/${encodeURIComponent(buildingId)}/documents`);
    }
    async createBuildingDocument(buildingId, body) {
        return this.json(`/v1/properties/buildings/${encodeURIComponent(buildingId)}/documents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async downloadBuildingDocument(buildingId, docId) {
        const resp = await this.request(`/v1/properties/buildings/${encodeURIComponent(buildingId)}/documents/${encodeURIComponent(docId)}/download`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        return {
            mimeType: resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
            bytes: buf,
            size: buf.length,
            partial: false,
        };
    }
    async updateBuildingSpace(spaceId, body) {
        return this.json(`/v1/properties/spaces/${encodeURIComponent(spaceId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async deleteBuildingSpace(spaceId) {
        return this.json(`/v1/properties/spaces/${encodeURIComponent(spaceId)}`, {
            method: 'DELETE',
        });
    }
    async getUnit(id) {
        return this.json(`/v1/properties/units/${encodeURIComponent(id)}`);
    }
    async getUnitFinancing(id) {
        return this.json(`/v1/properties/units/${encodeURIComponent(id)}/financing`);
    }
    async applyFinancingSuggestion(unitId, key) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/financing/suggestions/${encodeURIComponent(key)}/apply`, { method: 'POST' });
    }
    async dismissFinancingSuggestion(unitId, key) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/financing/suggestions/${encodeURIComponent(key)}/dismiss`, { method: 'POST' });
    }
    async extractLoanFromDocs(unitId, body = {}) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/loan-from-docs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async listUnitLoans(unitId) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/loans`);
    }
    async createUnitLoan(unitId, body) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/loans`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async updateUnit(id, body) {
        return this.json(`/v1/properties/units/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async listUnitVersions(unitId, opts = {}) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/versions`, {}, opts.limit != null ? { limit: String(opts.limit) } : {});
    }
    async restoreUnit(unitId, versionId) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/versions/${encodeURIComponent(versionId)}/restore`, { method: 'POST' });
    }
    async listUnitDocuments(unitId) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/documents`);
    }
    async createUnitDocument(unitId, body) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/documents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async updateUnitDocument(unitId, docId, body) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/documents/${encodeURIComponent(docId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async createProofOfRevenue(body) {
        return this.json('/v1/properties/proof-of-revenue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async downloadUnitDocument(unitId, docId) {
        const resp = await this.request(`/v1/properties/units/${encodeURIComponent(unitId)}/documents/${encodeURIComponent(docId)}/download`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        return {
            mimeType: resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
            bytes: buf,
            size: buf.length,
            partial: false,
        };
    }
    async listUnitPayments(unitId, opts = {}) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/payments`, {}, opts);
    }
    async landlordProfile(opts = {}) {
        return this.json('/v1/properties/landlord-profile', {}, opts);
    }
    async listBank(opts) {
        return this.json('/v1/properties/bank', {}, opts);
    }
    async listMailAccounts(opts = {}) {
        return this.json('/v1/mail/accounts', {}, opts);
    }
    async searchMail(opts) {
        const { unread, flagged, hasAttachments, ...rest } = opts;
        return this.json('/v1/mail/messages', {}, {
            ...rest,
            unread: unread ? 1 : undefined,
            flagged: flagged ? 1 : undefined,
            hasAttachments: hasAttachments ? 1 : undefined,
        });
    }
    async readMailThread(id) {
        return this.json(`/v1/mail/messages/${encodeURIComponent(id)}/thread`);
    }
    async readMailAttachment(id) {
        const resp = await this.request(`/v1/mail/attachments/${encodeURIComponent(id)}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        const disposition = resp.headers.get('content-disposition') || '';
        const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
        const plain = /filename="([^"]+)"/i.exec(disposition);
        return {
            mimeType: resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
            bytes: buf,
            size: buf.length,
            partial: false,
            filename: star ? decodeURIComponent(star[1]) : plain?.[1] ?? null,
        };
    }
    async readMail(id) {
        return this.json(`/v1/mail/messages/${encodeURIComponent(id)}`);
    }
    async manageMail(body) {
        return this.json('/v1/mail/messages/manage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async createMailDraft(body) {
        return this.json('/v1/mail/drafts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async listAgentNotes(opts = {}) {
        return this.json('/v1/agent/notes', {}, opts);
    }
    async listGitFolders(opts = {}) {
        return this.json('/v1/git-folders', {}, opts);
    }
    async listSkills(opts = {}) {
        return this.json('/v1/skills', {}, opts);
    }
    async getSkill(name, opts = {}) {
        return this.json(`/v1/skills/${encodeURIComponent(name)}`, {}, opts);
    }
    async createNkLetter(body) {
        const resp = await this.request('/v1/letters/nk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const buf = new Uint8Array(await resp.arrayBuffer());
        return {
            mimeType: 'application/pdf',
            bytes: buf,
            size: buf.length,
            partial: false,
            documentId: resp.headers.get('x-achi-document-id') || undefined,
            settlementId: resp.headers.get('x-achi-nk-settlement-id') || undefined,
        };
    }
    async listPropertyVisits(opts = {}) {
        return this.json('/v1/properties/visits', {}, {
            teamId: opts.teamId,
            year: opts.year != null ? String(opts.year) : undefined,
        });
    }
    async createPropertyVisit(body) {
        return this.json('/v1/properties/visits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async updatePropertyVisit(id, body) {
        return this.json(`/v1/properties/visits/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async listNkSettlements(unitId, opts = {}) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/nk`, {}, opts.year != null ? { year: String(opts.year) } : {});
    }
    async createNkSettlement(unitId, body) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/nk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async updateNkSettlement(unitId, nkId, body) {
        return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/nk/${encodeURIComponent(nkId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async listCrmBoards(opts = {}) {
        return this.json('/v1/crm/boards', {}, opts);
    }
    async createCrmBoard(body) {
        return this.json('/v1/crm/boards', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async listCrmRecords(opts) {
        return this.json('/v1/crm/records', {}, opts);
    }
    async createCrmRecord(body) {
        return this.json('/v1/crm/records', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async updateCrmRecord(id, body) {
        return this.json(`/v1/crm/records/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async refreshCrmXProfile(id) {
        return this.json(`/v1/crm/records/${encodeURIComponent(id)}/refresh-x`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
    }
    async getCrmStats(boardId) {
        return this.json('/v1/crm/stats', {}, { boardId });
    }
    async listCrmRecordVersions(id) {
        return this.json(`/v1/crm/records/${encodeURIComponent(id)}/versions`);
    }
    async restoreCrmRecord(id, versionId) {
        return this.json(`/v1/crm/records/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }
    async getFinancialsBook(opts = {}) {
        return this.json('/v1/financials/book', {}, opts);
    }
    async listBankTransactions(opts = {}) {
        return this.json('/v1/financials/transactions', {}, {
            teamId: opts.teamId,
            state: opts.state,
            missingReceipt: opts.missingReceipt ? 1 : undefined,
        });
    }
    async importBankCsv(bankId, body) {
        return this.json(`/v1/financials/banks/${encodeURIComponent(bankId)}/import`, jsonPost(body), { teamId: body.teamId });
    }
    async categorizeTransaction(id, body) {
        return this.json(`/v1/financials/transactions/${encodeURIComponent(id)}/categorize`, jsonPost(body), { teamId: body.teamId });
    }
    async excludeTransaction(id, opts = {}) {
        return this.json(`/v1/financials/transactions/${encodeURIComponent(id)}/exclude`, jsonPost({}), { teamId: opts.teamId });
    }
    async setTransactionRate(id, body) {
        return this.json(`/v1/financials/transactions/${encodeURIComponent(id)}/rate`, jsonPost({ rate: body.rate }), { teamId: body.teamId });
    }
    /** Read a receipt from disk and upload it; the server hashes it and stores it once per book. */
    async uploadReceipt(opts) {
        const { readFile, stat } = await import('node:fs/promises');
        const { basename } = await import('node:path');
        const info = await stat(opts.path);
        if (info.size > RECEIPT_MAX_BYTES) {
            throw new AchiApiError(413, 'FILE_TOO_LARGE', `Receipts are limited to 25 MB (${opts.path} is ${info.size} bytes)`);
        }
        const bytes = await readFile(opts.path);
        return this.json('/v1/financials/documents', jsonPost({
            filename: (opts.filename ?? basename(opts.path)).trim(),
            contentBase64: bytes.toString('base64'),
            mimeType: opts.mimeType,
            transactionId: opts.transactionId,
            amount: opts.amount,
            currency: opts.currency,
            date: opts.date,
            vendor: opts.vendor,
            autoMatch: opts.autoMatch,
        }), { teamId: opts.teamId });
    }
    async attachReceipt(transactionId, documentId, opts = {}) {
        return this.json(`/v1/financials/transactions/${encodeURIComponent(transactionId)}/attach`, jsonPost({ documentId }), { teamId: opts.teamId });
    }
    async detachReceipt(transactionId, documentId, opts = {}) {
        return this.json(`/v1/financials/transactions/${encodeURIComponent(transactionId)}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' }, { teamId: opts.teamId });
    }
    async listReceipts(opts = {}) {
        return this.json('/v1/financials/documents', {}, opts);
    }
    async findReceiptMatches(opts) {
        return this.json('/v1/financials/documents/matches', {}, opts);
    }
    async findTransferMatches(id, opts = {}) {
        return this.json(`/v1/financials/transactions/${encodeURIComponent(id)}/transfer-candidates`, {}, opts);
    }
    async postTransfer(id, body) {
        return this.json(`/v1/financials/transactions/${encodeURIComponent(id)}/transfer`, jsonPost(body), { teamId: body.teamId });
    }
    async unpostTransaction(id, body = {}) {
        return this.json(`/v1/financials/transactions/${encodeURIComponent(id)}/unpost`, jsonPost(body), { teamId: body.teamId });
    }
    async reverseJournal(id, body = {}) {
        return this.json(`/v1/financials/journals/${encodeURIComponent(id)}/reverse`, jsonPost(body), { teamId: body.teamId });
    }
    async postJournal(body) {
        return this.json('/v1/financials/journals', jsonPost(body), { teamId: body.teamId });
    }
    async listJournals(opts = {}) {
        return this.json('/v1/financials/journals', {}, opts);
    }
    async getTrialBalance(opts = {}) {
        return this.json('/v1/financials/reports/trial-balance', {}, opts);
    }
    async getReportPnl(opts = {}) {
        return this.json('/v1/financials/reports/pnl', {}, opts);
    }
    async getPnlByDepartment(opts = {}) {
        return this.json('/v1/financials/reports/pnl-by-department', {}, opts);
    }
    async listDepartments(opts = {}) {
        return this.json('/v1/financials/departments', {}, opts);
    }
    async createDepartment(body) {
        return this.json('/v1/financials/departments', jsonPost({ code: body.code, name: body.name }), { teamId: body.teamId });
    }
    async setTransactionDepartment(id, body) {
        return this.json(`/v1/financials/transactions/${encodeURIComponent(id)}/department`, jsonPost({ departmentCode: body.departmentCode }), { teamId: body.teamId });
    }
    async getReportBs(opts = {}) {
        return this.json('/v1/financials/reports/bs', {}, opts);
    }
    async getReportCash(opts = {}) {
        return this.json('/v1/financials/reports/cash', {}, opts);
    }
}
