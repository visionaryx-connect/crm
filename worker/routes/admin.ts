import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings, StaffAuth } from '../env'
import { createUserSchema, roleSchema, updateUserRolesSchema } from '@shared/schemas'
import { ALL_PERMISSIONS } from '@shared/permissions'
import { activity } from '../lib/audit'
import { newId, randomToken, sha256Hex } from '../lib/crypto'
import { many, nowIso, one, placeholders } from '../lib/db'
import { ApiError, body, clientIp, conflict, forbidden, notFound, query } from '../lib/http'
import { requirePermission, requireStaff, revokeUserSessions } from '../lib/session'
import { getAllSettings, putSetting, SETTING_SCHEMAS, type SettingKey } from '../services/settings'
import { disconnect } from '../services/realtime'

const admin = new Hono<AppBindings>()
admin.use('*', requireStaff())

const AVATAR_COLORS = ['#1F4D3A', '#5B6B4E', '#8A7444', '#3E5C6B', '#6B4E5B', '#4E5B6B', '#2F3B35']

/** Lowest (most privileged) rank the actor holds. Users may only grant roles strictly below themselves, except super admins. */
function actorRank(a: StaffAuth) {
  return Math.min(...a.roles.map((r) => r.rank), 999)
}

async function assertGrantable(db: D1Database, a: StaffAuth, roleKeys: string[]) {
  const roles = await many<{ id: string; key: string; rank: number }>(db, `SELECT id, key, rank FROM roles WHERE key IN (${placeholders(roleKeys.length)})`, ...roleKeys)
  if (roles.length !== new Set(roleKeys).size) throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown role', { fields: { roleKeys: 'One or more roles do not exist' } })
  const mine = actorRank(a)
  const isSuper = a.roles.some((r) => r.key === 'super_admin')
  for (const r of roles) {
    if (!isSuper && r.rank <= mine) throw forbidden(`You cannot grant the ${r.key} role`)
  }
  return roles
}

async function activeSuperAdmins(db: D1Database, excludingUserId?: string) {
  const r = await one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE r.key = 'super_admin' AND u.status = 'active' AND u.id <> ?`,
    excludingUserId ?? '',
  )
  return r?.n ?? 0
}

async function issueToken(db: D1Database, userId: string, purpose: 'activation' | 'password_reset', createdBy: string, hours: number) {
  const token = randomToken(32)
  const now = new Date()
  await db.batch([
    db.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').bind(now.toISOString(), userId, purpose),
    db.prepare('INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(newId('atk'), userId, purpose, await sha256Hex(token), new Date(now.getTime() + hours * 3600_000).toISOString(), createdBy, now.toISOString()),
  ])
  return token
}

const linkFor = (origin: string, token: string, purpose: 'activation' | 'password_reset') =>
  `${origin}/${purpose === 'activation' ? 'activate' : 'reset-password'}#token=${token}`

// ───────── Users ─────────

admin.get('/users', requirePermission('users.manage', 'security.manage'), async (c) => {
  const users = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT u.id, u.name, u.email, u.status, u.mfa_enabled, u.last_login_at, u.locked_until, u.created_at, u.is_seed,
            ep.employee_code, ep.designation, d.name AS department_name,
            (SELECT GROUP_CONCAT(r.key) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS role_keys,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
       FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id LEFT JOIN departments d ON d.id = ep.department_id
      ORDER BY u.status = 'deactivated', u.name`,
    nowIso(),
  )
  return c.json({ users: users.map((u) => ({ ...u, mfa_enabled: Boolean(u.mfa_enabled), is_seed: Boolean(u.is_seed), roles: String(u.role_keys ?? '').split(',').filter(Boolean) })) })
})

admin.post('/users', requirePermission('users.manage'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, createUserSchema)
  const roles = await assertGrantable(c.env.DB, a, input.roleKeys)
  if (await one(c.env.DB, 'SELECT 1 AS x FROM users WHERE email = ?', input.email)) {
    throw new ApiError(409, 'CONFLICT', 'A user with that email already exists', { fields: { email: 'Already in use' } })
  }
  if (await one(c.env.DB, 'SELECT 1 AS x FROM employee_profiles WHERE employee_code = ?', input.employeeCode)) {
    throw new ApiError(409, 'CONFLICT', 'Employee ID already in use', { fields: { employeeCode: 'Already in use' } })
  }
  const id = newId('usr')
  const now = nowIso()
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users (id, email, name, status, avatar_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, input.email, input.name, 'invited', color, now, now),
    c.env.DB.prepare(
      `INSERT INTO employee_profiles (user_id, employee_code, designation, department_id, manager_user_id, joining_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, input.employeeCode, input.designation, input.departmentId ?? null, input.managerUserId ?? null, input.joiningDate ?? null, now, now),
    ...roles.map((r) => c.env.DB.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').bind(id, r.id, a.userId, now)),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'user.created', entityType: 'user', entityId: id, summary: `Invited ${input.name} (${input.email}) as ${input.roleKeys.join(', ')}`, ip: clientIp(c) }),
  ])
  const token = await issueToken(c.env.DB, id, 'activation', a.userId, 72)
  return c.json({ id, activationLink: linkFor(new URL(c.req.url).origin, token, 'activation'), expiresInHours: 72 }, 201)
})

admin.put('/users/:id/roles', requirePermission('users.manage'), async (c) => {
  const a = c.get('auth')
  const userId = c.req.param('id')
  const { roleKeys } = await body(c, updateUserRolesSchema)
  const target = await one<{ id: string; name: string }>(c.env.DB, 'SELECT id, name FROM users WHERE id = ?', userId)
  if (!target) throw notFound('User')
  if (userId === a.userId) throw forbidden('You cannot change your own roles')
  const current = await many<{ key: string; rank: number }>(c.env.DB, 'SELECT r.key, r.rank FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', userId)
  const isSuper = a.roles.some((r) => r.key === 'super_admin')
  if (!isSuper && current.some((r) => r.rank <= actorRank(a))) throw forbidden('You cannot modify a user with equal or higher privileges')
  if (current.some((r) => r.key === 'super_admin') && !roleKeys.includes('super_admin') && (await activeSuperAdmins(c.env.DB, userId)) === 0) {
    throw conflict('At least one active Super Admin must remain')
  }
  const roles = await assertGrantable(c.env.DB, a, roleKeys)
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(userId),
    ...roles.map((r) => c.env.DB.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').bind(userId, r.id, a.userId, now)),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'user.roles_changed', entityType: 'user', entityId: userId, summary: `Changed roles for ${target.name}`, changes: { from: current.map((r) => r.key), to: roleKeys }, ip: clientIp(c) }),
  ])
  // Force re-authentication so new privileges (and any MFA requirement) apply immediately.
  await revokeUserSessions(c.env, userId, 'roles_changed')
  disconnect(c.env, c.executionCtx, { userId })
  return c.json({ ok: true })
})

admin.post('/users/:id/status', requirePermission('users.manage'), async (c) => {
  const a = c.get('auth')
  const userId = c.req.param('id')
  const { status } = await body(c, z.object({ status: z.enum(['active', 'deactivated']) }))
  const target = await one<{ id: string; name: string; status: string; password_hash: string | null }>(c.env.DB, 'SELECT id, name, status, password_hash FROM users WHERE id = ?', userId)
  if (!target) throw notFound('User')
  if (userId === a.userId) throw forbidden('You cannot change your own account status')
  if (status === 'deactivated' && (await activeSuperAdmins(c.env.DB, userId)) === 0) {
    const isTargetSuper = await one(c.env.DB, `SELECT 1 AS x FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.key = 'super_admin'`, userId)
    if (isTargetSuper) throw conflict('At least one active Super Admin must remain')
  }
  if (status === 'active' && !target.password_hash) throw conflict('This user has not activated their account yet. Send a new activation link instead.')
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET status = ?, deactivated_at = ?, updated_at = ? WHERE id = ?').bind(status, status === 'deactivated' ? now : null, now, userId),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: status === 'deactivated' ? 'user.deactivated' : 'user.reactivated', entityType: 'user', entityId: userId, summary: `${status === 'deactivated' ? 'Deactivated' : 'Reactivated'} ${target.name}`, ip: clientIp(c) }),
  ])
  if (status === 'deactivated') {
    await revokeUserSessions(c.env, userId, 'deactivated')
    disconnect(c.env, c.executionCtx, { userId })
  }
  return c.json({ ok: true })
})

admin.post('/users/:id/link', requirePermission('users.manage'), async (c) => {
  const a = c.get('auth')
  const userId = c.req.param('id')
  const target = await one<{ id: string; name: string; status: string; password_hash: string | null }>(c.env.DB, 'SELECT id, name, status, password_hash FROM users WHERE id = ?', userId)
  if (!target) throw notFound('User')
  if (target.status === 'deactivated') throw conflict('Reactivate the account first')
  const purpose = target.password_hash ? 'password_reset' : 'activation'
  const token = await issueToken(c.env.DB, userId, purpose, a.userId, purpose === 'activation' ? 72 : 24)
  await activity(c.env.DB, { category: 'security', actorId: a.userId, action: `user.${purpose}_link_issued`, entityType: 'user', entityId: userId, summary: `Issued ${purpose === 'activation' ? 'activation' : 'password reset'} link for ${target.name}`, ip: clientIp(c) }).run()
  return c.json({ link: linkFor(new URL(c.req.url).origin, token, purpose), purpose, expiresInHours: purpose === 'activation' ? 72 : 24 })
})

admin.post('/users/:id/reset-mfa', requirePermission('security.manage'), async (c) => {
  const a = c.get('auth')
  const userId = c.req.param('id')
  if (userId === a.userId) throw forbidden('Use your own security settings to change MFA')
  const target = await one<{ name: string }>(c.env.DB, 'SELECT name FROM users WHERE id = ?', userId)
  if (!target) throw notFound('User')
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret_enc = NULL, mfa_pending_enc = NULL, mfa_last_step = NULL, updated_at = ? WHERE id = ?').bind(nowIso(), userId),
    c.env.DB.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').bind(userId),
    activity(c.env.DB, { category: 'security', actorId: a.userId, action: 'user.mfa_reset', entityType: 'user', entityId: userId, summary: `Reset two-factor authentication for ${target.name}`, ip: clientIp(c) }),
  ])
  await revokeUserSessions(c.env, userId, 'mfa_reset')
  disconnect(c.env, c.executionCtx, { userId })
  return c.json({ ok: true })
})

admin.post('/users/:id/revoke-sessions', requirePermission('security.manage'), async (c) => {
  const a = c.get('auth')
  const userId = c.req.param('id')
  await revokeUserSessions(c.env, userId, 'admin_revoked', userId === a.userId ? a.sessionId : undefined)
  await activity(c.env.DB, { category: 'security', actorId: a.userId, action: 'user.sessions_revoked', entityType: 'user', entityId: userId, summary: 'Revoked all sessions', ip: clientIp(c) }).run()
  disconnect(c.env, c.executionCtx, { userId })
  return c.json({ ok: true })
})

// ───────── Roles & permissions ─────────

admin.get('/roles', requirePermission('users.manage', 'roles.manage'), async (c) => {
  const roles = await many<{ id: string; key: string; name: string; description: string; is_system: number; requires_mfa: number; rank: number; user_count: number }>(
    c.env.DB,
    `SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count FROM roles r ORDER BY r.rank, r.name`,
  )
  const rp = await many<{ role_id: string; permission_key: string }>(c.env.DB, 'SELECT role_id, permission_key FROM role_permissions')
  const permissions = await many<{ key: string; label: string; category: string }>(c.env.DB, 'SELECT key, label, category FROM permissions ORDER BY category, key')
  return c.json({
    roles: roles.map((r) => ({ ...r, is_system: Boolean(r.is_system), requires_mfa: Boolean(r.requires_mfa), permissions: rp.filter((x) => x.role_id === r.id).map((x) => x.permission_key) })),
    permissions,
  })
})

async function writeRole(c: { env: AppBindings['Bindings'] }, a: StaffAuth, roleId: string | null, input: z.infer<typeof roleSchema>, ip: string | null) {
  const unknown = input.permissions.filter((p) => !(ALL_PERMISSIONS as string[]).includes(p))
  if (unknown.length) throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown permissions', { fields: { permissions: unknown.join(', ') } })
  const now = nowIso()
  const db = c.env.DB
  if (!roleId) {
    const id = newId('role')
    const key = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || id
    if (await one(db, 'SELECT 1 AS x FROM roles WHERE key = ?', key)) throw conflict('A role with that name already exists')
    await db.batch([
      db.prepare('INSERT INTO roles (id, key, name, description, is_system, requires_mfa, rank, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 60, ?, ?)').bind(id, key, input.name, input.description, input.requiresMfa ? 1 : 0, now, now),
      ...input.permissions.map((p) => db.prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)').bind(id, p)),
      activity(db, { category: 'admin', actorId: a.userId, action: 'role.created', entityType: 'role', entityId: id, summary: `Created role ${input.name}`, changes: { permissions: input.permissions }, ip }),
    ])
    return id
  }
  const role = await one<{ id: string; key: string; name: string }>(db, 'SELECT id, key, name FROM roles WHERE id = ?', roleId)
  if (!role) throw notFound('Role')
  if (role.key === 'super_admin') throw forbidden('The Super Admin role always has every permission')
  const before = (await many<{ permission_key: string }>(db, 'SELECT permission_key FROM role_permissions WHERE role_id = ?', roleId)).map((r) => r.permission_key)
  await db.batch([
    db.prepare('UPDATE roles SET name = ?, description = ?, requires_mfa = ?, updated_at = ? WHERE id = ?').bind(input.name, input.description, input.requiresMfa ? 1 : 0, now, roleId),
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(roleId),
    ...input.permissions.map((p) => db.prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)').bind(roleId, p)),
    activity(db, {
      category: 'admin', actorId: a.userId, action: 'role.updated', entityType: 'role', entityId: roleId, summary: `Updated role ${input.name}`,
      changes: { added: input.permissions.filter((p) => !before.includes(p)), removed: before.filter((p) => !input.permissions.includes(p)) }, ip,
    }),
  ])
  return roleId
}

admin.post('/roles', requirePermission('roles.manage'), async (c) => {
  const id = await writeRole(c, c.get('auth'), null, await body(c, roleSchema), clientIp(c))
  return c.json({ id }, 201)
})

admin.put('/roles/:id', requirePermission('roles.manage'), async (c) => {
  await writeRole(c, c.get('auth'), c.req.param('id'), await body(c, roleSchema), clientIp(c))
  return c.json({ ok: true })
})

admin.delete('/roles/:id', requirePermission('roles.manage'), async (c) => {
  const a = c.get('auth')
  const role = await one<{ id: string; name: string; is_system: number }>(c.env.DB, 'SELECT id, name, is_system FROM roles WHERE id = ?', c.req.param('id'))
  if (!role) throw notFound('Role')
  if (role.is_system) throw forbidden('System roles cannot be deleted')
  if (await one(c.env.DB, 'SELECT 1 AS x FROM user_roles WHERE role_id = ?', role.id)) throw conflict('Remove this role from all users first')
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM roles WHERE id = ?').bind(role.id),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'role.deleted', entityType: 'role', entityId: role.id, summary: `Deleted role ${role.name}`, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

// ───────── Audit & security ─────────

admin.get('/audit', requirePermission('audit.read'), async (c) => {
  const where: string[] = []
  const params: unknown[] = []
  const category = query(c, 'category')
  if (category) {
    where.push('l.category = ?')
    params.push(category)
  }
  const actor = query(c, 'actorId')
  if (actor) {
    where.push('l.actor_id = ?')
    params.push(actor)
  }
  const q = query(c, 'q')
  if (q) {
    where.push('(l.summary LIKE ? OR l.action LIKE ?)')
    params.push(`%${q}%`, `%${q}%`)
  }
  const before = query(c, 'before')
  if (before) {
    where.push('l.created_at < ?')
    params.push(before)
  }
  const from = query(c, 'from')
  if (from) {
    where.push('l.created_at >= ?')
    params.push(from)
  }
  const limit = 100
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT l.*, u.name AS actor_name FROM activity_logs l LEFT JOIN users u ON u.id = l.actor_id AND l.actor_type = 'user'
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.created_at DESC LIMIT ${limit + 1}`,
    ...params,
  )
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit).map((r) => ({ ...r, changes: r.changes ? JSON.parse(String(r.changes)) : null }))
  return c.json({ entries: page, nextBefore: hasMore ? rows[limit - 1]?.created_at : null })
})

admin.get('/sessions', requirePermission('security.manage'), async (c) => {
  const rows = await many(
    c.env.DB,
    `SELECT s.id, s.user_id, u.name, u.email, s.created_at, s.last_seen_at, s.ip, s.user_agent, s.mfa_state
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.revoked_at IS NULL AND s.expires_at > ? ORDER BY s.last_seen_at DESC LIMIT 200`,
    nowIso(),
  )
  const portal = await many(
    c.env.DB,
    `SELECT ps.id, ps.client_id, cl.name AS client_name, t.label, ps.created_at, ps.last_seen_at, ps.ip
       FROM portal_sessions ps JOIN clients cl ON cl.id = ps.client_id JOIN client_access_tokens t ON t.id = ps.access_token_id
      WHERE ps.revoked_at IS NULL AND ps.expires_at > ? ORDER BY ps.last_seen_at DESC LIMIT 200`,
    nowIso(),
  )
  return c.json({ staff: rows, portal })
})

// ───────── Settings ─────────

admin.get('/settings', requirePermission('settings.manage'), async (c) => c.json({ settings: await getAllSettings(c.env.DB) }))

admin.put('/settings/:key', requirePermission('settings.manage'), async (c) => {
  const a = c.get('auth')
  const key = c.req.param('key') as SettingKey
  const schema = SETTING_SCHEMAS[key]
  if (!schema) throw notFound('Setting')
  const value = await body(c, schema as z.ZodType<unknown>)
  await putSetting(c.env.DB, key, value, a.userId)
  await activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'settings.updated', entityType: 'setting', entityId: key, summary: `Updated setting ${key}`, changes: value, ip: clientIp(c) }).run()
  return c.json({ ok: true })
})

// ───────── Data export ─────────

const EXPORT_TABLES: Record<string, string> = {
  clients: 'SELECT * FROM clients',
  client_contacts: 'SELECT * FROM client_contacts',
  projects: 'SELECT * FROM projects',
  project_members: 'SELECT * FROM project_members',
  milestones: 'SELECT * FROM milestones',
  tasks: 'SELECT * FROM tasks',
  task_status_history: 'SELECT * FROM task_status_history',
  time_entries: 'SELECT * FROM time_entries',
  deliverables: 'SELECT * FROM deliverables',
  attachments: 'SELECT id, project_id, task_id, deliverable_id, version, file_name, content_type, size_bytes, sha256, client_visible, created_at, deleted_at FROM attachments',
  calendar_events: 'SELECT * FROM calendar_events',
  holidays: 'SELECT * FROM holidays',
  departments: 'SELECT * FROM departments',
  users: 'SELECT id, email, name, status, created_at, deactivated_at FROM users',
  employee_profiles: 'SELECT * FROM employee_profiles',
  leave_requests: 'SELECT * FROM leave_requests',
  attendance_records: 'SELECT * FROM attendance_records',
  client_feedback: 'SELECT * FROM client_feedback',
}

admin.get('/export', requirePermission('data.export'), async (c) => {
  const a = c.get('auth')
  const out: Record<string, unknown[]> = {}
  for (const [name, sql] of Object.entries(EXPORT_TABLES)) out[name] = await many(c.env.DB, sql)
  await activity(c.env.DB, { category: 'security', actorId: a.userId, action: 'data.exported', summary: 'Exported company data (JSON)', ip: clientIp(c) }).run()
  return new Response(JSON.stringify({ exportedAt: nowIso(), exportedBy: a.email, tables: out }, null, 1), {
    headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="visionaryx-export-${nowIso().slice(0, 10)}.json"`, 'cache-control': 'no-store' },
  })
})

export default admin
