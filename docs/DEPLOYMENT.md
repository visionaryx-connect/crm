# Deployment (Cloudflare)

> **New to this?** Follow the numbered walkthrough in [DEPLOY_STEP_BY_STEP.md](DEPLOY_STEP_BY_STEP.md). This page is the reference version.

The whole system is a single Worker that serves the built SPA as static assets, the `/api/*` REST API, the `/ws/*` WebSocket endpoints and a daily Cron Trigger. Bindings: D1 (`DB`), Durable Object (`REALTIME`), optional R2 (`FILES`).

## 1. One-time account setup

```bash
npx wrangler login
```

Create the resources (run once per environment; names match `wrangler.jsonc`):

```bash
npx wrangler d1 create visionaryx-ops
```

```bash
npx wrangler d1 create visionaryx-ops-staging
```

Paste each printed `database_id` into the matching `env.production` / `env.staging` block of `wrangler.jsonc` (replace `REPLACE_WITH_…_D1_ID`).

R2 is optional (file uploads are disabled with a clear message without it). Enabling R2 requires a payment method on the account even though the free allowance is usually enough:

```bash
npx wrangler r2 bucket create visionaryx-ops-files
```

```bash
npx wrangler r2 bucket create visionaryx-ops-files-staging
```

If you do not enable R2, delete the `r2_buckets` entries from the environments you deploy.

## 2. Secrets

Generate fresh values per environment — never reuse development values (see [ENVIRONMENT.md](ENVIRONMENT.md)):

```bash
npx wrangler secret put SESSION_SECRET --name visionaryx-ops-production
```

```bash
npx wrangler secret put DATA_KEY --name visionaryx-ops-production
```

`DATA_KEY` encrypts MFA secrets at rest. **Losing it means every MFA user must be reset**; store it in the company password manager. Rotating it requires re-enrolment (no automatic re-encryption is implemented).

## 3. Database migrations

```bash
npx wrangler d1 migrations apply visionaryx-ops --remote --env production -c wrangler.jsonc
```

Never run `scripts/seed.mjs` against production. Create the first Super Admin with the bootstrap command below, then invite everyone else from **Users & roles**.

### Bootstrapping the first Super Admin

Generate a one-time activation link for the founder (writes nothing but a user, a profile, the role and an activation token):

```bash
node scripts/bootstrap-admin.mjs --name "Founder Name" --email founder@visionary-x.in --code VX-001 --origin https://ops.visionary-x.in > bootstrap.sql
```

```bash
npx wrangler d1 execute visionaryx-ops --remote --env production -c wrangler.jsonc --file bootstrap.sql && rm bootstrap.sql
```

The command prints an activation link (valid 72 h). Open it and set a password. Two-factor authentication is optional; enabling it under Account is strongly recommended for the Super Admin.

## 4. Build and deploy

```bash
CLOUDFLARE_ENV=production npm run build
```

```bash
npx wrangler deploy
```

The Vite Cloudflare plugin writes the resolved environment config into `dist/`, so `wrangler deploy` deploys the right bindings, routes, vars and cron. Use `CLOUDFLARE_ENV=staging` for staging.

## 5. Custom domain

`routes` in each environment uses `custom_domain: true` for `ops.visionary-x.in` / `ops-staging.visionary-x.in`. The `visionary-x.in` zone must be on the same Cloudflare account; the certificate is issued automatically. Keep the marketing site on the apex domain and the application on the subdomain. After choosing the final hostname, update `APP_ORIGIN` to match exactly — WebSocket upgrades and mutating requests are rejected from any other origin.

Recommended zone settings: *Always Use HTTPS* on, minimum TLS 1.2, HSTS (already sent by `_headers`), and a WAF rate-limiting rule on `/api/auth/*` and `/api/portal/session` as a second layer above the app's own limiter.

## 6. CI/CD with GitHub

Either connect the repository in **Workers & Pages → your Worker → Settings → Builds** (Workers Builds; set build command `CLOUDFLARE_ENV=production npm run build` and deploy command `npx wrangler deploy`), or use the included GitHub Actions workflow `.github/workflows/deploy.yml`, which runs typecheck + tests on every push and deploys `main` to production after applying migrations. Add repository secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers" + D1 edit) and `CLOUDFLARE_ACCOUNT_ID`.

## 7. Post-deploy checklist

- `GET /api/health` returns `{ ok: true, env: "production", r2: true|false }`.
- Sign in as the Super Admin; enable MFA under Account (recommended) and store recovery codes offline.
- Settings → Company: set support email/phone shown on the client portal.
- Settings → Working days: confirm the weekly pattern and Saturday rule.
- Settings → Holidays: import the current year's Government of India and Tamil Nadu lists and **verify** each against the official notification.
- Invite staff. If you want MFA mandatory for a role, tick “Require two-factor authentication” on that role in Users & roles.
- Run `scripts/backup.sh` once and a restore drill (see BACKUP_RECOVERY.md).

## Free-tier fit and costs

Figures are Cloudflare's published limits at the time of writing — confirm on the Cloudflare pricing pages before relying on them.

| Service | Free allowance (approx.) | Expected use at ~10–30 staff | Notes |
|---|---|---|---|
| Workers requests | 100,000 / day | Low thousands / day | Static assets are served free and don't count against Worker requests in most cases. |
| Workers CPU | 10 ms / request (free) | PBKDF2 sign-in ≈ 30–60 ms | **Sign-in and large reports can exceed the free CPU limit.** Workers Paid (US$5/mo, 30 s CPU) is recommended for production. |
| D1 | 5 M rows read / day, 100 k rows written / day, 5 GB storage | Well under | Reports read more rows; still small at this scale. |
| D1 Time Travel | 7 days (free), 30 days (paid) | — | Point-in-time restore; see BACKUP_RECOVERY.md. |
| Durable Objects (SQLite) | 100 k requests / day, 13,000 GB-s / day | Small | Hibernation keeps idle sockets free of duration charges. Incoming WS messages are billed at 20:1. |
| R2 | 10 GB-month, 1 M Class A, 10 M Class B ops / month, free egress | Depends on files | Requires a payment method to enable. |
| Cron Triggers | 5 per account (free) | 1 used | |

Services that may incur charges: Workers Paid (recommended), R2 beyond 10 GB, D1 beyond free quotas, any email/SMS provider you add later.
