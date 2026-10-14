import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { as, call, scaffoldProject } from './helpers'

async function setup() {
  const admin = await as('super_admin')
  const pm = await as('project_manager')
  const dev = await as('employee')
  const lead = await as('team_lead')
  const { projectId, clientId } = await scaffoldProject(admin.agent, pm.id, [{ id: dev.id }, { id: lead.id, role: 'lead', canReview: true }])
  return { admin, pm, dev, lead, projectId, clientId }
}

describe('clients and projects CRUD', () => {
  it('detects duplicate clients and archives only when projects are closed', async () => {
    const admin = await as('super_admin')
    const a = await call(admin.agent, 'POST', '/api/clients', { name: 'Acme Foods', email: 'ops@acme.test' })
    expect(a.status).toBe(201)
    expect(a.json.reference).toMatch(/^CL-\d{4}$/)
    const dup = await call(admin.agent, 'POST', '/api/clients', { name: 'acme foods' })
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe('DUPLICATE_CLIENT')
    const pr = await call(admin.agent, 'POST', '/api/projects', { name: 'Site', clientId: a.json.id, status: 'in_progress' })
    expect(pr.json.reference).toMatch(/^VX-\d{4}-\d{3}$/)
    expect((await call(admin.agent, 'POST', `/api/clients/${a.json.id}/archive`, {})).status).toBe(409)
    const v = await call(admin.agent, 'POST', '/api/clients', { name: 'Bad', email: 'not-an-email' })
    expect(v.status).toBe(422)
    expect(v.json.error.details.fields.email).toBeTruthy()
  })

  it('duplicates a project with milestones and tasks reset', async () => {
    const { pm, projectId } = await setup()
    await call(pm.agent, 'POST', `/api/projects/${projectId}/milestones`, { title: 'M1' })
    await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'T1' })
    const copy = await call(pm.agent, 'POST', `/api/projects/${projectId}/duplicate`, {})
    expect(copy.status).toBe(201)
    const detail = await call(pm.agent, 'GET', `/api/projects/${copy.json.id}`)
    expect(detail.json.milestones).toHaveLength(1)
    expect(detail.json.taskStats.backlog).toBe(1)
  })
})

describe('task workflow, progress and approvals', () => {
  it('progress only moves when work is approved', async () => {
    const { pm, dev, projectId } = await setup()
    const t1 = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Build API', responsibleId: dev.id })
    await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Docs', responsibleId: dev.id })
    expect(t1.status).toBe(201)
    expect((await call(dev.agent, 'POST', `/api/tasks/${t1.json.id}/status`, { status: 'in_progress' })).status).toBe(200)
    // Cannot self-complete a task that requires approval.
    expect((await call(dev.agent, 'POST', `/api/tasks/${t1.json.id}/status`, { status: 'completed' })).status).toBe(409)
    expect((await call(dev.agent, 'POST', `/api/tasks/${t1.json.id}/submit`, { note: 'done' })).status).toBe(200)
    let p = await call(pm.agent, 'GET', `/api/projects/${projectId}`)
    expect(p.json.project.progress).toBe(0)
    // Revision then approval.
    expect((await call(pm.agent, 'POST', `/api/tasks/${t1.json.id}/review`, { decision: 'revision_requested', note: '' })).status).toBe(422)
    expect((await call(pm.agent, 'POST', `/api/tasks/${t1.json.id}/review`, { decision: 'revision_requested', note: 'Add tests' })).status).toBe(200)
    expect((await call(dev.agent, 'POST', `/api/tasks/${t1.json.id}/submit`, {})).status).toBe(200)
    expect((await call(pm.agent, 'POST', `/api/tasks/${t1.json.id}/review`, { decision: 'approved' })).status).toBe(200)
    p = await call(pm.agent, 'GET', `/api/projects/${projectId}`)
    expect(p.json.project.progress).toBe(50)
    const detail = await call(pm.agent, 'GET', `/api/tasks/${t1.json.id}`)
    expect(detail.json.submissions.map((s: { decision: string }) => s.decision)).toEqual(['approved', 'revision_requested'])
    expect(detail.json.statusHistory[0].to_status).toBe('completed')
    // A snapshot exists for report history.
    const snaps = await env.DB.prepare('SELECT progress FROM project_progress_snapshots WHERE project_id = ? ORDER BY recorded_at').bind(projectId).all<{ progress: number }>()
    expect(snaps.results.at(-1)?.progress).toBe(50)
  })

  it('reviewers cannot approve their own submissions; non-reviewers cannot review', async () => {
    const { pm, dev, lead, projectId } = await setup()
    const t = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Lead task', responsibleId: lead.id })
    await call(lead.agent, 'POST', `/api/tasks/${t.json.id}/submit`, {})
    expect((await call(lead.agent, 'POST', `/api/tasks/${t.json.id}/review`, { decision: 'approved' })).status).toBe(403)
    expect((await call(dev.agent, 'POST', `/api/tasks/${t.json.id}/review`, { decision: 'approved' })).status).toBe(403)
    expect((await call(pm.agent, 'POST', `/api/tasks/${t.json.id}/review`, { decision: 'approved' })).status).toBe(200)
  })

  it('open dependencies block starting work and cycles are rejected', async () => {
    const { pm, dev, projectId } = await setup()
    const a = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'A', responsibleId: dev.id, requiresApproval: false })
    const b = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'B', responsibleId: dev.id, dependsOn: [a.json.id] })
    const start = await call(dev.agent, 'POST', `/api/tasks/${b.json.id}/status`, { status: 'in_progress' })
    expect(start.status).toBe(409)
    expect(start.json.error.code).toBe('DEPENDENCIES_OPEN')
    expect((await call(pm.agent, 'PATCH', `/api/tasks/${a.json.id}`, { dependsOn: [b.json.id] })).status).toBe(422)
    expect((await call(dev.agent, 'POST', `/api/tasks/${a.json.id}/status`, { status: 'completed' })).status).toBe(200)
    expect((await call(dev.agent, 'POST', `/api/tasks/${b.json.id}/status`, { status: 'in_progress' })).status).toBe(200)
  })

  it('assignees must be project members; blocking needs a reason', async () => {
    const { pm, dev, projectId } = await setup()
    const outsider = await as('employee')
    expect((await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'X', responsibleId: outsider.id })).status).toBe(422)
    const t = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Y', responsibleId: dev.id })
    expect((await call(dev.agent, 'POST', `/api/tasks/${t.json.id}/status`, { status: 'blocked' })).status).toBe(422)
    expect((await call(dev.agent, 'POST', `/api/tasks/${t.json.id}/status`, { status: 'blocked', blockedReason: 'Waiting on assets' })).status).toBe(200)
    // Members cannot cancel
    expect((await call(dev.agent, 'POST', `/api/tasks/${t.json.id}/status`, { status: 'cancelled' })).status).toBe(403)
  })

  it('cancelled tasks are excluded from progress', async () => {
    const { pm, projectId } = await setup()
    const a = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'A', requiresApproval: false })
    const b = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'B' })
    await call(pm.agent, 'POST', `/api/tasks/${a.json.id}/status`, { status: 'completed' })
    await call(pm.agent, 'POST', `/api/tasks/${b.json.id}/status`, { status: 'cancelled' })
    expect((await call(pm.agent, 'GET', `/api/projects/${projectId}`)).json.project.progress).toBe(100)
  })

  it('project closure requires completed tasks and approved deliverables', async () => {
    const { pm, projectId } = await setup()
    const t = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Final', requiresApproval: false })
    const blocked = await call(pm.agent, 'PATCH', `/api/projects/${projectId}`, { status: 'completed' })
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.code).toBe('CLOSURE_BLOCKED')
    await call(pm.agent, 'POST', `/api/tasks/${t.json.id}/status`, { status: 'completed' })
    const d = await call(pm.agent, 'POST', `/api/files/deliverables?projectId=${projectId}`, { title: 'Handover pack' })
    expect((await call(pm.agent, 'PATCH', `/api/projects/${projectId}`, { status: 'completed' })).status).toBe(409)
    await env.DB.prepare(`UPDATE deliverables SET status = 'approved' WHERE id = ?`).bind(d.json.id).run()
    const ok = await call(pm.agent, 'PATCH', `/api/projects/${projectId}`, { status: 'completed' })
    expect(ok.status).toBe(200)
    const hist = await env.DB.prepare('SELECT to_status FROM project_status_history WHERE project_id = ? ORDER BY changed_at DESC LIMIT 1').bind(projectId).first<{ to_status: string }>()
    expect(hist?.to_status).toBe('completed')
  })

  it('bulk updates check permission per project', async () => {
    const { pm, dev, projectId } = await setup()
    const t1 = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: '1' })
    const t2 = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: '2' })
    expect((await call(dev.agent, 'POST', '/api/tasks/bulk', { taskIds: [t1.json.id, t2.json.id], action: 'set_priority', priority: 'urgent' })).status).toBe(403)
    expect((await call(pm.agent, 'POST', '/api/tasks/bulk', { taskIds: [t1.json.id, t2.json.id], action: 'assign', responsibleId: dev.id })).status).toBe(200)
    const list = await call(dev.agent, 'GET', '/api/tasks?mine=1')
    expect(list.json.tasks).toHaveLength(2)
  })

  it('time logging rejects future dates', async () => {
    const { pm, dev, projectId } = await setup()
    const t = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'T', responsibleId: dev.id })
    expect((await call(dev.agent, 'POST', `/api/tasks/${t.json.id}/time`, { workDate: '2099-01-01', minutes: 60 })).status).toBe(422)
    expect((await call(dev.agent, 'POST', `/api/tasks/${t.json.id}/time`, { workDate: '2026-01-05', minutes: 90 })).status).toBe(201)
  })
})
