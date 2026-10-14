import { describe, expect, it } from 'vitest'
import { as, call, scaffoldProject } from './helpers'

describe('role and resource permissions', () => {
  it('employees cannot manage clients or see projects they are not on', async () => {
    const admin = await as('super_admin')
    const emp = await as('employee')
    const pm = await as('project_manager')
    const { projectId } = await scaffoldProject(admin.agent, pm.id)
    expect((await call(emp.agent, 'POST', '/api/clients', { name: 'X' })).status).toBe(403)
    expect((await call(emp.agent, 'GET', '/api/clients')).json.clients).toEqual([])
    // Non-members get 404, not 403, so project existence is not revealed.
    expect((await call(emp.agent, 'GET', `/api/projects/${projectId}`)).status).toBe(404)
    expect((await call(emp.agent, 'GET', '/api/projects')).json.projects).toEqual([])
    expect((await call(emp.agent, 'GET', `/api/tasks?projectId=${projectId}`)).json.tasks).toEqual([])
  })

  it('HR manages people but has no automatic access to client material', async () => {
    const admin = await as('super_admin')
    const hr = await as('hr_manager')
    const pm = await as('project_manager')
    const { projectId, clientId } = await scaffoldProject(admin.agent, pm.id)
    expect((await call(hr.agent, 'GET', `/api/projects/${projectId}`)).status).toBe(404)
    expect((await call(hr.agent, 'GET', `/api/clients/${clientId}`)).status).toBe(404)
    expect((await call(hr.agent, 'PATCH', `/api/team/members/${pm.id}`, { designation: 'Delivery Manager', personalPhone: '+91 90000 00000' })).status).toBe(200)
  })

  it('sensitive HR fields are hidden from colleagues but visible to HR and the person', async () => {
    const hr = await as('hr_manager')
    const a = await as('employee')
    const b = await as('employee')
    await call(hr.agent, 'PATCH', `/api/team/members/${a.id}`, { personalPhone: '+91 90000 11111', dateOfBirth: '1995-05-05' })
    const asColleague = await call(b.agent, 'GET', `/api/team/members/${a.id}`)
    expect(asColleague.json.member.personal_phone).toBeUndefined()
    expect(asColleague.json.member.date_of_birth).toBeUndefined()
    expect(asColleague.json.work).toBeNull()
    expect((await call(a.agent, 'GET', `/api/team/members/${a.id}`)).json.member.personal_phone).toBe('+91 90000 11111')
    expect((await call(hr.agent, 'GET', `/api/team/members/${a.id}`)).json.member.date_of_birth).toBe('1995-05-05')
    // Self-service cannot change organisational fields.
    expect((await call(a.agent, 'PATCH', `/api/team/members/${a.id}`, { designation: 'CTO' })).status).toBe(403)
  })

  it('project managers manage only their own projects', async () => {
    const admin = await as('super_admin')
    const pm1 = await as('project_manager')
    const pm2 = await as('project_manager')
    const { projectId } = await scaffoldProject(admin.agent, pm1.id)
    expect((await call(pm1.agent, 'PATCH', `/api/projects/${projectId}`, { priority: 'high' })).status).toBe(200)
    expect((await call(pm2.agent, 'PATCH', `/api/projects/${projectId}`, { priority: 'low' })).status).toBe(404)
    // A PM cannot hand their project to someone else (admin-only).
    expect((await call(pm1.agent, 'PATCH', `/api/projects/${projectId}`, { managerId: pm2.id })).status).toBe(403)
  })

  it('viewers can read but not contribute', async () => {
    const admin = await as('super_admin')
    const pm = await as('project_manager')
    const viewer = await as('employee')
    const { projectId } = await scaffoldProject(admin.agent, pm.id, [{ id: viewer.id, role: 'viewer' }])
    const task = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Read only' })
    expect((await call(viewer.agent, 'GET', `/api/projects/${projectId}`)).status).toBe(200)
    expect((await call(viewer.agent, 'POST', `/api/tasks/${task.json.id}/comments`, { body: 'hi' })).status).toBe(403)
    expect((await call(viewer.agent, 'POST', '/api/tasks', { projectId, title: 'nope' })).status).toBe(403)
  })

  it('prevents privilege escalation through role assignment', async () => {
    const admin = await as('admin')
    const emp = await as('employee')
    const sup = await as('super_admin')
    expect((await call(admin.agent, 'PUT', `/api/admin/users/${emp.id}/roles`, { roleKeys: ['super_admin'] })).status).toBe(403)
    expect((await call(admin.agent, 'PUT', `/api/admin/users/${emp.id}/roles`, { roleKeys: ['admin'] })).status).toBe(403)
    expect((await call(admin.agent, 'PUT', `/api/admin/users/${sup.id}/roles`, { roleKeys: ['employee'] })).status).toBe(403)
    expect((await call(admin.agent, 'PUT', `/api/admin/users/${emp.id}/roles`, { roleKeys: ['team_lead'] })).status).toBe(200)
    expect((await call(admin.agent, 'PUT', `/api/admin/roles/role_employee`, { name: 'Employee', permissions: ['team.read'] })).status).toBe(403)
    expect((await call(sup.agent, 'PUT', `/api/admin/roles/role_super_admin`, { name: 'Super Admin', permissions: [] })).status).toBe(403)
  })

  it('audit log is restricted and records security events', async () => {
    const emp = await as('employee')
    const sup = await as('super_admin')
    expect((await call(emp.agent, 'GET', '/api/admin/audit')).status).toBe(403)
    const log = await call(sup.agent, 'GET', '/api/admin/audit?category=security')
    expect(log.status).toBe(200)
    expect(log.json.entries.some((e: { action: string }) => e.action === 'auth.login')).toBe(true)
  })
})
