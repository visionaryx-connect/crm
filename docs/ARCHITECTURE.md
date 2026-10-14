# Architecture

```
Browser (React SPA) ──HTTPS──► Cloudflare Worker (Hono)
   │   REST /api/*  ─────────────────┤  session/RBAC/CSRF middleware → route → D1 (db.batch for atomic writes)
   │                                  │                                  └─► publish(events) ─► RealtimeHub (Durable Object)
   └── WebSocket /ws/staff|portal ───► upgrade: verify cookie + Origin ──────────────────────────► RealtimeHub
                                        Static assets (SPA) served by Workers Static Assets
Cron (08:00 IST) ─► reminders, housekeeping, R2 purge, month-end report snapshots
R2 (optional) ◄── uploads/downloads streamed through authorised Worker endpoints
```

## Code layout

| Path | Purpose |
|---|---|
| `migrations/` | Versioned D1 schema (`0001` core schema, `0002` permissions/roles/default settings — generated from `shared/permissions.ts` by `scripts/gen-access-sql.ts`) |
| `shared/` | Code used by both sides: constants, Zod request schemas, permission matrix, progress/health maths, IST date helpers, working-day rules, RRULE expansion |
| `worker/index.ts` | Hono app, security headers, error mapping, WebSocket upgrades, cron entry |
| `worker/lib/` | crypto, password hashing, TOTP, sessions & CSRF, resource authorisation, rate limiting, audit, HTTP helpers |
| `worker/routes/` | `auth`, `admin`, `team`, `clients`, `projects`, `tasks`, `files`, `calendar`, `hr`, `notifications`, `reports`, `dashboard`, `portal` |
| `worker/services/` | progress recalculation, notifications, realtime publishing, report builders, settings, scheduled jobs |
| `worker/do/RealtimeHub.ts` | Durable Object holding hibernatable WebSockets and enforcing delivery rules |
| `src/` | React app: `components/` (design system), `layout/` (shell, command palette), `pages/` (workspace + portal), `lib/` (API client, auth gate, realtime, formatting) |
| `tests/` | Vitest in the Workers runtime (`@cloudflare/vitest-plugin`) with real D1, R2 and Durable Objects |
| `scripts/` | seed, admin bootstrap, backup, restore drill, permission SQL generator |

## Data model (main tables)

Identity: `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `sessions`, `auth_tokens`, `mfa_recovery_codes`, `rate_limits`.
Organisation: `departments`, `employee_profiles`, `employee_skills`, `service_categories`.
CRM: `clients`, `client_contacts`, `client_service_categories`, `client_interactions`, `client_access_tokens`, `portal_sessions`, `client_feedback`.
Delivery: `projects`, `project_members`, `project_status_history`, `project_progress_snapshots`, `project_updates`, `milestones`, `milestone_dependencies`, `tasks`, `task_assignees`, `subtasks`, `task_dependencies`, `task_status_history`, `task_submissions`, `time_entries`, `comments`, `deliverables`, `attachments`.
Time & people: `calendar_events`, `event_attendees`, `holidays`, `working_day_overrides`, `leave_types`, `leave_balances`, `leave_requests`, `attendance_records`, `attendance_corrections`.
Platform: `notifications`, `notification_preferences`, `activity_logs`, `report_snapshots`, `company_settings`.

Conventions: opaque TEXT ids with type prefixes; UTC ISO timestamps (`*_at`); IST calendar dates (`*_date`); `is_seed` marks sample data; D1 enforces foreign keys; multi-statement writes use `db.batch()` (atomic).

## Realtime design

- One `RealtimeHub` instance (`idFromName('hub')`) using the WebSocket Hibernation API, so idle connections cost nothing.
- The Worker authenticates the upgrade and passes a trusted identity header; the DO is not internet-reachable.
- Rooms: `user:<id>`, `company`, `perm:<permission>`, `project:<id>` (requires read access, checked against D1 with a 60 s cache, and an explicit subscription), `portal:project:<id>` (portal sockets only).
- Routes **write to D1 first**, then publish small envelopes `{id, type, room, at, data}` via DO RPC inside `waitUntil`. Clients treat events as invalidation hints, re-read state over REST, de-duplicate by event id, and refetch everything after reconnecting.
- Sessions are re-validated every 2 minutes and on activity; revocations close sockets with code 4401.
