import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hashPassword } from '../worker/lib/password'
import { decryptSecret, newId } from '../worker/lib/crypto'
import { currentStep, totpAt } from '../worker/lib/totp'

export const ORIGIN = 'http://example.com'
export const PASSWORD = 'correct-horse-battery-9'
let counter = 0

export async function createUser(roleKey: string, opts: { name?: string; departmentId?: string | null; managerId?: string | null } = {}) {
  const id = newId('usr')
  const n = ++counter
  const email = `${roleKey}.${n}.${Math.random().toString(36).slice(2, 7)}@test.local`
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, name, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, email, opts.name ?? `${roleKey} ${n}`, await hashPassword(PASSWORD), 'active', now, now),
    env.DB.prepare('INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)').bind(id, `role_${roleKey}`, now),
    env.DB.prepare('INSERT INTO employee_profiles (user_id, employee_code, designation, department_id, manager_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, `T-${id.slice(-8)}`, roleKey, opts.departmentId ?? null, opts.managerId ?? null, now, now),
  ])
  return { id, email }
}

export interface Agent {
  cookie: string
  csrf: string
  userId?: string
}

function mergeCookies(existing: string, res: Response): string {
  const jar = new Map(existing.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]))
  for (const sc of res.headers.getSetCookie()) {
    const pair = sc.split(';')[0]
    const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]
    if (!value || /max-age=0/i.test(sc)) jar.delete(name)
    else jar.set(name, pair)
  }
  return [...jar.values()].join('; ')
}

export async function call(agent: Agent | null, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...extraHeaders }
  if (agent?.cookie) headers.cookie = agent.cookie
  if (agent?.csrf && method !== 'GET') headers['x-csrf-token'] = agent.csrf
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await SELF.fetch(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  if (agent) agent.cookie = mergeCookies(agent.cookie, res)
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json, res }
}

/** Log in (completing MFA enrolment/verification automatically for roles that require it). */
export async function login(email: string, password = PASSWORD): Promise<Agent> {
  const agent: Agent = { cookie: '', csrf: '' }
  // Each simulated user signs in from its own address so the per-IP limiter does not trip across a test file.
  const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
  const r = await call(agent, 'POST', '/api/auth/login', { email, password }, { 'cf-connecting-ip': ip })
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.json)}`)
  agent.csrf = r.json.csrfToken
  if (r.json.mfa === 'enrol') {
    const setup = await call(agent, 'POST', '/api/auth/mfa/setup', {})
    const code = await totpAt(setup.json.secret, currentStep())
    const en = await call(agent, 'POST', '/api/auth/mfa/enable', { code })
    if (en.status !== 200) throw new Error(`mfa enable failed ${JSON.stringify(en.json)}`)
    agent.csrf = en.json.csrfToken
  } else if (r.json.mfa === 'required') {
    const user = await env.DB.prepare('SELECT mfa_secret_enc, mfa_last_step FROM users WHERE email = ?').bind(email).first<{ mfa_secret_enc: string; mfa_last_step: number | null }>()
    const secret = await decryptSecret(env.DATA_KEY, user!.mfa_secret_enc)
    const step = Math.max(currentStep(), (user!.mfa_last_step ?? 0) + 1)
    const v = await call(agent, 'POST', '/api/auth/mfa/verify', { code: await totpAt(secret, step) })
    if (v.status !== 200) throw new Error(`mfa verify failed ${JSON.stringify(v.json)}`)
    agent.csrf = v.json.csrfToken
  }
  const me = await call(agent, 'GET', '/api/auth/me')
  agent.userId = me.json.user.id
  return agent
}

export async function as(roleKey: string, opts?: Parameters<typeof createUser>[1]) {
  const u = await createUser(roleKey, opts)
  return { ...u, agent: await login(u.email) }
}

/** Build a client + project managed by `pm`, with optional members. */
export async function scaffoldProject(admin: Agent, pmId: string, memberIds: { id: string; role?: string; canReview?: boolean }[] = []) {
  const cl = await call(admin, 'POST', '/api/clients', { name: `Client ${Math.random().toString(36).slice(2, 8)}`, email: `c${Math.random().toString(36).slice(2, 8)}@client.test` })
  if (cl.status !== 201) throw new Error(JSON.stringify(cl.json))
  const pr = await call(admin, 'POST', '/api/projects', { name: 'Test project', clientId: cl.json.id, managerId: pmId, status: 'in_progress' })
  if (pr.status !== 201) throw new Error(JSON.stringify(pr.json))
  for (const m of memberIds) {
    const r = await call(admin, 'POST', `/api/projects/${pr.json.id}/members`, { userId: m.id, role: m.role ?? 'member', canReview: m.canReview ?? false })
    if (r.status !== 200) throw new Error(JSON.stringify(r.json))
  }
  return { clientId: cl.json.id as string, projectId: pr.json.id as string }
}
