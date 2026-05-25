#!/usr/bin/env node
/**
 * End-to-end smoke test for a deployed Achi /v1 API.
 *
 * Usage:
 *   ACHI_API_TOKEN=achi_pat_xxx node scripts/smoke-test.mjs
 *   ACHI_API_URL=https://your-worker scripts/smoke-test.mjs   # optional override
 *
 * Walks the full happy path:
 *   1. /v1/me                            — auth works
 *   2. /v1/teams                         — DB reachable
 *   3. /v1/_debug/unwrap                 — wrapped masterKey unwraps
 *   4. /v1/files (list root)             — listing + name decryption
 *   5. POST /v1/folders                  — create folder
 *   6. POST /v1/files into that folder   — streaming upload + chunk encrypt
 *   7. GET /v1/files/:id/content         — decrypt + roundtrip bytes match
 *   8. PATCH /v1/files/:id (rename)      — re-encrypt name
 *   9. /v1/search                        — brute-force decrypt-and-filter
 *  10. DELETE both with permanent=1      — chunk + DB cleanup
 *
 * Exits non-zero if any step fails. Designed to be run from CI or by hand
 * right after `wrangler deploy`.
 */

const token = process.env.ACHI_API_TOKEN
const apiUrl = (process.env.ACHI_API_URL || 'https://api.achi.cc').replace(/\/+$/, '')

if (!token) {
  console.error('Set ACHI_API_TOKEN (achi_pat_... with content access)')
  process.exit(1)
}

let pass = 0, fail = 0
const failures = []

function ok(label) { console.log(`  ✓ ${label}`); pass++ }
function bad(label, err) { console.log(`  ✗ ${label} — ${err}`); fail++; failures.push(`${label}: ${err}`) }

async function api(method, path, opts = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...opts.headers }
  if (opts.body && !(opts.body instanceof Uint8Array) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(opts.body)
  }
  const res = await fetch(`${apiUrl}${path}`, { method, headers, body: opts.body })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  return { status: res.status, headers: res.headers, json, text }
}

async function step(label, fn) {
  try {
    await fn()
  } catch (err) {
    bad(label, err instanceof Error ? err.message : String(err))
  }
}

const TEST_TAG = `mcp-smoketest-${Date.now()}`
const TEST_PAYLOAD = `hello from achi-drive smoke test\n${new Array(50).fill('lorem ipsum').join(' ')}\n`
let createdFolderId = null
let createdFileId = null

console.log(`Achi smoke test → ${apiUrl}\n`)

await step('1. GET /v1/me', async () => {
  const r = await api('GET', '/v1/me')
  if (r.status !== 200) throw new Error(`status ${r.status}: ${r.text}`)
  if (!r.json?.userId) throw new Error('no userId in response')
  if (!r.json?.hasContentAccess) throw new Error('token lacks content access — create a new token with "Allow file content access" checked')
  ok(`authed as ${r.json.userId.slice(0, 8)}…  contentAccess=${r.json.hasContentAccess}`)
})

await step('2. GET /v1/teams', async () => {
  const r = await api('GET', '/v1/teams')
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  ok(`teams=${r.json.teams.length}`)
})

await step('3. GET /v1/_debug/unwrap (verify wrapped masterKey)', async () => {
  const r = await api('GET', '/v1/_debug/unwrap')
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  if (!r.json?.ok) throw new Error(`unwrap failed: ${r.json?.reason}`)
  ok('masterKey unwraps cleanly')
})

await step('4. GET /v1/files (list root)', async () => {
  const r = await api('GET', '/v1/files?limit=5')
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  if (!Array.isArray(r.json?.files)) throw new Error('no files array')
  ok(`root has ${r.json.files.length} file(s) + ${r.json.folders.length} folder(s) on first page`)
})

await step('5. POST /v1/folders (create test folder)', async () => {
  const r = await api('POST', '/v1/folders', { body: { name: TEST_TAG } })
  if (r.status !== 200) throw new Error(`status ${r.status}: ${r.text}`)
  createdFolderId = r.json.id
  ok(`folder created id=${createdFolderId.slice(0, 8)}… name="${r.json.name}"`)
  if (r.json.name !== TEST_TAG) throw new Error(`name roundtrip mismatch: expected ${TEST_TAG}, got ${r.json.name}`)
})

await step('6. POST /v1/files (streaming upload)', async () => {
  const bytes = new TextEncoder().encode(TEST_PAYLOAD)
  const url = `${apiUrl}/v1/files?name=${encodeURIComponent(TEST_TAG + '.txt')}&parentFolderId=${createdFolderId}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: bytes,
  })
  if (res.status !== 200) {
    const t = await res.text()
    throw new Error(`status ${res.status}: ${t}`)
  }
  const json = await res.json()
  createdFileId = json.id
  if (json.sizeBytes !== bytes.length) throw new Error(`size mismatch: server says ${json.sizeBytes}, sent ${bytes.length}`)
  if (json.name !== TEST_TAG + '.txt') throw new Error(`name mismatch`)
  ok(`uploaded ${json.sizeBytes} bytes, name="${json.name}", mime="${json.mimeType}"`)
})

await step('7. GET /v1/files/:id/content (roundtrip)', async () => {
  const res = await fetch(`${apiUrl}/v1/files/${createdFileId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) throw new Error(`status ${res.status}`)
  const text = await res.text()
  if (text !== TEST_PAYLOAD) {
    throw new Error(`bytes mismatch: got ${text.length} chars, expected ${TEST_PAYLOAD.length}`)
  }
  ok(`download bytes match exactly (${text.length} chars)`)
})

await step('7b. GET /v1/files/:id/content with Range (partial)', async () => {
  const res = await fetch(`${apiUrl}/v1/files/${createdFileId}/content`, {
    headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-15' },
  })
  if (res.status !== 206) throw new Error(`status ${res.status} (expected 206 Partial Content)`)
  const text = await res.text()
  if (text !== TEST_PAYLOAD.slice(0, 16)) {
    throw new Error(`range bytes mismatch: got "${text}", expected "${TEST_PAYLOAD.slice(0, 16)}"`)
  }
  ok(`Range bytes=0-15 → 206, first 16 bytes match`)
})

await step('8. PATCH /v1/files/:id (rename)', async () => {
  const r = await api('PATCH', `/v1/files/${createdFileId}`, { body: { name: TEST_TAG + '-renamed.txt' } })
  if (r.status !== 200) throw new Error(`status ${r.status}: ${r.text}`)
  if (r.json.name !== TEST_TAG + '-renamed.txt') throw new Error(`rename roundtrip failed`)
  ok(`renamed → "${r.json.name}"`)
})

await step('9. GET /v1/search (find our file)', async () => {
  const r = await api('GET', `/v1/search?q=${encodeURIComponent(TEST_TAG)}`)
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  const found = r.json.files.find((f) => f.id === createdFileId)
  if (!found) throw new Error(`search did not return our file (scanned ${r.json.scanned.files} files)`)
  ok(`search returned ${r.json.files.length} match(es), scanned ${r.json.scanned.files} files`)
})

await step('10. DELETE /v1/files/:id?permanent=1', async () => {
  const r = await api('DELETE', `/v1/files/${createdFileId}?permanent=1`)
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  ok('file permanently deleted (R2 chunks + DB row)')
})

await step('11. DELETE /v1/folders/:id?permanent=1', async () => {
  const r = await api('DELETE', `/v1/folders/${createdFolderId}?permanent=1`)
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  ok('folder permanently deleted')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
