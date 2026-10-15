import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { as, call, scaffoldProject } from './helpers'
import { markDelayedProjects } from '../worker/services/automations'

const waiter = { waitUntil: () => undefined }
const status = async (projectId: string) => (await env.DB.prepare('SELECT status FROM projects WHERE id = ?').bind(projectId).first<{ status: string }>())!.status

async function setup() {
  const admin = await as('super_admin')
  const pm = await as('project_manager')
  const dev = await as('employee')
  const { projectId } = await scaffoldProject(admin.agent, pm.id, [{ id: dev.id }])
  await env.DB.prepare(`UPDATE projects SET status = 'planning' WHERE id = ?`).bind(projectId).run()
  return { admin, pm, dev, projectId }
}

describe('workflow automations', () => {
  it('starts the project and its milestone when the first task starts, and closes the milestone when all tasks are approved', async () => {
    const { pm, dev, projectId } = await setup()
    const m = await call(pm.agent, 'POST', `/api/projects/${projectId}/milestones`, { title: 'Design' })
    const a = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'A', responsibleId: dev.id, milestoneId: m.json.id })
    const b = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'B', responsibleId: dev.id, milestoneId: m.json.id, requiresApproval: false })
    await call(dev.agent, 'POST', `/api/tasks/${a.json.id}/status`, { status: 'in_progress' })
    expect(await status(projectId)).toBe('in_progress')
    const ms = () => env.DB.prepare('SELECT status FROM milestones WHERE id = ?').bind(m.json.id).first<{ status: string }>()
    expect((await ms())!.status).toBe('in_progress')
    await call(dev.agent, 'POST', `/api/tasks/${a.json.id}/submit`, {})
    await call(pm.agent, 'POST', `/api/tasks/${a.json.id}/review`, { decision: 'approved' })
    expect((await ms())!.status).toBe('in_progress')
    await call(dev.agent, 'POST', `/api/tasks/${b.json.id}/status`, { status: 'completed' })
    expect((await ms())!.status).toBe('achieved')
    // Everything is done → project waits for the PM's review/closure.
    expect(await status(projectId)).toBe('in_review')
    const log = await env.DB.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE project_id = ? AND action LIKE 'automation.%'`).bind(projectId).first<{ n: number }>()
    expect(log!.n).toBeGreaterThanOrEqual(3)
    // Reopening work undoes the automatic states.
    await call(pm.agent, 'POST', `/api/tasks/${b.json.id}/status`, { status: 'todo', note: 'More to do' })
    expect((await ms())!.status).toBe('in_progress')
    expect(await status(projectId)).toBe('in_progress')
  })

  it('moves dependent work to To do and tells its owner when dependencies finish', async () => {
    const { pm, dev, projectId } = await setup()
    const a = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Foundation', responsibleId: dev.id, requiresApproval: false })
    const b = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Walls', status: 'backlog', dependsOn: [a.json.id] })
    // Give it an owner while keeping it parked in Backlog (assignment would otherwise move it to To do).
    await env.DB.prepare(`UPDATE tasks SET responsible_id = ? WHERE id = ?`).bind(pm.id, b.json.id).run()
    await call(dev.agent, 'POST', `/api/tasks/${a.json.id}/status`, { status: 'completed' })
    const t = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(b.json.id).first<{ status: string }>()
    expect(t!.status).toBe('todo')
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND dedupe_key = ?`).bind(pm.id, `ready:${b.json.id}`).first<{ n: number }>()
    expect(n!.n).toBe(1)
  })

  it('moves a backlog task to To do when it gets an owner', async () => {
    const { pm, dev, projectId } = await setup()
    const t = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Parked', status: 'backlog' })
    await call(pm.agent, 'PATCH', `/api/tasks/${t.json.id}`, { responsibleId: dev.id })
    const row = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?').bind(t.json.id).first<{ status: string }>()
    expect(row!.status).toBe('todo')
  })

  it('marks overdue projects as delayed (daily job) and respects the on/off setting', async () => {
    const { projectId } = await setup()
    await env.DB.prepare(`UPDATE projects SET status = 'in_progress', target_date = '2020-01-31' WHERE id = ?`).bind(projectId).run()
    await env.DB.prepare(`INSERT INTO company_settings (key, value, updated_at) VALUES ('automations', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(JSON.stringify({ projectAutoStart: true, milestoneAutoStatus: true, dependencyReady: true, projectReadyForReview: true, projectAutoDelayed: false, assignedBacklogToTodo: true }), new Date().toISOString()).run()
    await markDelayedProjects(env, waiter, '2026-10-15')
    expect(await status(projectId)).toBe('in_progress')
    await env.DB.prepare(`DELETE FROM company_settings WHERE key = 'automations'`).run()
    await markDelayedProjects(env, waiter, '2026-10-15')
    expect(await status(projectId)).toBe('delayed')
  })
})
