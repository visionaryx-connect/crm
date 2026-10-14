import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { changePasswordSchema, forgotSchema, loginSchema, mfaCodeSchema, setPasswordSchema } from '@shared/schemas'
import { activity, logActivity } from '../lib/audit'
import { decryptSecret, encryptSecret, newId, randomBytes, sha256Hex } from '../lib/crypto'
import { many, nowIso, one } from '../lib/db'
import { ApiError, body, clientIp } from '../lib/http'
import { hashPassword, needsRehash, verifyPassword } from '../lib/password'
import { rateLimit } from '../lib/ratelimit'
import {
  assertSameOrigin, clearCookie, createStaffSession, loadPermissions, requireStaff, revokeSession, revokeUserSessions, staffCookieName,
} from '../lib/session'
import { generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp'
import { notify, usersWithPermission } from '../services/notify'
import { disconnect } from '../services/realtime'

const LOCK_THRESHOLD = 5
const LOCK_MINUTES = 15

interface UserRow {
  id: string
  email: string
  name: string
  password_hash: string | null
  status: string
  mfa_enabled: number
  mfa_secret_enc: string | null
  mfa_pending_enc: string | null
  mfa_last_step: number | null
  failed_login_count: number
  locked_until: string | null
}

const auth = new Hono<AppBindings>()

async function mfaStateFor(db: D1Database, user: UserRow): Promise<'none' | 'pending' | 'enrol_required'> {
  if (user.mfa_enabled) return 'pending'
  const { roles } = await loadPermissions(db, user.id)
  return roles.some((r) => r.requiresMfa) ? 'enrol_required' : 'none'
}

auth.post('/login', async (c) => {
  assertSameOrigin(c)
  const ip = clientIp(c) ?? 'unknown'
  const input = await body(c, loginSchema)
  await rateLimit(c.env.DB, `login:ip:${ip}`, 30, 15 * 60)
  await rateLimit(c.env.DB, `login:email:${input.email}`, 10, 15 * 60)

  const user = await one<UserRow>(c.env.DB, 'SELECT * FROM users WHERE email = ?', input.email)
  const generic = new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.')

  if (user?.locked_until && Date.parse(user.locked_until) > Date.now()) {
    await verifyPassword(input.password, null) // equalise timing
    await logActivity(c.env.DB, { category: 'security', actorId: user.id, action: 'auth.login_locked', entityType: 'user', entityId: user.id, summary: `Login attempt while locked: ${user.email}`, ip })
    throw new ApiError(429, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes or reset your password.`)
  }
  const ok = await verifyPassword(input.password, user?.password_hash ?? null)
  if (!user || !ok || user.status !== 'active') {
    if (user) {
      const failures = user.failed_login_count + 1
      const lock = failures >= LOCK_THRESHOLD ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?').bind(lock ? 0 : failures, lock, user.id),
        activity(c.env.DB, {
          category: 'security', actorId: user.id, action: lock ? 'auth.account_locked' : 'auth.login_failed', entityType: 'user', entityId: user.id,
          summary: lock ? `Account locked after ${LOCK_THRESHOLD} failed sign-ins` : `Failed sign-in for ${user.email}`, ip,
        }),
      ])
      if (lock) await notify(c.env, c.executionCtx, [{ userId: user.id, kind: 'security', title: 'Your account was temporarily locked', body: 'Several failed sign-in attempts were made. If this was not you, reset your password.' }])
    } else {
      await logActivity(c.env.DB, { category: 'security', actorType: 'system', action: 'auth.login_failed', summary: 'Failed sign-in for unknown email', ip })
    }
    if (user && ok && user.status !== 'active') throw new ApiError(403, 'ACCOUNT_INACTIVE', 'This account is not active. Contact an administrator.')
    throw generic
  }

  const mfaState = await mfaStateFor(c.env.DB, user)
  const updates = [
    c.env.DB.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').bind(nowIso(), user.id),
    activity(c.env.DB, { category: 'security', actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, summary: `Signed in${mfaState === 'pending' ? ' (awaiting MFA)' : ''}`, ip }),
  ]
  if (user.password_hash && needsRehash(user.password_hash)) {
    updates.push(c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(input.password), user.id))
  }
  await c.env.DB.batch(updates)
  const { csrfToken } = await createStaffSession(c, user.id, mfaState)
  return c.json({ mfa: mfaState === 'pending' ? 'required' : mfaState === 'enrol_required' ? 'enrol' : null, csrfToken })
})

auth.get('/me', requireStaff({ allowMfaPending: true, allowEnrolment: true }), async (c) => {
  const a = c.get('auth')
  const profile = await one<{ designation: string; department_id: string | null; employee_code: string; avatar_color: string | null }>(
    c.env.DB,
    `SELECT ep.designation, ep.department_id, ep.employee_code, u.avatar_color FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id WHERE u.id = ?`,
    a.userId,
  )
  return c.json({
    user: { id: a.userId, name: a.name, email: a.email, designation: profile?.designation ?? '', departmentId: profile?.department_id ?? null, employeeCode: profile?.employee_code ?? null, avatarColor: profile?.avatar_color ?? null },
    roles: a.roles,
    permissions: [...a.permissions].sort(),
    csrfToken: a.csrfToken,
    mfaState: a.mfaState,
    mfaEnabled: a.mfaEnabled,
    expiresAt: a.expiresAt,
  })
})

auth.post('/logout', requireStaff({ allowMfaPending: true, allowEnrolment: true }), async (c) => {
  const a = c.get('auth')
  await revokeSession(c.env, a.sessionId, 'logout')
  await logActivity(c.env.DB, { category: 'security', actorId: a.userId, action: 'auth.logout', summary: 'Signed out', ip: clientIp(c) })
  clearCookie(c, staffCookieName(c.env))
  disconnect(c.env, c.executionCtx, { sessionHash: a.sessionHash })
  return c.json({ ok: true })
})

/** Second factor. Rotates the session token on success to prevent fixation. */
auth.post('/mfa/verify', requireStaff({ allowMfaPending: true }), async (c) => {
  const a = c.get('auth')
  if (a.mfaState !== 'pending') throw new ApiError(400, 'MFA_NOT_PENDING', 'No verification is pending.')
  await rateLimit(c.env.DB, `mfa:${a.userId}`, 8, 10 * 60)
  const { code } = await body(c, mfaCodeSchema)
  const user = await one<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', a.userId)
  if (!user?.mfa_secret_enc) throw new ApiError(400, 'MFA_NOT_ENABLED', 'Two-factor authentication is not set up.')
  let method: 'totp' | 'recovery' | null = null
  const updates: D1PreparedStatement[] = []
  if (/^\d{6}$/.test(code)) {
    const step = await verifyTotp(await decryptSecret(c.env.DATA_KEY, user.mfa_secret_enc), code, user.mfa_last_step)
    if (step != null) {
      method = 'totp'
      updates.push(c.env.DB.prepare('UPDATE users SET mfa_last_step = ? WHERE id = ?').bind(step, user.id))
    }
  } else {
    const hash = await sha256Hex(code.toLowerCase())
    const rc = await one<{ id: string }>(c.env.DB, 'SELECT id FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', user.id, hash)
    if (rc) {
      method = 'recovery'
      updates.push(c.env.DB.prepare('UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ?').bind(nowIso(), rc.id))
    }
  }
  if (!method) {
    await logActivity(c.env.DB, { category: 'security', actorId: a.userId, action: 'auth.mfa_failed', summary: 'Incorrect verification code', ip: clientIp(c) })
    throw new ApiError(401, 'MFA_INVALID', 'That code is not valid. Check your authenticator app and try again.')
  }
  updates.push(activity(c.env.DB, { category: 'security', actorId: a.userId, action: 'auth.mfa_verified', summary: method === 'recovery' ? 'Verified with a recovery code' : 'Verified second factor', ip: clientIp(c) }))
  await c.env.DB.batch(updates)
  await revokeSession(c.env, a.sessionId, 'mfa_rotated')
  const { csrfToken } = await createStaffSession(c, a.userId, 'verified')
  if (method === 'recovery') {
    await notify(c.env, c.executionCtx, [{ userId: a.userId, kind: 'security', title: 'A recovery code was used to sign in', body: 'If this was not you, contact an administrator immediately.' }])
  }
  return c.json({ ok: true, csrfToken })
})

auth.post('/mfa/setup', requireStaff({ allowEnrolment: true }), async (c) => {
  const a = c.get('auth')
  if (a.mfaEnabled) throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already enabled.')
  const secret = generateTotpSecret()
  await c.env.DB.prepare('UPDATE users SET mfa_pending_enc = ?, updated_at = ? WHERE id = ?')
    .bind(await encryptSecret(c.env.DATA_KEY, secret), nowIso(), a.userId)
    .run()
  return c.json({ secret, otpauthUri: otpauthUri(secret, a.email) })
})

function recoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(10)
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length])
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`
}

auth.post('/mfa/enable', requireStaff({ allowEnrolment: true }), async (c) => {
  const a = c.get('auth')
  await rateLimit(c.env.DB, `mfa-enable:${a.userId}`, 10, 10 * 60)
  const { code } = await body(c, mfaCodeSchema)
  const user = await one<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', a.userId)
  if (!user?.mfa_pending_enc) throw new ApiError(400, 'MFA_SETUP_MISSING', 'Start setup first.')
  const secret = await decryptSecret(c.env.DATA_KEY, user.mfa_pending_enc)
  const step = await verifyTotp(secret, code, null)
  if (step == null) throw new ApiError(401, 'MFA_INVALID', 'That code is not valid. Make sure your device clock is correct.')
  const codes = Array.from({ length: 10 }, recoveryCode)
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret_enc = mfa_pending_enc, mfa_pending_enc = NULL, mfa_last_step = ?, updated_at = ? WHERE id = ?').bind(step, now, a.userId),
    c.env.DB.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').bind(a.userId),
    ...(await Promise.all(codes.map(async (rc) => c.env.DB.prepare('INSERT INTO mfa_recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)').bind(newId('rc'), a.userId, await sha256Hex(rc), now)))),
    activity(c.env.DB, { category: 'security', actorId: a.userId, action: 'auth.mfa_enabled', entityType: 'user', entityId: a.userId, summary: 'Enabled two-factor authentication', ip: clientIp(c) }),
  ])
  await revokeUserSessions(c.env, a.userId, 'mfa_enabled')
  const { csrfToken } = await createStaffSession(c, a.userId, 'verified')
  return c.json({ recoveryCodes: codes, csrfToken })
})

auth.post('/mfa/disable', requireStaff(), async (c) => {
  const a = c.get('auth')
  if (a.roles.some((r) => r.requiresMfa)) throw new ApiError(403, 'MFA_REQUIRED_BY_ROLE', 'Your role requires two-factor authentication.')
  const { code } = await body(c, mfaCodeSchema)
  const user = await one<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', a.userId)
  if (!user?.mfa_secret_enc) throw new ApiError(400, 'MFA_NOT_ENABLED', 'Two-factor authentication is not enabled.')
  const step = await verifyTotp(await decryptSecret(c.env.DATA_KEY, user.mfa_secret_enc), code, user.mfa_last_step)
  if (step == null) throw new ApiError(401, 'MFA_INVALID', 'That code is not valid.')
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL, mfa_last_step = NULL, updated_at = ? WHERE id = ?').bind(nowIso(), a.userId),
    c.env.DB.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').bind(a.userId),
    activity(c.env.DB, { category: 'security', actorId: a.userId, action: 'auth.mfa_disabled', summary: 'Disabled two-factor authentication', ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

auth.post('/password/change', requireStaff(), async (c) => {
  const a = c.get('auth')
  await rateLimit(c.env.DB, `pwchange:${a.userId}`, 5, 15 * 60)
  const input = await body(c, changePasswordSchema)
  const user = await one<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', a.userId)
  if (!user || !(await verifyPassword(input.currentPassword, user.password_hash))) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Current password is incorrect', { fields: { currentPassword: 'Current password is incorrect' } })
  }
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?').bind(await hashPassword(input.newPassword), now, now, a.userId),
    activity(c.env.DB, { category: 'security', actorId: a.userId, action: 'auth.password_changed', summary: 'Changed password; other sessions signed out', ip: clientIp(c) }),
  ])
  await revokeUserSessions(c.env, a.userId, 'password_changed', a.sessionId)
  return c.json({ ok: true })
})

/**
 * Self-service recovery request. Always answers the same way so it cannot be used to discover accounts.
 * Without a configured email provider, administrators are notified in-app and issue a one-time reset link.
 */
auth.post('/password/forgot', async (c) => {
  assertSameOrigin(c)
  await rateLimit(c.env.DB, `forgot:ip:${clientIp(c) ?? 'unknown'}`, 5, 60 * 60)
  const { email } = await body(c, forgotSchema)
  const user = await one<{ id: string; name: string; status: string }>(c.env.DB, 'SELECT id, name, status FROM users WHERE email = ?', email)
  if (user && user.status === 'active') {
    const admins = await usersWithPermission(c.env.DB, 'users.manage')
    await notify(c.env, c.executionCtx, admins.map((id) => ({
      userId: id, kind: 'security' as const, title: `Password reset requested by ${user.name}`, body: 'Verify the request with the person, then issue a reset link from Users.', link: `/admin/users?focus=${user.id}`,
      dedupeKey: `pwreset:${user.id}:${nowIso().slice(0, 13)}`,
    })))
    await logActivity(c.env.DB, { category: 'security', actorId: user.id, action: 'auth.reset_requested', entityType: 'user', entityId: user.id, summary: 'Requested a password reset', ip: clientIp(c) })
  }
  return c.json({ ok: true, message: 'If an active account exists for that email, an administrator has been notified to verify and send a reset link.' })
})

auth.get('/token/check', async (c) => {
  await rateLimit(c.env.DB, `tokencheck:${clientIp(c) ?? 'unknown'}`, 30, 15 * 60)
  const token = c.req.query('token') ?? ''
  if (token.length < 20 || token.length > 200) throw new ApiError(400, 'INVALID_TOKEN', 'This link is invalid.')
  const row = await one<{ purpose: string; expires_at: string; used_at: string | null; name: string; email: string }>(
    c.env.DB,
    'SELECT t.purpose, t.expires_at, t.used_at, u.name, u.email FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?',
    await sha256Hex(token),
  )
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) throw new ApiError(410, 'TOKEN_EXPIRED', 'This link has expired or was already used. Ask an administrator for a new one.')
  return c.json({ purpose: row.purpose, name: row.name, email: row.email })
})

auth.post('/password/reset', async (c) => {
  assertSameOrigin(c)
  await rateLimit(c.env.DB, `reset:${clientIp(c) ?? 'unknown'}`, 10, 15 * 60)
  const input = await body(c, setPasswordSchema)
  const hash = await sha256Hex(input.token)
  const row = await one<{ id: string; user_id: string; purpose: string; expires_at: string; used_at: string | null }>(
    c.env.DB,
    'SELECT id, user_id, purpose, expires_at, used_at FROM auth_tokens WHERE token_hash = ?',
    hash,
  )
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) throw new ApiError(400, 'TOKEN_EXPIRED', 'This link has expired or was already used.')
  const now = nowIso()
  const activation = row.purpose === 'activation'
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ?').bind(now, row.id),
    c.env.DB.prepare(
      `UPDATE users SET password_hash = ?, password_changed_at = ?, failed_login_count = 0, locked_until = NULL,
              status = CASE WHEN status = 'invited' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?`,
    ).bind(await hashPassword(input.password), now, now, row.user_id),
    c.env.DB.prepare(`UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).bind(now, row.user_id),
    activity(c.env.DB, { category: 'security', actorId: row.user_id, action: activation ? 'auth.account_activated' : 'auth.password_reset', entityType: 'user', entityId: row.user_id, summary: activation ? 'Activated account and set password' : 'Reset password via one-time link', ip: clientIp(c) }),
  ])
  await revokeUserSessions(c.env, row.user_id, 'password_reset')
  disconnect(c.env, c.executionCtx, { userId: row.user_id })
  return c.json({ ok: true })
})

auth.get('/sessions', requireStaff(), async (c) => {
  const a = c.get('auth')
  const rows = await many<{ id: string; created_at: string; last_seen_at: string; ip: string | null; user_agent: string | null }>(
    c.env.DB,
    `SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 20`,
    a.userId,
    nowIso(),
  )
  return c.json({ sessions: rows.map((r) => ({ ...r, current: r.id === a.sessionId })) })
})

auth.delete('/sessions/:id', requireStaff(), async (c) => {
  const a = c.get('auth')
  const s = await one<{ id: string; token_hash: string }>(c.env.DB, 'SELECT id, token_hash FROM sessions WHERE id = ? AND user_id = ?', c.req.param('id'), a.userId)
  if (!s) throw new ApiError(404, 'NOT_FOUND', 'Session not found')
  await revokeSession(c.env, s.id, 'user_revoked')
  await logActivity(c.env.DB, { category: 'security', actorId: a.userId, action: 'auth.session_revoked', summary: 'Signed out another session', ip: clientIp(c) })
  disconnect(c.env, c.executionCtx, { sessionHash: s.token_hash })
  return c.json({ ok: true })
})

export default auth
