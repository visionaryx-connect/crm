# Visionary X — Company Operations System

One platform for Visionary X's clients, projects, tasks, people, calendar, HR and reporting, plus a passwordless client portal. Built on Cloudflare Workers (Hono), D1, Durable Objects (WebSockets) and optional R2, with a React + TypeScript front end.

| | |
|---|---|
| Internal workspace | `/` — staff only, session + RBAC (+ optional MFA) |
| Client portal | `/portal/access#t=…` — passwordless, scoped, revocable links |
| API | `/api/*` — REST, every request authorised server-side |
| Live updates | `/ws/staff`, `/ws/portal` — authenticated WebSockets via a Durable Object |

## Quick start (local development)

Requirements: Node.js 22.18+ (Node 24 recommended), npm 11.

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars   # then fill SESSION_SECRET and DATA_KEY (see docs/ENVIRONMENT.md)
```

```bash
npm run db:reset:local           # applies migrations + loads clearly-marked sample data
```

```bash
npm run dev                      # http://localhost:5173 (Vite + the Worker running in workerd)
```

Sample accounts are listed when the seed runs; they all use `@sample.visionary-x.test` emails and the password defined as `SEED_PASSWORD` in [`scripts/seed.mjs`](scripts/seed.mjs). Two-factor authentication is optional: each user can turn it on under Account, and an administrator can require it for any role. Every sample record carries `is_seed = 1` and shows a **Sample** tag in the UI.

Other commands:

```bash
npm test                 # 63 Worker-runtime tests (auth, RBAC, isolation, realtime, workflows, reports)
npm run typecheck        # app + worker + config
npm run build            # production bundle (dist/)
scripts/backup.sh --local && scripts/restore-drill.sh "$(ls -t backups/*.sql | head -1)" --compare-local
```

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Cloudflare setup, environments, CI, custom domain, free-tier limits
- [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) — variables and secrets for development, staging and production
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, controls, what is and isn't covered
- [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md) — backups, point-in-time recovery, tested restore drill
- [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md) — progress, health, review workflow, reporting periods, holidays, attendance
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — code layout, data model, realtime design

## What is implemented

**Foundation** — D1 schema with 40+ normalised tables, FKs, indexes, CHECK constraints and versioned migrations; role/permission tables with a configurable matrix (6 system roles, custom roles); server-managed sessions (HttpOnly cookies, idle + absolute expiry, rotation on MFA); optional TOTP MFA with recovery codes (can be required per role); CSRF tokens + Origin checks; login lockout and D1-backed rate limiting; activity/security/admin audit log; account activation and admin-verified password reset via one-time links; session listing and revocation.

**CRM** — clients with references, contacts, services, account managers, relationship history (meetings, calls, requirements, notes), duplicate detection, archive/restore, pending feedback and approvals, portal-link management.

**Projects** — references (`VX-YYYY-NNN`), members with project roles and delegated review authority, milestones with weights and dependencies (cycle-checked), status history, derived progress (equal/effort/milestone) with snapshots, separate delivery-health assessment, duplication, closure gate (all tasks done + deliverables approved), client-visible updates, internal updates, activity history, board / list / timeline views.

**Tasks** — responsible + additional assignees, priority, dates, estimates, complexity weight, subtasks, dependencies (cycle-checked, block start/submit), internal comments, time logging, attachments, submission → approve / request-revision workflow with full history, self-approval prevention, blocked reasons, reassignment, bulk operations, change log.

**Deliverables & files** — private R2 storage with random keys, type allow-list + magic-byte checks, 25 MB limit, authorised streaming downloads, version history, internal review → approval → explicit share to client → client approve/request changes, soft delete with 30-day retention purge.

**Realtime** — one Durable Object hub using the WebSocket Hibernation API; all 15 required event types plus portal-namespaced events; per-socket authorisation at subscribe and delivery time, session re-validation, revocation-driven disconnects, size and rate limits, client de-duplication and full refetch on reconnect.

**Calendar & holidays** — month/week/day/agenda views, meetings with attendees, RRULE recurrence, reminders field, conflict warnings (meetings, leave, holidays), department/project filters, member availability API, project deadlines/milestones/task due dates, leave and holidays overlay; holiday register with official-source field and **verify before use**, CSV/JSON import, ICS export, working-day overrides; working week and alternate-Saturday rule in settings.

**HR** — employee profiles with sensitive-field protection, departments, skills, capacity; leave types, balances, holiday-aware day counting, overlap and balance checks, manager/HR approval; check-in/out, monthly sheets that never mark weekends/holidays absent, correction requests with approval, audited manual edits, CSV export; workload views by person and department.

**Reports** — company, project, member and client reports for any month or custom range, defined period rules, history-based "as of" values, charts, CSV export, print-to-PDF layout, saved snapshots and automatic month-end snapshots (cron).

**Client portal** — fragment-based link exchange, short-lived Strict cookie session, scope enforcement on every query, step-up email verification before approvals, feedback/revision requests, shared deliverable downloads, client-facing history, live updates.

## Known limitations (read before going live)

- **Password hashing uses PBKDF2-SHA256 (100,000 iterations), not Argon2id.** Workers' WebCrypto has no Argon2, and a WASM Argon2id at recommended cost exceeds the free plan's CPU budget. The hash format is versioned for a later upgrade. See docs/SECURITY.md.
- **CPU limits:** a sign-in (PBKDF2) and large reports can exceed the Workers **free** plan's 10 ms CPU per request. The **Workers Paid** plan (US$5/month) is recommended for production; everything else fits free-tier quotas at company scale.
- **No email/WhatsApp delivery** is wired up. Notifications are in-app (and live). Password-reset requests notify administrators, who verify the person and issue a one-time link. Activation/reset links are shown to the administrator to send.
- **No malware scanning** of uploads (not available on Cloudflare's free tier). Mitigations: allow-list, magic-byte check, forced download, sandbox CSP, private storage.
- **Holiday data must be verified each year.** The seed includes the 2026 Tamil Nadu list from G.O.(Ms) No. 708 (11 Nov 2025) as *pending verification* only; dates not confirmed in that notification (e.g. Deepavali, Vinayakar Chathurthi, Ayutha Pooja for 2026) were deliberately not seeded.
- **Reminder minutes** on calendar events are stored and displayed but no push reminder is sent at that time (the daily cron sends deadline/overdue notices).
- **Single realtime hub:** one Durable Object instance serves all sockets — ample for a company-sized team; shard by user/project if usage grows into thousands of concurrent connections.
- **Accessibility and responsiveness** were checked manually (keyboard navigation, focus rings, labels, 375 px layouts); no automated axe/visual-regression suite is included.
- Nothing here has been independently penetration-tested. Do not treat it as certified secure.
