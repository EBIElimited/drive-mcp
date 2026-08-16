/**
 * Thin HTTP client over the Achi Drive /v1 REST API.
 * Translates JSON responses to typed objects; throws on non-2xx.
 */

export interface FilePublic {
  id: string
  type: 'file'
  name: string
  mimeType: string
  sizeBytes: number
  parentFolderId: string | null
  teamId: string | null
  starred: boolean
  trashed: boolean
  hasThumbnail: boolean
  videoCodec: string | null
  createdAt: string
  updatedAt: string
}

export interface FolderPublic {
  id: string
  type: 'folder'
  name: string
  parentFolderId: string | null
  teamId: string | null
  starred: boolean
  trashed: boolean
  createdAt: string
  updatedAt: string
}

export interface ListResponse {
  files: FilePublic[]
  folders: FolderPublic[]
  nextCursor: string | null
}

export interface SearchResponse {
  query: string
  files: FilePublic[]
  folders: FolderPublic[]
  scanned: { files: number; folders: number; cap: number }
  truncated: boolean
}

export interface TeamSummary {
  id: string
  role: string
  name: string
}

export interface MeResponse {
  userId: string
  email: string | null
  authVia: 'api_token' | 'session'
  hasContentAccess: boolean
  apiTokenId: string | null
}

export interface ContentBytes {
  mimeType: string
  bytes: Uint8Array
  size: number
  /** True if the response was truncated by a Range request. */
  partial: boolean
}

export class AchiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AchiApiError'
  }
}

export class AchiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
  ) {
    if (!apiUrl) throw new Error('apiUrl is required')
    if (!token) throw new Error('token is required')
    if (!token.startsWith('achi_pat_')) {
      throw new Error('token must start with "achi_pat_" (create one in Settings → AI)')
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private url(path: string, query?: Record<string, string | number | boolean | null | undefined>): string {
    const u = new URL(this.apiUrl.replace(/\/+$/, '') + path)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === null || v === undefined) continue
        u.searchParams.set(k, String(v))
      }
    }
    return u.toString()
  }

  private async request(path: string, init: RequestInit = {}, query?: Record<string, unknown>): Promise<Response> {
    const url = this.url(path, query as Record<string, string | number | boolean | null | undefined>)
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.token}`)
    if (!headers.has('User-Agent')) headers.set('User-Agent', '@achi/drive-mcp')
    const resp = await fetch(url, { ...init, headers })
    if (!resp.ok) {
      // Try to parse JSON error envelope { error, code, requestId }
      let code = 'HTTP_' + resp.status
      let message = `Achi API ${resp.status} on ${path}`
      try {
        const body = (await resp.json()) as { error?: string; code?: string }
        if (body.code) code = body.code
        if (body.error) message = body.error
      } catch {
        // Non-JSON error body
      }
      throw new AchiApiError(resp.status, code, message)
    }
    return resp
  }

  private async json<T>(path: string, init: RequestInit = {}, query?: Record<string, unknown>): Promise<T> {
    const resp = await this.request(path, init, query)
    return resp.json() as Promise<T>
  }

  // ── Identity ────────────────────────────────────────────────────────────

  async me(): Promise<MeResponse> {
    return this.json<MeResponse>('/v1/me')
  }

  async teams(): Promise<{ teams: TeamSummary[] }> {
    return this.json<{ teams: TeamSummary[] }>('/v1/teams')
  }

  // ── List + Get ──────────────────────────────────────────────────────────

  async listFiles(opts: {
    parentFolderId?: string | null
    teamId?: string | null
    limit?: number
    cursor?: string
    trashed?: boolean
  } = {}): Promise<ListResponse> {
    return this.json<ListResponse>('/v1/files', {}, {
      parentFolderId: opts.parentFolderId,
      teamId: opts.teamId,
      limit: opts.limit,
      cursor: opts.cursor,
      trashed: opts.trashed ? '1' : undefined,
    })
  }

  async getFile(id: string): Promise<FilePublic> {
    return this.json<FilePublic>(`/v1/files/${encodeURIComponent(id)}`)
  }

  async getFolder(id: string): Promise<FolderPublic> {
    return this.json<FolderPublic>(`/v1/folders/${encodeURIComponent(id)}`)
  }

  async listFolderChildren(id: string, opts: { limit?: number; cursor?: string } = {}): Promise<ListResponse> {
    return this.json<ListResponse>(`/v1/folders/${encodeURIComponent(id)}/children`, {}, opts)
  }

  async search(opts: { q: string; teamId?: string; limit?: number }): Promise<SearchResponse> {
    return this.json<SearchResponse>('/v1/search', {}, opts)
  }

  // ── Content ─────────────────────────────────────────────────────────────

  async readContent(
    id: string,
    opts: { rangeStart?: number; rangeEnd?: number; maxBytes?: number } = {},
  ): Promise<ContentBytes> {
    const headers: Record<string, string> = {}
    let useRange = opts.rangeStart !== undefined || opts.rangeEnd !== undefined || opts.maxBytes !== undefined
    if (useRange) {
      const start = opts.rangeStart ?? 0
      const end =
        opts.rangeEnd ?? (opts.maxBytes !== undefined ? start + opts.maxBytes - 1 : '')
      headers['Range'] = `bytes=${start}-${end}`
    }
    const resp = await this.request(`/v1/files/${encodeURIComponent(id)}/content`, { headers })
    const buf = new Uint8Array(await resp.arrayBuffer())
    return {
      mimeType: resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
      bytes: buf,
      size: buf.length,
      partial: resp.status === 206,
    }
  }

  async readThumbnail(id: string): Promise<ContentBytes> {
    const resp = await this.request(`/v1/files/${encodeURIComponent(id)}/thumbnail`)
    const buf = new Uint8Array(await resp.arrayBuffer())
    return {
      mimeType: resp.headers.get('content-type') || 'image/jpeg',
      bytes: buf,
      size: buf.length,
      partial: false,
    }
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  async uploadFile(opts: {
    name: string
    bytes: Uint8Array
    mimeType?: string
    parentFolderId?: string | null
    teamId?: string | null
  }): Promise<FilePublic> {
    const headers: Record<string, string> = {
      'Content-Type': opts.mimeType || 'application/octet-stream',
      'Content-Length': String(opts.bytes.length),
    }
    return this.json<FilePublic>(
      '/v1/files',
      // Uint8Array is a valid fetch body in Node 18+ undici; cast to satisfy TS
      // without pulling in the entire DOM lib.
      { method: 'POST', body: opts.bytes as unknown as ArrayBuffer, headers },
      { name: opts.name, parentFolderId: opts.parentFolderId, teamId: opts.teamId },
    )
  }

  async patchFile(
    id: string,
    body: { name?: string; starred?: boolean; trashed?: boolean; parentFolderId?: string | null },
  ): Promise<FilePublic> {
    return this.json<FilePublic>(`/v1/files/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async deleteFile(id: string, opts: { permanent?: boolean } = {}): Promise<{ ok: boolean; id: string; permanent: boolean }> {
    return this.json(`/v1/files/${encodeURIComponent(id)}`, { method: 'DELETE' }, {
      permanent: opts.permanent ? '1' : undefined,
    })
  }

  async createFolder(body: { name: string; parentFolderId?: string | null; teamId?: string | null }): Promise<FolderPublic> {
    return this.json<FolderPublic>('/v1/folders', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async patchFolder(
    id: string,
    body: { name?: string; starred?: boolean; trashed?: boolean; parentFolderId?: string | null },
  ): Promise<FolderPublic> {
    return this.json<FolderPublic>(`/v1/folders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async deleteFolder(id: string, opts: { permanent?: boolean } = {}): Promise<{ ok: boolean; id: string; permanent: boolean }> {
    return this.json(`/v1/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }, {
      permanent: opts.permanent ? '1' : undefined,
    })
  }

  // ── Properties / Mail / Agent / letters ────────────────────────────────

  async listUnits(opts: { teamId?: string; scope?: 'all' } = {}) {
    return this.json<{ scope: string; teamId: string | null; units: unknown[] }>('/v1/properties/units', {}, opts)
  }

  async getUnit(id: string) {
    return this.json<{ unit: unknown }>(`/v1/properties/units/${encodeURIComponent(id)}`)
  }

  async updateUnit(id: string, body: Record<string, unknown>) {
    return this.json<{ unit: unknown; changedFields: string[]; version: unknown }>(
      `/v1/properties/units/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
  }

  async listUnitVersions(unitId: string, opts: { limit?: number } = {}) {
    return this.json<{ unitId: string; unitName: string; versions: unknown[] }>(
      `/v1/properties/units/${encodeURIComponent(unitId)}/versions`,
      {},
      opts.limit != null ? { limit: String(opts.limit) } : {},
    )
  }

  async restoreUnit(unitId: string, versionId: string) {
    return this.json<{ unit: unknown; restoredFrom: unknown; version: unknown }>(
      `/v1/properties/units/${encodeURIComponent(unitId)}/versions/${encodeURIComponent(versionId)}/restore`,
      { method: 'POST' },
    )
  }

  async listUnitDocuments(unitId: string) {
    return this.json<{ unitId: string; documents: unknown[] }>(
      `/v1/properties/units/${encodeURIComponent(unitId)}/documents`,
    )
  }

  async downloadUnitDocument(unitId: string, docId: string): Promise<ContentBytes> {
    const resp = await this.request(
      `/v1/properties/units/${encodeURIComponent(unitId)}/documents/${encodeURIComponent(docId)}/download`,
    )
    const buf = new Uint8Array(await resp.arrayBuffer())
    return {
      mimeType: resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
      bytes: buf,
      size: buf.length,
      partial: false,
    }
  }

  async listUnitPayments(unitId: string, opts: { from?: string; to?: string } = {}) {
    return this.json(`/v1/properties/units/${encodeURIComponent(unitId)}/payments`, {}, opts)
  }

  async landlordProfile(opts: { teamId?: string } = {}) {
    return this.json('/v1/properties/landlord-profile', {}, opts)
  }

  async listBank(opts: { teamId: string; from?: string; to?: string }) {
    return this.json('/v1/properties/bank', {}, opts)
  }

  async listMailAccounts(opts: { teamId?: string } = {}) {
    return this.json('/v1/mail/accounts', {}, opts)
  }

  async searchMail(opts: { teamId?: string; accountId?: string; q?: string; mailbox?: string; limit?: number }) {
    return this.json('/v1/mail/messages', {}, opts)
  }

  async readMail(id: string) {
    return this.json(`/v1/mail/messages/${encodeURIComponent(id)}`)
  }

  async listAgentNotes(opts: { teamId?: string } = {}) {
    return this.json('/v1/agent/notes', {}, opts)
  }

  async createNkLetter(body: Record<string, unknown>): Promise<ContentBytes> {
    const resp = await this.request('/v1/letters/nk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const buf = new Uint8Array(await resp.arrayBuffer())
    return {
      mimeType: 'application/pdf',
      bytes: buf,
      size: buf.length,
      partial: false,
    }
  }
}
