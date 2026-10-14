import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { addDays, localDate } from '@shared/dates'
import { assessHealth } from '@shared/progress'
import { readableProjectsFilter } from '../lib/authz'
import { many, one } from '../lib/db'
import { query } from '../lib/http'
import { can, requireStaff } from '../lib/session'

const dashboard = new Hono<AppBindings>()
dashboard.use('*', requireStaff())

const OPEN = `('backlog','todo','in_progress','in_review','blocked')`

dashboard.get('/', async (c) => {
  const a = c.get('auth')
  const today = localDate()
  const weekEnd = addDays(today, 7)
  const f = readableProjectsFilter(a)

  const mine = await one<Record<string, number>>(
    c.env.DB,
    `SELECT
       SUM(CASE WHEN t.status IN ${OPEN} THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
       SUM(CASE WHEN t.status = 'in_review' THEN 1 ELSE 0 END) AS in_review,
       SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
       SUM(CASE WHEN t.status IN ${OPEN} AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue,
       SUM(CASE WHEN t.status IN ${OPEN} AND t.due_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS due_week
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE p.archived_at IS NULL AND (t.responsible_id = ? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?))`,
    today, today, weekEnd, a.userId, a.userId,
  )
  const myTasks = await many(
    c.env.DB,
    `SELECT t.id, t.number, t.title, t.status, t.priority, t.due_date, p.id AS project_id, p.reference AS project_reference, p.name AS project_name
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE p.archived_at IS NULL AND t.status IN ${OPEN} AND (t.responsible_id = ? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?))
      ORDER BY t.due_date IS NULL, t.due_date, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END LIMIT 8`,
    a.userId, a.userId,
  )
  const reviewWhere = can(a, 'tasks.review_all') || can(a, 'projects.manage_all')
    ? '1 = 1'
    : `(p.manager_id = ? OR EXISTS (SELECT 1 FROM project_members r WHERE r.project_id = t.project_id AND r.user_id = ? AND (r.can_review = 1 OR r.role = 'manager')))`
  const reviewQueue = await many(
    c.env.DB,
    `SELECT t.id, t.number, t.title, t.submitted_at, p.reference AS project_reference, u.name AS responsible_name
       FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.responsible_id
      WHERE t.status = 'in_review' AND ${f.sql} AND ${reviewWhere} ORDER BY t.submitted_at LIMIT 8`,
    ...f.params, ...(reviewWhere === '1 = 1' ? [] : [a.userId, a.userId]),
  )
  const projects = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT p.id, p.reference, p.name, p.status, p.progress, p.start_date, p.target_date, cl.name AS client_name, u.name AS manager_name,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'cancelled') AS total_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN ${OPEN} AND t.due_date < ?) AS overdue_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'blocked') AS blocked_tasks
       FROM projects p JOIN clients cl ON cl.id = p.client_id LEFT JOIN users u ON u.id = p.manager_id
      WHERE ${f.sql} AND p.archived_at IS NULL AND p.status NOT IN ('completed','archived') ORDER BY p.target_date IS NULL, p.target_date LIMIT 60`,
    today, ...f.params,
  )
  const withHealth = projects.map((p) => {
    const h = assessHealth({ status: String(p.status), progress: Number(p.progress), hasData: Number(p.total_tasks) > 0, startDate: (p.start_date as string) ?? null, targetDate: (p.target_date as string) ?? null, today, overdueTasks: Number(p.overdue_tasks), blockedTasks: Number(p.blocked_tasks) })
    return { ...p, health: h.health, health_reasons: h.reasons }
  })
  const milestones = await many(
    c.env.DB,
    `SELECT m.id, m.title, m.due_date, m.status, p.id AS project_id, p.reference FROM milestones m JOIN projects p ON p.id = m.project_id
      WHERE ${f.sql} AND m.status IN ('pending','in_progress') AND m.due_date BETWEEN ? AND ? ORDER BY m.due_date LIMIT 8`,
    ...f.params, addDays(today, -14), addDays(today, 30),
  )
  const onLeaveToday = await many(
    c.env.DB,
    `SELECT u.id, u.name, l.half_day, l.end_date FROM leave_requests l JOIN users u ON u.id = l.user_id WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ? ORDER BY u.name`,
    today, today,
  )
  const nextHoliday = await one(c.env.DB, `SELECT holiday_date, name, kind FROM holidays WHERE status = 'verified' AND is_day_off = 1 AND holiday_date >= ? ORDER BY holiday_date LIMIT 1`, today)
  const unverifiedHolidays = can(a, 'holidays.manage') ? (await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM holidays WHERE status = 'pending_verification'`))?.n ?? 0 : null

  let company: unknown = null
  if (can(a, 'dashboard.company')) {
    const monthStart = `${today.slice(0, 7)}-01`
    const statusCounts = await many(c.env.DB, `SELECT status, COUNT(*) AS n FROM projects WHERE archived_at IS NULL GROUP BY status`)
    const throughput = await many(
      c.env.DB,
      `SELECT substr(h.changed_at, 1, 10) AS day, COUNT(*) AS n FROM task_status_history h WHERE h.to_status = 'completed' AND h.changed_at >= ? GROUP BY day ORDER BY day`,
      new Date(Date.now() - 30 * 86400_000).toISOString(),
    )
    const totals = await one<Record<string, number>>(
      c.env.DB,
      `SELECT
         (SELECT COUNT(*) FROM clients WHERE archived_at IS NULL AND status = 'active') AS active_clients,
         (SELECT COUNT(*) FROM projects WHERE archived_at IS NULL AND status NOT IN ('completed','archived')) AS active_projects,
         (SELECT COUNT(*) FROM tasks WHERE status IN ${OPEN}) AS open_tasks,
         (SELECT COUNT(*) FROM tasks WHERE status IN ${OPEN} AND due_date < ?) AS overdue_tasks,
         (SELECT COUNT(DISTINCT task_id) FROM task_status_history WHERE to_status = 'completed' AND changed_at >= ?) AS completed_this_month,
         (SELECT COUNT(*) FROM client_feedback WHERE status = 'open') AS open_feedback,
         (SELECT COUNT(*) FROM deliverables WHERE status = 'shared') AS awaiting_client,
         (SELECT COUNT(*) FROM leave_requests WHERE status = 'pending') AS pending_leave`,
      today, new Date(Date.parse(monthStart + 'T00:00:00+05:30')).toISOString(),
    )
    company = { statusCounts, throughput, totals }
  }

  return c.json({
    today,
    mine,
    myTasks,
    reviewQueue,
    projects: withHealth,
    milestones,
    onLeaveToday,
    nextHoliday,
    unverifiedHolidays,
    company,
  })
})

dashboard.get('/search', async (c) => {
  const a = c.get('auth')
  const q = (query(c, 'q') ?? '').trim()
  if (q.length < 2) return c.json({ results: [] })
  const like = `%${q}%`
  const f = readableProjectsFilter(a)
  const projects = await many<{ id: string; reference: string; name: string; client_name: string }>(
    c.env.DB,
    `SELECT p.id, p.reference, p.name, cl.name AS client_name FROM projects p JOIN clients cl ON cl.id = p.client_id WHERE ${f.sql} AND (p.name LIKE ? OR p.reference LIKE ?) LIMIT 6`,
    ...f.params, like, like,
  )
  const tasks = await many<{ id: string; number: number; title: string; reference: string }>(
    c.env.DB,
    `SELECT t.id, t.number, t.title, p.reference FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${f.sql} AND t.title LIKE ? AND t.status <> 'cancelled' LIMIT 6`,
    ...f.params, like,
  )
  const clients = can(a, 'clients.read')
    ? await many<{ id: string; reference: string; name: string }>(c.env.DB, `SELECT id, reference, name FROM clients WHERE archived_at IS NULL AND (name LIKE ? OR organization LIKE ? OR reference LIKE ?) LIMIT 5`, like, like, like)
    : []
  const people = can(a, 'team.read')
    ? await many<{ id: string; name: string; designation: string | null }>(c.env.DB, `SELECT u.id, u.name, ep.designation FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id WHERE u.status = 'active' AND u.name LIKE ? LIMIT 5`, like)
    : []
  return c.json({
    results: [
      ...projects.map((p) => ({ type: 'project', id: p.id, title: p.name, subtitle: `${p.reference} · ${p.client_name}`, href: `/projects/${p.id}` })),
      ...tasks.map((t) => ({ type: 'task', id: t.id, title: t.title, subtitle: `${t.reference}-${t.number}`, href: `/tasks/${t.id}` })),
      ...clients.map((cl) => ({ type: 'client', id: cl.id, title: cl.name, subtitle: cl.reference, href: `/clients/${cl.id}` })),
      ...people.map((u) => ({ type: 'person', id: u.id, title: u.name, subtitle: u.designation ?? '', href: `/team/${u.id}` })),
    ],
  })
})

export default dashboard
