// Workflow automations.
//
// They run after every task or milestone change (from recalcProgress) and from the daily cron. Each rule looks at the
// *current* state and only acts when something is out of step, so running them twice is harmless. Every action is
// written to the project's activity history as "Automation: …" (actor = system) and to status history with the
// note prefix "Automation:". Each rule can be switched off in Settings → Automations.

import type { Env } from '../env'
import { activity } from '../lib/audit'
import { newId } from '../lib/crypto'
import { many, nowIso, one, placeholders } from '../lib/db'
import { notify, projectReviewers } from './notify'
import { publish, rooms, type Waiter } from './realtime'
import { getSetting } from './settings'

const STARTED = ['in_progress', 'in_review', 'blocked', 'completed']
const AUTO_NOTE = 'Automation:'

interface TaskLite {
  id: string
  number: number
  title: string
  status: string
  milestone_id: string | null
  responsible_id: string | null
}

async function setProjectStatus(env: Env, projectId: string, from: string, to: string, why: string) {
  const now = nowIso()
  await env.DB.batch([
    env.DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ? AND status = ?').bind(to, now, projectId, from),
    env.DB.prepare('INSERT INTO project_status_history (id, project_id, from_status, to_status, note, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .bind(newId('psh'), projectId, from, to, `${AUTO_NOTE} ${why}`, now),
    activity(env.DB, { actorType: 'system', action: 'automation.project_status', entityType: 'project', entityId: projectId, projectId, summary: `Automation: project ${from.replace('_', ' ')} → ${to.replace('_', ' ')} — ${why}` }),
  ])
}

export async function runProjectAutomations(env: Env, waiter: Waiter, projectId: string): Promise<{ milestonesChanged: boolean; actions: string[] }> {
  const rules = await getSetting(env.DB, 'automations')
  const actions: string[] = []
  let milestonesChanged = false
  const project = await one<{ id: string; name: string; reference: string; status: string; manager_id: string | null; archived_at: string | null }>(
    env.DB,
    'SELECT id, name, reference, status, manager_id, archived_at FROM projects WHERE id = ?',
    projectId,
  )
  if (!project || project.archived_at || project.status === 'completed' || project.status === 'archived') return { milestonesChanged, actions }
  const tasks = await many<TaskLite>(env.DB, `SELECT id, number, title, status, milestone_id, responsible_id FROM tasks WHERE project_id = ? AND status <> 'cancelled'`, projectId)

  // 1. First work started → project in progress.
  if (rules.projectAutoStart && ['planning', 'not_started'].includes(project.status) && tasks.some((t) => STARTED.includes(t.status))) {
    await setProjectStatus(env, projectId, project.status, 'in_progress', 'work started on the first task')
    actions.push('project_started')
    project.status = 'in_progress'
  }

  // 2. Milestones follow their tasks.
  if (rules.milestoneAutoStatus) {
    const milestones = await many<{ id: string; title: string; status: string; client_visible: number }>(env.DB, 'SELECT id, title, status, client_visible FROM milestones WHERE project_id = ?', projectId)
    for (const m of milestones) {
      const list = tasks.filter((t) => t.milestone_id === m.id)
      if (list.length === 0) continue
      const allDone = list.every((t) => t.status === 'completed')
      const anyStarted = list.some((t) => STARTED.includes(t.status))
      let to: string | null = null
      let why = ''
      if (allDone && m.status !== 'achieved') {
        to = 'achieved'
        why = 'all of its tasks are approved'
      } else if (!allDone && m.status === 'achieved') {
        to = 'in_progress'
        why = 'a task in it was reopened or added'
      } else if (anyStarted && m.status === 'pending') {
        to = 'in_progress'
        why = 'work started on one of its tasks'
      }
      if (!to) continue
      const now = nowIso()
      await env.DB.batch([
        env.DB.prepare('UPDATE milestones SET status = ?, achieved_at = ?, updated_at = ? WHERE id = ?').bind(to, to === 'achieved' ? now : null, now, m.id),
        activity(env.DB, { actorType: 'system', action: 'automation.milestone_status', entityType: 'milestone', entityId: m.id, projectId, summary: `Automation: milestone “${m.title}” → ${to.replace('_', ' ')} — ${why}` }),
      ])
      milestonesChanged = true
      actions.push(`milestone_${to}`)
      publish(env, waiter, [
        { type: 'project.milestone_updated', room: rooms.project(projectId), data: { projectId, milestoneId: m.id, status: to } },
        ...(m.client_visible ? [{ type: 'portal.project_updated' as const, room: rooms.portalProject(projectId), data: { projectId } }] : []),
      ])
      if (to === 'achieved') {
        const members = await many<{ user_id: string }>(env.DB, 'SELECT user_id FROM project_members WHERE project_id = ?', projectId)
        await notify(env, waiter, members.map((x) => ({ userId: x.user_id, kind: 'milestone_updated' as const, title: `Milestone achieved: ${m.title}`, body: `${project.reference} · all tasks approved`, link: `/projects/${projectId}?tab=milestones`, dedupeKey: `ms-achieved:${m.id}:${now.slice(0, 10)}` })))
      }
    }
  }

  // 3. Dependencies finished → dependent work is ready to start.
  if (rules.dependencyReady) {
    const waiting = tasks.filter((t) => t.status === 'backlog' || t.status === 'todo')
    if (waiting.length) {
      const deps = await many<{ task_id: string; dep_status: string }>(
        env.DB,
        `SELECT td.task_id, d.status AS dep_status FROM task_dependencies td JOIN tasks d ON d.id = td.depends_on_task_id WHERE td.task_id IN (${placeholders(waiting.length)})`,
        ...waiting.map((t) => t.id),
      )
      for (const t of waiting) {
        const mine = deps.filter((d) => d.task_id === t.id)
        if (mine.length === 0 || !mine.every((d) => d.dep_status === 'completed' || d.dep_status === 'cancelled')) continue
        if (t.status === 'backlog') {
          const now = nowIso()
          await env.DB.batch([
            env.DB.prepare(`UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ? AND status = 'backlog'`).bind(now, t.id),
            env.DB.prepare('INSERT INTO task_status_history (id, task_id, project_id, from_status, to_status, note, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
              .bind(newId('tsh'), t.id, projectId, 'backlog', 'todo', `${AUTO_NOTE} all dependencies are complete`, now),
            activity(env.DB, { actorType: 'system', action: 'automation.task_ready', entityType: 'task', entityId: t.id, projectId, summary: `Automation: #${t.number} moved to To do — its dependencies are complete` }),
          ])
          publish(env, waiter, [{ type: 'task.updated', room: rooms.project(projectId), data: { taskId: t.id, projectId, status: 'todo' } }])
          actions.push('task_ready')
        }
        if (t.responsible_id) {
          await notify(env, waiter, [{ userId: t.responsible_id, kind: 'task_assigned', title: `Ready to start: #${t.number} ${t.title}`, body: 'Everything it depends on is complete.', link: `/tasks/${t.id}`, entityType: 'task', entityId: t.id, dedupeKey: `ready:${t.id}` }])
        }
      }
    }
  }

  // 4. All work done → project goes to review so the PM can check deliverables and close it.
  if (rules.projectReadyForReview && tasks.length > 0) {
    const allDone = tasks.every((t) => t.status === 'completed')
    if (allDone && ['in_progress', 'at_risk', 'delayed'].includes(project.status)) {
      await setProjectStatus(env, projectId, project.status, 'in_review', 'every task is complete')
      actions.push('project_in_review')
      const reviewers = await projectReviewers(env.DB, projectId)
      await notify(env, waiter, reviewers.map((u) => ({ userId: u, kind: 'review_requested' as const, title: `All tasks done: ${project.reference} ${project.name}`, body: 'Approve the remaining deliverables, then close the project.', link: `/projects/${projectId}`, dedupeKey: `proj-review:${projectId}:${nowIso().slice(0, 10)}` })))
    } else if (!allDone && project.status === 'in_review') {
      // Only undo a review state that the automation itself set.
      const last = await one<{ note: string; changed_by: string | null }>(env.DB, 'SELECT note, changed_by FROM project_status_history WHERE project_id = ? ORDER BY changed_at DESC LIMIT 1', projectId)
      if (last && last.changed_by === null && last.note.startsWith(AUTO_NOTE)) {
        await setProjectStatus(env, projectId, 'in_review', 'in_progress', 'new or reopened work')
        actions.push('project_reopened')
      }
    }
  }

  if (actions.some((a) => a.startsWith('project_'))) {
    publish(env, waiter, [
      { type: 'project.updated', room: rooms.project(projectId), data: { projectId, fields: ['status'] } },
      { type: 'portal.project_updated', room: rooms.portalProject(projectId), data: { projectId } },
    ])
  }
  return { milestonesChanged, actions }
}

/** Newly assigned work that is still parked in Backlog moves to To do. Called when a responsible person is set. */
export async function onTaskAssigned(env: Env, waiter: Waiter, taskId: string) {
  const rules = await getSetting(env.DB, 'automations')
  if (!rules.assignedBacklogToTodo) return false
  const t = await one<{ project_id: string; number: number; status: string; responsible_id: string | null }>(env.DB, 'SELECT project_id, number, status, responsible_id FROM tasks WHERE id = ?', taskId)
  if (!t || t.status !== 'backlog' || !t.responsible_id) return false
  const now = nowIso()
  await env.DB.batch([
    env.DB.prepare(`UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ? AND status = 'backlog'`).bind(now, taskId),
    env.DB.prepare('INSERT INTO task_status_history (id, task_id, project_id, from_status, to_status, note, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
      .bind(newId('tsh'), taskId, t.project_id, 'backlog', 'todo', `${AUTO_NOTE} assigned to someone`, now),
    activity(env.DB, { actorType: 'system', action: 'automation.task_assigned_todo', entityType: 'task', entityId: taskId, projectId: t.project_id, summary: `Automation: #${t.number} moved to To do — it now has an owner` }),
  ])
  publish(env, waiter, [{ type: 'task.updated', room: rooms.project(t.project_id), data: { taskId, projectId: t.project_id, status: 'todo' } }])
  return true
}

/** Daily: projects past their target date that are still running become Delayed (PM notified). */
export async function markDelayedProjects(env: Env, waiter: Waiter, today: string) {
  const rules = await getSetting(env.DB, 'automations')
  if (!rules.projectAutoDelayed) return 0
  const late = await many<{ id: string; reference: string; name: string; status: string; target_date: string; manager_id: string | null }>(
    env.DB,
    `SELECT id, reference, name, status, target_date, manager_id FROM projects WHERE archived_at IS NULL AND target_date < ? AND status IN ('not_started','in_progress','at_risk')`,
    today,
  )
  for (const p of late) {
    await setProjectStatus(env, p.id, p.status, 'delayed', `target date ${p.target_date} has passed`)
    if (p.manager_id) await notify(env, waiter, [{ userId: p.manager_id, kind: 'task_overdue', title: `Project delayed: ${p.reference} ${p.name}`, body: `Target date ${p.target_date} has passed. Update the plan or the target date.`, link: `/projects/${p.id}`, dedupeKey: `proj-delayed:${p.id}` }])
    publish(env, waiter, [{ type: 'project.updated', room: rooms.project(p.id), data: { projectId: p.id, fields: ['status'] } }])
  }
  return late.length
}
