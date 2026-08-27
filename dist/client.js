/**
 * Thin HTTP client over the Achi Drive /v1 REST API.
 * Translates JSON responses to typed objects; throws on non-2xx.
 */
/** MCP upload_file (text/base64) hard cap. Larger files: upload_file_from_path. */
export const INLINE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
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
        return this.json('/v1/mail/messages', {}, opts);
    }
    async readMail(id) {
        return this.json(`/v1/mail/messages/${encodeURIComponent(id)}`);
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
}
