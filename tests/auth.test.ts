import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { as, call, createUser, login, PASSWORD, type Agent } from './helpers'

describe('authentication and sessions', () => {
  it('logs in, returns profile, and logs out (session revoked)', async () => {
    const u = await createUser('employee')
    const agent = await login(u.email)
    const me = await call(agent, 'GET', '/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.json.user.email).toBe(u.email)
    expect(me.json.permissions).toContain('leave.request')
    expect(me.json.permissions).not.toContain('clients.read')
    const out = await call(agent, 'POST', '/api/auth/logout', {})
    expect(out.status).toBe(200)
    expect((await call(agent, 'GET', '/api/auth/me')).status).toBe(401)
  })

  it('reuse of a revoked cookie is rejected even if the browser keeps it', async () => {
    const u = await createUser('employee')
    const agent = await login(u.email)
    const saved = agent.cookie
    await call(agent, 'POST', '/api/auth/logout', {})
    const r = await call({ cookie: saved, csrf: agent.csrf }, 'GET', '/api/auth/me')
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe('SESSION_EXPIRED')
  })

  it('rejects wrong passwords with a generic message and locks after repeated failures', async () => {
    const u = await createUser('employee')
    for (let i = 0; i < 4; i++) {
      const r = await call({ cookie: '', csrf: '' }, 'POST', '/api/auth/login', { email: u.email, password: 'nope-nope-nope' })
      expect(r.status).toBe(401)
      expect(r.json.error.code).toBe('INVALID_CREDENTIALS')
    }
    await call({ cookie: '', csrf: '' }, 'POST', '/api/auth/login', { email: u.email, password: 'nope-nope-nope' })
    const locked = await call({ cookie: '', csrf: '' }, 'POST', '/api/auth/login', { email: u.email, password: PASSWORD })
    expect(locked.status).toBe(429)
    expect(locked.json.error.code).toBe('ACCOUNT_LOCKED')
    const log = await env.DB.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'auth.account_locked' AND entity_id = ?`).bind(u.id).first<{ n: number }>()
    expect(log?.n).toBe(1)
  })

  it('expires idle sessions', async () => {
    const u = await createUser('employee')
    const agent = await login(u.email)
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE user_id = ?').bind(new Date(Date.now() - 13 * 3600_000).toISOString(), u.id).run()
    const r = await call(agent, 'GET', '/api/auth/me')
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe('SESSION_EXPIRED')
  })

  it('expires sessions at their absolute limit', async () => {
    const u = await createUser('employee')
    const agent = await login(u.email)
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').bind(new Date(Date.now() - 1000).toISOString(), u.id).run()
    expect((await call(agent, 'GET', '/api/auth/me')).status).toBe(401)
  })

  it('deactivated users lose access immediately', async () => {
    const admin = await as('super_admin')
    const u = await createUser('employee')
    const agent = await login(u.email)
    const r = await call(admin.agent, 'POST', `/api/admin/users/${u.id}/status`, { status: 'deactivated' })
    expect(r.status).toBe(200)
    expect((await call(agent, 'GET', '/api/auth/me')).status).toBe(401)
  })

  it('requires the CSRF token and same origin on mutations', async () => {
    const u = await createUser('employee')
    const agent = await login(u.email)
    const noToken = await call({ cookie: agent.cookie, csrf: '' }, 'POST', '/api/notifications/read', { all: true })
    expect(noToken.status).toBe(403)
    expect(noToken.json.error.code).toBe('CSRF_FAILED')
    const crossSite = await call(agent, 'POST', '/api/notifications/read', { all: true }, { origin: 'https://evil.example' })
    expect(crossSite.status).toBe(403)
    expect((await call(agent, 'POST', '/api/notifications/read', { all: true })).status).toBe(200)
  })

  it('admins sign in without MFA by default', async () => {
    const u = await createUser('admin')
    const r = await call({ cookie: '', csrf: '' }, 'POST', '/api/auth/login', { email: u.email, password: PASSWORD })
    expect(r.json.mfa).toBeNull()
  })

  it('forces MFA enrolment when a role is configured to require it', async () => {
    await env.DB.prepare(`UPDATE roles SET requires_mfa = 1 WHERE key = 'hr_manager'`).run()
    const u = await createUser('hr_manager')
    const agent: Agent = { cookie: '', csrf: '' }
    const r = await call(agent, 'POST', '/api/auth/login', { email: u.email, password: PASSWORD })
    expect(r.json.mfa).toBe('enrol')
    agent.csrf = r.json.csrfToken
    const blocked = await call(agent, 'GET', '/api/team/members')
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('MFA_ENROLMENT_REQUIRED')
    // Once enrolled, the next login requires a code.
    const full = await login(u.email)
    expect((await call(full, 'GET', '/api/team/members')).status).toBe(200)
    const again: Agent = { cookie: '', csrf: '' }
    const second = await call(again, 'POST', '/api/auth/login', { email: u.email, password: PASSWORD })
    expect(second.json.mfa).toBe('required')
    again.csrf = second.json.csrfToken
    expect((await call(again, 'GET', '/api/team/members')).json.error.code).toBe('MFA_REQUIRED')
    await env.DB.prepare(`UPDATE roles SET requires_mfa = 0 WHERE key = 'hr_manager'`).run()
    expect((await call(again, 'POST', '/api/auth/mfa/verify', { code: '000000' })).status).toBe(401)
  })

  it('activation links set a password once and cannot be replayed', async () => {
    const admin = await as('super_admin')
    const created = await call(admin.agent, 'POST', '/api/admin/users', { name: 'New Hire', email: 'new.hire@test.local', roleKeys: ['employee'], employeeCode: 'NH-1' })
    expect(created.status).toBe(201)
    const token = new URL(created.json.activationLink).hash.replace('#token=', '')
    const check = await call(null, 'GET', `/api/auth/token/check?token=${token}`)
    expect(check.json.purpose).toBe('activation')
    expect((await call(null, 'POST', '/api/auth/password/reset', { token, password: 'a-brand-new-passphrase-1' })).status).toBe(200)
    expect((await call(null, 'POST', '/api/auth/password/reset', { token, password: 'another-passphrase-22' })).status).toBe(400)
    expect((await login('new.hire@test.local', 'a-brand-new-passphrase-1')).userId).toBe(created.json.id)
  })
})
