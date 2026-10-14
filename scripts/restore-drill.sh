#!/usr/bin/env bash
# Recovery drill: restore a SQL export into a throwaway LOCAL database and compare row counts with the source.
# Usage: scripts/restore-drill.sh backups/visionaryx-ops-<stamp>.sql [--compare-local]
# Never touches the remote database.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?usage: restore-drill.sh <export.sql> [--compare-local]}"
DRILL_STATE=".wrangler/restore-drill"
rm -rf "${DRILL_STATE}"
TABLES="users clients projects tasks task_status_history milestones calendar_events holidays leave_requests attendance_records activity_logs"
count_sql() { local q="SELECT"; local sep=""; for t in $TABLES; do q="${q}${sep} (SELECT COUNT(*) FROM ${t}) AS ${t}"; sep=","; done; echo "${q};"; }
echo "Restoring ${FILE} into a scratch database…"
npx wrangler d1 execute visionaryx-ops --local --persist-to "${DRILL_STATE}" --file "${FILE}" > /dev/null
RESTORED=$(npx wrangler d1 execute visionaryx-ops --local --persist-to "${DRILL_STATE}" --command "$(count_sql)" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s)[0].results[0])))')
echo "Restored row counts: ${RESTORED}"
FK=$(npx wrangler d1 execute visionaryx-ops --local --persist-to "${DRILL_STATE}" --command "PRAGMA foreign_key_check;" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].results.length))')
echo "Foreign-key violations after restore: ${FK}"
if [[ "${2:-}" == "--compare-local" ]]; then
  SOURCE=$(npx wrangler d1 execute visionaryx-ops --local --command "$(count_sql)" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s)[0].results[0])))')
  echo "Source row counts:   ${SOURCE}"
  if [[ "${SOURCE}" == "${RESTORED}" && "${FK}" == "0" ]]; then echo "RESTORE DRILL PASSED"; else echo "RESTORE DRILL FAILED"; exit 1; fi
fi
rm -rf "${DRILL_STATE}"
