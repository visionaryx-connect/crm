import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { attendanceCorrectionSchema, attendanceManualSchema, decisionSchema, leaveRequestSchema } from '@shared/schemas'
import { eachDate, isValidDate, localDate, localDateTimeToUtc, monthBounds } from '@shared/dates'
import { classifyDay, leaveDays } from '@shared/workdays'
import { activity } from '../lib/audit'
import { canViewMember } from '../lib/authz'
import { newId } from '../lib/crypto'
import { many, nowIso, one } from '../lib/db'
import { ApiError, body, clientIp, conflict, forbidden, notFound, query } from '../lib/http'
import { can, requirePermission, requireStaff } from '../lib/session'
import { notify, usersWithPermission } from '../services/notify'
import { publish, rooms } from '../services/realtime'
import { getDayOffSource, getSetting, getWorkweek } from '../services/settings'

const hr = new Hono<AppBindings>()
hr.use('*', requireStaff())

// ───────── Leave ─────────

hr.get('/leave-types', async (c) => c.json({ types: await many(c.env.DB, 'SELECT * FROM leave_types WHERE active = 1 ORDER BY name') }))

hr.put('/leave-types/:id', requirePermission('leave.manage'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, z.object({ name: z.string().trim().min(2).max(60), annualQuota: z.number().min(0).max(365).nullable(), isPaid: z.boolean(), active: z.boolean() }))
  const r = await c.env.DB.prepare('UPDATE leave_types SET name = ?, annual_quota = ?, is_paid = ?, active = ? WHERE id = ?').bind(input.name, input.annualQuota, input.isPaid ? 1 : 0, input.active ? 1 : 0, c.req.param('id')).run()
  if (!r.meta.changes) throw notFound('Leave type')
  await activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'leave_type.updated', entityType: 'leave_type', entityId: c.req.param('id'), summary: `Updated leave type ${input.name}`, ip: clientIp(c) }).run()
  return c.json({ ok: true })
})

/** Balance = allocation (explicit row, else the type's annual quota) + adjustment − approved days in that year. */
async function balances(db: D1Database, userId: string, year: number) {
  return many<Record<string, unknown>>(
    db,
    `SELECT lt.id AS leave_type_id, lt.code, lt.name, lt.is_paid, lt.annual_quota,
            COALESCE(lb.allocated, lt.annual_quota) AS allocated, COALESCE(lb.adjustment, 0) AS adjustment,
            (SELECT COALESCE(SUM(l.days), 0) FROM leave_requests l WHERE l.user_id = ? AND l.leave_type_id = lt.id AND l.status = 'approved' AND substr(l.start_date, 1, 4) = ?) AS used,
            (SELECT COALESCE(SUM(l.days), 0) FROM leave_requests l WHERE l.user_id = ? AND l.leave_type_id = lt.id AND l.status = 'pending' AND substr(l.start_date, 1, 4) = ?) AS pending
       FROM leave_types lt LEFT JOIN leave_balances lb ON lb.leave_type_id = lt.id AND lb.user_id = ? AND lb.year = ?
      WHERE lt.active = 1 ORDER BY lt.name`,
    userId, String(year), userId, String(year), userId, year,
  )
}

hr.get('/leave/balances', async (c) => {
  const a = c.get('auth')
  const userId = query(c, 'userId') ?? a.userId
  if (userId !== a.userId && !can(a, 'leave.approve') && !(await canViewMember(c.env.DB, a, userId))) throw forbidden()
  const year = Number(query(c, 'year') ?? localDate().slice(0, 4))
  const rows = await balances(c.env.DB, userId, year)
  return c.json({
    balances: rows.map((r) => ({ ...r, is_paid: Boolean(r.is_paid), remaining: r.allocated == null ? null : Number(r.allocated) + Number(r.adjustment) - Number(r.used) })),
  })
})

hr.put('/leave/balances', requirePermission('leave.manage'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, z.object({ userId: z.string(), leaveTypeId: z.string(), year: z.number().int().min(2000).max(2100), allocated: z.number().min(0).max(365), adjustment: z.number().min(-365).max(365), note: z.string().trim().max(300).default('') }))
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO leave_balances (user_id, leave_type_id, year, allocated, adjustment, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(user_id, leave_type_id, year) DO UPDATE SET allocated = excluded.allocated, adjustment = excluded.adjustment, note = excluded.note, updated_at = excluded.updated_at`)
      .bind(input.userId, input.leaveTypeId, input.year, input.allocated, input.adjustment, input.note, nowIso()),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'leave.balance_set', entityType: 'user', entityId: input.userId, summary: `Set leave balance (${input.year}): allocated ${input.allocated}, adjustment ${input.adjustment}`, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

hr.post('/leave/preview', async (c) => {
  const input = await body(c, leaveRequestSchema)
  const ww = await getWorkweek(c.env.DB)
  const src = await getDayOffSource(c.env.DB, input.startDate, input.endDate)
  const days = eachDate(input.startDate, input.endDate).map((d) => classifyDay(d, ww, src))
  return c.json({ days, chargeable: leaveDays(input.startDate, input.endDate, input.halfDay, ww, src) })
})

hr.get('/leave', async (c) => {
  const a = c.get('auth')
  const scope = query(c, 'scope') ?? 'mine' // mine | approvals | all
  const where: string[] = []
  const params: unknown[] = []
  if (scope === 'mine') {
    where.push('l.user_id = ?')
    params.push(a.userId)
  } else if (scope === 'approvals') {
    if (can(a, 'leave.approve')) where.push('1 = 1')
    else {
      // Reporting managers approve their direct reports.
      where.push('ep.manager_user_id = ?')
      params.push(a.userId)
    }
  } else {
    if (!can(a, 'leave.approve')) throw forbidden()
  }
  const status = query(c, 'status')
  if (status) {
    where.push('l.status = ?')
    params.push(status)
  }
  const rows = await many(
    c.env.DB,
    `SELECT l.*, u.name AS user_name, lt.name AS type_name, d.name AS decided_by_name, dep.name AS department_name
       FROM leave_requests l JOIN users u ON u.id = l.user_id JOIN leave_types lt ON lt.id = l.leave_type_id LEFT JOIN users d ON d.id = l.decided_by
       LEFT JOIN employee_profiles ep ON ep.user_id = l.user_id LEFT JOIN departments dep ON dep.id = ep.department_id
      WHERE ${where.join(' AND ') || '1 = 1'} ORDER BY l.status = 'pending' DESC, l.start_date DESC LIMIT 300`,
    ...params,
  )
  return c.json({ requests: rows })
})

hr.post('/leave', requirePermission('leave.request'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, leaveRequestSchema)
  const type = await one<{ name: string; annual_quota: number | null }>(c.env.DB, 'SELECT name, annual_quota FROM leave_types WHERE id = ? AND active = 1', input.leaveTypeId)
  if (!type) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a leave type', { fields: { leaveTypeId: 'Unknown leave type' } })
  const ww = await getWorkweek(c.env.DB)
  const src = await getDayOffSource(c.env.DB, input.startDate, input.endDate)
  const days = leaveDays(input.startDate, input.endDate, input.halfDay, ww, src)
  if (days === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'The selected dates are all weekends or holidays', { fields: { startDate: 'No working days in range' } })
  const overlap = await one(c.env.DB, `SELECT 1 AS x FROM leave_requests WHERE user_id = ? AND status IN ('pending','approved') AND start_date <= ? AND end_date >= ?`, a.userId, input.endDate, input.startDate)
  if (overlap) throw conflict('You already have leave requested for some of these dates')
  if (type.annual_quota != null) {
    const bal = (await balances(c.env.DB, a.userId, Number(input.startDate.slice(0, 4)))).find((b) => b.leave_type_id === input.leaveTypeId)
    const remaining = bal ? Number(bal.allocated) + Number(bal.adjustment) - Number(bal.used) - Number(bal.pending) : 0
    if (days > remaining) throw new ApiError(422, 'VALIDATION_FAILED', `Only ${remaining} day(s) of ${type.name} available`, { fields: { leaveTypeId: 'Insufficient balance' } })
  }
  const id = newId('lv')
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO leave_requests (id, user_id, leave_type_id, start_date, end_date, half_day, days, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, a.userId, input.leaveTypeId, input.startDate, input.endDate, input.halfDay, days, input.reason, now, now),
    activity(c.env.DB, { actorId: a.userId, action: 'leave.requested', entityType: 'leave_request', entityId: id, summary: `Requested ${days} day(s) of ${type.name} (${input.startDate} – ${input.endDate})` }),
  ])
  const manager = await one<{ manager_user_id: string | null }>(c.env.DB, 'SELECT manager_user_id FROM employee_profiles WHERE user_id = ?', a.userId)
  const approvers = new Set([...(await usersWithPermission(c.env.DB, 'leave.approve')), ...(manager?.manager_user_id ? [manager.manager_user_id] : [])])
  await notify(c.env, c.executionCtx, [...approvers].map((u) => ({ userId: u, kind: 'leave_requested' as const, title: `${a.name} requested leave`, body: `${type.name}: ${input.startDate} – ${input.endDate} (${days} day${days === 1 ? '' : 's'})`, link: '/hr/leave?tab=approvals', entityType: 'leave_request', entityId: id })), a.userId)
  publish(c.env, c.executionCtx, [{ type: 'leave.requested', room: rooms.perm('leave.approve'), data: { leaveId: id } }])
  return c.json({ id, days }, 201)
})

hr.post('/leave/:id/decide', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const l = await one<{ user_id: string; status: string; start_date: string; end_date: string; days: number; type_name: string; manager_user_id: string | null }>(
    c.env.DB,
    'SELECT l.user_id, l.status, l.start_date, l.end_date, l.days, lt.name AS type_name, ep.manager_user_id FROM leave_requests l JOIN leave_types lt ON lt.id = l.leave_type_id LEFT JOIN employee_profiles ep ON ep.user_id = l.user_id WHERE l.id = ?',
    id,
  )
  if (!l) throw notFound('Leave request')
  if (!can(a, 'leave.approve') && l.manager_user_id !== a.userId) throw forbidden()
  if (l.user_id === a.userId) throw forbidden('You cannot decide your own leave request')
  if (l.status !== 'pending') throw conflict('This request has already been decided')
  const input = await body(c, decisionSchema)
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?').bind(input.decision, a.userId, now, input.note, now, id),
    activity(c.env.DB, { actorId: a.userId, action: `leave.${input.decision}`, entityType: 'leave_request', entityId: id, summary: `${input.decision === 'approved' ? 'Approved' : 'Rejected'} ${l.type_name} ${l.start_date} – ${l.end_date}` }),
  ])
  await notify(c.env, c.executionCtx, [{ userId: l.user_id, kind: 'leave_decision', title: `Leave ${input.decision}: ${l.start_date} – ${l.end_date}`, body: input.note, link: '/hr/leave' }], a.userId)
  publish(c.env, c.executionCtx, [
    { type: 'leave.approved', room: rooms.user(l.user_id), data: { leaveId: id, decision: input.decision } },
    ...(input.decision === 'approved' ? [{ type: 'calendar.event_updated' as const, room: rooms.company(), data: { leaveId: id } }] : []),
  ])
  return c.json({ ok: true })
})

hr.post('/leave/:id/cancel', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const l = await one<{ user_id: string; status: string; start_date: string }>(c.env.DB, 'SELECT user_id, status, start_date FROM leave_requests WHERE id = ?', id)
  if (!l) throw notFound('Leave request')
  if (l.user_id !== a.userId && !can(a, 'leave.approve')) throw forbidden()
  if (!['pending', 'approved'].includes(l.status)) throw conflict('Nothing to cancel')
  if (l.status === 'approved' && l.start_date <= localDate() && !can(a, 'leave.approve')) throw conflict('Leave that has started can only be cancelled by HR')
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE leave_requests SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(nowIso(), id),
    activity(c.env.DB, { actorId: a.userId, action: 'leave.cancelled', entityType: 'leave_request', entityId: id, summary: 'Cancelled a leave request' }),
  ])
  publish(c.env, c.executionCtx, [{ type: 'calendar.event_updated', room: rooms.company(), data: { leaveId: id } }])
  return c.json({ ok: true })
})

// ───────── Attendance ─────────

hr.get('/attendance/today', async (c) => {
  const a = c.get('auth')
  const today = localDate()
  const rec = await one(c.env.DB, 'SELECT * FROM attendance_records WHERE user_id = ? AND work_date = ?', a.userId, today)
  const ww = await getWorkweek(c.env.DB)
  const src = await getDayOffSource(c.env.DB, today, today)
  return c.json({ record: rec, day: classifyDay(today, ww, src) })
})

hr.post('/attendance/check-in', requirePermission('attendance.self'), async (c) => {
  const a = c.get('auth')
  const today = localDate()
  const remote = c.req.query('remote') === '1'
  const existing = await one<{ check_in_at: string | null }>(c.env.DB, 'SELECT check_in_at FROM attendance_records WHERE user_id = ? AND work_date = ?', a.userId, today)
  if (existing?.check_in_at) throw conflict('Already checked in today')
  const now = nowIso()
  await c.env.DB.prepare(
    `INSERT INTO attendance_records (id, user_id, work_date, check_in_at, status, source, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'self', ?, ?, ?)
     ON CONFLICT(user_id, work_date) DO UPDATE SET check_in_at = excluded.check_in_at, status = excluded.status, updated_at = excluded.updated_at`,
  ).bind(newId('att'), a.userId, today, now, remote ? 'remote' : 'present', now, now, a.userId).run()
  return c.json({ ok: true, at: now })
})

hr.post('/attendance/check-out', requirePermission('attendance.self'), async (c) => {
  const a = c.get('auth')
  const today = localDate()
  const rec = await one<{ id: string; check_in_at: string | null; check_out_at: string | null }>(c.env.DB, 'SELECT id, check_in_at, check_out_at FROM attendance_records WHERE user_id = ? AND work_date = ?', a.userId, today)
  if (!rec?.check_in_at) throw conflict('Check in first')
  if (rec.check_out_at) throw conflict('Already checked out today')
  const now = nowIso()
  const hours = (Date.parse(now) - Date.parse(rec.check_in_at)) / 3600_000
  const { halfDayHours } = await getSetting(c.env.DB, 'workdays.hours')
  await c.env.DB.prepare(`UPDATE attendance_records SET check_out_at = ?, status = CASE WHEN status = 'remote' THEN 'remote' WHEN ? < ? THEN 'half_day' ELSE 'present' END, updated_at = ? WHERE id = ?`)
    .bind(now, hours, halfDayHours, now, rec.id)
    .run()
  return c.json({ ok: true, at: now, hours: Math.round(hours * 100) / 100 })
})

/**
 * Monthly attendance sheet. Day status combines records with the working-day calendar: weekends and verified
 * holidays are never treated as absences; approved leave shows as leave; a working day in the past with no
 * record shows as "no record" (not automatically "absent").
 */
hr.get('/attendance', async (c) => {
  const a = c.get('auth')
  const month = query(c, 'month') ?? localDate().slice(0, 7)
  const { start, end } = monthBounds(month)
  const userId = query(c, 'userId')
  const all = can(a, 'attendance.manage')
  let userIds: string[]
  if (userId) {
    if (userId !== a.userId && !all && !(await canViewMember(c.env.DB, a, userId))) throw forbidden()
    userIds = [userId]
  } else if (all) {
    const dep = query(c, 'departmentId')
    userIds = (await many<{ id: string }>(c.env.DB, `SELECT u.id FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id WHERE u.status = 'active' ${dep ? 'AND ep.department_id = ?' : ''} ORDER BY u.name`, ...(dep ? [dep] : []))).map((r) => r.id)
  } else {
    userIds = [a.userId]
  }
  const ww = await getWorkweek(c.env.DB)
  const src = await getDayOffSource(c.env.DB, start, end)
  const days = eachDate(start, end).map((d) => classifyDay(d, ww, src))
  const today = localDate()
  const people = []
  for (const uid of userIds.slice(0, 200)) {
    const user = await one<{ name: string; joining_date: string | null; exit_date: string | null }>(c.env.DB, 'SELECT u.name, ep.joining_date, ep.exit_date FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id WHERE u.id = ?', uid)
    const recs = await many<{ work_date: string; status: string; check_in_at: string | null; check_out_at: string | null; source: string; note: string }>(c.env.DB, 'SELECT work_date, status, check_in_at, check_out_at, source, note FROM attendance_records WHERE user_id = ? AND work_date BETWEEN ? AND ?', uid, start, end)
    const leaves = await many<{ start_date: string; end_date: string; half_day: string; type_name: string }>(
      c.env.DB,
      `SELECT l.start_date, l.end_date, l.half_day, lt.name AS type_name FROM leave_requests l JOIN leave_types lt ON lt.id = l.leave_type_id WHERE l.user_id = ? AND l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ?`,
      uid, end, start,
    )
    const summary = { present: 0, remote: 0, half_day: 0, absent: 0, leave: 0, holiday: 0, weekend: 0, no_record: 0, working_days: 0 }
    const cells = days.map((d) => {
      const rec = recs.find((r) => r.work_date === d.date)
      const lv = leaves.find((l) => l.start_date <= d.date && l.end_date >= d.date)
      const beforeJoin = user?.joining_date && d.date < user.joining_date
      const afterExit = user?.exit_date && d.date > user.exit_date
      let status: string
      if (beforeJoin || afterExit) status = 'not_employed'
      else if (!d.working) status = d.kind === 'holiday' || d.kind === 'override_off' ? 'holiday' : 'weekend'
      else if (lv && lv.half_day === 'none') status = 'leave'
      else if (rec) status = rec.status
      else if (lv) status = 'leave'
      else if (d.date >= today) status = 'upcoming'
      else status = 'no_record'
      if (d.working && !beforeJoin && !afterExit) summary.working_days++
      if (status in summary) (summary as Record<string, number>)[status]++
      return { date: d.date, status, checkIn: rec?.check_in_at ?? null, checkOut: rec?.check_out_at ?? null, source: rec?.source ?? null, leaveType: lv?.type_name ?? null, label: d.label ?? null }
    })
    people.push({ userId: uid, name: user?.name ?? '', cells, summary })
  }
  return c.json({ month, days, people, canManage: all })
})

hr.post('/attendance/corrections', requirePermission('attendance.self'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, attendanceCorrectionSchema)
  if (input.workDate > localDate()) throw new ApiError(422, 'VALIDATION_FAILED', 'Corrections are for past or current dates', { fields: { workDate: 'Choose today or earlier' } })
  const id = newId('acr')
  await c.env.DB.prepare(`INSERT INTO attendance_corrections (id, user_id, work_date, requested_check_in, requested_check_out, requested_status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, a.userId, input.workDate, input.requestedCheckIn ?? null, input.requestedCheckOut ?? null, input.requestedStatus, input.reason, nowIso())
    .run()
  const approvers = await usersWithPermission(c.env.DB, 'attendance.manage')
  await notify(c.env, c.executionCtx, approvers.map((u) => ({ userId: u, kind: 'leave_requested' as const, title: `Attendance correction from ${a.name}`, body: `${input.workDate}: ${input.reason}`, link: '/hr/attendance?tab=corrections' })), a.userId)
  return c.json({ id }, 201)
})

hr.get('/attendance/corrections', async (c) => {
  const a = c.get('auth')
  const all = can(a, 'attendance.manage')
  const rows = await many(
    c.env.DB,
    `SELECT ac.*, u.name AS user_name, d.name AS decided_by_name FROM attendance_corrections ac JOIN users u ON u.id = ac.user_id LEFT JOIN users d ON d.id = ac.decided_by
      WHERE ${all ? '1 = 1' : 'ac.user_id = ?'} ORDER BY ac.status = 'pending' DESC, ac.created_at DESC LIMIT 200`,
    ...(all ? [] : [a.userId]),
  )
  return c.json({ corrections: rows, canManage: all })
})

hr.post('/attendance/corrections/:id/decide', requirePermission('attendance.manage'), async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const cr = await one<{ user_id: string; work_date: string; requested_check_in: string | null; requested_check_out: string | null; requested_status: string; status: string }>(c.env.DB, 'SELECT * FROM attendance_corrections WHERE id = ?', id)
  if (!cr) throw notFound('Correction')
  if (cr.status !== 'pending') throw conflict('Already decided')
  if (cr.user_id === a.userId) throw forbidden('You cannot approve your own correction')
  const input = await body(c, decisionSchema)
  const now = nowIso()
  const stmts = [
    c.env.DB.prepare('UPDATE attendance_corrections SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').bind(input.decision, a.userId, now, input.note, id),
  ]
  if (input.decision === 'approved') {
    const before = await one(c.env.DB, 'SELECT * FROM attendance_records WHERE user_id = ? AND work_date = ?', cr.user_id, cr.work_date)
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO attendance_records (id, user_id, work_date, check_in_at, check_out_at, status, source, note, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'correction', ?, ?, ?, ?)
         ON CONFLICT(user_id, work_date) DO UPDATE SET check_in_at = excluded.check_in_at, check_out_at = excluded.check_out_at, status = excluded.status, source = 'correction', note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).bind(newId('att'), cr.user_id, cr.work_date, cr.requested_check_in ? localDateTimeToUtc(cr.work_date, cr.requested_check_in) : null, cr.requested_check_out ? localDateTimeToUtc(cr.work_date, cr.requested_check_out) : null, cr.requested_status, `Correction ${id}`, now, now, a.userId),
      activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'attendance.corrected', entityType: 'user', entityId: cr.user_id, summary: `Approved attendance correction for ${cr.work_date}`, changes: { before, after: { status: cr.requested_status, checkIn: cr.requested_check_in, checkOut: cr.requested_check_out } }, ip: clientIp(c) }),
    )
  }
  await c.env.DB.batch(stmts)
  await notify(c.env, c.executionCtx, [{ userId: cr.user_id, kind: 'leave_decision', title: `Attendance correction ${input.decision} (${cr.work_date})`, body: input.note, link: '/hr/attendance' }], a.userId)
  return c.json({ ok: true })
})

/** Direct edit by HR — always audited with before/after values and a reason. */
hr.put('/attendance', requirePermission('attendance.manage'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, attendanceManualSchema)
  if (!isValidDate(input.workDate) || input.workDate > localDate()) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose today or an earlier date', { fields: { workDate: 'Invalid date' } })
  const before = await one(c.env.DB, 'SELECT * FROM attendance_records WHERE user_id = ? AND work_date = ?', input.userId, input.workDate)
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO attendance_records (id, user_id, work_date, check_in_at, check_out_at, status, source, note, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)
       ON CONFLICT(user_id, work_date) DO UPDATE SET check_in_at = excluded.check_in_at, check_out_at = excluded.check_out_at, status = excluded.status, source = 'manual', note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(newId('att'), input.userId, input.workDate, input.checkIn ? localDateTimeToUtc(input.workDate, input.checkIn) : null, input.checkOut ? localDateTimeToUtc(input.workDate, input.checkOut) : null, input.status, input.note, now, now, a.userId),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'attendance.manual_edit', entityType: 'user', entityId: input.userId, summary: `Edited attendance for ${input.workDate}: ${input.note}`, changes: { before, after: input }, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

export default hr
