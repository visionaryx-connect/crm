#!/usr/bin/env bash
# Export the D1 database to a timestamped SQL file.
#   scripts/backup.sh            → remote (production) database
#   scripts/backup.sh --local    → local development database
#   ENV=staging scripts/backup.sh → a named wrangler environment
# Optionally copy the export to R2 for off-site retention: set BACKUP_BUCKET=<bucket-name>.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="--remote"; [[ "${1:-}" == "--local" ]] && TARGET="--local"
ENV_FLAG=""; [[ -n "${ENV:-}" ]] && ENV_FLAG="--env ${ENV}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="backups/visionaryx-ops-${STAMP}.sql"
mkdir -p backups
npx wrangler d1 export visionaryx-ops ${TARGET} ${ENV_FLAG} --output "${OUT}"
shasum -a 256 "${OUT}" > "${OUT}.sha256"
echo "Backup written: ${OUT} ($(wc -c < "${OUT}") bytes)"
if [[ -n "${BACKUP_BUCKET:-}" && "${TARGET}" == "--remote" ]]; then
  npx wrangler r2 object put "${BACKUP_BUCKET}/d1/$(basename "${OUT}")" --file "${OUT}" --remote
  echo "Copied to r2://${BACKUP_BUCKET}/d1/"
fi
