// Creates the first Super Admin for a fresh database and prints a one-time activation link.
// Usage: node scripts/bootstrap-admin.mjs --name "Full Name" --email you@visionary-x.in --code VX-001 --origin https://crm.visionary-x.in > bootstrap.sql
// The SQL goes to stdout; the activation link goes to stderr (so it is not written into the SQL file).
import { createHash, randomBytes } from 'node:crypto'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []))
for (const k of ['name', 'email', 'code', 'origin']) {
  if (!args[k]) {
    console.error(`Missing --${k}`)
    process.exit(1)
  }
}
const q = (s) => `'${String(s).replaceAll("'", "''")}'`
const id = (p) => `${p}_${Date.now().toString(36)}${randomBytes(10).toString('hex')}`
const now = new Date().toISOString()
const userId = id('usr')
const token = randomBytes(32).toString('base64url')
const tokenHash = createHash('sha256').update(token).digest('hex')
const expires = new Date(Date.now() + 72 * 3600_000).toISOString()
const email = args.email.trim().toLowerCase()

console.log(`-- Bootstrap Super Admin (${email}). Fails safely if the email already exists.`)
console.log(`INSERT INTO users (id, email, name, status, avatar_color, created_at, updated_at) VALUES (${q(userId)}, ${q(email)}, ${q(args.name)}, 'invited', '#1F4D3A', ${q(now)}, ${q(now)});`)
console.log(`INSERT INTO employee_profiles (user_id, employee_code, designation, created_at, updated_at) VALUES (${q(userId)}, ${q(args.code)}, 'Founder', ${q(now)}, ${q(now)});`)
console.log(`INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (${q(userId)}, 'role_super_admin', ${q(now)});`)
console.log(`INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (${q(id('atk'))}, ${q(userId)}, 'activation', ${q(tokenHash)}, ${q(expires)}, ${q(now)});`)
console.log(`INSERT INTO activity_logs (id, category, actor_type, action, entity_type, entity_id, summary, created_at) VALUES (${q(id('act'))}, 'security', 'system', 'user.bootstrapped', 'user', ${q(userId)}, ${q(`Bootstrapped Super Admin ${email}`)}, ${q(now)});`)
console.error(`\nActivation link (valid 72 h, single use):\n${args.origin.replace(/\/$/, '')}/activate#token=${token}\n`)
