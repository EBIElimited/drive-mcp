# Achi

Use Achi as the user’s account: spaces, Drive, Properties, Mail, Agent notes, and tenant letters.

## Auth

```
ACHI_API_TOKEN=achi_pat_…     # Settings → AI, content access on
ACHI_API_URL=https://api.achi.cc   # optional
```

MCP: `npx -y @achi/drive-mcp`

REST: `Authorization: Bearer achi_pat_…` against `/v1`.

The token sees **the same spaces and apps as the user**. Revoke it in Settings → AI.

## Do this

1. `whoami` then `list_teams`. Use `teamId` for Chi Ross / Elania.
2. Properties: `list_units` → `get_unit` → `list_unit_documents` → `download_unit_document` for HV / heating / tax. Do not ask the user to re-attach trail files.
3. Rent paid truth: `list_unit_payments` / `list_bank_transactions`. Do not invent payments.
4. Letterhead: `get_landlord_profile`. Empty IBAN / Anschrift stay empty. Never invent them.
5. Mail: `list_mail_accounts` → `search_mail` → `read_mail`. No passwords.
6. Space memory: `list_agent_notes` then `read_file` on those ids.
7. NK letter: `create_nk_letter` with recoverable line items only. No Eigentümerkosten leftover, no Quellenangabe. Server compiles the PDF.

## Do not

- Invent legal names, street, IBAN, loan size, or rent paid.
- Put Secrets / passwords in letters or Agent notes.
- Use browser pdf.js for NK. Always `POST /v1/letters/nk` or `create_nk_letter`.
