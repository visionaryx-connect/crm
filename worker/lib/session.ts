import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppBindings, Env, StaffAuth } from '../env'
import { newId, randomToken, safeEqual, sha256Hex } from './crypto'
import { many, nowIso, one } from './db'
import { ApiError } from './http'

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000 // 12 h without activity
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days hard limit
export const MFA_PENDING_MS = 10 * 60 * 1000
const TOUCH_INTERVAL_MS = 5 * 60 * 1000

const isSecure = (env: Env) => env.APP_ENV !== 'development' && env.APP_ENV !== 'test'
export const staffCookieName = (env: Env) => (isSecure(env) ? '__Host-vx_sid' : 'vx_sid')
export const portalCookieName = (env: Env) => (isSecure(env) ? '__Host-vx_portal' : 'vx_portal')

export function setSessionCookie(c: Context<AppBindings>, name: string, token: string, maxAgeSeconds: number, sameSite: 'Lax' | 'Strict') {
  setCookie(c, name, token, {
    httpOnly: true,
    secure: isSecure(c.env),
    sameSite,
    path: '/',
    maxAge: maxAgeSeconds,
  })
}

export function clearCookie(c: Context<AppBindings>, name: string) {
  deleteCookie(c, name, { path: '/', secure: isSecure(c.env) })
}

interface SessionRow {
  id: string
  user_id: string
  csrf_token: string
  mfa_state: StaffAuth['mfaState']
  created_at: string
  last_seen_at: string
  expires_at: string
  revoked_at: string | null
  name: string
  email: string
  status: string
  mfa_enabled: number
}

export async function loadPermissions(db: D1Database, userId: string) {
  const roles = await many<{ key: string; name: string; rank: number; requires_mfa: number }>(
    db,
    `SELECT r.key, r.name, r.rank, r.requires_mfa FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.rank`,
    userId,
  )
  const perms = await many<{ permission_key: string }>(
    db,
    `SELECT DISTINCT rp.permission_key FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = ?`,
    userId,
  )
  return {
    roles: roles.map((r) => ({ key: r.key, name: r.name, rank: r.rank, requiresMfa: Boolean(r.requires_mfa) })),
    permissions: new Set(perms.map((p) => p.permission_key)),
  }
}

export type SessionLookup = { ok: true; auth: StaffAuth } | { ok: false; code: 'UNAUTHENTICATED' | 'SESSION_EXPIRED' }

/** Resolve a staff session from a raw cookie token. Used by HTTP middleware and the WebSocket upgrade. */
export async function resolveStaffSession(env: Env, token: string | undefined, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<SessionLookup> {
  if (!token || token.length > 128) return { ok: false, code: 'UNAUTHENTICATED' }
  const hash = await sha256Hex(token)
  const row = await one<SessionRow>(
    env.DB,
    `SELECT s.id, s.user_id, s.csrf_token, s.mfa_state, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
            u.name, u.email, u.status, u.mfa_enabled
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    hash,
  )
  if (!row) return { ok: false, code: 'UNAUTHENTICATED' }
  const now = Date.now()
  const idleLimit = row.mfa_state === 'pending' ? MFA_PENDING_MS : SESSION_IDLE_MS
  const expired =
    row.revoked_at != null ||
    now >= Date.parse(row.expires_at) ||
    now - Date.parse(row.last_seen_at) > idleLimit ||
    row.status !== 'active'
  if (expired) {
    if (!row.revoked_at) {
      const reason = row.status !== 'active' ? 'account_inactive' : 'expired'
      await env.DB.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?').bind(nowIso(), reason, row.id).run()
    }
    return { ok: false, code: 'SESSION_EXPIRED' }
  }
  if (now - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
    const p = env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(nowIso(), row.id).run()
    if (ctx) ctx.waitUntil(p)
    else await p
  }
  const { roles, permissions } = await loadPermissions(env.DB, row.user_id)
  const idleExpiry = Math.min(Date.parse(row.expires_at), now + idleLimit)
  return {
    ok: true,
    auth: {
      kind: 'staff',
      userId: row.user_id,
      name: row.name,
      email: row.email,
      sessionId: row.id,
      sessionHash: hash,
      csrfToken: row.csrf_token,
      expiresAt: new Date(idleExpiry).toISOString(),
      roles,
      permissions,
      mfaState: row.mfa_state,
      mfaEnabled: Boolean(row.mfa_enabled),
    },
  }
}

/** Create a session and set the cookie. Returns the CSRF token for the client. */
export async function createStaffSession(
  c: Context<AppBindings>,
  userId: string,
  mfaState: StaffAuth['mfaState'],
): Promise<{ csrfToken: string; sessionId: string }> {
  const token = randomToken(32)
  const csrfToken = randomToken(24)
  const id = newId('ses')
  const now = new Date()
  const expires = new Date(now.getTime() + SESSION_ABSOLUTE_MS)
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, csrf_token, mfa_state, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      await sha256Hex(token),
      userId,
      csrfToken,
      mfaState,
      now.toISOString(),
      now.toISOString(),
      expires.toISOString(),
      c.req.header('cf-connecting-ip') ?? null,
      (c.req.header('user-agent') ?? '').slice(0, 300),
    )
    .run()
  setSessionCookie(c, staffCookieName(c.env), token, SESSION_ABSOLUTE_MS / 1000, 'Lax')
  return { csrfToken, sessionId: id }
}

export async function revokeSession(env: Env, sessionId: string, reason: string) {
  await env.DB.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(nowIso(), reason, sessionId)
    .run()
}

export async function revokeUserSessions(env: Env, userId: string, reason: string, exceptSessionId?: string) {
  await env.DB.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?')
    .bind(nowIso(), reason, userId, exceptSessionId ?? '')
    .run()
}

/**
 * Requires a fully authenticated staff session. Mutating requests must also carry the session's CSRF
 * token in `X-CSRF-Token` and, when the browser sends one, a same-origin `Origin` header.
 */
export function requireStaff(opts: { allowMfaPending?: boolean; allowEnrolment?: boolean } = {}): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const result = await resolveStaffSession(c.env, getCookie(c, staffCookieName(c.env)), c.executionCtx)
    if (!result.ok) {
      throw new ApiError(401, result.code, result.code === 'SESSION_EXPIRED' ? 'Your session has expired. Please sign in again.' : 'Please sign in.')
    }
    const auth = result.auth
    if (auth.mfaState === 'pending' && !opts.allowMfaPending) throw new ApiError(401, 'MFA_REQUIRED', 'Enter your verification code to continue.')
    if (auth.mfaState === 'enrol_required' && !opts.allowEnrolment) {
      throw new ApiError(403, 'MFA_ENROLMENT_REQUIRED', 'Your role requires two-factor authentication. Set it up to continue.')
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) assertCsrf(c, auth.csrfToken)
    c.set('auth', auth)
    await next()
  }
}

export function assertSameOrigin(c: Context<AppBindings>) {
  const origin = c.req.header('origin')
  if (!origin) return
  const self = new URL(c.req.url).origin
  if (origin !== self && origin !== c.env.APP_ORIGIN) throw new ApiError(403, 'BAD_ORIGIN', 'Cross-origin request rejected')
}

export function assertCsrf(c: Context<AppBindings>, expected: string) {
  assertSameOrigin(c)
  const provided = c.req.header('x-csrf-token') ?? ''
  if (!provided || !safeEqual(provided, expected)) throw new ApiError(403, 'CSRF_FAILED', 'Security check failed. Refresh the page and try again.')
}

export function requirePermission(...perms: string[]): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = c.get('auth')
    if (!perms.some((p) => auth.permissions.has(p))) throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to do that')
    await next()
  }
}

export const can = (auth: StaffAuth, perm: string) => auth.permissions.has(perm)

export function assertCan(auth: StaffAuth, ...perms: string[]) {
  if (!perms.some((p) => auth.permissions.has(p))) throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to do that')
}
