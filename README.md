# @achi/drive-mcp

MCP server for [Achi](https://achi.cc) — Hermes, Grok Build, Claude, Cursor. One `achi_pat_*` token sees the same spaces and apps as the user: Drive, Properties, Mail, CRM, Financials, Studio, Agent notes, and server-side NK letters.

## Install + run

You need an API token first. Sign in to Achi → **Settings → AI** → create a key with **"Allow file content access"** enabled. Copy the `achi_pat_…` token (it's only shown once).

### Claude Desktop / Claude Code

Add to your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or via `claude mcp add`):

```json
{
  "mcpServers": {
    "achi-drive": {
      "command": "npx",
      "args": ["-y", "github:EBIElimited/drive-mcp"],
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
ACHI_API_TOKEN=achi_pat_xxx npx -y github:EBIElimited/drive-mcp

`@achi/drive-mcp` is the package name; install from GitHub until it is on the npm registry.
```

## Tools

Every tool carries a `title` and MCP `annotations` (`readOnlyHint` for list/get/read/search, `destructiveHint` for deletes, mail triage and ledger postings, `idempotentHint` where repeating a call is safe). JSON results are compact (no indentation).

### Identity + Drive

| Tool | What it does |
|---|---|
| `whoami` | Show authenticated user + token capabilities |
| `list_teams` | List teams you belong to |
| `list_files` | List files + folders (paginated, supports `parentFolderId`, `teamId`, `trashed`) |
| `get_file` | File metadata |
| `get_folder` | Folder metadata |
| `list_folder_children` | List a folder's contents (inherits team space) |
| `search` | Find files/folders by name (substring, case-insensitive) |
| `read_file` | Download file content (text inline, images as MCP image, other as resource) |
| `read_file_text` | Read a file decoded as UTF-8. Errors on non-UTF-8 (binary) files |
| `read_thumbnail` | JPEG thumbnail for images/videos |
| `upload_file_from_path` | **Large files.** Local disk path → 5 MiB plaintext chunks. Use this for zips. |
| `upload_file` | Small text/base64 only (under 8 MB). Refuses huge blobs. |
| `update_file` | Rename / move / star / trash / restore |
| `delete_file` | Trash (default) or permanent delete |
| `create_folder` | Make a new folder |
| `update_folder` | Rename / move / star / trash / restore |
| `delete_folder` | Recursive trash (default) or permanent delete |

### Properties

| Tool | What it does |
|---|---|
| `list_units` | Properties apartments (`teamId` / `scope=all` / `buildingId` / `kind=etw\|building` / `financing=debt_free`). `summary.remainingDebtEuros` counts each MFH loan once. |
| `list_buildings` / `get_building` | MFH objects (one loan, units, garage spaces) |
| `create_building` / `update_building` | Create/patch an MFH. Never invent remaining debt. |
| `create_building_space` / `update_building_space` / `delete_building_space` | Garage/Stellplatz; `occupancyUnitId` = with-rented. Delete is permanent |
| `list_building_documents` | MFH trail (Kaufvertrag, Nutzungsänderung, Exposé) |
| `create_building_document` | Add a house file. Not a Wohnung lease |
| `download_building_document` | Download a building trail file |
| `get_unit` | One apartment (includes loanStatus, Grundschuld) |
| `update_unit` | Write sqm, rooms, rent, tenant, loanStatus… Snapshots first. Never invent remaining debt. |
| `get_unit_financing` | Suggestions from trail titles, loans, events |
| `apply_financing_suggestion` / `dismiss_financing_suggestion` | Apply a suggestion after the user confirms, or dismiss it |
| `extract_loan_from_docs` | Restschuld from Tilgungsplan PDF (`dryRun` first) |
| `list_unit_loans` / `create_unit_loan` | Multiple loans per unit |
| `list_unit_versions` | Version history |
| `restore_unit` | Revert a snapshot |
| `list_unit_documents` | Trail (HV, heating, tax, letters) |
| `create_unit_document` | Add a trail file (`contentBase64` or Drive file id). Revenue: `effectiveOn`, `rentEurosAfter`, `isCurrentLease` |
| `update_unit_document` | Fix trail title / date / category / rentEurosAfter |
| `schedule_rent_change` | Future cold-rent change (Mieterhöhung ab …) |
| `create_proof_of_revenue` | Bank pack (PDF + ZIP). `dryRun` first. Never invent rent |
| `download_unit_document` | Download a trail file |
| `list_unit_payments` | Bank-matched rent trail |
| `get_landlord_profile` | Stored letterhead (never invented) |
| `list_bank_transactions` | **Properties** rent bank ledger: Kontoauszug lines of a team space (`from`/`to` = `YYYY-MM`). Not the Financials books — see `list_book_transactions` |
| `get_valuation_worklist` / `set_unit_valuation` / `set_building_valuation` | Market-value research worklist and writes (`dryRun` first) |
| `create_nk_letter` | Server NK PDF |
| `list_nk_settlements` / `update_nk_settlement` | Tenant NK settlements |
| `list_property_visits` / `create_property_visit` / `update_property_visit` | Besichtigungsfahrten (never invent km) |

### Mail

| Tool | What it does |
|---|---|
| `list_mail_accounts` | Mailboxes (no passwords) |
| `search_mail` / `read_mail` | Search and read mail |
| `create_mail_draft` | Save a draft or reply in Drafts; the user sends it |
| `manage_mail` | Mark read/unread, flag, move to Trash or back to Inbox |
| `read_mail_thread` | The whole conversation a message belongs to |
| `read_mail_attachment` | Open or save a mail attachment |

### Agent memory

| Tool | What it does |
|---|---|
| `list_agent_notes` | Drive `/Agent` notes |
| `list_git_folders` | Drive folders that mirror a git repo |
| `list_skills` / `read_skill` | Mirrored `SKILL.md` files; read them with `read_file` |

### CRM

| Tool | What it does |
|---|---|
| `list_crm_boards` / `create_crm_board` | Boards in a space |
| `list_crm_records` / `create_crm_record` / `update_crm_record` | Contacts. Updates snapshot a version first |
| `list_crm_record_versions` / `restore_crm_record` | Record history and undo |
| `get_crm_stats` | Records, followers, by role / country / stage |
| `refresh_crm_x_profile` | Followers and country from the public X profile |

### Financials (USD books)

| Tool | What it does |
|---|---|
| `get_financials_book` | Chart of accounts, bank pots, coding rules |
| `list_book_transactions` | **Financials** bank lines (Mercury/Wise) with state and receipts. Not the Properties rent ledger — see `list_bank_transactions` |
| `import_bank_csv` | Import a Mercury/Wise CSV (idempotent, `dryRun`) |
| `categorize_transaction` / `exclude_transaction` / `set_transaction_rate` / `set_transaction_department` | Work the inbox |
| `upload_receipt` / `attach_receipt` / `detach_receipt` / `list_receipts` / `find_receipt_matches` | Receipts and invoices |
| `find_transfer_matches` / `post_transfer` | Transfers between own accounts |
| `unpost_transaction` / `reverse_journal` | Undo a posting / reverse a journal |
| `post_journal` / `list_journals` | Manual journals (permanent, `dryRun` first) and the general ledger |
| `get_trial_balance` / `get_report_pnl` / `get_pnl_by_department` / `get_report_bs` / `get_report_cash` | Reports |
| `list_departments` / `create_department` | Departments (classes) |

### Studio

| Tool | What it does |
|---|---|
| `list_studio_projects` | Productions, or the one production with its documents |
| `get_studio_document` / `update_studio_document` | Read and save a story / dialog document. Saves need `expectedUpdatedAt` + `reason`; stories are checked per scene (`sceneBase`, 409 `SCENE_CONFLICT`) |
| `list_studio_versions` | Saved versions of a document |
| `get_studio_scene` | One scene in reading order with the renders assigned to each block and line |
| `view_studio_render` | A render as a JPEG the model can see (`maxWidth` 256–2048) |

## Environment

| Var | Default | Description |
|---|---|---|
| `ACHI_API_TOKEN` | — | **Required.** `achi_pat_*` token. |
| `ACHI_API_URL` | `https://worker.achiapp.com` | Override for self-hosted or staging endpoints. |

## Read-size caps

- `read_file` and `read_file_text` return up to **1 MB** by default, **5 MB** hard cap. Use `rangeStart`/`rangeEnd` for windowed reads of larger files.
- For large videos/binaries, agents should typically request `read_thumbnail` for preview and call `read_file` only with a range.

## Permissions

The token grants the agent **whatever access you have** — personal files plus every team you're a member of. There's no per-folder scoping. Revoke the token at any time from Settings → AI.

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
| `scripts/smoke-test.mjs` | End-to-end /v1 API test against a deployed worker. Idempotent (cleans up after itself). |

## License

MIT
