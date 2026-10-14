import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { as, call, scaffoldProject, type Agent } from './helpers'

async function openPortal(link: string): Promise<{ agent: Agent; status: number; json: any }> {
  const token = new URL(link).hash.replace('#t=', '')
  const agent: Agent = { cookie: '', csrf: '' }
  const r = await call(agent, 'POST', '/api/portal/session', { token })
  if (r.status === 200) {
    const me = await call(agent, 'GET', '/api/portal/me')
    agent.csrf = me.json.csrfToken
  }
  return { agent, status: r.status, json: r.json }
}

async function world() {
  const admin = await as('super_admin')
  const pm = await as('project_manager')
  const a = await scaffoldProject(admin.agent, pm.id)
  const b = await scaffoldProject(admin.agent, pm.id)
  await call(admin.agent, 'POST', `/api/clients/${a.clientId}/contacts`, { name: 'Client A', email: 'boss@a.test', isPrimary: true })
  const link = await call(pm.agent, 'POST', `/api/clients/${a.clientId}/portal-links`, { label: 'Main', projectId: a.projectId, validDays: 7 })
  expect(link.status).toBe(201)
  return { admin, pm, a, b, link: link.json }
}

describe('passwordless client portal', () => {
  it('never stores the raw link secret', async () => {
    const { link } = await world()
    const token = new URL(link.link).hash.replace('#t=', '')
    const row = await env.DB.prepare('SELECT token_hash, token_hint FROM client_access_tokens WHERE id = ?').bind(link.id).first<{ token_hash: string; token_hint: string }>()
    expect(row!.token_hash).not.toContain(token)
    expect(row!.token_hash).toHaveLength(64)
    expect(token).toHaveLength(43)
  })

  it('exposes only client-visible records of the scoped project', async () => {
    const { pm, a, b, link } = await world()
    await call(pm.agent, 'POST', `/api/projects/${a.projectId}/updates`, { title: 'Public update', clientVisible: true })
    await call(pm.agent, 'POST', `/api/projects/${a.projectId}/updates`, { title: 'Internal margin note', clientVisible: false })
    await call(pm.agent, 'POST', `/api/projects/${a.projectId}/milestones`, { title: 'Hidden milestone', clientVisible: false })
    await call(pm.agent, 'POST', `/api/projects/${a.projectId}/milestones`, { title: 'Visible milestone', clientVisible: true })
    const t = await call(pm.agent, 'POST', '/api/tasks', { projectId: a.projectId, title: 'Internal task' })
    await call(pm.agent, 'POST', `/api/tasks/${t.json.id}/comments`, { body: 'internal comment secret' })
    await call(pm.agent, 'POST', `/api/files/deliverables?projectId=${a.projectId}`, { title: 'Unshared draft' })

    const { agent } = await openPortal(link.link)
    const me = await call(agent, 'GET', '/api/portal/me')
    expect(me.json.projects.map((p: { id: string }) => p.id)).toEqual([a.projectId])
    const view = await call(agent, 'GET', `/api/portal/projects/${a.projectId}`)
    const raw = JSON.stringify(view.json)
    expect(raw).toContain('Public update')
    expect(raw).toContain('Visible milestone')
    expect(raw).not.toContain('Internal margin note')
    expect(raw).not.toContain('Hidden milestone')
    expect(raw).not.toContain('Internal task')
    expect(raw).not.toContain('internal comment secret')
    expect(raw).not.toContain('Unshared draft')
    expect(raw).not.toContain('estimated_hours')
    // Other client's project is invisible.
    expect((await call(agent, 'GET', `/api/portal/projects/${b.projectId}`)).status).toBe(404)
    // Portal session cannot call staff APIs.
    expect((await call(agent, 'GET', '/api/projects')).status).toBe(401)
    expect((await call(agent, 'GET', `/api/projects/${a.projectId}`)).status).toBe(401)
  })

  it('accepts feedback and requires step-up verification for approvals', async () => {
    const { pm, a, link } = await world()
    const d = await call(pm.agent, 'POST', `/api/files/deliverables?projectId=${a.projectId}`, { title: 'Logo pack' })
    await env.DB.prepare(`UPDATE deliverables SET status = 'approved', current_version = 1 WHERE id = ?`).bind(d.json.id).run()
    expect((await call(pm.agent, 'POST', `/api/files/deliverables/${d.json.id}/status`, { action: 'share' })).status).toBe(200)
    const { agent } = await openPortal(link.link)
    const fb = await call(agent, 'POST', '/api/portal/feedback', { projectId: a.projectId, kind: 'question', authorName: 'Boss', body: 'When is launch?' })
    expect(fb.status).toBe(201)
    const decide = () => call(agent, 'POST', `/api/portal/deliverables/${d.json.id}/decision`, { decision: 'client_approved', authorName: 'Boss' })
    expect((await decide()).json.error.code).toBe('REVERIFY_REQUIRED')
    expect((await call(agent, 'POST', '/api/portal/verify', { email: 'someone@else.test' })).status).toBe(401)
    expect((await call(agent, 'POST', '/api/portal/verify', { email: 'boss@a.test' })).status).toBe(200)
    expect((await decide()).status).toBe(200)
    const st = await env.DB.prepare('SELECT status FROM deliverables WHERE id = ?').bind(d.json.id).first<{ status: string }>()
    expect(st?.status).toBe('client_approved')
    // Portal mutations need the CSRF header.
    expect((await call({ ...agent, csrf: '' }, 'POST', '/api/portal/feedback', { projectId: a.projectId, kind: 'feedback', authorName: 'x', body: 'y' })).status).toBe(403)
  })

  it('revocation and expiry end access immediately', async () => {
    const { pm, a, link } = await world()
    const { agent } = await openPortal(link.link)
    expect((await call(agent, 'GET', '/api/portal/me')).status).toBe(200)
    expect((await call(pm.agent, 'POST', `/api/clients/${a.clientId}/portal-links/${link.id}/revoke`, {})).status).toBe(200)
    expect((await call(agent, 'GET', '/api/portal/me')).status).toBe(401)
    expect((await openPortal(link.link)).status).toBe(401)

    const fresh = await call(pm.agent, 'POST', `/api/clients/${a.clientId}/portal-links`, { label: 'Short', validDays: 1 })
    await env.DB.prepare('UPDATE client_access_tokens SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), fresh.json.id).run()
    const expired = await openPortal(fresh.json.link)
    expect(expired.status).toBe(401)
    expect(expired.json.error.code).toBe('PORTAL_LINK_INVALID')
  })

  it('rejects garbage tokens and rate-limits guessing', async () => {
    let last = 0
    for (let i = 0; i < 22; i++) {
      last = (await call({ cookie: '', csrf: '' }, 'POST', '/api/portal/session', { token: 'x'.repeat(43) }, { 'cf-connecting-ip': '203.0.113.9' })).status
    }
    expect(last).toBe(429)
  })
})
