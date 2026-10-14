import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { as, call, scaffoldProject } from './helpers'
import { companyReport, memberReport, projectReport } from '../worker/services/reports'
import { deadlineReminders } from '../worker/services/scheduled'

describe('report period boundaries', () => {
  it('assigns completions to the IST month they happened in', async () => {
    const admin = await as('super_admin')
    const pm = await as('project_manager')
    const dev = await as('employee')
    const { projectId } = await scaffoldProject(admin.agent, pm.id, [{ id: dev.id }])
    const mk = async (title: string, due: string) => (await call(pm.agent, 'POST', '/api/tasks', { projectId, title, responsibleId: dev.id, requiresApproval: false, dueDate: due })).json.id as string
    const sept = await mk('Late September', '2026-09-30')
    const oct = await mk('Just after midnight IST', '2026-09-30')
    const open = await mk('Still open', '2026-09-15')
    // Backdate creation, then record completions on either side of IST midnight (18:30 UTC).
    await env.DB.prepare(`UPDATE tasks SET created_at = '2026-08-20T05:00:00.000Z' WHERE project_id = ?`).bind(projectId).run()
    await env.DB.prepare(`UPDATE task_status_history SET changed_at = '2026-08-20T05:00:00.000Z' WHERE project_id = ?`).bind(projectId).run()
    await env.DB.prepare(`UPDATE projects SET created_at = '2026-08-01T05:00:00.000Z' WHERE id = ?`).bind(projectId).run()
    await env.DB.prepare(`UPDATE project_status_history SET changed_at = '2026-08-01T05:00:00.000Z' WHERE project_id = ?`).bind(projectId).run()
    const done = (id: string, at: string) =>
      env.DB.batch([
        env.DB.prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`).bind(at, id),
        env.DB.prepare(`INSERT INTO task_status_history (id, task_id, project_id, from_status, to_status, changed_at) VALUES (?, ?, ?, 'in_progress', 'completed', ?)`).bind(`h_${id}`, id, projectId, at),
      ])
    await done(sept, '2026-09-30T18:29:59.000Z') // 23:59:59 IST, 30 Sep
    await done(oct, '2026-09-30T18:30:00.000Z') // 00:00:00 IST, 1 Oct

    const sep = await projectReport(env.DB, projectId, '2026-09-01', '2026-09-30')
    const val = (r: typeof sep, k: string) => r.summary.find((s) => s.key === k)?.value
    expect(val(sep, 'completed')).toBe(1)
    expect(sep.tables.find((t) => t.key === 'completed')!.rows.map((r) => r.title)).toEqual(['Late September'])
    // Open at end of September: the task completed at 00:00 IST on 1 Oct, plus the never-completed one.
    expect(val(sep, 'outstanding')).toBe(2)
    expect(val(sep, 'delayed')).toBe(1) // only 'Still open' had a due date before 30 Sep
    const octR = await projectReport(env.DB, projectId, '2026-10-01', '2026-10-31')
    expect(val(octR, 'completed')).toBe(1)
    expect(val(octR, 'opening_status')).toBe('in_progress')

    const mem = await memberReport(env.DB, dev.id, '2026-09-01', '2026-09-30')
    expect(mem.summary.find((s) => s.key === 'completed')?.value).toBe(1)
    expect(mem.summary.find((s) => s.key === 'on_time')?.value).toBe(1)
    const company = await companyReport(env.DB, '2026-09-01', '2026-09-30')
    expect(company.summary.find((s) => s.key === 'tasks_completed')?.value).toBeGreaterThanOrEqual(1)
    void open
  })

  it('reports missing history as unavailable rather than inventing it', async () => {
    const admin = await as('super_admin')
    const pm = await as('project_manager')
    const { projectId } = await scaffoldProject(admin.agent, pm.id)
    const r = await projectReport(env.DB, projectId, '2020-01-01', '2020-01-31')
    expect(r.summary.find((s) => s.key === 'progress_end')?.value).toBeNull()
    expect(r.summary.find((s) => s.key === 'opening_status')?.value).toBeNull()
    expect(r.notes.length).toBeGreaterThan(0)
  })

  it('enforces report permissions', async () => {
    const emp = await as('employee')
    const other = await as('employee')
    expect((await call(emp.agent, 'GET', '/api/reports/run?type=company&start=2026-09-01&end=2026-09-30')).status).toBe(403)
    expect((await call(emp.agent, 'GET', `/api/reports/run?type=member&scopeId=${emp.id}&start=2026-09-01&end=2026-09-30`)).status).toBe(200)
    expect((await call(emp.agent, 'GET', `/api/reports/run?type=member&scopeId=${other.id}&start=2026-09-01&end=2026-09-30`)).status).toBe(403)
  })
})

describe('calendar, holidays and leave', () => {
  it('holidays need a source before verification and only verified holidays affect leave', async () => {
    const hr = await as('hr_manager')
    const emp = await as('employee')
    // 2027-03-01 is a Monday. Request Mon–Wed.
    await call(hr.agent, 'POST', '/api/calendar/holidays', { date: '2027-03-02', name: 'Test holiday', kind: 'state', region: 'IN-TN', source: '' })
    const list = await call(hr.agent, 'GET', '/api/calendar/holidays?year=2027')
    const h = list.json.holidays.find((x: { name: string }) => x.name === 'Test holiday')
    expect(h.status).toBe('pending_verification')
    let prev = await call(emp.agent, 'POST', '/api/hr/leave/preview', { leaveTypeId: 'lt_casual', startDate: '2027-03-01', endDate: '2027-03-03' })
    expect(prev.json.chargeable).toBe(3)
    expect((await call(hr.agent, 'POST', `/api/calendar/holidays/${h.id}/verify`, { status: 'verified' })).status).toBe(422)
    await call(hr.agent, 'PUT', `/api/calendar/holidays/${h.id}`, { date: '2027-03-02', name: 'Test holiday', kind: 'state', region: 'IN-TN', source: 'G.O. test 1' })
    expect((await call(hr.agent, 'POST', `/api/calendar/holidays/${h.id}/verify`, { status: 'verified' })).status).toBe(200)
    prev = await call(emp.agent, 'POST', '/api/hr/leave/preview', { leaveTypeId: 'lt_casual', startDate: '2027-03-01', endDate: '2027-03-03' })
    expect(prev.json.chargeable).toBe(2)
    // Employees cannot maintain holidays.
    expect((await call(emp.agent, 'POST', '/api/calendar/holidays', { date: '2027-03-09', name: 'Nope', kind: 'company', region: 'COMPANY' })).status).toBe(403)
  })

  it('leave approval workflow with balance and overlap checks', async () => {
    const hr = await as('hr_manager')
    const emp = await as('employee')
    const req = await call(emp.agent, 'POST', '/api/hr/leave', { leaveTypeId: 'lt_casual', startDate: '2027-04-05', endDate: '2027-04-06', reason: 'Trip' })
    expect(req.status).toBe(201)
    expect(req.json.days).toBe(2)
    expect((await call(emp.agent, 'POST', '/api/hr/leave', { leaveTypeId: 'lt_casual', startDate: '2027-04-06', endDate: '2027-04-07' })).status).toBe(409)
    expect((await call(emp.agent, 'POST', '/api/hr/leave', { leaveTypeId: 'lt_casual', startDate: '2027-05-03', endDate: '2027-05-31' })).status).toBe(422)
    expect((await call(emp.agent, 'POST', `/api/hr/leave/${req.json.id}/decide`, { decision: 'approved' })).status).toBe(403)
    expect((await call(hr.agent, 'POST', `/api/hr/leave/${req.json.id}/decide`, { decision: 'approved' })).status).toBe(200)
    const bal = await call(emp.agent, 'GET', '/api/hr/leave/balances?year=2027')
    expect(bal.json.balances.find((b: { code: string }) => b.code === 'CL').remaining).toBe(10)
  })

  it('attendance never marks weekends or holidays as absences', async () => {
    const emp = await as('employee')
    const r = await call(emp.agent, 'GET', '/api/hr/attendance?month=2026-08')
    const cells = r.json.people[0].cells as { date: string; status: string }[]
    expect(cells.find((c) => c.date === '2026-08-02')!.status).toBe('weekend') // Sunday
    expect(cells.filter((c) => c.status === 'absent')).toHaveLength(0)
  })

  it('events validate recurrence and warn about attendee conflicts', async () => {
    const pm = await as('project_manager')
    const dev = await as('employee')
    const bad = await call(pm.agent, 'POST', '/api/calendar/events', { title: 'x', kind: 'internal_meeting', startAt: '2027-01-04T05:00:00.000Z', endAt: '2027-01-04T06:00:00.000Z', recurrenceRule: 'FREQ=HOURLY' })
    expect(bad.status).toBe(422)
    const first = await call(pm.agent, 'POST', '/api/calendar/events', { title: 'Sync', kind: 'internal_meeting', startAt: '2027-01-04T05:00:00.000Z', endAt: '2027-01-04T06:00:00.000Z', attendeeIds: [dev.id] })
    expect(first.status).toBe(201)
    const clash = await call(pm.agent, 'POST', '/api/calendar/events', { title: 'Overlap', kind: 'internal_meeting', startAt: '2027-01-04T05:30:00.000Z', endAt: '2027-01-04T06:30:00.000Z', attendeeIds: [dev.id] })
    expect(clash.json.conflicts.some((x: { type: string }) => x.type === 'event')).toBe(true)
    // Only the organiser (or calendar managers) may edit.
    expect((await call(dev.agent, 'DELETE', `/api/calendar/events/${first.json.id}`)).status).toBe(403)
    // Ordinary staff cannot create company-wide events.
    expect((await call(dev.agent, 'POST', '/api/calendar/events', { title: 'Party', kind: 'company_event', startAt: '2027-01-05T05:00:00.000Z', endAt: '2027-01-05T06:00:00.000Z' })).status).toBe(403)
  })

  it('deadline reminders are deduplicated per day', async () => {
    const admin = await as('super_admin')
    const pm = await as('project_manager')
    const dev = await as('employee')
    const { projectId } = await scaffoldProject(admin.agent, pm.id, [{ id: dev.id }])
    await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Due tomorrow', responsibleId: dev.id, dueDate: '2030-06-11' })
    const waiter = { waitUntil: () => undefined }
    await deadlineReminders(env, waiter, '2030-06-10')
    await deadlineReminders(env, waiter, '2030-06-10')
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'task_due_soon'`).bind(dev.id).first<{ n: number }>()
    expect(n?.n).toBe(1)
  })
})
