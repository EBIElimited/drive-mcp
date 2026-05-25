#!/usr/bin/env bash
# One-shot deploy helper: runs the new migration + ships the worker.
#
# Prereqs:
#   - NILE_DIRECT_DB_URL  exported (Postgres connection string)
#   - wrangler logged in  (`wrangler login` first time)
#   - psql installed      (`brew install postgresql` if not)
#
# Usage:
#   ./scripts/deploy-helper.sh

set -euo pipefail

WORKER_REPO="${WORKER_REPO:-$HOME/Documents/GitHub/drive-worker}"
FRONTEND_REPO="${FRONTEND_REPO:-$HOME/Documents/GitHub/drive}"
MIGRATION="migrations/0007_api_token_wrapped_key.sql"

cd "$WORKER_REPO"

echo "→ Checking prereqs"
command -v psql >/dev/null || { echo "  psql not installed (brew install postgresql)"; exit 1; }
command -v wrangler >/dev/null || { echo "  wrangler not installed (npm i -g wrangler)"; exit 1; }
[[ -n "${NILE_DIRECT_DB_URL:-}" ]] || { echo "  NILE_DIRECT_DB_URL not set"; exit 1; }
[[ -f "$MIGRATION" ]] || { echo "  Migration $MIGRATION not found"; exit 1; }
echo "  ✓ psql + wrangler installed, env vars set"

echo "→ Running migration $MIGRATION"
psql "$NILE_DIRECT_DB_URL" -f "$MIGRATION"

echo "→ Deploying worker"
wrangler deploy

echo "→ Building frontend"
cd "$FRONTEND_REPO"
npm run build

echo ""
echo "✓ Done. Next:"
echo "  1. Mint a token: Settings → Developer API tokens → enable content access"
echo "  2. Run: ACHI_API_TOKEN=achi_pat_xxx node $HOME/Documents/GitHub/drive-mcp/scripts/smoke-test.mjs"
echo "  3. Replace REPLACE_WITH_YOUR_achi_pat_TOKEN in ~/Library/Application Support/Claude/claude_desktop_config.json"
echo "  4. Restart Claude Desktop"
