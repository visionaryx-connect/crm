import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { feedbackResponseSchema, milestoneSchema, projectMemberSchema, projectPatchSchema, projectSchema, projectUpdateSchema } from '@shared/schemas'
import { assessHealth } from '@shared/progress'
import { localDate } from '@shared/dates'
import { PROJECT_STATUS_LABEL, type ProjectStatus } from '@shared/constants'
import { activity } from '../lib/audit'
import { readableProjectsFilter, requireProject } from '../lib/authz'
import { newId } from '../lib/crypto'
import { diff, many, nowIso, one, patchColumns, placeholders } from '../lib/db'
import { ApiError, body, clientIp, conflict, forbidden, notFound, query } from '../lib/http'
import { requirePermission, requireStaff } from '../lib/session'
import { recalcProgress } from '../services/progress'
import { notify } from '../services/notify'
import { invalidateMembership, publish, rooms } from '../services/realtime'

const projects = new Hono<AppBindings>()
projects.use('*', requireStaff())

const OPEN = `('backlog','todo','in_progress','in_review','blocked')`

async function nextProjectReference(db: D1Database) {
  const year = new Date().getUTCFullYear()
  const r = await one<{ n: number }>(db, `SELECT COALESCE(MAX(CAST(SUBSTR(reference, 9) AS INTEGER)), 0) AS n FROM projects WHERE reference LIKE ?`, `VX-${year}-%`)
  return `VX-${year}-${String((r?.n ?? 0) + 1).padStart(3, '0')}`
}

function withHealth<T extends Record<string, unknown>>(p: T, today: string) {
  const { health, reasons } = assessHealth({
    status: String(p.status),
    progress: Number(p.progress),
    hasData: Number(p.total_tasks ?? 0) > 0,
    startDate: (p.start_date as string) ?? null,
    targetDate: (p.target_date as string) ?? null,
    today,
    overdueTasks: Number(p.overdue_tasks ?? 0),
    blockedTasks: Number(p.blocked_tasks ?? 0),
  })
  return { ...p, health, health_reasons: reasons, is_seed: Boolean(p.is_seed) }
}

projects.get('/', async (c) => {
  const a = c.get('auth')
  const today = localDate()
  const f = readableProjectsFilter(a)
  const where = [f.sql]
  const params: unknown[] = [...f.params]
  const status = query(c, 'status')
  if (status === 'archived') where.push('p.archived_at IS NOT NULL')
  else {
    where.push('p.archived_at IS NULL')
    if (status === 'active') where.push(`p.status NOT IN ('completed','archived')`)
    else if (status) {
      where.push('p.status = ?')
      params.push(status)
    }
  }
  for (const [key, col] of [['clientId', 'p.client_id'], ['managerId', 'p.manager_id'], ['serviceCategoryId', 'p.service_category_id']] as const) {
    const v = query(c, key)
    if (v) {
      where.push(`${col} = ?`)
      params.push(v)
    }
  }
  if (query(c, 'mine') === '1') {
    where.push('(p.manager_id = ? OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?))')
    params.push(a.userId, a.userId)
  }
  const q = query(c, 'q')
  if (q) {
    where.push('(p.name LIKE ? OR p.reference LIKE ? OR cl.name LIKE ?)')
    params.push(`%${q}%`, `%${q}%`, `%${q}%`)
  }
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT p.id, p.reference, p.name, p.status, p.priority, p.progress, p.progress_mode, p.start_date, p.target_date, p.completed_at, p.is_seed, p.updated_at,
            p.client_id, cl.name AS client_name, p.manager_id, u.name AS manager_name, sc.name AS service_category,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'cancelled') AS total_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS completed_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN ${OPEN} AND t.due_date < ?) AS overdue_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'blocked') AS blocked_tasks,
            (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS member_count
       FROM projects p JOIN clients cl ON cl.id = p.client_id LEFT JOIN users u ON u.id = p.manager_id LEFT JOIN service_categories sc ON sc.id = p.service_category_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE p.status WHEN 'completed' THEN 2 WHEN 'archived' THEN 3 ELSE 1 END, p.target_date IS NULL, p.target_date LIMIT 500`,
    today,
    ...params,
  )
  return c.json({ projects: rows.map((r) => withHealth(r, today)) })
})

projects.post('/', requirePermission('projects.create'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, projectSchema)
  const client = await one<{ name: string; archived_at: string | null }>(c.env.DB, 'SELECT name, archived_at FROM clients WHERE id = ?', input.clientId)
  if (!client) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a client', { fields: { clientId: 'Client not found' } })
  if (client.archived_at) throw conflict('Cannot create projects for an archived client')
  const managerId = input.managerId ?? a.userId
  if (managerId !== a.userId && !a.permissions.has('projects.manage_all')) throw forbidden('Only administrators can assign another project manager')
  const id = newId('prj')
  const reference = await nextProjectReference(c.env.DB)
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO projects (id, reference, name, client_id, manager_id, service_category_id, description, scope, start_date, target_date, status, priority, progress_mode, estimated_hours, client_status_note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, reference, input.name, input.clientId, managerId, input.serviceCategoryId ?? null, input.description, input.scope, input.startDate ?? null, input.targetDate ?? null, input.status, input.priority, input.progressMode, input.estimatedHours ?? null, input.clientStatusNote, a.userId, now, now),
    c.env.DB.prepare(`INSERT INTO project_members (project_id, user_id, role, can_review, responsibility, added_by, added_at) VALUES (?, ?, 'manager', 1, 'Project manager', ?, ?)`).bind(id, managerId, a.userId, now),
    c.env.DB.prepare('INSERT INTO project_status_history (id, project_id, from_status, to_status, note, changed_by, changed_at) VALUES (?, ?, NULL, ?, ?, ?, ?)').bind(newId('psh'), id, input.status, 'Project created', a.userId, now),
    c.env.DB.prepare('INSERT INTO project_progress_snapshots (id, project_id, progress, completed_units, total_units, recorded_at) VALUES (?, ?, 0, 0, 0, ?)').bind(newId('pps'), id, now),
    activity(c.env.DB, { actorId: a.userId, action: 'project.created', entityType: 'project', entityId: id, projectId: id, summary: `Created project ${reference} · ${input.name} for ${client.name}`, ip: clientIp(c) }),
  ])
  invalidateMembership(c.env, c.executionCtx, [managerId])
  publish(c.env, c.executionCtx, [{ type: 'project.updated', room: rooms.project(id), data: { projectId: id, created: true } }])
  return c.json({ id, reference }, 201)
})

projects.get('/:id', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const access = await requireProject(c.env.DB, a, id)
  const today = localDate()
  const project = await one<Record<string, unknown>>(
    c.env.DB,
    `SELECT p.*, cl.name AS client_name, cl.reference AS client_reference, u.name AS manager_name, sc.name AS service_category, ca.name AS closure_approved_by_name,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'cancelled') AS total_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN ${OPEN} AND t.due_date < ?) AS overdue_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'blocked') AS blocked_tasks
       FROM projects p JOIN clients cl ON cl.id = p.client_id LEFT JOIN users u ON u.id = p.manager_id
       LEFT JOIN service_categories sc ON sc.id = p.service_category_id LEFT JOIN users ca ON ca.id = p.closure_approved_by
      WHERE p.id = ?`,
    today,
    id,
  )
  const [members, milestones, deps, taskStats, effort, deliverableStats, feedbackOpen] = await Promise.all([
    many(c.env.DB, `SELECT pm.user_id, u.name, u.email, u.avatar_color, ep.designation, pm.role, pm.can_review, pm.responsibility, pm.added_at FROM project_members pm JOIN users u ON u.id = pm.user_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id WHERE pm.project_id = ? ORDER BY CASE pm.role WHEN 'manager' THEN 0 WHEN 'lead' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.name`, id),
    many<Record<string, unknown>>(
      c.env.DB,
      `SELECT m.*, (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id = m.id AND t.status <> 'cancelled') AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id = m.id AND t.status = 'completed') AS completed_count
         FROM milestones m WHERE m.project_id = ? ORDER BY m.sort_order, m.due_date`,
      id,
    ),
    many<{ milestone_id: string; depends_on_id: string }>(c.env.DB, 'SELECT md.milestone_id, md.depends_on_id FROM milestone_dependencies md JOIN milestones m ON m.id = md.milestone_id WHERE m.project_id = ?', id),
    many<{ status: string; n: number }>(c.env.DB, 'SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status', id),
    one<{ estimated: number; logged_minutes: number }>(
      c.env.DB,
      `SELECT (SELECT COALESCE(SUM(estimate_hours), 0) FROM tasks WHERE project_id = ? AND status <> 'cancelled') AS estimated,
              (SELECT COALESCE(SUM(minutes), 0) FROM time_entries WHERE project_id = ?) AS logged_minutes`,
      id,
      id,
    ),
    many<{ status: string; n: number }>(c.env.DB, 'SELECT status, COUNT(*) AS n FROM deliverables WHERE project_id = ? GROUP BY status', id),
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM client_feedback WHERE project_id = ? AND status = 'open'`, id),
  ])
  return c.json({
    project: withHealth(project!, today),
    members: members.map((m) => ({ ...(m as object), can_review: Boolean((m as { can_review: number }).can_review) })),
    milestones: milestones.map((m) => ({ ...m, client_visible: Boolean(m.client_visible), depends_on: deps.filter((d) => d.milestone_id === m.id).map((d) => d.depends_on_id) })),
    taskStats: Object.fromEntries(taskStats.map((s) => [s.status, s.n])),
    effort: { estimatedHours: effort?.estimated ?? 0, loggedHours: Math.round(((effort?.logged_minutes ?? 0) / 60) * 10) / 10, budgetHours: project?.estimated_hours ?? null },
    deliverableStats: Object.fromEntries(deliverableStats.map((s) => [s.status, s.n])),
    openFeedback: feedbackOpen?.n ?? 0,
    access: { memberRole: access.memberRole, canManage: access.canManage, canManageTasks: access.canManageTasks, canReview: access.canReview, canContribute: access.canContribute },
  })
})

/** Closure gate: every applicable task completed and every deliverable approved/accepted. */
async function closureBlockers(db: D1Database, projectId: string): Promise<string[]> {
  const reasons: string[] = []
  const open = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status IN ${OPEN}`, projectId)
  if ((open?.n ?? 0) > 0) reasons.push(`${open!.n} task(s) are still open`)
  const pend = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM deliverables WHERE project_id = ? AND status IN ('draft','in_review','changes_requested')`, projectId)
  if ((pend?.n ?? 0) > 0) reasons.push(`${pend!.n} deliverable(s) are not yet approved`)
  return reasons
}

projects.patch('/:id', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  await requireProject(c.env.DB, a, id, 'manage')
  const input = await body(c, projectPatchSchema)
  const before = await one<Record<string, unknown>>(c.env.DB, 'SELECT * FROM projects WHERE id = ?', id)
  if (!before) throw notFound('Project')
  if (input.managerId !== undefined && input.managerId !== before.manager_id && !a.permissions.has('projects.manage_all')) throw forbidden('Only administrators can reassign the project manager')
  const start = input.startDate !== undefined ? input.startDate : (before.start_date as string | null)
  const target = input.targetDate !== undefined ? input.targetDate : (before.target_date as string | null)
  if (start && target && target < start) throw new ApiError(422, 'VALIDATION_FAILED', 'Target date must be on or after the start date', { fields: { targetDate: 'Must be on or after the start date' } })

  const now = nowIso()
  const stmts: D1PreparedStatement[] = []
  const extra: Record<string, unknown> = {}
  if (input.status && input.status !== before.status) {
    if (input.status === 'completed') {
      const blockers = await closureBlockers(c.env.DB, id)
      if (blockers.length) throw new ApiError(409, 'CLOSURE_BLOCKED', 'This project cannot be closed yet', { reasons: blockers })
      extra.completed_at = now
      extra.closure_approved_by = a.userId
      extra.closure_approved_at = now
    }
    if (input.status === 'archived') extra.archived_at = now
    if (before.status === 'archived' && input.status !== 'archived') extra.archived_at = null
    if (before.status === 'completed' && input.status !== 'completed' && input.status !== 'archived') {
      extra.completed_at = null
      extra.closure_approved_by = null
      extra.closure_approved_at = null
    }
    stmts.push(
      c.env.DB.prepare('INSERT INTO project_status_history (id, project_id, from_status, to_status, note, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(newId('psh'), id, before.status, input.status, input.statusNote ?? '', a.userId, now),
    )
  }
  const { sets, values } = patchColumns(input as Record<string, unknown>, {
    name: 'name', managerId: 'manager_id', serviceCategoryId: 'service_category_id', description: 'description', scope: 'scope', startDate: 'start_date',
    targetDate: 'target_date', status: 'status', priority: 'priority', progressMode: 'progress_mode', estimatedHours: 'estimated_hours', clientStatusNote: 'client_status_note',
  })
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`)
    values.push(v)
  }
  if (sets.length === 0) return c.json({ ok: true })
  stmts.unshift(c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...values, now, id))
  if (input.managerId && input.managerId !== before.manager_id) {
    stmts.push(
      c.env.DB.prepare(`INSERT INTO project_members (project_id, user_id, role, can_review, added_by, added_at) VALUES (?, ?, 'manager', 1, ?, ?)
                        ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'manager', can_review = 1`).bind(id, input.managerId, a.userId, now),
    )
  }
  const changes = diff(before, Object.fromEntries(sets.map((s, i) => [s.split(' = ')[0], values[i]])))
  const statusText = input.status && input.status !== before.status ? ` · status ${PROJECT_STATUS_LABEL[before.status as ProjectStatus]} → ${PROJECT_STATUS_LABEL[input.status]}` : ''
  stmts.push(activity(c.env.DB, { actorId: a.userId, action: 'project.updated', entityType: 'project', entityId: id, projectId: id, summary: `Updated project${statusText}`, changes, ip: clientIp(c) }))
  await c.env.DB.batch(stmts)
  if (input.progressMode && input.progressMode !== before.progress_mode) await recalcProgress(c.env, c.executionCtx, id)
  if (input.managerId) invalidateMembership(c.env, c.executionCtx, [input.managerId, String(before.manager_id ?? '')].filter(Boolean))
  publish(c.env, c.executionCtx, [
    { type: 'project.updated', room: rooms.project(id), data: { projectId: id, fields: Object.keys(changes) } },
    ...(input.clientStatusNote !== undefined || input.status ? [{ type: 'portal.project_updated' as const, room: rooms.portalProject(id), data: { projectId: id } }] : []),
  ])
  return c.json({ ok: true })
})

projects.post('/:id/duplicate', requirePermission('projects.create'), async (c) => {
  const a = c.get('auth')
  const srcId = c.req.param('id')
  await requireProject(c.env.DB, a, srcId)
  const src = await one<Record<string, unknown>>(c.env.DB, 'SELECT * FROM projects WHERE id = ?', srcId)
  if (!src) throw notFound('Project')
  const id = newId('prj')
  const reference = await nextProjectReference(c.env.DB)
  const now = nowIso()
  const milestones = await many<Record<string, unknown>>(c.env.DB, 'SELECT * FROM milestones WHERE project_id = ? ORDER BY sort_order', srcId)
  const tasks = await many<Record<string, unknown>>(c.env.DB, `SELECT * FROM tasks WHERE project_id = ? AND status <> 'cancelled' ORDER BY number`, srcId)
  const mMap = new Map(milestones.map((m) => [m.id as string, newId('mil')]))
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO projects (id, reference, name, client_id, manager_id, service_category_id, description, scope, status, priority, progress_mode, estimated_hours, next_task_number, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, reference, `${src.name} (copy)`, src.client_id, a.userId, src.service_category_id, src.description, src.scope, src.priority, src.progress_mode, src.estimated_hours, tasks.length + 1, a.userId, now, now),
    c.env.DB.prepare(`INSERT INTO project_members (project_id, user_id, role, can_review, responsibility, added_by, added_at) VALUES (?, ?, 'manager', 1, 'Project manager', ?, ?)`).bind(id, a.userId, a.userId, now),
    c.env.DB.prepare('INSERT INTO project_status_history (id, project_id, from_status, to_status, note, changed_by, changed_at) VALUES (?, ?, NULL, ?, ?, ?, ?)').bind(newId('psh'), id, 'planning', `Duplicated from ${src.reference}`, a.userId, now),
  ]
  for (const m of milestones) {
    stmts.push(
      c.env.DB.prepare('INSERT INTO milestones (id, project_id, title, description, weight, client_visible, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(mMap.get(m.id as string), id, m.title, m.description, m.weight, m.client_visible, m.sort_order, now, now),
    )
  }
  tasks.forEach((t, i) => {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO tasks (id, project_id, milestone_id, number, title, description, status, priority, estimate_hours, weight, requires_approval, sort_order, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(newId('tsk'), id, t.milestone_id ? (mMap.get(t.milestone_id as string) ?? null) : null, i + 1, t.title, t.description, t.priority, t.estimate_hours, t.weight, t.requires_approval, i, a.userId, now, now),
    )
  })
  stmts.push(activity(c.env.DB, { actorId: a.userId, action: 'project.duplicated', entityType: 'project', entityId: id, projectId: id, summary: `Duplicated ${src.reference} into ${reference}`, ip: clientIp(c) }))
  await c.env.DB.batch(stmts)
  await recalcProgress(c.env, c.executionCtx, id)
  invalidateMembership(c.env, c.executionCtx, [a.userId])
  return c.json({ id, reference }, 201)
})

// ───────── Members ─────────

projects.post('/:id/members', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const access = await requireProject(c.env.DB, a, id, 'manage')
  const input = await body(c, projectMemberSchema)
  const user = await one<{ name: string; status: string }>(c.env.DB, 'SELECT name, status FROM users WHERE id = ?', input.userId)
  if (!user || user.status === 'deactivated') throw new ApiError(422, 'VALIDATION_FAILED', 'Choose an active team member', { fields: { userId: 'Not available' } })
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO project_members (project_id, user_id, role, can_review, responsibility, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, can_review = excluded.can_review, responsibility = excluded.responsibility`,
    ).bind(id, input.userId, input.role, input.canReview ? 1 : 0, input.responsibility, a.userId, now),
    activity(c.env.DB, { actorId: a.userId, action: 'project.member_added', entityType: 'project', entityId: id, projectId: id, summary: `Added ${user.name} as ${input.role}`, ip: clientIp(c) }),
  ])
  invalidateMembership(c.env, c.executionCtx, [input.userId])
  await notify(c.env, c.executionCtx, [{ userId: input.userId, kind: 'task_assigned', title: `You were added to ${access.project.name}`, body: `Role: ${input.role}${input.responsibility ? ` · ${input.responsibility}` : ''}`, link: `/projects/${id}`, entityType: 'project', entityId: id }], a.userId)
  publish(c.env, c.executionCtx, [{ type: 'project.updated', room: rooms.project(id), data: { projectId: id, fields: ['members'] } }])
  return c.json({ ok: true })
})

projects.delete('/:id/members/:userId', async (c) => {
  const a = c.get('auth')
  const { id, userId } = c.req.param()
  const access = await requireProject(c.env.DB, a, id, 'manage')
  if (access.project.manager_id === userId) throw conflict('Reassign the project manager before removing them')
  const open = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND responsible_id = ? AND status IN ${OPEN}`, id, userId)
  if ((open?.n ?? 0) > 0) throw conflict(`Reassign their ${open!.n} open task(s) first`)
  const user = await one<{ name: string }>(c.env.DB, 'SELECT name FROM users WHERE id = ?', userId)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').bind(id, userId),
    c.env.DB.prepare('DELETE FROM task_assignees WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE project_id = ?)').bind(userId, id),
    activity(c.env.DB, { actorId: a.userId, action: 'project.member_removed', entityType: 'project', entityId: id, projectId: id, summary: `Removed ${user?.name ?? 'member'} from the project`, ip: clientIp(c) }),
  ])
  invalidateMembership(c.env, c.executionCtx, [userId])
  publish(c.env, c.executionCtx, [{ type: 'project.updated', room: rooms.project(id), data: { projectId: id, fields: ['members'] } }])
  return c.json({ ok: true })
})

// ───────── Milestones ─────────

async function assertNoMilestoneCycle(db: D1Database, projectId: string, milestoneId: string, dependsOn: string[]) {
  if (dependsOn.length === 0) return
  if (dependsOn.includes(milestoneId)) throw new ApiError(422, 'VALIDATION_FAILED', 'A milestone cannot depend on itself', { fields: { dependsOn: 'Remove the self-reference' } })
  const ids = await many<{ id: string }>(db, `SELECT id FROM milestones WHERE project_id = ? AND id IN (${placeholders(dependsOn.length)})`, projectId, ...dependsOn)
  if (ids.length !== dependsOn.length) throw new ApiError(422, 'VALIDATION_FAILED', 'Dependencies must be milestones of this project', { fields: { dependsOn: 'Invalid milestone' } })
  const edges = await many<{ milestone_id: string; depends_on_id: string }>(db, 'SELECT md.milestone_id, md.depends_on_id FROM milestone_dependencies md JOIN milestones m ON m.id = md.milestone_id WHERE m.project_id = ? AND md.milestone_id <> ?', projectId, milestoneId)
  const graph = new Map<string, string[]>()
  for (const e of edges) graph.set(e.milestone_id, [...(graph.get(e.milestone_id) ?? []), e.depends_on_id])
  graph.set(milestoneId, dependsOn)
  const seen = new Set<string>()
  const stack = [...dependsOn]
  while (stack.length) {
    const n = stack.pop()!
    if (n === milestoneId) throw new ApiError(422, 'VALIDATION_FAILED', 'These dependencies would create a cycle', { fields: { dependsOn: 'Circular dependency' } })
    if (seen.has(n)) continue
    seen.add(n)
    stack.push(...(graph.get(n) ?? []))
  }
}

projects.post('/:id/milestones', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  await requireProject(c.env.DB, a, id, 'manage')
  const input = await body(c, milestoneSchema)
  const mid = newId('mil')
  await assertNoMilestoneCycle(c.env.DB, id, mid, input.dependsOn)
  const order = await one<{ n: number }>(c.env.DB, 'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM milestones WHERE project_id = ?', id)
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO milestones (id, project_id, title, description, due_date, weight, status, achieved_at, client_visible, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(mid, id, input.title, input.description, input.dueDate ?? null, input.weight, input.status, input.status === 'achieved' ? now : null, input.clientVisible ? 1 : 0, order?.n ?? 1, now, now),
    ...input.dependsOn.map((d) => c.env.DB.prepare('INSERT INTO milestone_dependencies (milestone_id, depends_on_id) VALUES (?, ?)').bind(mid, d)),
    activity(c.env.DB, { actorId: a.userId, action: 'milestone.created', entityType: 'milestone', entityId: mid, projectId: id, summary: `Added milestone "${input.title}"`, ip: clientIp(c) }),
  ])
  await recalcProgress(c.env, c.executionCtx, id)
  publish(c.env, c.executionCtx, [{ type: 'project.milestone_updated', room: rooms.project(id), data: { projectId: id, milestoneId: mid } }])
  return c.json({ id: mid }, 201)
})

projects.put('/:id/milestones/:mid', async (c) => {
  const a = c.get('auth')
  const { id, mid } = c.req.param()
  const access = await requireProject(c.env.DB, a, id, 'manage')
  const input = await body(c, milestoneSchema)
  const before = await one<Record<string, unknown>>(c.env.DB, 'SELECT * FROM milestones WHERE id = ? AND project_id = ?', mid, id)
  if (!before) throw notFound('Milestone')
  await assertNoMilestoneCycle(c.env.DB, id, mid, input.dependsOn)
  if (input.status === 'achieved' && before.status !== 'achieved' && input.dependsOn.length) {
    const unmet = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM milestones WHERE id IN (${placeholders(input.dependsOn.length)}) AND status <> 'achieved'`, ...input.dependsOn)
    if ((unmet?.n ?? 0) > 0) throw conflict('Dependent milestones must be achieved first')
  }
  const now = nowIso()
  const achievedAt = input.status === 'achieved' ? ((before.achieved_at as string) ?? now) : null
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE milestones SET title = ?, description = ?, due_date = ?, weight = ?, status = ?, achieved_at = ?, client_visible = ?, updated_at = ? WHERE id = ?')
      .bind(input.title, input.description, input.dueDate ?? null, input.weight, input.status, achievedAt, input.clientVisible ? 1 : 0, now, mid),
    c.env.DB.prepare('DELETE FROM milestone_dependencies WHERE milestone_id = ?').bind(mid),
    ...input.dependsOn.map((d) => c.env.DB.prepare('INSERT INTO milestone_dependencies (milestone_id, depends_on_id) VALUES (?, ?)').bind(mid, d)),
    activity(c.env.DB, {
      actorId: a.userId, action: 'milestone.updated', entityType: 'milestone', entityId: mid, projectId: id, summary: `Updated milestone "${input.title}"${input.status !== before.status ? ` → ${input.status}` : ''}`,
      changes: diff(before, { title: input.title, due_date: input.dueDate ?? null, weight: input.weight, status: input.status, client_visible: input.clientVisible ? 1 : 0 }), ip: clientIp(c),
    }),
  ])
  await recalcProgress(c.env, c.executionCtx, id)
  publish(c.env, c.executionCtx, [
    { type: 'project.milestone_updated', room: rooms.project(id), data: { projectId: id, milestoneId: mid, status: input.status } },
    ...(input.clientVisible ? [{ type: 'portal.project_updated' as const, room: rooms.portalProject(id), data: { projectId: id } }] : []),
  ])
  if (input.status !== before.status && (input.status === 'achieved' || input.status === 'missed')) {
    const members = await many<{ user_id: string }>(c.env.DB, 'SELECT user_id FROM project_members WHERE project_id = ?', id)
    await notify(c.env, c.executionCtx, members.map((m) => ({ userId: m.user_id, kind: 'milestone_updated' as const, title: `Milestone ${input.status}: ${input.title}`, body: access.project.name, link: `/projects/${id}?tab=milestones`, entityType: 'milestone', entityId: mid })), a.userId)
  }
  return c.json({ ok: true })
})

projects.delete('/:id/milestones/:mid', async (c) => {
  const a = c.get('auth')
  const { id, mid } = c.req.param()
  await requireProject(c.env.DB, a, id, 'manage')
  const m = await one<{ title: string }>(c.env.DB, 'SELECT title FROM milestones WHERE id = ? AND project_id = ?', mid, id)
  if (!m) throw notFound('Milestone')
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM milestones WHERE id = ?').bind(mid),
    activity(c.env.DB, { actorId: a.userId, action: 'milestone.deleted', entityType: 'milestone', entityId: mid, projectId: id, summary: `Removed milestone "${m.title}" (its tasks were kept)`, ip: clientIp(c) }),
  ])
  await recalcProgress(c.env, c.executionCtx, id)
  publish(c.env, c.executionCtx, [{ type: 'project.milestone_updated', room: rooms.project(id), data: { projectId: id, milestoneId: mid, deleted: true } }])
  return c.json({ ok: true })
})

// ───────── Timeline, activity, updates, feedback ─────────

projects.get('/:id/timeline', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  await requireProject(c.env.DB, a, id)
  const [milestones, tasks, deps] = await Promise.all([
    many(c.env.DB, 'SELECT id, title, due_date, status, weight FROM milestones WHERE project_id = ? ORDER BY sort_order', id),
    many(c.env.DB, `SELECT t.id, t.number, t.title, t.status, t.priority, t.start_date, t.due_date, t.milestone_id, t.completed_at, u.name AS responsible_name FROM tasks t LEFT JOIN users u ON u.id = t.responsible_id WHERE t.project_id = ? AND t.status <> 'cancelled' ORDER BY COALESCE(t.start_date, t.due_date), t.number`, id),
    many(c.env.DB, 'SELECT td.task_id, td.depends_on_task_id FROM task_dependencies td JOIN tasks t ON t.id = td.task_id WHERE t.project_id = ?', id),
  ])
  return c.json({ milestones, tasks, dependencies: deps })
})

projects.get('/:id/activity', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  await requireProject(c.env.DB, a, id)
  const before = query(c, 'before')
  const rows = await many(
    c.env.DB,
    `SELECT l.id, l.action, l.summary, l.entity_type, l.entity_id, l.created_at, l.actor_type, u.name AS actor_name
       FROM activity_logs l LEFT JOIN users u ON u.id = l.actor_id AND l.actor_type = 'user'
      WHERE l.project_id = ? AND l.category = 'activity' ${before ? 'AND l.created_at < ?' : ''} ORDER BY l.created_at DESC LIMIT 60`,
    id,
    ...(before ? [before] : []),
  )
  return c.json({ entries: rows })
})

projects.get('/:id/updates', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  await requireProject(c.env.DB, a, id)
  const rows = await many(c.env.DB, 'SELECT pu.*, u.name AS created_by_name, ap.name AS approved_by_name FROM project_updates pu LEFT JOIN users u ON u.id = pu.created_by LEFT JOIN users ap ON ap.id = pu.approved_by WHERE pu.project_id = ? ORDER BY pu.created_at DESC LIMIT 100', id)
  return c.json({ updates: rows })
})

projects.post('/:id/updates', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const access = await requireProject(c.env.DB, a, id, 'contribute')
  const input = await body(c, projectUpdateSchema)
  // Only managers can publish to the client; contributors' updates stay internal.
  if (input.clientVisible && !access.canManage) throw forbidden('Only the project manager can publish client-visible updates')
  const uid = newId('pup')
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO project_updates (id, project_id, title, body, client_visible, approved_by, approved_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid, id, input.title, input.body, input.clientVisible ? 1 : 0, input.clientVisible ? a.userId : null, input.clientVisible ? now : null, a.userId, now),
    activity(c.env.DB, { actorId: a.userId, action: 'project.update_posted', entityType: 'project', entityId: id, projectId: id, summary: `${input.clientVisible ? 'Published client update' : 'Posted internal update'}: ${input.title}`, ip: clientIp(c) }),
  ])
  publish(c.env, c.executionCtx, [
    { type: 'project.updated', room: rooms.project(id), data: { projectId: id, fields: ['updates'] } },
    ...(input.clientVisible ? [{ type: 'portal.project_updated' as const, room: rooms.portalProject(id), data: { projectId: id } }] : []),
  ])
  return c.json({ id: uid }, 201)
})

projects.post('/:id/updates/:uid/publish', async (c) => {
  const a = c.get('auth')
  const { id, uid } = c.req.param()
  await requireProject(c.env.DB, a, id, 'manage')
  const u = await one<{ title: string; client_visible: number }>(c.env.DB, 'SELECT title, client_visible FROM project_updates WHERE id = ? AND project_id = ?', uid, id)
  if (!u) throw notFound('Update')
  const visible = c.req.query('visible') !== '0'
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE project_updates SET client_visible = ?, approved_by = ?, approved_at = ? WHERE id = ?').bind(visible ? 1 : 0, visible ? a.userId : null, visible ? nowIso() : null, uid),
    activity(c.env.DB, { actorId: a.userId, action: visible ? 'project.update_published' : 'project.update_unpublished', entityType: 'project', entityId: id, projectId: id, summary: `${visible ? 'Shared' : 'Withdrew'} update "${u.title}" ${visible ? 'with' : 'from'} the client`, ip: clientIp(c) }),
  ])
  publish(c.env, c.executionCtx, [{ type: 'portal.project_updated', room: rooms.portalProject(id), data: { projectId: id } }])
  return c.json({ ok: true })
})

projects.get('/:id/feedback', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  await requireProject(c.env.DB, a, id)
  const rows = await many(
    c.env.DB,
    `SELECT f.*, d.title AS deliverable_title, u.name AS responded_by_name FROM client_feedback f LEFT JOIN deliverables d ON d.id = f.deliverable_id LEFT JOIN users u ON u.id = f.responded_by
      WHERE f.project_id = ? ORDER BY f.status = 'resolved', f.created_at DESC`,
    id,
  )
  return c.json({ feedback: rows })
})

projects.post('/:id/feedback/:fid/respond', async (c) => {
  const a = c.get('auth')
  const { id, fid } = c.req.param()
  await requireProject(c.env.DB, a, id, 'manage')
  const input = await body(c, feedbackResponseSchema)
  const f = await one<{ id: string }>(c.env.DB, 'SELECT id FROM client_feedback WHERE id = ? AND project_id = ?', fid, id)
  if (!f) throw notFound('Feedback')
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE client_feedback SET status = ?, response = COALESCE(?, response), responded_by = ?, responded_at = ? WHERE id = ?').bind(input.status, input.response ?? null, a.userId, now, fid),
    activity(c.env.DB, { actorId: a.userId, action: 'feedback.responded', entityType: 'client_feedback', entityId: fid, projectId: id, summary: `Marked client feedback ${input.status}${input.response ? ' with a reply' : ''}`, ip: clientIp(c) }),
  ])
  publish(c.env, c.executionCtx, [
    { type: 'project.updated', room: rooms.project(id), data: { projectId: id, fields: ['feedback'] } },
    { type: 'portal.feedback_answered', room: rooms.portalProject(id), data: { projectId: id, feedbackId: fid } },
  ])
  return c.json({ ok: true })
})

export default projects
