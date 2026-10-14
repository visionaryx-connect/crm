import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { departmentSchema, employeeProfileSchema } from '@shared/schemas'
import { localDate } from '@shared/dates'
import { activity } from '../lib/audit'
import { readableProjectsFilter, canViewMember } from '../lib/authz'
import { newId } from '../lib/crypto'
import { diff, many, nowIso, one, patchColumns } from '../lib/db'
import { ApiError, body, clientIp, conflict, forbidden, notFound } from '../lib/http'
import { can, requirePermission, requireStaff } from '../lib/session'

const team = new Hono<AppBindings>()
team.use('*', requireStaff())

const SENSITIVE = ['personal_phone', 'personal_email', 'date_of_birth', 'address', 'emergency_contact_name', 'emergency_contact_phone'] as const

team.get('/members', requirePermission('team.read'), async (c) => {
  const a = c.get('auth')
  const includeInactive = c.req.query('all') === '1' && can(a, 'users.manage')
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT u.id, u.name, u.email, u.status, u.avatar_color, u.is_seed, ep.employee_code, ep.designation, ep.department_id, d.name AS department_name,
            ep.manager_user_id, m.name AS manager_name, ep.work_phone, ep.employment_status, ep.joining_date, ep.weekly_capacity_hours,
            (SELECT GROUP_CONCAT(skill, '|') FROM employee_skills s WHERE s.user_id = u.id) AS skills,
            (SELECT GROUP_CONCAT(r.name, '|') FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS role_names
       FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id LEFT JOIN departments d ON d.id = ep.department_id LEFT JOIN users m ON m.id = ep.manager_user_id
      WHERE ${includeInactive ? '1 = 1' : "u.status <> 'deactivated'"} ORDER BY u.name`,
  )
  return c.json({
    members: rows.map((r) => ({
      ...r,
      is_seed: Boolean(r.is_seed),
      skills: String(r.skills ?? '').split('|').filter(Boolean),
      roles: String(r.role_names ?? '').split('|').filter(Boolean),
    })),
  })
})

team.get('/members/:id', requirePermission('team.read'), async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const row = await one<Record<string, unknown>>(
    c.env.DB,
    `SELECT u.id, u.name, u.email, u.status, u.avatar_color, u.is_seed, u.created_at, ep.*, d.name AS department_name, m.name AS manager_name
       FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id LEFT JOIN departments d ON d.id = ep.department_id LEFT JOIN users m ON m.id = ep.manager_user_id
      WHERE u.id = ?`,
    id,
  )
  if (!row) throw notFound('Member')
  const seeSensitive = a.userId === id || can(a, 'employees.read_sensitive')
  if (!seeSensitive) for (const k of SENSITIVE) delete row[k]
  const skills = (await many<{ skill: string }>(c.env.DB, 'SELECT skill FROM employee_skills WHERE user_id = ? ORDER BY skill', id)).map((s) => s.skill)
  const roles = await many<{ key: string; name: string }>(c.env.DB, 'SELECT r.key, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', id)
  const f = readableProjectsFilter(a)
  const projects = await many(
    c.env.DB,
    `SELECT p.id, p.reference, p.name, p.status, pm.role, pm.responsibility FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE pm.user_id = ? AND p.archived_at IS NULL AND ${f.sql} ORDER BY p.name`,
    id,
    ...f.params,
  )
  const canSeeWork = await canViewMember(c.env.DB, a, id)
  let work: unknown = null
  if (canSeeWork) {
    const today = localDate()
    work = await one(
      c.env.DB,
      `SELECT
         SUM(CASE WHEN t.status IN ('todo','backlog') THEN 1 ELSE 0 END) AS todo,
         SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN t.status = 'in_review' THEN 1 ELSE 0 END) AS in_review,
         SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
         SUM(CASE WHEN t.status NOT IN ('completed','cancelled') AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN t.status NOT IN ('completed','cancelled') THEN COALESCE(t.estimate_hours, 0) ELSE 0 END) AS open_estimate_hours
       FROM tasks t WHERE t.responsible_id = ?`,
      today,
      id,
    )
  }
  return c.json({
    member: { ...row, is_seed: Boolean(row.is_seed), skills, roles },
    projects,
    work,
    permissions: { seeSensitive, canEdit: can(a, 'employees.manage'), canEditSelf: a.userId === id, canSeeWork },
  })
})

team.patch('/members/:id', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const isHr = can(a, 'employees.manage')
  if (!isHr && a.userId !== id) throw forbidden()
  const input = await body(c, employeeProfileSchema)
  // Self-service may only update contact details; organisational fields require HR.
  const selfAllowed = new Set(['workPhone', 'personalPhone', 'personalEmail', 'address', 'emergencyContactName', 'emergencyContactPhone', 'skills'])
  if (!isHr) {
    const blocked = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined && !selfAllowed.has(k))
    if (blocked.length) throw forbidden(`Only HR can change: ${blocked.join(', ')}`)
  }
  const before = await one<Record<string, unknown>>(c.env.DB, 'SELECT * FROM employee_profiles WHERE user_id = ?', id)
  if (!before) throw notFound('Member')
  if (input.managerUserId && input.managerUserId === id) throw new ApiError(422, 'VALIDATION_FAILED', 'A person cannot report to themselves', { fields: { managerUserId: 'Choose someone else' } })
  const { sets, values } = patchColumns(input as Record<string, unknown>, {
    designation: 'designation', departmentId: 'department_id', managerUserId: 'manager_user_id', workPhone: 'work_phone', personalPhone: 'personal_phone',
    personalEmail: 'personal_email', dateOfBirth: 'date_of_birth', address: 'address', emergencyContactName: 'emergency_contact_name',
    emergencyContactPhone: 'emergency_contact_phone', joiningDate: 'joining_date', exitDate: 'exit_date', employmentType: 'employment_type',
    employmentStatus: 'employment_status', weeklyCapacityHours: 'weekly_capacity_hours',
  })
  const stmts: D1PreparedStatement[] = []
  const now = nowIso()
  if (sets.length) stmts.push(c.env.DB.prepare(`UPDATE employee_profiles SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ?`).bind(...values, now, id))
  if (input.name && isHr) stmts.push(c.env.DB.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').bind(input.name, now, id))
  if (input.skills) {
    stmts.push(c.env.DB.prepare('DELETE FROM employee_skills WHERE user_id = ?').bind(id))
    for (const s of new Set(input.skills.map((x) => x.trim()).filter(Boolean))) stmts.push(c.env.DB.prepare('INSERT OR IGNORE INTO employee_skills (user_id, skill) VALUES (?, ?)').bind(id, s))
  }
  // Audit without recording sensitive values.
  const changed = Object.keys(diff(before, Object.fromEntries(sets.map((s, i) => [s.split(' = ')[0], values[i]]))))
  stmts.push(activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'employee.updated', entityType: 'user', entityId: id, summary: `Updated employee profile`, changes: { fields: changed.concat(input.skills ? ['skills'] : [], input.name ? ['name'] : []) }, ip: clientIp(c) }))
  await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

/**
 * Team workload. Not a performance ranking: shows open work weighted by estimate and complexity, review
 * queue, overdue and blocked items, capacity, and recent approved effort.
 */
team.get('/workload', async (c) => {
  const a = c.get('auth')
  const today = localDate()
  const seeAll = can(a, 'reports.company') || can(a, 'reports.team') || can(a, 'employees.manage')
  const scopeSql = seeAll
    ? `u.status = 'active'`
    : `u.status = 'active' AND (u.id = ? OR ep.manager_user_id = ? OR ep.department_id IN (SELECT id FROM departments WHERE head_user_id = ?))`
  const scopeParams = seeAll ? [] : [a.userId, a.userId, a.userId]
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT u.id, u.name, u.avatar_color, ep.designation, ep.department_id, d.name AS department_name, ep.weekly_capacity_hours,
       (SELECT COUNT(*) FROM tasks t WHERE t.responsible_id = u.id AND t.status IN ('backlog','todo','in_progress','blocked','in_review')) AS open_tasks,
       (SELECT COUNT(*) FROM tasks t WHERE t.responsible_id = u.id AND t.status = 'in_progress') AS in_progress,
       (SELECT COUNT(*) FROM tasks t WHERE t.responsible_id = u.id AND t.status = 'in_review') AS awaiting_review,
       (SELECT COUNT(*) FROM tasks t WHERE t.responsible_id = u.id AND t.status = 'blocked') AS blocked,
       (SELECT COUNT(*) FROM tasks t WHERE t.responsible_id = u.id AND t.status NOT IN ('completed','cancelled') AND t.due_date < ?) AS overdue,
       (SELECT COUNT(*) FROM tasks t WHERE t.responsible_id = u.id AND t.status NOT IN ('completed','cancelled') AND t.due_date BETWEEN ? AND date(?, '+7 days')) AS due_this_week,
       (SELECT COALESCE(SUM(t.estimate_hours), 0) FROM tasks t WHERE t.responsible_id = u.id AND t.status NOT IN ('completed','cancelled')) AS open_estimate_hours,
       (SELECT COALESCE(SUM(t.weight), 0) FROM tasks t WHERE t.responsible_id = u.id AND t.status NOT IN ('completed','cancelled')) AS open_weight,
       (SELECT COUNT(*) FROM tasks t WHERE t.responsible_id = u.id AND t.status NOT IN ('completed','cancelled') AND t.priority IN ('high','urgent')) AS high_priority,
       (SELECT COALESCE(SUM(te.minutes), 0) FROM time_entries te WHERE te.user_id = u.id AND te.work_date >= ?) AS minutes_30d
     FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id LEFT JOIN departments d ON d.id = ep.department_id
     WHERE ${scopeSql} ORDER BY d.name, u.name`,
    today, today, today, since, ...scopeParams,
  )
  const departments = new Map<string, { id: string | null; name: string; members: number; open_tasks: number; open_estimate_hours: number; overdue: number; blocked: number; capacity: number | null }>()
  for (const r of rows) {
    const key = String(r.department_id ?? 'none')
    const d = departments.get(key) ?? { id: (r.department_id as string) ?? null, name: (r.department_name as string) ?? 'No department', members: 0, open_tasks: 0, open_estimate_hours: 0, overdue: 0, blocked: 0, capacity: null }
    d.members++
    d.open_tasks += Number(r.open_tasks)
    d.open_estimate_hours += Number(r.open_estimate_hours)
    d.overdue += Number(r.overdue)
    d.blocked += Number(r.blocked)
    if (r.weekly_capacity_hours != null) d.capacity = (d.capacity ?? 0) + Number(r.weekly_capacity_hours)
    departments.set(key, d)
  }
  return c.json({ members: rows, departments: [...departments.values()], scope: seeAll ? 'company' : 'team' })
})

// ───────── Departments ─────────

team.get('/departments', requirePermission('team.read'), async (c) => {
  const rows = await many(
    c.env.DB,
    `SELECT d.*, h.name AS head_name, (SELECT COUNT(*) FROM employee_profiles ep JOIN users u ON u.id = ep.user_id WHERE ep.department_id = d.id AND u.status <> 'deactivated') AS member_count
       FROM departments d LEFT JOIN users h ON h.id = d.head_user_id WHERE d.archived_at IS NULL ORDER BY d.name`,
  )
  return c.json({ departments: rows })
})

team.post('/departments', requirePermission('departments.manage'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, departmentSchema)
  if (await one(c.env.DB, 'SELECT 1 AS x FROM departments WHERE name = ? OR code = ?', input.name, input.code)) throw conflict('A department with that name or code exists')
  const id = newId('dep')
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO departments (id, name, code, description, head_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, input.name, input.code.toUpperCase(), input.description, input.headUserId ?? null, now, now),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'department.created', entityType: 'department', entityId: id, summary: `Created department ${input.name}`, ip: clientIp(c) }),
  ])
  return c.json({ id }, 201)
})

team.put('/departments/:id', requirePermission('departments.manage'), async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const input = await body(c, departmentSchema)
  const before = await one<Record<string, unknown>>(c.env.DB, 'SELECT * FROM departments WHERE id = ?', id)
  if (!before) throw notFound('Department')
  if (await one(c.env.DB, 'SELECT 1 AS x FROM departments WHERE (name = ? OR code = ?) AND id <> ?', input.name, input.code, id)) throw conflict('A department with that name or code exists')
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE departments SET name = ?, code = ?, description = ?, head_user_id = ?, updated_at = ? WHERE id = ?').bind(input.name, input.code.toUpperCase(), input.description, input.headUserId ?? null, nowIso(), id),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'department.updated', entityType: 'department', entityId: id, summary: `Updated department ${input.name}`, changes: diff(before, { name: input.name, code: input.code.toUpperCase(), description: input.description, head_user_id: input.headUserId ?? null }), ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

team.delete('/departments/:id', requirePermission('departments.manage'), async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const dep = await one<{ name: string }>(c.env.DB, 'SELECT name FROM departments WHERE id = ? AND archived_at IS NULL', id)
  if (!dep) throw notFound('Department')
  const members = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM employee_profiles ep JOIN users u ON u.id = ep.user_id WHERE ep.department_id = ? AND u.status <> 'deactivated'`, id)
  if ((members?.n ?? 0) > 0) throw conflict('Move active members to another department before archiving')
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE departments SET archived_at = ?, updated_at = ? WHERE id = ?').bind(nowIso(), nowIso(), id),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'department.archived', entityType: 'department', entityId: id, summary: `Archived department ${dep.name}`, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

// ───────── Service categories ─────────

team.get('/service-categories', async (c) => {
  return c.json({ categories: await many(c.env.DB, 'SELECT id, name, active FROM service_categories WHERE active = 1 ORDER BY name') })
})

team.post('/service-categories', requirePermission('clients.manage', 'projects.create', 'settings.manage'), async (c) => {
  const { name } = await body(c, z.object({ name: z.string().trim().min(2).max(60) }))
  if (await one(c.env.DB, 'SELECT 1 AS x FROM service_categories WHERE name = ?', name)) throw conflict('That category already exists')
  const id = newId('svc')
  await c.env.DB.prepare('INSERT INTO service_categories (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, nowIso()).run()
  return c.json({ id }, 201)
})

export default team
