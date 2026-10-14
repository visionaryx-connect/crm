# Backup and recovery

## What needs protecting

| Data | Where | Protection |
|---|---|---|
| Business records | D1 (`DB`) | Time Travel (point-in-time), scheduled SQL exports, pre-deploy export in CI |
| Files & deliverables | R2 (`FILES`) | Soft delete + 30-day retention before purge; optional bucket replication / periodic copy |
| Realtime state | Durable Object | None needed — it holds only live connections; clients refetch from D1 |
| Secrets | Cloudflare secrets | Copies in the company password manager (`DATA_KEY` loss forces MFA re-enrolment) |

## 1. Point-in-time recovery (D1 Time Travel)

D1 keeps a change history (7 days on the free plan, 30 days on paid). To inspect or restore:

```bash
npx wrangler d1 time-travel info visionaryx-ops --env production
```

```bash
npx wrangler d1 time-travel restore visionaryx-ops --env production --timestamp 2026-10-14T09:00:00+05:30
```

A restore replaces the whole database. Take an export first (below) so the restore itself can be undone, and announce a short maintenance window — writes made after the timestamp are lost.

## 2. Logical backups (SQL export)

```bash
scripts/backup.sh
```

Writes `backups/visionaryx-ops-<UTC timestamp>.sql` plus a SHA-256 checksum. Set `BACKUP_BUCKET=<r2-bucket>` to copy it off-site to R2. Suggested schedule: daily during business weeks (e.g. from a scheduled GitHub Action or an operator's machine), keep 30 daily and 12 monthly copies. The CI deploy job also exports the database before every migration and keeps it as a build artifact for 30 days.

Exports contain personal data — store them encrypted and restrict access like the production database.

## 3. Restoring an export

Restores always go into a **new** database first, never over production directly:

```bash
npx wrangler d1 create visionaryx-ops-restore
```

```bash
npx wrangler d1 execute visionaryx-ops-restore --remote --file backups/visionaryx-ops-<stamp>.sql
```

Verify counts (step 4), then point the production environment's `database_id` at the restored database and redeploy, or copy specific rows back with targeted SQL.

## 4. Tested recovery drill

`scripts/restore-drill.sh` restores an export into a throwaway local database, runs `PRAGMA foreign_key_check`, and compares row counts of the core tables with the source:

```bash
scripts/backup.sh --local && scripts/restore-drill.sh "$(ls -t backups/*.sql | head -1)" --compare-local
```

This drill was run during development and **passed** (identical counts across users, clients, projects, tasks, status history, milestones, events, holidays, leave, attendance and audit tables; zero FK violations). The first run failed — the export created a table before the table it references — which led to reordering migration 0001 so exports restore in dependency order. Run the drill against a recent production export at least quarterly and after every schema migration; record the date and result.

## 5. Files (R2)

Deleted attachments are hidden immediately and purged by the daily job after 30 days, so accidental deletions can be undone within that window by clearing `deleted_at` on the `attachments` row. Files already shared with a client cannot be deleted. For disaster recovery of R2 itself, periodically mirror the bucket (`rclone` with R2's S3 API, or a second bucket) — Cloudflare does not version R2 objects by default.

## 6. Incident runbook (short)

1. Stop the damage: revoke affected sessions/portal links (Users & roles / client Portal access), or roll back the Worker (`npx wrangler rollback`).
2. Export the current state (`scripts/backup.sh`) before changing anything.
3. Decide: Time Travel restore (whole DB, recent) vs. export restore into a new DB and targeted copy-back.
4. Verify with the drill queries, then reopen access.
5. Record what happened in the audit log notes and review it.
