import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings, StaffAuth } from '../env'
import { dateStr } from '@shared/schemas'
import { activity } from '../lib/audit'
import { canViewMember, requireProject } from '../lib/authz'
import { newId } from '../lib/crypto'
import { many, nowIso, one } from '../lib/db'
import { ApiError, body, clientIp, forbidden, notFound, query, validate } from '../lib/http'
import { can, requireStaff } from '../lib/session'
import { clientReport, companyReport, memberReport, projectReport, type ReportDoc } from '../services/reports'

const reports = new Hono<AppBindings>()
reports.use('*', requireStaff())

type ReportType = 'company' | 'project' | 'member' | 'client'

async function authorize(db: D1Database, a: StaffAuth, type: ReportType, scopeId: string | null) {
  if (type === 'company') {
    if (!can(a, 'reports.company')) throw forbidden('Company reports require the reports.company permission')
    return
  }
  if (!scopeId) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose what to report on', { fields: { scopeId: 'Required' } })
  if (type === 'project') {
    const access = await requireProject(db, a, scopeId)
    if (!access.canManage && !access.canReview && !can(a, 'reports.company')) throw forbidden('Project reports are available to project managers, reviewers and company reporters')
  } else if (type === 'member') {
    if (!(await canViewMember(db, a, scopeId))) throw forbidden()
  } else {
    const cl = await one<{ account_manager_id: string | null }>(db, 'SELECT account_manager_id FROM clients WHERE id = ?', scopeId)
    if (!cl) throw notFound('Client')
    if (!can(a, 'reports.company') && cl.account_manager_id !== a.userId) throw forbidden()
  }
}

export async function buildReport(db: D1Database, type: ReportType, scopeId: string | null, start: string, end: string): Promise<ReportDoc> {
  if (type === 'company') return companyReport(db, start, end)
  if (type === 'project') return projectReport(db, scopeId!, start, end)
  if (type === 'member') return memberReport(db, scopeId!, start, end)
  return clientReport(db, scopeId!, start, end)
}

const paramsSchema = z.object({
  type: z.enum(['company', 'project', 'member', 'client']),
  scopeId: z.string().max(64).nullable().optional(),
  start: dateStr,
  end: dateStr,
}).refine((p) => p.end >= p.start, { message: 'End must be on or after start', path: ['end'] })
  .refine((p) => (Date.parse(p.end) - Date.parse(p.start)) / 86400_000 <= 366, { message: 'Reports cover at most one year', path: ['end'] })

reports.get('/run', async (c) => {
  const a = c.get('auth')
  const p = validate(paramsSchema, { type: query(c, 'type'), scopeId: query(c, 'scopeId') ?? null, start: query(c, 'start'), end: query(c, 'end') })
  await authorize(c.env.DB, a, p.type, p.scopeId ?? null)
  return c.json({ report: await buildReport(c.env.DB, p.type, p.scopeId ?? null, p.start, p.end) })
})

reports.post('/snapshots', async (c) => {
  const a = c.get('auth')
  const p = await body(c, paramsSchema)
  await authorize(c.env.DB, a, p.type, p.scopeId ?? null)
  const doc = await buildReport(c.env.DB, p.type, p.scopeId ?? null, p.start, p.end)
  const id = newId('rpt')
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO report_snapshots (id, report_type, scope_id, period_start, period_end, source, payload, generated_by, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, p.type, p.scopeId ?? null, p.start, p.end, 'manual', JSON.stringify(doc), a.userId, nowIso()),
    activity(c.env.DB, { actorId: a.userId, action: 'report.snapshot_saved', entityType: 'report_snapshot', entityId: id, projectId: p.type === 'project' ? p.scopeId : null, summary: `Saved ${p.type} report snapshot for ${p.start} – ${p.end}`, ip: clientIp(c) }),
  ])
  return c.json({ id }, 201)
})

reports.get('/snapshots', async (c) => {
  const a = c.get('auth')
  const rows = await many<{ id: string; report_type: ReportType; scope_id: string | null; period_start: string; period_end: string; source: string; generated_at: string; generated_by_name: string | null; scope_name: string | null }>(
    c.env.DB,
    `SELECT s.id, s.report_type, s.scope_id, s.period_start, s.period_end, s.source, s.generated_at, u.name AS generated_by_name, json_extract(s.payload, '$.meta.scopeName') AS scope_name
       FROM report_snapshots s LEFT JOIN users u ON u.id = s.generated_by ORDER BY s.generated_at DESC LIMIT 200`,
  )
  const visible = []
  for (const r of rows) {
    try {
      await authorize(c.env.DB, a, r.report_type, r.scope_id)
      visible.push(r)
    } catch {
      /* not visible to this user */
    }
  }
  return c.json({ snapshots: visible })
})

reports.get('/snapshots/:id', async (c) => {
  const a = c.get('auth')
  const s = await one<{ report_type: ReportType; scope_id: string | null; payload: string; source: string; generated_at: string }>(c.env.DB, 'SELECT report_type, scope_id, payload, source, generated_at FROM report_snapshots WHERE id = ?', c.req.param('id'))
  if (!s) throw notFound('Snapshot')
  await authorize(c.env.DB, a, s.report_type, s.scope_id)
  return c.json({ report: JSON.parse(s.payload), snapshot: { id: c.req.param('id'), source: s.source, generatedAt: s.generated_at } })
})

/** Options for report pickers, limited to what the user may report on. */
reports.get('/scopes', async (c) => {
  const a = c.get('auth')
  const projects = await many<{ id: string; reference: string; name: string }>(
    c.env.DB,
    can(a, 'reports.company') || can(a, 'projects.manage_all')
      ? 'SELECT id, reference, name FROM projects ORDER BY reference DESC'
      : `SELECT p.id, p.reference, p.name FROM projects p WHERE p.manager_id = ? OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ? AND (m.role = 'manager' OR m.can_review = 1)) ORDER BY p.reference DESC`,
    ...(can(a, 'reports.company') || can(a, 'projects.manage_all') ? [] : [a.userId, a.userId]),
  )
  const seeAllPeople = can(a, 'reports.company') || can(a, 'employees.manage')
  const members = await many<{ id: string; name: string }>(
    c.env.DB,
    seeAllPeople
      ? `SELECT id, name FROM users WHERE status <> 'deactivated' ORDER BY name`
      : `SELECT u.id, u.name FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id LEFT JOIN departments d ON d.id = ep.department_id WHERE u.id = ? OR ep.manager_user_id = ? OR d.head_user_id = ? ORDER BY u.name`,
    ...(seeAllPeople ? [] : [a.userId, a.userId, a.userId]),
  )
  const clients = await many<{ id: string; reference: string; name: string }>(
    c.env.DB,
    can(a, 'reports.company') ? 'SELECT id, reference, name FROM clients ORDER BY name' : 'SELECT id, reference, name FROM clients WHERE account_manager_id = ? ORDER BY name',
    ...(can(a, 'reports.company') ? [] : [a.userId]),
  )
  return c.json({ company: can(a, 'reports.company'), projects, members, clients })
})

export default reports
