/**
 * Thin HTTP client over the Achi Drive /v1 REST API.
 * Translates JSON responses to typed objects; throws on non-2xx.
 */
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
        const headers = {
            'Content-Type': opts.mimeType || 'application/octet-stream',
            'Content-Length': String(opts.bytes.length),
        };
        return this.json('/v1/files', 
        // Uint8Array is a valid fetch body in Node 18+ undici; cast to satisfy TS
        // without pulling in the entire DOM lib.
        { method: 'POST', body: opts.bytes, headers }, { name: opts.name, parentFolderId: opts.parentFolderId, teamId: opts.teamId });
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
        };
    }
}
