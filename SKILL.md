# Achi

Use Achi as the user’s account: spaces, Drive, Properties, Mail, Agent notes, and tenant letters.

## Auth

```
ACHI_API_TOKEN=achi_pat_…     # Settings → AI, content access on
ACHI_API_URL=https://api.achi.cc   # optional
```

MCP: `npx -y github:EBIElimited/drive-mcp`

REST: `Authorization: Bearer achi_pat_…` against `/v1`.

The token sees **the same spaces and apps as the user**. Revoke it in Settings → AI.

## Do this

1. `whoami` then `list_teams`. Use `teamId` for Chi Ross / Elania.
2. Properties: `list_units` → `get_unit` → `update_unit` for empty fields (squareMeters, rooms, loanStatus). Always pass `versionReason`. Financing: `get_unit_financing` then `apply_financing_suggestion` only after the user confirms. Restschuld: `extract_loan_from_docs` with `dryRun` first. Never invent remaining debt. Filter: `list_units` `financing=debt_free`. Bad write: `list_unit_versions` then `restore_unit`. Trail: `list_unit_documents` → `create_unit_document` / `download_unit_document`. Wrong date/title: `update_unit_document`. Past tenant: occupancies with `leaseEnd`.
3. Rent paid truth: `list_unit_payments` / `list_bank_transactions`. Do not invent payments.
4. Letterhead: `get_landlord_profile`. Empty IBAN / Anschrift stay empty. Never invent them.
5. Mail: `list_mail_accounts` → `search_mail` → `read_mail`. No passwords.
6. Space memory: `list_agent_notes` then `read_file` on those ids.
7. NK letter: `create_nk_letter` with recoverable line items only. No Eigentümerkosten leftover, no Quellenangabe. Server compiles the PDF.

## Do not

- Invent legal names, street, IBAN, loan size, or rent paid.
- Put Secrets / passwords in letters or Agent notes.
- Use browser pdf.js for NK. Always `POST /v1/letters/nk` or `create_nk_letter`.
