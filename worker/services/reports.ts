// Report builders. All figures are computed from records; nothing is estimated or back-filled.
//
// Period rules (see docs/BUSINESS_RULES.md):
//  * A period is an inclusive range of local dates [start, end] in Asia/Kolkata. Instants are compared as
//    fromUtc <= t < toUtc (local midnight of start → local midnight after end).
//  * "Created in period"   – created_at within the period.
//  * "Completed in period" – the task has a status-history transition to `completed` within the period
//                            (counted once per task even if it was reopened and completed again).
//  * "Open at period end"  – created before toUtc and, per status history, in an open status at toUtc.
//  * "Overdue at period end" – open at end with a due date before the period's end date.
//  * Status/progress "at" a moment come from history tables (project_status_history,
//    project_progress_snapshots). Where no history exists the value is reported as null, not guessed.

import { addDays, localDate, makePeriod, type Period } from '@shared/dates'
import { assessHealth } from '@shared/progress'
import { many, one, placeholders } from '../lib/db'

const OPEN = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'blocked'])
const r1 = (n: number) => Math.round(n * 10) / 10

export interface ReportTable {
  key: string
  title: string
  columns: { key: string; label: string }[]
  rows: Record<string, unknown>[]
}

export interface ReportDoc {
  meta: { type: string; title: string; scopeId: string | null; scopeName: string | null; period: Period; generatedAt: string; timezone: string; definitions: string[] }
  summary: { key: string; label: string; value: number | string | null; note?: string }[]
  charts: Record<string, unknown[]>
  tables: ReportTable[]
  notes: string[]
}

interface TaskRow {
  id: string
  project_id: string
  number: number
  title: string
  status: string
  priority: string
  responsible_id: string | null
  due_date: string | null
  estimate_hours: number | null
  weight: number
  created_at: string
  completed_at: string | null
}

/** Task state as of `toUtc`, derived from status history. */
async function taskStatesAt(db: D1Database, projectIds: string[] | 'all', toUtc: string) {
  const scope = projectIds === 'all' ? '' : projectIds.length ? `AND project_id IN (${placeholders(projectIds.length)})` : 'AND 1 = 0'
  const rows = await many<{ task_id: string; to_status: string; changed_at: string }>(
    db,
    `SELECT task_id, to_status, changed_at FROM task_status_history WHERE changed_at < ? ${scope} ORDER BY changed_at`,
    toUtc,
    ...(projectIds === 'all' ? [] : projectIds),
  )
  const state = new Map<string, string>()
  for (const r of rows) state.set(r.task_id, r.to_status)
  return state
}

async function completionsIn(db: D1Database, p: Period, projectIds: string[] | 'all') {
  const scope = projectIds === 'all' ? '' : projectIds.length ? `AND h.project_id IN (${placeholders(projectIds.length)})` : 'AND 1 = 0'
  const rows = await many<{ task_id: string; changed_at: string }>(
    db,
    `SELECT h.task_id, MAX(h.changed_at) AS changed_at FROM task_status_history h WHERE h.to_status = 'completed' AND h.changed_at >= ? AND h.changed_at < ? ${scope} GROUP BY h.task_id`,
    p.fromUtc,
    p.toUtc,
    ...(projectIds === 'all' ? [] : projectIds),
  )
  return new Map(rows.map((r) => [r.task_id, r.changed_at]))
}

async function projectStatusAt(db: D1Database, projectId: string, atUtc: string) {
  const r = await one<{ to_status: string }>(db, 'SELECT to_status FROM project_status_history WHERE project_id = ? AND changed_at < ? ORDER BY changed_at DESC LIMIT 1', projectId, atUtc)
  return r?.to_status ?? null
}

async function progressAt(db: D1Database, projectId: string, atUtc: string) {
  const r = await one<{ progress: number }>(db, 'SELECT progress FROM project_progress_snapshots WHERE project_id = ? AND recorded_at < ? ORDER BY recorded_at DESC LIMIT 1', projectId, atUtc)
  return r?.progress ?? null
}

const localDay = (iso: string) => localDate(iso)

function taskTable<T extends TaskRow>(key: string, title: string, list: T[], extra: { key: string; label: string }[] = []): ReportTable {
  const tasks = list as unknown as (TaskRow & Record<string, unknown>)[]
  return {
    key,
    title,
    columns: [
      { key: 'ref', label: 'Task' }, { key: 'title', label: 'Title' }, { key: 'status', label: 'Status' }, { key: 'responsible', label: 'Responsible' }, { key: 'due_date', label: 'Due' }, ...extra,
    ],
    rows: tasks.map((t) => ({ ref: `${t.project_reference ?? ''}-${t.number}`, title: t.title, status: t.status, responsible: t.responsible_name ?? '—', due_date: t.due_date ?? '—', ...Object.fromEntries(extra.map((e) => [e.key, t[e.key] ?? '—'])), _id: t.id, _project: t.project_id })),
  }
}

const DEFS = [
  'Completed = moved to Completed during the period (after approval where review is required).',
  'Open at end = not completed or cancelled as of the end of the last day of the period.',
  'Overdue at end = open at end with a due date before the period’s last day.',
  'All dates are in Asia/Kolkata (IST).',
]

// ─────────────────────────── Company ───────────────────────────

export async function companyReport(db: D1Database, start: string, end: string): Promise<ReportDoc> {
  const p = makePeriod(start, end)
  const projects = await many<{ id: string; reference: string; name: string; status: string; created_at: string; target_date: string | null; start_date: string | null; progress: number; client_name: string; manager_name: string | null }>(
    db,
    `SELECT p.id, p.reference, p.name, p.status, p.created_at, p.target_date, p.start_date, p.progress, cl.name AS client_name, u.name AS manager_name
       FROM projects p JOIN clients cl ON cl.id = p.client_id LEFT JOIN users u ON u.id = p.manager_id WHERE p.created_at < ?`,
    p.toUtc,
  )
  const statusAtEnd = new Map<string, string | null>()
  for (const pr of projects) statusAtEnd.set(pr.id, await projectStatusAt(db, pr.id, p.toUtc))
  const closed = await many<{ project_id: string }>(db, `SELECT DISTINCT project_id FROM project_status_history WHERE to_status = 'completed' AND changed_at >= ? AND changed_at < ?`, p.fromUtc, p.toUtc)
  const activeAtEnd = projects.filter((x) => { const s = statusAtEnd.get(x.id); return s != null && s !== 'completed' && s !== 'archived' })
  const newProjects = projects.filter((x) => x.created_at >= p.fromUtc)

  const tasks = await many<TaskRow & { project_reference: string; responsible_name: string | null; department_id: string | null; department_name: string | null }>(
    db,
    `SELECT t.id, t.project_id, t.number, t.title, t.status, t.priority, t.responsible_id, t.due_date, t.estimate_hours, t.weight, t.created_at, t.completed_at,
            p.reference AS project_reference, u.name AS responsible_name, ep.department_id, d.name AS department_name
       FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.responsible_id LEFT JOIN employee_profiles ep ON ep.user_id = t.responsible_id LEFT JOIN departments d ON d.id = ep.department_id
      WHERE t.created_at < ?`,
    p.toUtc,
  )
  const state = await taskStatesAt(db, 'all', p.toUtc)
  const completed = await completionsIn(db, p, 'all')
  const created = tasks.filter((t) => t.created_at >= p.fromUtc)
  const openAtEnd = tasks.filter((t) => OPEN.has(state.get(t.id) ?? t.status))
  const overdueAtEnd = openAtEnd.filter((t) => t.due_date && t.due_date < p.end)
  const blockedAtEnd = openAtEnd.filter((t) => (state.get(t.id) ?? t.status) === 'blocked')
  const completedTasks = tasks.filter((t) => completed.has(t.id))

  const msAchieved = await many<{ title: string; reference: string; due_date: string | null; achieved_at: string }>(
    db,
    `SELECT m.title, p.reference, m.due_date, m.achieved_at FROM milestones m JOIN projects p ON p.id = m.project_id WHERE m.achieved_at >= ? AND m.achieved_at < ? ORDER BY m.achieved_at`,
    p.fromUtc, p.toUtc,
  )
  const msDelayed = await many<{ title: string; reference: string; due_date: string; status: string; achieved_at: string | null }>(
    db,
    `SELECT m.title, p.reference, m.due_date, m.status, m.achieved_at FROM milestones m JOIN projects p ON p.id = m.project_id
      WHERE m.due_date BETWEEN ? AND ? AND (m.achieved_at IS NULL OR m.achieved_at >= ? OR substr(m.achieved_at, 1, 10) > m.due_date) ORDER BY m.due_date`,
    p.start, p.end, p.toUtc,
  )

  const logged = await many<{ department_id: string | null; minutes: number }>(
    db,
    `SELECT ep.department_id, SUM(te.minutes) AS minutes FROM time_entries te LEFT JOIN employee_profiles ep ON ep.user_id = te.user_id WHERE te.work_date BETWEEN ? AND ? GROUP BY ep.department_id`,
    p.start, p.end,
  )
  const departments = await many<{ id: string; name: string }>(db, 'SELECT id, name FROM departments WHERE archived_at IS NULL ORDER BY name')
  const deptRows = [...departments, { id: null as unknown as string, name: 'No department' }].map((d) => ({
    department: d.name,
    completed: completedTasks.filter((t) => (t.department_id ?? null) === (d.id ?? null)).length,
    open_at_end: openAtEnd.filter((t) => (t.department_id ?? null) === (d.id ?? null)).length,
    overdue_at_end: overdueAtEnd.filter((t) => (t.department_id ?? null) === (d.id ?? null)).length,
    logged_hours: r1((logged.find((l) => (l.department_id ?? null) === (d.id ?? null))?.minutes ?? 0) / 60),
  })).filter((r) => r.completed + r.open_at_end + r.logged_hours > 0)

  const plannedCompleted = completedTasks.reduce((s, t) => s + (t.estimate_hours ?? 0), 0)
  const estimatedCount = completedTasks.filter((t) => t.estimate_hours != null).length
  const actualOnCompleted = completedTasks.length
    ? ((await one<{ m: number }>(db, `SELECT COALESCE(SUM(minutes), 0) AS m FROM time_entries WHERE task_id IN (${placeholders(completedTasks.length)})`, ...completedTasks.map((t) => t.id)))?.m ?? 0) / 60
    : 0
  const loggedInPeriod = logged.reduce((s, l) => s + l.minutes, 0) / 60

  const approvals = await one<{ approved: number; changes: number }>(
    db,
    `SELECT SUM(CASE WHEN kind = 'approval' THEN 1 ELSE 0 END) AS approved, SUM(CASE WHEN kind = 'revision_request' THEN 1 ELSE 0 END) AS changes FROM client_feedback WHERE created_at >= ? AND created_at < ?`,
    p.fromUtc, p.toUtc,
  )
  const unresolved = await many<{ project: string; kind: string; created_at: string; body: string }>(
    db,
    `SELECT p.reference AS project, f.kind, f.created_at, substr(f.body, 1, 140) AS body FROM client_feedback f JOIN projects p ON p.id = f.project_id
      WHERE f.created_at < ? AND (f.status <> 'resolved' OR f.responded_at >= ?) AND f.kind <> 'approval' ORDER BY f.created_at`,
    p.toUtc, p.toUtc,
  )
  const horizonEnd = addDays(p.end, 14)
  const upcoming = await many<{ kind: string; ref: string; title: string; date: string }>(
    db,
    `SELECT 'Project' AS kind, reference AS ref, name AS title, target_date AS date FROM projects WHERE target_date > ? AND target_date <= ? AND status NOT IN ('completed','archived')
     UNION ALL SELECT 'Milestone', p.reference, m.title, m.due_date FROM milestones m JOIN projects p ON p.id = m.project_id WHERE m.due_date > ? AND m.due_date <= ? AND m.status IN ('pending','in_progress')
     ORDER BY date LIMIT 40`,
    p.end, horizonEnd, p.end, horizonEnd,
  )
  const risks = activeAtEnd
    .map((pr) => {
      const prTasks = tasks.filter((t) => t.project_id === pr.id)
      const h = assessHealth({
        status: statusAtEnd.get(pr.id) ?? pr.status, progress: pr.progress, hasData: prTasks.length > 0, startDate: pr.start_date, targetDate: pr.target_date, today: p.end,
        overdueTasks: overdueAtEnd.filter((t) => t.project_id === pr.id).length, blockedTasks: blockedAtEnd.filter((t) => t.project_id === pr.id).length,
      })
      return { project: `${pr.reference} · ${pr.name}`, client: pr.client_name, manager: pr.manager_name ?? '—', health: h.health, reasons: h.reasons.join('; ') }
    })
    .filter((x) => x.health === 'at_risk' || x.health === 'off_track')

  const throughput = new Map<string, number>()
  for (const at of completed.values()) {
    const d = localDay(at)
    throughput.set(d, (throughput.get(d) ?? 0) + 1)
  }

  return {
    meta: { type: 'company', title: 'Company report', scopeId: null, scopeName: 'Visionary X', period: p, generatedAt: new Date().toISOString(), timezone: 'Asia/Kolkata', definitions: DEFS },
    summary: [
      { key: 'active_projects', label: 'Active projects at end', value: activeAtEnd.length },
      { key: 'new_projects', label: 'New projects', value: newProjects.length },
      { key: 'closed_projects', label: 'Projects closed', value: closed.length },
      { key: 'tasks_created', label: 'Tasks created', value: created.length },
      { key: 'tasks_completed', label: 'Tasks completed', value: completedTasks.length },
      { key: 'open_at_end', label: 'Open at end', value: openAtEnd.length },
      { key: 'overdue_at_end', label: 'Overdue at end', value: overdueAtEnd.length },
      { key: 'blocked_at_end', label: 'Blocked at end', value: blockedAtEnd.length },
      { key: 'milestones_achieved', label: 'Milestones achieved', value: msAchieved.length },
      { key: 'milestones_delayed', label: 'Milestones delayed', value: msDelayed.length },
      { key: 'client_approvals', label: 'Client approvals', value: approvals?.approved ?? 0 },
      { key: 'unresolved_feedback', label: 'Unresolved client feedback', value: unresolved.length },
      { key: 'planned_hours', label: 'Planned hours (completed work)', value: estimatedCount ? r1(plannedCompleted) : null, note: estimatedCount < completedTasks.length ? `${completedTasks.length - estimatedCount} completed task(s) had no estimate` : undefined },
      { key: 'actual_hours', label: 'Logged hours (completed work)', value: r1(actualOnCompleted) },
      { key: 'logged_in_period', label: 'Hours logged in period', value: r1(loggedInPeriod) },
    ],
    charts: {
      completionsByDay: [...throughput.entries()].sort().map(([day, n]) => ({ day, completed: n })),
      departmentWorkload: deptRows,
      projectStatus: Object.entries(
        [...statusAtEnd.values()].filter(Boolean).reduce<Record<string, number>>((acc, s) => ({ ...acc, [s!]: (acc[s!] ?? 0) + 1 }), {}),
      ).map(([status, n]) => ({ status, count: n })),
    },
    tables: [
      { key: 'risks', title: 'Delivery risks at period end', columns: [{ key: 'project', label: 'Project' }, { key: 'client', label: 'Client' }, { key: 'manager', label: 'Manager' }, { key: 'health', label: 'Health' }, { key: 'reasons', label: 'Why' }], rows: risks },
      { key: 'departments', title: 'Department workload', columns: [{ key: 'department', label: 'Department' }, { key: 'completed', label: 'Completed' }, { key: 'open_at_end', label: 'Open at end' }, { key: 'overdue_at_end', label: 'Overdue at end' }, { key: 'logged_hours', label: 'Logged h' }], rows: deptRows },
      { key: 'milestones_delayed', title: 'Delayed milestones', columns: [{ key: 'reference', label: 'Project' }, { key: 'title', label: 'Milestone' }, { key: 'due_date', label: 'Due' }, { key: 'status', label: 'Status' }], rows: msDelayed },
      { key: 'milestones_achieved', title: 'Milestones achieved', columns: [{ key: 'reference', label: 'Project' }, { key: 'title', label: 'Milestone' }, { key: 'due_date', label: 'Due' }, { key: 'achieved', label: 'Achieved' }], rows: msAchieved.map((m) => ({ ...m, achieved: localDay(m.achieved_at) })) },
      { key: 'upcoming', title: 'Upcoming deadlines (14 days after period)', columns: [{ key: 'kind', label: 'Type' }, { key: 'ref', label: 'Project' }, { key: 'title', label: 'Title' }, { key: 'date', label: 'Date' }], rows: upcoming },
      { key: 'feedback', title: 'Unresolved client feedback at end', columns: [{ key: 'project', label: 'Project' }, { key: 'kind', label: 'Kind' }, { key: 'body', label: 'Message' }], rows: unresolved },
      taskTable('overdue', 'Overdue at end', overdueAtEnd),
    ],
    notes: [],
  }
}

// ─────────────────────────── Project ───────────────────────────

export async function projectReport(db: D1Database, projectId: string, start: string, end: string): Promise<ReportDoc> {
  const p = makePeriod(start, end)
  const pr = await one<{ id: string; reference: string; name: string; client_name: string; created_at: string; estimated_hours: number | null; status: string }>(
    db,
    'SELECT p.id, p.reference, p.name, cl.name AS client_name, p.created_at, p.estimated_hours, p.status FROM projects p JOIN clients cl ON cl.id = p.client_id WHERE p.id = ?',
    projectId,
  )
  if (!pr) throw new Error('Project not found')
  const notes: string[] = []
  const existedAtStart = pr.created_at < p.fromUtc
  if (!existedAtStart) notes.push('The project was created during this period, so opening status and progress are not applicable.')
  const openingStatus = existedAtStart ? await projectStatusAt(db, projectId, p.fromUtc) : null
  const closingStatus = await projectStatusAt(db, projectId, p.toUtc)
  const progressStart = existedAtStart ? await progressAt(db, projectId, p.fromUtc) : null
  const progressEnd = await progressAt(db, projectId, p.toUtc)

  const tasks = await many<TaskRow & { project_reference: string; responsible_name: string | null }>(
    db,
    `SELECT t.*, ? AS project_reference, u.name AS responsible_name FROM tasks t LEFT JOIN users u ON u.id = t.responsible_id WHERE t.project_id = ? AND t.created_at < ?`,
    pr.reference, projectId, p.toUtc,
  )
  const state = await taskStatesAt(db, [projectId], p.toUtc)
  const completed = await completionsIn(db, p, [projectId])
  const completedTasks = tasks.filter((t) => completed.has(t.id)).map((t) => ({ ...t, completed_on: localDay(completed.get(t.id)!) }))
  const outstanding = tasks.filter((t) => OPEN.has(state.get(t.id) ?? t.status)).map((t) => ({ ...t, status: state.get(t.id) ?? t.status }))
  const delayed = outstanding.filter((t) => t.due_date && t.due_date < p.end)
  const msAchieved = await many<{ title: string; due_date: string | null; achieved_at: string }>(db, 'SELECT title, due_date, achieved_at FROM milestones WHERE project_id = ? AND achieved_at >= ? AND achieved_at < ?', projectId, p.fromUtc, p.toUtc)
  const msMissed = await many<{ title: string; due_date: string; status: string }>(
    db,
    `SELECT title, due_date, status FROM milestones WHERE project_id = ? AND due_date BETWEEN ? AND ? AND (achieved_at IS NULL OR achieved_at >= ?)`,
    projectId, p.start, p.end, p.toUtc,
  )
  const deliverablesSubmitted = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM activity_logs WHERE project_id = ? AND action = 'deliverable.submit_review' AND created_at >= ? AND created_at < ?`, projectId, p.fromUtc, p.toUtc)
  const deliverablesApproved = await many<{ title: string; approved_at: string | null; client_decision_at: string | null; status: string }>(
    db,
    `SELECT title, approved_at, client_decision_at, status FROM deliverables WHERE project_id = ? AND ((approved_at >= ? AND approved_at < ?) OR (client_decision_at >= ? AND client_decision_at < ?))`,
    projectId, p.fromUtc, p.toUtc, p.fromUtc, p.toUtc,
  )
  const revisions = await many<{ ref: string; title: string; decided_at: string; note: string; by: string | null }>(
    db,
    `SELECT t.number AS ref, t.title, s.decided_at, s.decision_note AS note, u.name AS by FROM task_submissions s JOIN tasks t ON t.id = s.task_id LEFT JOIN users u ON u.id = s.decided_by
      WHERE t.project_id = ? AND s.decision = 'revision_requested' AND s.decided_at >= ? AND s.decided_at < ? ORDER BY s.decided_at`,
    projectId, p.fromUtc, p.toUtc,
  )
  const clientRevisions = await many<{ body: string; created_at: string }>(db, `SELECT substr(body, 1, 200) AS body, created_at FROM client_feedback WHERE project_id = ? AND kind = 'revision_request' AND created_at >= ? AND created_at < ?`, projectId, p.fromUtc, p.toUtc)
  const deps = await many<{ number: number; title: string; dep_number: number; dep_title: string; dep_status: string }>(
    db,
    `SELECT t.number, t.title, d.number AS dep_number, d.title AS dep_title, d.status AS dep_status FROM task_dependencies td JOIN tasks t ON t.id = td.task_id JOIN tasks d ON d.id = td.depends_on_task_id
      WHERE t.project_id = ? AND t.status IN ('backlog','todo','in_progress','in_review','blocked') AND d.status NOT IN ('completed','cancelled')`,
    projectId,
  )
  const loggedPeriod = (await one<{ m: number }>(db, 'SELECT COALESCE(SUM(minutes), 0) AS m FROM time_entries WHERE project_id = ? AND work_date BETWEEN ? AND ?', projectId, p.start, p.end))?.m ?? 0
  const loggedTotal = (await one<{ m: number }>(db, 'SELECT COALESCE(SUM(minutes), 0) AS m FROM time_entries WHERE project_id = ? AND work_date <= ?', projectId, p.end))?.m ?? 0
  const estimatedTotal = tasks.filter((t) => (state.get(t.id) ?? t.status) !== 'cancelled').reduce((s, t) => s + (t.estimate_hours ?? 0), 0)
  const progressSeries = await many<{ recorded_at: string; progress: number }>(db, 'SELECT recorded_at, progress FROM project_progress_snapshots WHERE project_id = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at', projectId, p.fromUtc, p.toUtc)
  if (progressEnd == null) notes.push('No progress history exists before the period end.')
  if (completed.size && deliverablesApproved.length === 0) notes.push('Task completion is tracked separately from deliverable approval.')

  return {
    meta: { type: 'project', title: `Project report · ${pr.reference}`, scopeId: projectId, scopeName: `${pr.reference} · ${pr.name} (${pr.client_name})`, period: p, generatedAt: new Date().toISOString(), timezone: 'Asia/Kolkata', definitions: DEFS },
    summary: [
      { key: 'opening_status', label: 'Opening status', value: openingStatus },
      { key: 'closing_status', label: 'Closing status', value: closingStatus },
      { key: 'progress_start', label: 'Progress at start', value: progressStart == null ? null : `${progressStart}%` },
      { key: 'progress_end', label: 'Progress at end', value: progressEnd == null ? null : `${progressEnd}%` },
      { key: 'completed', label: 'Tasks completed', value: completedTasks.length },
      { key: 'outstanding', label: 'Outstanding at end', value: outstanding.length },
      { key: 'delayed', label: 'Delayed (overdue) at end', value: delayed.length },
      { key: 'milestones', label: 'Milestones achieved', value: msAchieved.length },
      { key: 'deliverables_submitted', label: 'Deliverables submitted', value: deliverablesSubmitted?.n ?? 0 },
      { key: 'deliverables_approved', label: 'Deliverables approved', value: deliverablesApproved.length },
      { key: 'revisions', label: 'Revision requests', value: revisions.length + clientRevisions.length, note: `${revisions.length} internal · ${clientRevisions.length} client` },
      { key: 'planned', label: 'Planned hours (all tasks)', value: estimatedTotal ? r1(estimatedTotal) : null, note: pr.estimated_hours != null ? `Budget ${pr.estimated_hours} h` : undefined },
      { key: 'actual_total', label: 'Logged hours to date', value: r1(loggedTotal / 60) },
      { key: 'actual_period', label: 'Logged in period', value: r1(loggedPeriod / 60) },
    ],
    charts: { progress: progressSeries.map((s) => ({ date: localDay(s.recorded_at), progress: s.progress })) },
    tables: [
      taskTable('completed', 'Completed in period', completedTasks, [{ key: 'completed_on', label: 'Completed' }]),
      taskTable('outstanding', 'Outstanding at end', outstanding),
      { key: 'milestones', title: 'Milestones', columns: [{ key: 'title', label: 'Milestone' }, { key: 'due_date', label: 'Due' }, { key: 'outcome', label: 'Outcome' }], rows: [...msAchieved.map((m) => ({ title: m.title, due_date: m.due_date ?? '—', outcome: `Achieved ${localDay(m.achieved_at)}` })), ...msMissed.map((m) => ({ title: m.title, due_date: m.due_date, outcome: 'Not achieved by period end' }))] },
      { key: 'revisions', title: 'Revision history', columns: [{ key: 'source', label: 'Source' }, { key: 'item', label: 'Item' }, { key: 'note', label: 'Note' }, { key: 'date', label: 'Date' }], rows: [...revisions.map((r) => ({ source: `Internal (${r.by ?? '—'})`, item: `#${r.ref} ${r.title}`, note: r.note, date: localDay(r.decided_at) })), ...clientRevisions.map((r) => ({ source: 'Client', item: '—', note: r.body, date: localDay(r.created_at) }))] },
      { key: 'dependencies', title: 'Unresolved dependencies (current)', columns: [{ key: 'task', label: 'Task' }, { key: 'waiting_on', label: 'Waiting on' }, { key: 'status', label: 'Status' }], rows: deps.map((d) => ({ task: `#${d.number} ${d.title}`, waiting_on: `#${d.dep_number} ${d.dep_title}`, status: d.dep_status })) },
    ],
    notes,
  }
}

// ─────────────────────────── Member ───────────────────────────

export async function memberReport(db: D1Database, userId: string, start: string, end: string): Promise<ReportDoc> {
  const p = makePeriod(start, end)
  const user = await one<{ name: string; designation: string | null; weekly_capacity_hours: number | null }>(db, 'SELECT u.name, ep.designation, ep.weekly_capacity_hours FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id WHERE u.id = ?', userId)
  if (!user) throw new Error('Member not found')
  const tasks = await many<TaskRow & { project_reference: string; responsible_name: string | null }>(
    db,
    `SELECT t.*, p.reference AS project_reference, ? AS responsible_name FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE (t.responsible_id = ? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?)) AND t.created_at < ?`,
    user.name, userId, userId, p.toUtc,
  )
  // Assignment events: creation with this responsible, or a later reassignment to them (from the change log).
  const reassigned = await many<{ entity_id: string; changes: string }>(db, `SELECT entity_id, changes FROM activity_logs WHERE action = 'task.updated' AND created_at >= ? AND created_at < ? AND changes LIKE ?`, p.fromUtc, p.toUtc, `%${userId}%`)
  const assignedIds = new Set<string>(tasks.filter((t) => t.created_at >= p.fromUtc).map((t) => t.id))
  for (const r of reassigned) {
    try {
      const ch = JSON.parse(r.changes)
      if (ch?.responsible_id?.to === userId || (Array.isArray(ch?.assignees?.to) && ch.assignees.to.includes(userId))) assignedIds.add(r.entity_id)
    } catch {
      /* ignore malformed */
    }
  }
  const ids = tasks.map((t) => t.id)
  const state = new Map<string, string>()
  if (ids.length) {
    const rows = await many<{ task_id: string; to_status: string }>(db, `SELECT task_id, to_status FROM task_status_history WHERE changed_at < ? AND task_id IN (${placeholders(ids.length)}) ORDER BY changed_at`, p.toUtc, ...ids)
    for (const r of rows) state.set(r.task_id, r.to_status)
  }
  const completedRows = ids.length
    ? await many<{ task_id: string; at: string }>(db, `SELECT task_id, MAX(changed_at) AS at FROM task_status_history WHERE to_status = 'completed' AND changed_at >= ? AND changed_at < ? AND task_id IN (${placeholders(ids.length)}) GROUP BY task_id`, p.fromUtc, p.toUtc, ...ids)
    : []
  const completedMap = new Map(completedRows.map((r) => [r.task_id, r.at]))
  const completed = tasks.filter((t) => completedMap.has(t.id)).map((t) => {
    const day = localDay(completedMap.get(t.id)!)
    return { ...t, completed_on: day, timeliness: t.due_date ? (day <= t.due_date ? 'On time' : 'Late') : 'No due date' }
  })
  const onTime = completed.filter((t) => t.timeliness === 'On time').length
  const late = completed.filter((t) => t.timeliness === 'Late').length
  const openAtEnd = tasks.filter((t) => OPEN.has(state.get(t.id) ?? t.status)).map((t) => ({ ...t, status: state.get(t.id) ?? t.status }))
  const blocked = openAtEnd.filter((t) => t.status === 'blocked')
  const overdue = openAtEnd.filter((t) => t.due_date && t.due_date < p.end)
  const submissions = await many<{ decision: string; decided_by: string | null; decision_note: string; submitted_at: string; decided_at: string | null; number: number; title: string; reviewer: string | null; reference: string }>(
    db,
    `SELECT s.decision, s.decided_by, s.decision_note, s.submitted_at, s.decided_at, t.number, t.title, u.name AS reviewer, p.reference FROM task_submissions s JOIN tasks t ON t.id = s.task_id JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = s.decided_by
      WHERE s.submitted_by = ? AND ((s.submitted_at >= ? AND s.submitted_at < ?) OR (s.decided_at >= ? AND s.decided_at < ?)) ORDER BY s.submitted_at`,
    userId, p.fromUtc, p.toUtc, p.fromUtc, p.toUtc,
  )
  const submittedInPeriod = submissions.filter((s) => s.submitted_at >= p.fromUtc && s.submitted_at < p.toUtc)
  const decidedInPeriod = submissions.filter((s) => s.decided_at && s.decided_at >= p.fromUtc && s.decided_at < p.toUtc)
  const logged = (await one<{ m: number }>(db, 'SELECT COALESCE(SUM(minutes), 0) AS m FROM time_entries WHERE user_id = ? AND work_date BETWEEN ? AND ?', userId, p.start, p.end))?.m ?? 0
  const estimatedCompleted = completed.reduce((s, t) => s + (t.estimate_hours ?? 0), 0)
  const loggedOnCompleted = completed.length
    ? ((await one<{ m: number }>(db, `SELECT COALESCE(SUM(minutes), 0) AS m FROM time_entries WHERE user_id = ? AND task_id IN (${placeholders(completed.length)})`, userId, ...completed.map((t) => t.id)))?.m ?? 0)
    : 0
  const weeks = (Date.parse(p.toUtc) - Date.parse(p.fromUtc)) / (7 * 86400_000)
  const notes = ['Task counts alone are not a performance measure; read them with complexity (weight/estimate), timeliness, review outcomes and blockers.']
  if (user.weekly_capacity_hours == null) notes.push('No weekly capacity is recorded for this member, so utilisation is not shown.')

  return {
    meta: { type: 'member', title: `Member report · ${user.name}`, scopeId: userId, scopeName: `${user.name}${user.designation ? ` · ${user.designation}` : ''}`, period: p, generatedAt: new Date().toISOString(), timezone: 'Asia/Kolkata', definitions: DEFS },
    summary: [
      { key: 'assigned', label: 'Tasks assigned in period', value: assignedIds.size },
      { key: 'completed', label: 'Tasks completed', value: completed.length },
      { key: 'complexity', label: 'Completed weight', value: r1(completed.reduce((s, t) => s + t.weight, 0)), note: 'Sum of task weights (complexity)' },
      { key: 'on_time', label: 'Completed on time', value: completed.length ? onTime : null, note: completed.length ? `${late} late · ${completed.length - onTime - late} without due date` : undefined },
      { key: 'submitted', label: 'Work submitted', value: submittedInPeriod.length },
      { key: 'approved', label: 'Approvals received', value: decidedInPeriod.filter((s) => s.decision === 'approved').length },
      { key: 'revisions', label: 'Revisions requested', value: decidedInPeriod.filter((s) => s.decision === 'revision_requested').length },
      { key: 'logged', label: 'Hours logged', value: r1(logged / 60) },
      { key: 'estimated_completed', label: 'Estimated hours (completed)', value: completed.some((t) => t.estimate_hours != null) ? r1(estimatedCompleted) : null },
      { key: 'logged_completed', label: 'Logged on completed tasks', value: r1(loggedOnCompleted / 60) },
      { key: 'utilisation', label: 'Utilisation', value: user.weekly_capacity_hours ? `${Math.round((logged / 60 / (user.weekly_capacity_hours * weeks)) * 100)}%` : null },
      { key: 'open_at_end', label: 'Open at end', value: openAtEnd.length },
      { key: 'overdue_at_end', label: 'Overdue at end', value: overdue.length },
      { key: 'blocked_at_end', label: 'Blocked at end', value: blocked.length },
    ],
    charts: {},
    tables: [
      taskTable('completed', 'Completed in period', completed, [{ key: 'completed_on', label: 'Completed' }, { key: 'timeliness', label: 'Timeliness' }]),
      taskTable('open', 'Open at end (workload)', openAtEnd, [{ key: 'priority', label: 'Priority' }, { key: 'estimate_hours', label: 'Estimate h' }]),
      { key: 'feedback', title: 'Review feedback received', columns: [{ key: 'task', label: 'Task' }, { key: 'decision', label: 'Decision' }, { key: 'reviewer', label: 'Reviewer' }, { key: 'note', label: 'Note' }], rows: decidedInPeriod.map((s) => ({ task: `${s.reference}-${s.number} ${s.title}`, decision: s.decision, reviewer: s.reviewer ?? '—', note: s.decision_note || '—' })) },
    ],
    notes,
  }
}

// ─────────────────────────── Client ───────────────────────────

export async function clientReport(db: D1Database, clientId: string, start: string, end: string): Promise<ReportDoc> {
  const p = makePeriod(start, end)
  const client = await one<{ name: string; reference: string }>(db, 'SELECT name, reference FROM clients WHERE id = ?', clientId)
  if (!client) throw new Error('Client not found')
  const projects = await many<{ id: string; reference: string; name: string; status: string; progress: number; target_date: string | null; completed_at: string | null }>(
    db,
    'SELECT id, reference, name, status, progress, target_date, completed_at FROM projects WHERE client_id = ? AND created_at < ? ORDER BY reference',
    clientId, p.toUtc,
  )
  const ids = projects.map((x) => x.id)
  const statusEnd = new Map<string, string | null>()
  for (const pr of projects) statusEnd.set(pr.id, await projectStatusAt(db, pr.id, p.toUtc))
  const completedTasks = ids.length ? await completionsIn(db, p, ids) : new Map()
  const delivered = ids.length
    ? await many<{ reference: string; title: string; status: string; shared_at: string | null; client_decision_at: string | null }>(
        db,
        `SELECT p.reference, d.title, d.status, d.shared_at, d.client_decision_at FROM deliverables d JOIN projects p ON p.id = d.project_id
          WHERE p.client_id = ? AND ((d.shared_at >= ? AND d.shared_at < ?) OR (d.client_decision_at >= ? AND d.client_decision_at < ?))`,
        clientId, p.fromUtc, p.toUtc, p.fromUtc, p.toUtc,
      )
    : []
  const milestones = ids.length
    ? await many<{ reference: string; title: string; achieved_at: string }>(db, `SELECT p.reference, m.title, m.achieved_at FROM milestones m JOIN projects p ON p.id = m.project_id WHERE p.client_id = ? AND m.achieved_at >= ? AND m.achieved_at < ?`, clientId, p.fromUtc, p.toUtc)
    : []
  const outstanding = await many<{ reference: string; title: string; shared_at: string }>(db, `SELECT p.reference, d.title, d.shared_at FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE p.client_id = ? AND d.status = 'shared'`, clientId)
  const feedback = await many<{ reference: string; kind: string; body: string; created_at: string; status: string }>(
    db,
    `SELECT p.reference, f.kind, substr(f.body, 1, 160) AS body, f.created_at, f.status FROM client_feedback f JOIN projects p ON p.id = f.project_id WHERE f.client_id = ? AND f.status <> 'resolved' AND f.kind <> 'approval'`,
    clientId,
  )
  const upcoming = await many<{ kind: string; reference: string; title: string; date: string }>(
    db,
    `SELECT 'Project deadline' AS kind, reference, name AS title, target_date AS date FROM projects WHERE client_id = ? AND target_date > ? AND target_date <= ? AND status NOT IN ('completed','archived')
     UNION ALL SELECT 'Milestone', p.reference, m.title, m.due_date FROM milestones m JOIN projects p ON p.id = m.project_id WHERE p.client_id = ? AND m.due_date > ? AND m.due_date <= ? AND m.status IN ('pending','in_progress')
     ORDER BY date`,
    clientId, p.end, addDays(p.end, 30), clientId, p.end, addDays(p.end, 30),
  )
  return {
    meta: { type: 'client', title: `Client report · ${client.name}`, scopeId: clientId, scopeName: `${client.name} (${client.reference})`, period: p, generatedAt: new Date().toISOString(), timezone: 'Asia/Kolkata', definitions: DEFS },
    summary: [
      { key: 'active', label: 'Active projects at end', value: projects.filter((x) => { const s = statusEnd.get(x.id); return s && s !== 'completed' && s !== 'archived' }).length },
      { key: 'completed_projects', label: 'Completed projects (to date)', value: projects.filter((x) => statusEnd.get(x.id) === 'completed').length },
      { key: 'tasks_completed', label: 'Tasks completed in period', value: completedTasks.size },
      { key: 'delivered', label: 'Deliverables shared / decided', value: delivered.length },
      { key: 'milestones', label: 'Milestones achieved', value: milestones.length },
      { key: 'outstanding', label: 'Awaiting client approval (now)', value: outstanding.length },
      { key: 'feedback', label: 'Open feedback & revisions (now)', value: feedback.length },
    ],
    charts: {},
    tables: [
      { key: 'projects', title: 'Projects', columns: [{ key: 'reference', label: 'Ref' }, { key: 'name', label: 'Project' }, { key: 'status_end', label: 'Status at end' }, { key: 'progress', label: 'Progress now' }, { key: 'target_date', label: 'Target' }], rows: projects.map((x) => ({ ...x, status_end: statusEnd.get(x.id) ?? '—', progress: `${x.progress}%`, target_date: x.target_date ?? '—' })) },
      { key: 'delivered', title: 'Work delivered', columns: [{ key: 'reference', label: 'Project' }, { key: 'title', label: 'Deliverable' }, { key: 'status', label: 'Status' }], rows: delivered },
      { key: 'milestones', title: 'Milestones achieved', columns: [{ key: 'reference', label: 'Project' }, { key: 'title', label: 'Milestone' }, { key: 'date', label: 'Date' }], rows: milestones.map((m) => ({ ...m, date: localDay(m.achieved_at) })) },
      { key: 'outstanding', title: 'Outstanding approvals', columns: [{ key: 'reference', label: 'Project' }, { key: 'title', label: 'Deliverable' }, { key: 'shared', label: 'Shared' }], rows: outstanding.map((o) => ({ ...o, shared: localDay(o.shared_at) })) },
      { key: 'feedback', title: 'Pending feedback and revisions', columns: [{ key: 'reference', label: 'Project' }, { key: 'kind', label: 'Kind' }, { key: 'body', label: 'Message' }, { key: 'status', label: 'Status' }], rows: feedback },
      { key: 'upcoming', title: 'Upcoming deadlines (30 days)', columns: [{ key: 'kind', label: 'Type' }, { key: 'reference', label: 'Project' }, { key: 'title', label: 'Title' }, { key: 'date', label: 'Date' }], rows: upcoming },
    ],
    notes: ['“Now” figures reflect the current state at generation time, not the period end.'],
  }
}
