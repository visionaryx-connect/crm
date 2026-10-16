# Deploying Visionary X Operations to Cloudflare — step by step

This guide takes you from a fresh Cloudflare login to a live system at **https://crm.visionary-x.in**, with the first Super Admin signed in. It takes about 30–45 minutes the first time. Run every command from the project folder (`VisionaryX/CRM`) in a terminal.

The commands were checked against this project with Wrangler 4.151: the production build, a dry-run deploy, migrations and backup.

> **What gets created**
> - One Cloudflare Worker named `visionaryx-ops-production`. It serves the website, the `/api` and the live-update WebSockets, and runs a daily job at 08:00 IST.
> - One D1 database, `visionaryx-ops`.
> - One Durable Object for live updates, created automatically.
> - Optionally, one R2 bucket for files, `visionaryx-ops-files`.
> - The custom domain `crm.visionary-x.in`.

---

## Step 0 — Before you start

| You need | Why / how to check |
|---|---|
| Access to the **Cloudflare account that holds `visionary-x.in`** | The domain is already on Cloudflare (nameservers `ben`/`dorthy.ns.cloudflare.com`). The app must be deployed to that **same** account to use `crm.visionary-x.in`. |
| **Node.js 22.18+** (24 recommended) and npm | `node -v` |
| The project dependencies installed | `npm install` |
| A password manager entry for the secrets | You'll store two secrets and the backup location there. |
| *(Recommended)* **Workers Paid plan**, US$5/month | On the free plan each request gets only 10 ms of CPU time. Signing in (password hashing) and large reports can exceed that and fail with error 1102. Cloudflare dashboard → **Workers & Pages → Plans** → upgrade to Paid. |

Install the dependencies:

```bash
npm install
```

---

## Step 1 — Log Wrangler in to Cloudflare

```bash
npx wrangler login
```

A browser window opens; approve access. Then confirm you're on the right account:

```bash
npx wrangler whoami
```

If you have several accounts, note the **Account ID** of the one that owns `visionary-x.in`. If Wrangler asks you to pick an account later, pick that one.

---

## Step 2 — Create the production database (D1)

```bash
npx wrangler d1 create visionaryx-ops
```

Wrangler then asks **"Would you like Wrangler to add it on your behalf?" — answer `No`**. Saying yes adds the database to the local-development section under a different name and points your local dev server at the live database.

The output contains a block like `"database_id": "1a2b3c4d-…"`. Open **`wrangler.jsonc`**, find the **`env` → `production`** section, and replace `REPLACE_WITH_PRODUCTION_D1_ID` with that ID:

```jsonc
"production": {
  ...
  "d1_databases": [{ "binding": "DB", "database_name": "visionaryx-ops", "database_id": "PASTE-THE-ID-HERE", "migrations_dir": "migrations" }],
```

Leave the top-level (development) `database_id` of all zeros as it is; it's only used locally.

---

## Step 3 — File storage (R2): enable it, or switch it off

Uploads (task attachments, deliverables, client downloads) need R2. R2 has a free allowance (10 GB), but Cloudflare asks for a payment method before enabling it.

**Option A — use R2 (recommended):**
1. Cloudflare dashboard → **R2 Object Storage** → **Enable / Purchase R2** (add a payment method if asked).
2. Create the bucket:

```bash
npx wrangler r2 bucket create visionaryx-ops-files
```

**Option B — no file uploads for now:** in `wrangler.jsonc`, delete this line from the `env.production` section:

```jsonc
"r2_buckets": [{ "binding": "FILES", "bucket_name": "visionaryx-ops-files" }],
```

The app still works; upload buttons show "File storage (R2) is not configured".

---

## Step 4 — Confirm the web address

The app is configured for **`crm.visionary-x.in`**. In `wrangler.jsonc` → `env.production`, these two values must match exactly:

```jsonc
"vars": { "APP_ENV": "production", "APP_ORIGIN": "https://crm.visionary-x.in", ... },
"routes": [{ "pattern": "crm.visionary-x.in", "custom_domain": true }],
```

To use a different subdomain (for example `crm.visionary-x.in`), change it in **both** places. `APP_ORIGIN` is checked on every form submission and live connection, so a mismatch blocks saving.

In the Cloudflare dashboard → **visionary-x.in → DNS**, make sure there is **no existing record** named `crm` (or your chosen name). Cloudflare creates it automatically in Step 7 and refuses if one already exists. Your main website on `visionary-x.in` is not affected.

---

## Step 5 — Create the database tables

```bash
npx wrangler d1 migrations apply visionaryx-ops --remote --env production -c wrangler.jsonc
```

Type `y` when asked. You should see three migrations applied: `0001_core_schema`, `0002_access_control` and `0003_mfa_optional`. Check them:

```bash
npx wrangler d1 migrations list visionaryx-ops --remote --env production -c wrangler.jsonc
```

> **Never** run `npm run db:seed:local` or `scripts/seed.mjs` against production. That's sample data for development only.

---

## Step 6 — Build the production version

```bash
CLOUDFLARE_ENV=production npm run build
```

This type-checks everything and writes the website and Worker into `dist/` with the production settings.

(Windows PowerShell: `$env:CLOUDFLARE_ENV="production"; npm run build`)

Optional sanity check without changing anything live:

```bash
npx wrangler deploy --dry-run
```

It should list `REALTIME` (Durable Object), `DB` (D1), `FILES` (R2, if you kept it) and `APP_ENV ("production")`.

---

## Step 7 — Deploy

```bash
npx wrangler deploy
```

This uploads the Worker and website and creates the Durable Object, the daily 08:00 IST schedule and the `crm.visionary-x.in` domain with its HTTPS certificate. The certificate can take a few minutes the very first time.

---

## Step 8 — Add the two secrets

Generate fresh random values. Don't reuse your `.dev.vars` values.

```bash
node -e "const c=require('crypto');console.log('SESSION_SECRET='+c.randomBytes(32).toString('hex'));console.log('DATA_KEY='+c.randomBytes(32).toString('base64'))"
```

**Save both in your password manager first.** `DATA_KEY` encrypts two-factor secrets. If it's lost, everyone who uses two-factor has to set it up again.

Then set them on the live Worker. Each command asks you to paste the value:

```bash
npx wrangler secret put SESSION_SECRET --name visionaryx-ops-production
```

```bash
npx wrangler secret put DATA_KEY --name visionaryx-ops-production
```

Each `secret put` makes the new value live immediately. Wrangler prints a warning that "multiple environments are defined"; that is expected here, because `--name` already targets the production Worker. Never paste the generated values into chat, email or tickets.

---

## Step 9 — Check it's running

```bash
curl https://crm.visionary-x.in/api/health
```

Expected: `{"ok":true,"env":"production",…,"r2":true}` (`r2` is `false` if you chose Option B).

Open **https://crm.visionary-x.in** in a browser. You should see the dark Visionary X sign-in page.

---

## Step 10 — Create the first Super Admin (founder)

Generate a one-time setup file and activation link (replace the name, email and employee ID):

```bash
node scripts/bootstrap-admin.mjs --name "Your Full Name" --email you@visionary-x.in --code VX-001 --origin https://crm.visionary-x.in > bootstrap.sql
```

The terminal prints an **activation link**; copy it. Then load the file into the live database and delete it:

```bash
npx wrangler d1 execute visionaryx-ops --remote --env production -c wrangler.jsonc --file bootstrap.sql
```

```bash
rm bootstrap.sql
```

Open the activation link within 72 hours, choose a password (at least 12 characters), and sign in.

---

## Step 11 — First-day setup inside the app

As the Super Admin:

1. **Account (top-right menu) → Two-factor authentication → Set up.** Strongly recommended for the founder account. Store the recovery codes offline.
2. **Settings → Company:** company name, and the client support email and phone shown on the client portal.
3. **Settings → Working days:** working weekdays and the Saturday rule (for example, 2nd and 4th Saturday off), plus office hours.
4. **Settings → Holidays:** import this year's Government of India and Tamil Nadu lists (CSV or JSON), then **verify** each one against the official G.O. Unverified holidays don't affect leave or attendance.
5. **Settings → Automations:** leave all six on, or switch off any you don't want.
6. **Team → Departments:** add departments.
7. **Users & roles → Invite.** Each person gets a one-time activation link to send them. To make two-factor mandatory for admins, open **Roles & permissions**, edit the role, and tick *Require two-factor authentication*.
8. Add clients, then projects. **Workflow guide** in the sidebar explains the day-to-day flow.

---

## Step 12 — Backups (do this on day one)

Take a backup now and keep it somewhere safe and encrypted:

```bash
scripts/backup.sh
```

This writes `backups/visionaryx-ops-<date>.sql` plus a checksum. Repeat it on a regular schedule (for example every working day). D1 also keeps 7 days of point-in-time history on the free plan and 30 days on Workers Paid:

```bash
npx wrangler d1 time-travel info visionaryx-ops --env production -c wrangler.jsonc
```

Restore procedures and the tested restore drill are in [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md).

---

## Step 13 — Automatic deploys from GitHub (recommended)

After this, every push to `main` runs the tests, backs up the database, applies new migrations and deploys.

1. Create a **private** GitHub repository and push the project:

```bash
git remote add origin https://github.com/<your-org>/visionaryx-ops.git
```

```bash
git push -u origin main
```

2. Cloudflare dashboard → **My Profile → API Tokens → Create Token** → template **"Edit Cloudflare Workers"** → **Add more → Account → D1 → Edit** → limit it to your account → create, then copy the token.
3. In GitHub → repository **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2.
   - `CLOUDFLARE_ACCOUNT_ID`: from `npx wrangler whoami`.
4. In GitHub → **Settings → Environments**, create an environment called **`production`**. Optionally add yourself as a required reviewer so each deploy waits for your approval.
5. Make sure the `database_id` change from Step 2 is committed, then push. Watch it run under the **Actions** tab. The workflow is `.github/workflows/deploy.yml`.

The two secrets from Step 8 stay on Cloudflare; GitHub never needs them.

---

## Updating the live system later

With GitHub (Step 13), push to `main`. Done.

Manually:

```bash
scripts/backup.sh
```

```bash
npx wrangler d1 migrations apply visionaryx-ops --remote --env production -c wrangler.jsonc
```

```bash
CLOUDFLARE_ENV=production npm run build && npx wrangler deploy
```

## Rolling back a bad release

See recent versions, then roll back the code to the previous one:

```bash
npx wrangler deployments list --name visionaryx-ops-production
```

```bash
npx wrangler rollback --name visionaryx-ops-production
```

A code rollback doesn't undo database changes. For data, restore from a backup or D1 time travel ([BACKUP_RECOVERY.md](BACKUP_RECOVERY.md)).

---

## Optional — a staging copy for testing changes

Same steps with staging names: `npx wrangler d1 create visionaryx-ops-staging`. Then:
1. Put its ID in `env.staging`.
2. Create the bucket `visionaryx-ops-files-staging`.
3. Apply the migrations with `--env staging`.
4. Build with `CLOUDFLARE_ENV=staging`.
5. Set the secrets with `--name visionaryx-ops-staging`.

It runs at `crm-staging.visionary-x.in`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Error **1102** / "Worker exceeded CPU" on sign-in or reports | Free plan's 10 ms CPU limit | Upgrade to Workers Paid (Step 0) |
| Deploy fails: database `REPLACE_WITH_PRODUCTION_D1_ID` / D1 not found | Step 2 ID not pasted, or wrong account | Paste the ID into `env.production`; check `npx wrangler whoami` |
| Deploy fails on the custom domain | `visionary-x.in` isn't in this account, or an `ops` DNS record already exists | Deploy to the account that owns the zone; delete the existing `ops` record |
| Deploy fails mentioning R2 | R2 not enabled / bucket missing | Do Step 3 Option A, or remove `r2_buckets` (Option B) |
| "Security check failed" / "Cross-origin request rejected" when saving; Live indicator says Offline | `APP_ORIGIN` doesn't match the address in the browser | Make `APP_ORIGIN` and `routes` identical (Step 4), rebuild, redeploy |
| Two-factor setup fails with an error | `DATA_KEY` missing or not 32 bytes base64 | Redo Step 8 with the generator command |
| "That record already exists" running bootstrap | The admin email already exists | Use a password-reset link from Users & roles instead |
| Activation link "expired or already used" | Older than 72 h or already used | Run Step 10 again with a new email, or issue a new link from Users & roles |
| A `wrangler d1 …` command touches the wrong database | Wrangler switched to the generated config after a build | Always include `--env production -c wrangler.jsonc` as shown |

## What it costs

On **Workers Paid (US$5/month)**, a team of 10–30 people should stay inside the included usage for Workers, D1 and Durable Objects. R2 is free up to 10 GB of files. There are no other required charges.

Confirm current limits on Cloudflare's pricing pages. The full table is in [DEPLOYMENT.md](DEPLOYMENT.md#free-tier-fit-and-costs).
