import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings, StaffAuth } from '../env'
import { eventSchema, holidayImportSchema, holidaySchema, overrideSchema } from '@shared/schemas'
import { addDays, eachDate, isValidDate, localDate, startOfLocalDay } from '@shared/dates'
import { expandOccurrences, parseRule, type Occurrence } from '@shared/recurrence'
import { classifyDay } from '@shared/workdays'
import { activity } from '../lib/audit'
import { readableProjectsFilter, requireProject } from '../lib/authz'
import { newId } from '../lib/crypto'
import { many, nowIso, one, placeholders } from '../lib/db'
import { ApiError, body, clientIp, forbidden, notFound, query } from '../lib/http'
import { can, requirePermission, requireStaff } from '../lib/session'
import { notify } from '../services/notify'
import { publish, rooms } from '../services/realtime'
import { getDayOffSource, getWorkweek } from '../services/settings'

const calendar = new Hono<AppBindings>()
calendar.use('*', requireStaff())

function range(c: { req: { query(k: string): string | undefined } }) {
  const from = c.req.query('from')
  const to = c.req.query('to')
  if (!from || !to || !isValidDate(from) || !isValidDate(to) || to < from) throw new ApiError(422, 'VALIDATION_FAILED', 'from and to must be dates (YYYY-MM-DD), to ≥ from')
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 120) throw new ApiError(422, 'VALIDATION_FAILED', 'Range is limited to 120 days')
  return { from, to, fromUtc: startOfLocalDay(from).toISOString(), toUtc: startOfLocalDay(addDays(to, 1)).toISOString() }
}

async function userDepartment(db: D1Database, userId: string) {
  return (await one<{ department_id: string | null }>(db, 'SELECT department_id FROM employee_profiles WHERE user_id = ?', userId))?.department_id ?? null
}

/** Events the user may see, as a SQL fragment over `e`. */
async function visibleEventsFilter(db: D1Database, a: StaffAuth) {
  if (can(a, 'calendar.manage')) return { sql: '1 = 1', params: [] as unknown[] }
  const dept = await userDepartment(db, a.userId)
  const pf = readableProjectsFilter(a, 'pv')
  return {
    sql: `(e.visibility = 'company'
          OR e.organizer_id = ?
          OR EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id = ?)
          OR (e.visibility = 'department' AND e.department_id = ?)
          OR (e.visibility = 'project' AND EXISTS (SELECT 1 FROM projects pv WHERE pv.id = e.project_id AND ${pf.sql})))`,
    params: [a.userId, a.userId, dept, ...pf.params],
  }
}

calendar.get('/', async (c) => {
  const a = c.get('auth')
  const r = range(c)
  const projectId = query(c, 'projectId')
  const departmentId = query(c, 'departmentId')
  const scope = query(c, 'scope') ?? 'mine' // 'mine' | 'all' for tasks
  const vf = await visibleEventsFilter(c.env.DB, a)
  const evWhere = [vf.sql, 'e.cancelled_at IS NULL', '(e.recurrence_rule IS NOT NULL OR (e.start_at < ? AND e.end_at > ?))']
  const evParams: unknown[] = [...vf.params, r.toUtc, r.fromUtc]
  if (projectId) {
    evWhere.push('e.project_id = ?')
    evParams.push(projectId)
  }
  if (departmentId) {
    evWhere.push('e.department_id = ?')
    evParams.push(departmentId)
  }
  const events = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT e.*, p.name AS project_name, cl.name AS client_name, u.name AS organizer_name,
            (SELECT GROUP_CONCAT(ea.user_id) FROM event_attendees ea WHERE ea.event_id = e.id) AS attendee_ids
       FROM calendar_events e LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN clients cl ON cl.id = e.client_id LEFT JOIN users u ON u.id = e.organizer_id
      WHERE ${evWhere.join(' AND ')} LIMIT 1000`,
    ...evParams,
  )
  const items: Record<string, unknown>[] = []
  for (const e of events) {
    let occ: Occurrence[]
    try {
      occ = expandOccurrences(String(e.start_at), String(e.end_at), (e.recurrence_rule as string) ?? null, r.fromUtc, r.toUtc)
    } catch {
      occ = []
    }
    for (const o of occ) {
      items.push({
        type: 'event', id: `${e.id}:${o.index}`, eventId: e.id, title: e.title, kind: e.kind, start: o.startAt, end: o.endAt, allDay: Boolean(e.all_day),
        location: e.location, projectId: e.project_id, projectName: e.project_name, clientName: e.client_name, organizerId: e.organizer_id, organizerName: e.organizer_name,
        recurring: Boolean(e.recurrence_rule), attendeeIds: String(e.attendee_ids ?? '').split(',').filter(Boolean), visibility: e.visibility,
      })
    }
  }

  const pf = readableProjectsFilter(a)
  const projWhere = [pf.sql, 'p.archived_at IS NULL']
  const projParams: unknown[] = [...pf.params]
  if (projectId) {
    projWhere.push('p.id = ?')
    projParams.push(projectId)
  }
  const deadlines = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT p.id, p.reference, p.name, p.target_date, p.status FROM projects p WHERE ${projWhere.join(' AND ')} AND p.target_date BETWEEN ? AND ? AND p.status NOT IN ('completed','archived')`,
    ...projParams, r.from, r.to,
  )
  for (const p of deadlines) items.push({ type: 'project_deadline', id: `pd:${p.id}`, projectId: p.id, title: `${p.reference} deadline · ${p.name}`, date: p.target_date, status: p.status })
  const milestones = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT m.id, m.title, m.due_date, m.status, p.id AS project_id, p.reference FROM milestones m JOIN projects p ON p.id = m.project_id WHERE ${projWhere.join(' AND ')} AND m.due_date BETWEEN ? AND ?`,
    ...projParams, r.from, r.to,
  )
  for (const m of milestones) items.push({ type: 'milestone', id: `ms:${m.id}`, projectId: m.project_id, title: `${m.reference} · ${m.title}`, date: m.due_date, status: m.status })
  const taskWhere = [...projWhere, `t.status NOT IN ('completed','cancelled')`, 't.due_date BETWEEN ? AND ?']
  const taskParams: unknown[] = [...projParams, r.from, r.to]
  if (scope === 'mine' && !projectId) {
    taskWhere.push('(t.responsible_id = ? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?))')
    taskParams.push(a.userId, a.userId)
  }
  const tasksDue = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT t.id, t.number, t.title, t.due_date, t.status, t.priority, p.id AS project_id, p.reference, u.name AS responsible_name
       FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.responsible_id WHERE ${taskWhere.join(' AND ')} LIMIT 500`,
    ...taskParams,
  )
  for (const t of tasksDue) items.push({ type: 'task_due', id: `td:${t.id}`, taskId: t.id, projectId: t.project_id, title: `${t.reference}-${t.number} ${t.title}`, date: t.due_date, status: t.status, priority: t.priority, responsibleName: t.responsible_name })

  // Leave: everyone can see who is away (availability); type and reason only for HR or the person.
  const leaveWhere = [`l.status = 'approved'`, 'l.start_date <= ?', 'l.end_date >= ?']
  const leaveParams: unknown[] = [r.to, r.from]
  if (departmentId) {
    leaveWhere.push('ep.department_id = ?')
    leaveParams.push(departmentId)
  }
  const leaves = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT l.id, l.user_id, u.name, l.start_date, l.end_date, l.half_day, lt.name AS type_name FROM leave_requests l JOIN users u ON u.id = l.user_id JOIN leave_types lt ON lt.id = l.leave_type_id
       LEFT JOIN employee_profiles ep ON ep.user_id = l.user_id WHERE ${leaveWhere.join(' AND ')}
     UNION ALL
     SELECT l.id, l.user_id, u.name, l.start_date, l.end_date, l.half_day, lt.name || ' (pending)' FROM leave_requests l JOIN users u ON u.id = l.user_id JOIN leave_types lt ON lt.id = l.leave_type_id
      WHERE l.status = 'pending' AND l.user_id = ? AND l.start_date <= ? AND l.end_date >= ?`,
    ...leaveParams, a.userId, r.to, r.from,
  )
  const hr = can(a, 'leave.approve') || can(a, 'employees.manage')
  for (const l of leaves) {
    items.push({ type: 'leave', id: `lv:${l.id}`, userId: l.user_id, title: `${l.name} — ${hr || l.user_id === a.userId ? l.type_name : 'on leave'}`, start: l.start_date, end: l.end_date, halfDay: l.half_day })
  }

  const holidays = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT id, holiday_date, name, kind, region, status, is_day_off FROM holidays WHERE holiday_date BETWEEN ? AND ? AND status <> 'rejected' ${can(a, 'holidays.manage') ? '' : "AND status = 'verified'"}`,
    r.from, r.to,
  )
  for (const h of holidays) items.push({ type: 'holiday', id: `hd:${h.id}`, title: h.name, date: h.holiday_date, kind: h.kind, region: h.region, verified: h.status === 'verified', dayOff: Boolean(h.is_day_off) })

  const ww = await getWorkweek(c.env.DB)
  const src = await getDayOffSource(c.env.DB, r.from, r.to)
  const days = eachDate(r.from, r.to).map((d) => classifyDay(d, ww, src))
  return c.json({ items, days, today: localDate() })
})

// ───────── Events ─────────

async function attendeeConflicts(db: D1Database, attendeeIds: string[], startAt: string, endAt: string, excludeEventId?: string) {
  if (attendeeIds.length === 0) return []
  const ids = attendeeIds.slice(0, 100)
  const busy = await many<{ user_id: string; name: string; title: string; start_at: string; end_at: string }>(
    db,
    `SELECT ea.user_id, u.name, e.title, e.start_at, e.end_at FROM event_attendees ea JOIN calendar_events e ON e.id = ea.event_id JOIN users u ON u.id = ea.user_id
      WHERE ea.user_id IN (${placeholders(ids.length)}) AND e.cancelled_at IS NULL AND e.recurrence_rule IS NULL AND e.start_at < ? AND e.end_at > ? AND e.id <> ? AND ea.response <> 'declined'`,
    ...ids, endAt, startAt, excludeEventId ?? '',
  )
  const startDate = localDate(startAt)
  const endDate = localDate(new Date(Date.parse(endAt) - 1))
  const leave = await many<{ user_id: string; name: string; start_date: string; end_date: string }>(
    db,
    `SELECT l.user_id, u.name, l.start_date, l.end_date FROM leave_requests l JOIN users u ON u.id = l.user_id
      WHERE l.user_id IN (${placeholders(ids.length)}) AND l.status IN ('approved','pending') AND l.start_date <= ? AND l.end_date >= ?`,
    ...ids, endDate, startDate,
  )
  const holidays = await many<{ name: string; holiday_date: string }>(db, `SELECT name, holiday_date FROM holidays WHERE status = 'verified' AND is_day_off = 1 AND holiday_date BETWEEN ? AND ?`, startDate, endDate)
  return [
    ...busy.map((b) => ({ type: 'event', userId: b.user_id, message: `${b.name} is in “${b.title}”` })),
    ...leave.map((l) => ({ type: 'leave', userId: l.user_id, message: `${l.name} is on leave (${l.start_date} – ${l.end_date})` })),
    ...holidays.map((h) => ({ type: 'holiday', userId: null, message: `${h.holiday_date} is a holiday: ${h.name}` })),
  ]
}

async function validateEvent(db: D1Database, a: StaffAuth, input: z.infer<typeof eventSchema>) {
  if (input.kind === 'company_event' && !can(a, 'calendar.manage')) throw forbidden('Only calendar managers can create company events')
  if (input.visibility === 'company' && input.kind !== 'company_event' && !can(a, 'calendar.manage') && !input.projectId) {
    // Ordinary meetings default to attendees-only unless linked to a project.
    input.visibility = 'attendees'
  }
  if (input.projectId) await requireProject(db, a, input.projectId, 'contribute')
  if (input.visibility === 'project' && !input.projectId) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a project for project-visible events', { fields: { projectId: 'Required' } })
  if (input.visibility === 'department' && !input.departmentId) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a department', { fields: { departmentId: 'Required' } })
  if (input.clientId && !(await one(db, 'SELECT 1 AS x FROM clients WHERE id = ?', input.clientId))) throw notFound('Client')
  if (input.recurrenceRule) {
    try {
      parseRule(input.recurrenceRule)
    } catch (e) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid repeat rule', { fields: { recurrenceRule: (e as Error).message } })
    }
  }
  if (Date.parse(input.endAt) - Date.parse(input.startAt) > 14 * 86400_000) throw new ApiError(422, 'VALIDATION_FAILED', 'Events can last at most 14 days', { fields: { endAt: 'Too long' } })
}

calendar.post('/conflicts', async (c) => {
  const input = await body(c, z.object({ attendeeIds: z.array(z.string()).max(100), startAt: z.string(), endAt: z.string(), excludeEventId: z.string().optional() }))
  return c.json({ conflicts: await attendeeConflicts(c.env.DB, input.attendeeIds, new Date(input.startAt).toISOString(), new Date(input.endAt).toISOString(), input.excludeEventId) })
})

calendar.get('/events/:id', async (c) => {
  const a = c.get('auth')
  const vf = await visibleEventsFilter(c.env.DB, a)
  const e = await one<Record<string, unknown>>(
    c.env.DB,
    `SELECT e.*, u.name AS organizer_name, p.name AS project_name, cl.name AS client_name FROM calendar_events e LEFT JOIN users u ON u.id = e.organizer_id LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN clients cl ON cl.id = e.client_id WHERE e.id = ? AND ${vf.sql}`,
    c.req.param('id'),
    ...vf.params,
  )
  if (!e) throw notFound('Event')
  const attendees = await many(c.env.DB, 'SELECT ea.user_id, u.name, ea.response FROM event_attendees ea JOIN users u ON u.id = ea.user_id WHERE ea.event_id = ?', e.id)
  return c.json({ event: { ...e, all_day: Boolean(e.all_day) }, attendees, canEdit: e.organizer_id === a.userId || can(a, 'calendar.manage') })
})

calendar.post('/events', async (c) => {
  const a = c.get('auth')
  const input = await body(c, eventSchema)
  await validateEvent(c.env.DB, a, input)
  const id = newId('evt')
  const now = nowIso()
  const startAt = new Date(input.startAt).toISOString()
  const endAt = new Date(input.endAt).toISOString()
  const attendees = [...new Set(input.attendeeIds)]
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO calendar_events (id, title, description, kind, start_at, end_at, all_day, location, project_id, client_id, department_id, organizer_id, visibility, recurrence_rule, reminder_minutes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, input.title, input.description, input.kind, startAt, endAt, input.allDay ? 1 : 0, input.location ?? null, input.projectId ?? null, input.clientId ?? null, input.departmentId ?? null, a.userId, input.visibility, input.recurrenceRule || null, input.reminderMinutes ?? null, now, now),
    ...attendees.map((u) => c.env.DB.prepare(`INSERT INTO event_attendees (event_id, user_id, response) VALUES (?, ?, ?)`).bind(id, u, u === a.userId ? 'accepted' : 'pending')),
    activity(c.env.DB, { actorId: a.userId, action: 'calendar.event_created', entityType: 'calendar_event', entityId: id, projectId: input.projectId ?? null, summary: `Scheduled “${input.title}”`, ip: clientIp(c) }),
  ])
  const conflicts = await attendeeConflicts(c.env.DB, attendees, startAt, endAt, id)
  await notify(c.env, c.executionCtx, attendees.map((u) => ({ userId: u, kind: 'calendar_changed' as const, title: `Invitation: ${input.title}`, body: `${new Date(startAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}`, link: `/calendar?event=${id}` })), a.userId)
  publish(c.env, c.executionCtx, [{ type: 'calendar.event_created', room: input.projectId ? rooms.project(input.projectId) : rooms.company(), data: { eventId: id } }])
  return c.json({ id, conflicts }, 201)
})

calendar.put('/events/:id', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const ev = await one<{ organizer_id: string | null; title: string; start_at: string }>(c.env.DB, 'SELECT organizer_id, title, start_at FROM calendar_events WHERE id = ? AND cancelled_at IS NULL', id)
  if (!ev) throw notFound('Event')
  if (ev.organizer_id !== a.userId && !can(a, 'calendar.manage')) throw forbidden('Only the organiser can edit this event')
  const input = await body(c, eventSchema)
  await validateEvent(c.env.DB, a, input)
  const startAt = new Date(input.startAt).toISOString()
  const endAt = new Date(input.endAt).toISOString()
  const prev = (await many<{ user_id: string; response: string }>(c.env.DB, 'SELECT user_id, response FROM event_attendees WHERE event_id = ?', id))
  const attendees = [...new Set(input.attendeeIds)]
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE calendar_events SET title = ?, description = ?, kind = ?, start_at = ?, end_at = ?, all_day = ?, location = ?, project_id = ?, client_id = ?, department_id = ?, visibility = ?, recurrence_rule = ?, reminder_minutes = ?, updated_at = ? WHERE id = ?`,
    ).bind(input.title, input.description, input.kind, startAt, endAt, input.allDay ? 1 : 0, input.location ?? null, input.projectId ?? null, input.clientId ?? null, input.departmentId ?? null, input.visibility, input.recurrenceRule || null, input.reminderMinutes ?? null, nowIso(), id),
    c.env.DB.prepare('DELETE FROM event_attendees WHERE event_id = ?').bind(id),
    ...attendees.map((u) => c.env.DB.prepare('INSERT INTO event_attendees (event_id, user_id, response) VALUES (?, ?, ?)').bind(id, u, prev.find((p) => p.user_id === u)?.response ?? 'pending')),
    activity(c.env.DB, { actorId: a.userId, action: 'calendar.event_updated', entityType: 'calendar_event', entityId: id, projectId: input.projectId ?? null, summary: `Updated “${input.title}”${ev.start_at !== startAt ? ' (time changed)' : ''}`, ip: clientIp(c) }),
  ])
  const conflicts = await attendeeConflicts(c.env.DB, attendees, startAt, endAt, id)
  await notify(c.env, c.executionCtx, attendees.map((u) => ({ userId: u, kind: 'calendar_changed' as const, title: `Updated: ${input.title}`, link: `/calendar?event=${id}` })), a.userId)
  publish(c.env, c.executionCtx, [{ type: 'calendar.event_updated', room: input.projectId ? rooms.project(input.projectId) : rooms.company(), data: { eventId: id } }])
  return c.json({ ok: true, conflicts })
})

calendar.post('/events/:id/respond', async (c) => {
  const a = c.get('auth')
  const { response } = await body(c, z.object({ response: z.enum(['accepted', 'declined']) }))
  const r = await c.env.DB.prepare('UPDATE event_attendees SET response = ? WHERE event_id = ? AND user_id = ?').bind(response, c.req.param('id'), a.userId).run()
  if (!r.meta.changes) throw notFound('Invitation')
  publish(c.env, c.executionCtx, [{ type: 'calendar.event_updated', room: rooms.company(), data: { eventId: c.req.param('id') } }])
  return c.json({ ok: true })
})

calendar.delete('/events/:id', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const ev = await one<{ organizer_id: string | null; title: string; project_id: string | null }>(c.env.DB, 'SELECT organizer_id, title, project_id FROM calendar_events WHERE id = ? AND cancelled_at IS NULL', id)
  if (!ev) throw notFound('Event')
  if (ev.organizer_id !== a.userId && !can(a, 'calendar.manage')) throw forbidden('Only the organiser can cancel this event')
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE calendar_events SET cancelled_at = ?, updated_at = ? WHERE id = ?').bind(nowIso(), nowIso(), id),
    activity(c.env.DB, { actorId: a.userId, action: 'calendar.event_cancelled', entityType: 'calendar_event', entityId: id, projectId: ev.project_id, summary: `Cancelled “${ev.title}”`, ip: clientIp(c) }),
  ])
  const attendees = await many<{ user_id: string }>(c.env.DB, 'SELECT user_id FROM event_attendees WHERE event_id = ?', id)
  await notify(c.env, c.executionCtx, attendees.map((x) => ({ userId: x.user_id, kind: 'calendar_changed' as const, title: `Cancelled: ${ev.title}` })), a.userId)
  publish(c.env, c.executionCtx, [{ type: 'calendar.event_updated', room: ev.project_id ? rooms.project(ev.project_id) : rooms.company(), data: { eventId: id, cancelled: true } }])
  return c.json({ ok: true })
})

/** Member availability for scheduling: per day, who is on leave and who has events. */
calendar.get('/availability', async (c) => {
  const r = range(c)
  const ids = (c.req.query('userIds') ?? '').split(',').filter(Boolean).slice(0, 50)
  if (ids.length === 0) return c.json({ users: [] })
  const leave = await many<{ user_id: string; start_date: string; end_date: string; half_day: string }>(
    c.env.DB,
    `SELECT user_id, start_date, end_date, half_day FROM leave_requests WHERE status = 'approved' AND user_id IN (${placeholders(ids.length)}) AND start_date <= ? AND end_date >= ?`,
    ...ids, r.to, r.from,
  )
  const busy = await many<{ user_id: string; start_at: string; end_at: string }>(
    c.env.DB,
    `SELECT ea.user_id, e.start_at, e.end_at FROM event_attendees ea JOIN calendar_events e ON e.id = ea.event_id WHERE ea.user_id IN (${placeholders(ids.length)}) AND e.cancelled_at IS NULL AND e.recurrence_rule IS NULL AND e.start_at < ? AND e.end_at > ? AND ea.response <> 'declined'`,
    ...ids, r.toUtc, r.fromUtc,
  )
  const users = await many<{ id: string; name: string }>(c.env.DB, `SELECT id, name FROM users WHERE id IN (${placeholders(ids.length)})`, ...ids)
  return c.json({
    users: users.map((u) => ({ ...u, leave: leave.filter((l) => l.user_id === u.id), busy: busy.filter((b) => b.user_id === u.id).map((b) => ({ start: b.start_at, end: b.end_at })) })),
  })
})

// ───────── Holidays ─────────

calendar.get('/holidays', async (c) => {
  const a = c.get('auth')
  const year = Number(c.req.query('year') ?? new Date().getUTCFullYear())
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid year')
  const rows = await many(
    c.env.DB,
    `SELECT h.*, v.name AS verified_by_name FROM holidays h LEFT JOIN users v ON v.id = h.verified_by WHERE h.year = ? ${can(a, 'holidays.manage') ? '' : "AND h.status = 'verified'"} ORDER BY h.holiday_date`,
    year,
  )
  const overrides = await many(c.env.DB, `SELECT o.*, u.name AS created_by_name FROM working_day_overrides o LEFT JOIN users u ON u.id = o.created_by WHERE o.override_date LIKE ? ORDER BY o.override_date`, `${year}-%`)
  return c.json({ holidays: rows, overrides, canManage: can(a, 'holidays.manage') })
})

async function insertHolidays(db: D1Database, a: StaffAuth, list: z.infer<typeof holidaySchema>[], ip: string | null) {
  const now = nowIso()
  const stmts = list.map((h) =>
    db.prepare(
      `INSERT INTO holidays (id, holiday_date, year, name, kind, region, is_day_off, source, source_url, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_verification', ?, ?, ?)
       ON CONFLICT(holiday_date, name) DO UPDATE SET kind = excluded.kind, region = excluded.region, is_day_off = excluded.is_day_off, source = excluded.source, source_url = excluded.source_url, updated_at = excluded.updated_at`,
    ).bind(newId('hol'), h.date, Number(h.date.slice(0, 4)), h.name, h.kind, h.region, h.isDayOff ? 1 : 0, h.source, h.sourceUrl || null, a.userId, now, now),
  )
  stmts.push(activity(db, { category: 'admin', actorId: a.userId, action: 'holidays.imported', summary: `Added/updated ${list.length} holiday record(s) — pending verification`, ip }))
  await db.batch(stmts)
}

calendar.post('/holidays', requirePermission('holidays.manage'), async (c) => {
  const input = await body(c, holidaySchema)
  await insertHolidays(c.env.DB, c.get('auth'), [input], clientIp(c))
  return c.json({ ok: true }, 201)
})

calendar.post('/holidays/import', requirePermission('holidays.manage'), async (c) => {
  const { holidays } = await body(c, holidayImportSchema)
  await insertHolidays(c.env.DB, c.get('auth'), holidays, clientIp(c))
  return c.json({ ok: true, count: holidays.length })
})

calendar.put('/holidays/:id', requirePermission('holidays.manage'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, holidaySchema)
  const h = await one(c.env.DB, 'SELECT id FROM holidays WHERE id = ?', c.req.param('id'))
  if (!h) throw notFound('Holiday')
  // Any correction sends the record back for verification.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE holidays SET holiday_date = ?, year = ?, name = ?, kind = ?, region = ?, is_day_off = ?, source = ?, source_url = ?, status = 'pending_verification', verified_by = NULL, verified_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(input.date, Number(input.date.slice(0, 4)), input.name, input.kind, input.region, input.isDayOff ? 1 : 0, input.source, input.sourceUrl || null, nowIso(), c.req.param('id')),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'holiday.corrected', entityType: 'holiday', entityId: c.req.param('id'), summary: `Corrected holiday ${input.name} (${input.date})`, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

calendar.post('/holidays/:id/verify', requirePermission('holidays.manage'), async (c) => {
  const a = c.get('auth')
  const { status } = await body(c, z.object({ status: z.enum(['verified', 'rejected']) }))
  const h = await one<{ name: string; holiday_date: string; source: string }>(c.env.DB, 'SELECT name, holiday_date, source FROM holidays WHERE id = ?', c.req.param('id'))
  if (!h) throw notFound('Holiday')
  if (status === 'verified' && !h.source.trim()) throw new ApiError(422, 'VALIDATION_FAILED', 'Record the official source (e.g. the G.O. number) before verifying', { fields: { source: 'Required for verification' } })
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE holidays SET status = ?, verified_by = ?, verified_at = ?, updated_at = ? WHERE id = ?').bind(status, a.userId, nowIso(), nowIso(), c.req.param('id')),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: `holiday.${status}`, entityType: 'holiday', entityId: c.req.param('id'), summary: `${status === 'verified' ? 'Verified' : 'Rejected'} holiday ${h.name} (${h.holiday_date})`, ip: clientIp(c) }),
  ])
  publish(c.env, c.executionCtx, [{ type: 'calendar.event_updated', room: rooms.company(), data: { holidayId: c.req.param('id') } }])
  return c.json({ ok: true })
})

calendar.delete('/holidays/:id', requirePermission('holidays.manage'), async (c) => {
  const a = c.get('auth')
  const h = await one<{ name: string; holiday_date: string }>(c.env.DB, 'SELECT name, holiday_date FROM holidays WHERE id = ?', c.req.param('id'))
  if (!h) throw notFound('Holiday')
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM holidays WHERE id = ?').bind(c.req.param('id')),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'holiday.deleted', entityType: 'holiday', entityId: c.req.param('id'), summary: `Deleted holiday ${h.name} (${h.holiday_date})`, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

calendar.post('/overrides', requirePermission('holidays.manage'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, overrideSchema)
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO working_day_overrides (override_date, is_working, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(override_date) DO UPDATE SET is_working = excluded.is_working, reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at`)
      .bind(input.date, input.isWorking ? 1 : 0, input.reason, a.userId, nowIso()),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'workday.override', summary: `${input.date} set as ${input.isWorking ? 'working day' : 'day off'}: ${input.reason}`, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

calendar.delete('/overrides/:date', requirePermission('holidays.manage'), async (c) => {
  const a = c.get('auth')
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM working_day_overrides WHERE override_date = ?').bind(c.req.param('date')),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'workday.override_removed', summary: `Removed working-day override for ${c.req.param('date')}`, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

calendar.get('/workdays', async (c) => {
  const r = range(c)
  const ww = await getWorkweek(c.env.DB)
  const src = await getDayOffSource(c.env.DB, r.from, r.to)
  return c.json({ days: eachDate(r.from, r.to).map((d) => classifyDay(d, ww, src)), workweek: ww })
})

// ───────── Export (iCalendar / CSV) ─────────

const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const icsStamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')

calendar.get('/export.ics', async (c) => {
  const a = c.get('auth')
  const year = Number(c.req.query('year') ?? new Date().getUTCFullYear())
  const holidaysOnly = c.req.query('holidays') === '1'
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Visionary X//Operations//EN', 'CALSCALE:GREGORIAN', 'X-WR-TIMEZONE:Asia/Kolkata']
  const hol = await many<{ id: string; holiday_date: string; name: string; kind: string; region: string }>(c.env.DB, `SELECT id, holiday_date, name, kind, region FROM holidays WHERE year = ? AND status = 'verified' ORDER BY holiday_date`, year)
  for (const h of hol) {
    lines.push('BEGIN:VEVENT', `UID:${h.id}@visionary-x.in`, `DTSTAMP:${icsStamp(nowIso())}`, `DTSTART;VALUE=DATE:${h.holiday_date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(h.holiday_date, 1).replace(/-/g, '')}`, `SUMMARY:${icsEscape(h.name)}`, `CATEGORIES:${h.kind.toUpperCase()},${h.region}`, 'TRANSP:TRANSPARENT', 'END:VEVENT')
  }
  if (!holidaysOnly) {
    const vf = await visibleEventsFilter(c.env.DB, a)
    const evs = await many<{ id: string; title: string; description: string; start_at: string; end_at: string; location: string | null; recurrence_rule: string | null }>(
      c.env.DB,
      `SELECT e.id, e.title, e.description, e.start_at, e.end_at, e.location, e.recurrence_rule FROM calendar_events e WHERE ${vf.sql} AND e.cancelled_at IS NULL AND substr(e.start_at, 1, 4) = ?`,
      ...vf.params, String(year),
    )
    for (const e of evs) {
      lines.push('BEGIN:VEVENT', `UID:${e.id}@visionary-x.in`, `DTSTAMP:${icsStamp(nowIso())}`, `DTSTART:${icsStamp(e.start_at)}`, `DTEND:${icsStamp(e.end_at)}`, `SUMMARY:${icsEscape(e.title)}`)
      if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`)
      if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`)
      if (e.recurrence_rule) lines.push(`RRULE:${e.recurrence_rule}`)
      lines.push('END:VEVENT')
    }
  }
  lines.push('END:VCALENDAR')
  return new Response(lines.join('\r\n'), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="visionaryx-${holidaysOnly ? 'holidays' : 'calendar'}-${year}.ics"`, 'cache-control': 'no-store' } })
})

export default calendar
