import { describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'
import { as, call, ORIGIN, scaffoldProject, type Agent } from './helpers'

interface Socket {
  ws: WebSocket
  messages: any[]
  closed: { code: number } | null
}

async function connect(path: string, agent: Agent, origin = ORIGIN): Promise<{ status: number; socket?: Socket }> {
  const res = await SELF.fetch(`${ORIGIN}${path}`, { headers: { upgrade: 'websocket', origin, cookie: agent.cookie } })
  if (!res.webSocket) return { status: res.status }
  const ws = res.webSocket
  const socket: Socket = { ws, messages: [], closed: null }
  ws.accept()
  ws.addEventListener('message', (e) => { socket.messages.push(JSON.parse(e.data as string)) })
  ws.addEventListener('close', (e) => (socket.closed = { code: e.code }))
  return { status: res.status, socket }
}

const events = (s: Socket) => s.messages.filter((m) => m.type === 'event').map((m) => m.event)
async function until(fn: () => boolean, ms = 1500) {
  const start = Date.now()
  while (!fn() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 20))
}
const settle = () => new Promise((r) => setTimeout(r, 250))

async function openPortal(link: string): Promise<Agent> {
  const agent: Agent = { cookie: '', csrf: '' }
  await call(agent, 'POST', '/api/portal/session', { token: new URL(link).hash.replace('#t=', '') })
  return agent
}

describe('realtime WebSocket authorisation and isolation', () => {
  it('rejects unauthenticated and cross-origin upgrades', async () => {
    expect((await connect('/ws/staff', { cookie: '', csrf: '' })).status).toBe(401)
    const emp = await as('employee')
    expect((await connect('/ws/staff', emp.agent, 'https://evil.example')).status).toBe(403)
    expect((await connect('/ws/portal', emp.agent)).status).toBe(401)
  })

  it('delivers project events only to authorised subscribers and never to portal sockets', async () => {
    const admin = await as('super_admin')
    const pm = await as('project_manager')
    const member = await as('employee')
    const outsider = await as('employee')
    const { projectId, clientId } = await scaffoldProject(admin.agent, pm.id, [{ id: member.id }])
    const link = await call(pm.agent, 'POST', `/api/clients/${clientId}/portal-links`, { label: 'RT', projectId })
    const portalAgent = await openPortal(link.json.link)

    const m = (await connect('/ws/staff', member.agent)).socket!
    const o = (await connect('/ws/staff', outsider.agent)).socket!
    const p = (await connect('/ws/portal', portalAgent)).socket!
    await until(() => m.messages.length > 0 && o.messages.length > 0 && p.messages.length > 0)
    expect(m.messages[0].type).toBe('welcome')

    m.ws.send(JSON.stringify({ type: 'subscribe', rooms: ['projects:*', `project:${projectId}`] }))
    o.ws.send(JSON.stringify({ type: 'subscribe', rooms: [`project:${projectId}`, 'projects:*'] }))
    p.ws.send(JSON.stringify({ type: 'subscribe', rooms: [`project:${projectId}`] }))
    await until(() => o.messages.some((x) => x.type === 'error') && p.messages.some((x) => x.type === 'error'))
    expect(o.messages.find((x) => x.type === 'error').details.rooms).toEqual([`project:${projectId}`])
    expect(p.messages.find((x) => x.type === 'error').code).toBe('FORBIDDEN_ROOM')

    await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Realtime task', responsibleId: member.id })
    await until(() => events(m).some((e) => e.type === 'task.created'))
    await settle()
    expect(events(m).map((e) => e.type)).toEqual(expect.arrayContaining(['task.created', 'task.assigned', 'notification.created']))
    expect(events(o)).toEqual([])
    expect(events(p)).toEqual([])

    // Client-visible update reaches the portal as a portal-namespaced event only.
    await call(pm.agent, 'POST', `/api/projects/${projectId}/updates`, { title: 'Hello client', clientVisible: true })
    await until(() => events(p).length > 0)
    expect(events(p).every((e) => e.type.startsWith('portal.') && e.room === `portal:project:${projectId}`)).toBe(true)
    expect(JSON.stringify(events(p))).not.toContain('Realtime task')
  })

  it('closes sockets when the session is revoked', async () => {
    const emp = await as('employee')
    const s = (await connect('/ws/staff', emp.agent)).socket!
    await until(() => s.messages.length > 0)
    await call(emp.agent, 'POST', '/api/auth/logout', {})
    await until(() => s.closed !== null)
    expect(s.closed?.code).toBe(4401)
  })

  it('validates message size and type', async () => {
    const emp = await as('employee')
    const s = (await connect('/ws/staff', emp.agent)).socket!
    await until(() => s.messages.length > 0)
    s.ws.send('not json')
    s.ws.send(JSON.stringify({ type: 'teleport' }))
    s.ws.send(JSON.stringify({ type: 'ping' }))
    await until(() => s.messages.some((x) => x.type === 'pong'))
    expect(s.messages.filter((x) => x.type === 'error').map((x) => x.code)).toEqual(['BAD_MESSAGE', 'BAD_MESSAGE'])
    s.ws.send('x'.repeat(5000))
    await until(() => s.closed !== null)
    expect(s.closed?.code).toBe(1009)
  })
})
