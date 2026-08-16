# @achi/drive-mcp

MCP server for [Achi](https://achi.cc) — Hermes, Grok Build, Claude, Cursor. One `achi_pat_*` token sees the same spaces and apps as the user: Drive, Properties, Mail, Agent notes, and server-side NK letters.

## Install + run

You need an API token first. Sign in to Achi → **Settings → Developer API tokens** → create one with **"Allow file content access"** enabled. Copy the `achi_pat_…` token (it's only shown once).

### Claude Desktop / Claude Code

Add to your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or via `claude mcp add`):

```json
{
  "mcpServers": {
    "achi-drive": {
      "command": "npx",
      "args": ["-y", "@achi/drive-mcp"],
      "env": {
        "ACHI_API_TOKEN": "achi_pat_xxxxxxxx"
      }
    }
  }
}
```

### Cursor / Continue / other MCP-capable hosts

Same idea — point the host at the binary and set `ACHI_API_TOKEN`. The binary speaks stdio JSON-RPC.

### Manual run (for debugging)

```bash
ACHI_API_TOKEN=achi_pat_xxx npx @achi/drive-mcp
```

## Tools

| Tool | What it does |
|---|---|
| `whoami` | Show authenticated user + token capabilities |
| `list_teams` | List teams you belong to |
| `list_files` | List files + folders (paginated, supports `parentFolderId`, `teamId`, `trashed`) |
| `get_file` | File metadata |
| `get_folder` | Folder metadata |
| `list_folder_children` | List a folder's contents |
| `search` | Find files/folders by name (substring, case-insensitive) |
| `read_file` | Download file content (text inline, images as MCP image, other as resource) |
| `read_file_text` | Convenience: read a file decoded as UTF-8 |
| `read_thumbnail` | JPEG thumbnail for images/videos |
| `upload_file` | Create a file from text or base64 |
| `update_file` | Rename / move / star / trash / restore |
| `delete_file` | Trash (default) or permanent delete |
| `create_folder` | Make a new folder |
| `update_folder` | Rename / move / star / trash / restore |
| `delete_folder` | Recursive trash (default) or permanent delete |
| `list_units` | Properties apartments (`teamId` / `scope=all`) |
| `get_unit` | One apartment |
| `list_unit_documents` | Trail (HV, heating, tax, letters) |
| `download_unit_document` | Download a trail file |
| `list_unit_payments` | Bank-matched rent trail |
| `get_landlord_profile` | Stored letterhead (never invented) |
| `list_bank_transactions` | Kontoauszug lines |
| `list_mail_accounts` | Mailboxes (no passwords) |
| `search_mail` / `read_mail` | Search and read mail |
| `list_agent_notes` | Drive `/Agent` notes |
| `create_nk_letter` | Server NK PDF |

## Environment

| Var | Default | Description |
|---|---|---|
| `ACHI_API_TOKEN` | — | **Required.** `achi_pat_*` token. |
| `ACHI_API_URL` | `https://api.achi.cc` | Override for self-hosted or staging endpoints. |

## Read-size caps

- `read_file` returns up to **1 MB** by default, **5 MB** hard cap. Use `rangeStart`/`rangeEnd` for windowed reads of larger files.
- For large videos/binaries, agents should typically request `read_thumbnail` for preview and call `read_file` only with a range.

## Permissions

The token grants the agent **whatever access you have** — personal files plus every team you're a member of. There's no per-folder scoping. Revoke the token at any time from Settings → Developer.

Tokens created without "Allow file content access" can only call metadata operations (`list_*`, `get_*`, `update_*` with non-name changes, `delete_*`). Content reads/writes and rename/search will return `METADATA_ONLY_TOKEN` errors.

## Security model

- The token itself is the only secret needed. Your password and master encryption key never leave your browser.
- The server side stores your masterKey wrapped under a key derived from the raw token via HKDF-SHA256 — the worker can only unwrap during a request that presents the raw token.
- All file content is encrypted on Cloudflare R2 with per-file AES-GCM keys. The MCP server only ever sees plaintext for the duration of a single tool call.

## Build from source

```bash
git clone … drive-mcp
cd drive-mcp
npm install
npm run build
ACHI_API_TOKEN=achi_pat_xxx node dist/index.js
```

## Smoke test

After deploying the backend (worker + migration), verify the chain end-to-end:

```bash
ACHI_API_TOKEN=achi_pat_xxx npm run smoke
```

This walks: auth → list → unwrap → create folder → upload → download (full + Range) → rename → search → permanent delete. Exits non-zero on any failure.

## Helper scripts

| Script | What it does |
|---|---|
| `scripts/deploy-helper.sh` | Runs the DB migration, deploys the worker, rebuilds the frontend. Needs `NILE_DIRECT_DB_URL` exported + `wrangler login` already done. |
| `scripts/smoke-test.mjs` | End-to-end /v1 API test against a deployed worker. Idempotent (cleans up after itself). |

## License

MIT
