import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { AppBindings, Env } from './env'
import { ApiError } from './lib/http'
import { resolveStaffSession, staffCookieName } from './lib/session'
import { resolvePortalSession } from './routes/portal'
import { hub } from './services/realtime'
import { runScheduled } from './services/scheduled'
import type { SocketIdentity } from './do/RealtimeHub'
import authRoutes from './routes/auth'
import adminRoutes from './routes/admin'
import teamRoutes from './routes/team'
import clientRoutes from './routes/clients'
import projectRoutes from './routes/projects'
import taskRoutes from './routes/tasks'
import fileRoutes from './routes/files'
import calendarRoutes from './routes/calendar'
import hrRoutes from './routes/hr'
import notificationRoutes from './routes/notifications'
import reportRoutes from './routes/reports'
import dashboardRoutes from './routes/dashboard'
import portalRoutes from './routes/portal'

export { RealtimeHub } from './do/RealtimeHub'

const app = new Hono<AppBindings>()

// Baseline security headers for every API response.
app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  if (!c.res.headers.has('cache-control')) c.header('Cache-Control', 'no-store')
})

app.onError((err, c) => {
  if (err instanceof ApiError) {
    if (err.status === 429 && (err.details as { retryAfter?: number })?.retryAfter) c.header('Retry-After', String((err.details as { retryAfter: number }).retryAfter))
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, err.status)
  }
  const msg = err instanceof Error ? err.message : String(err)
  // D1 constraint failures surface as generic errors; map the common ones to user-actionable responses.
  if (/UNIQUE constraint failed/i.test(msg)) return c.json({ error: { code: 'CONFLICT', message: 'That record already exists.', details: null } }, 409)
  if (/FOREIGN KEY constraint failed/i.test(msg)) return c.json({ error: { code: 'CONFLICT', message: 'A related record is missing or still in use.', details: null } }, 409)
  console.error('Unhandled error', err)
  return c.json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. The error has been logged.', details: null } }, 500)
})

const api = new Hono<AppBindings>()
api.get('/health', (c) => c.json({ ok: true, env: c.env.APP_ENV, time: new Date().toISOString(), r2: Boolean(c.env.FILES) }))
api.route('/auth', authRoutes)
api.route('/admin', adminRoutes)
api.route('/team', teamRoutes)
api.route('/clients', clientRoutes)
api.route('/projects', projectRoutes)
api.route('/tasks', taskRoutes)
api.route('/files', fileRoutes)
api.route('/calendar', calendarRoutes)
api.route('/hr', hrRoutes)
api.route('/notifications', notificationRoutes)
api.route('/reports', reportRoutes)
api.route('/dashboard', dashboardRoutes)
api.route('/portal', portalRoutes)
api.all('*', (c) => c.json({ error: { code: 'NOT_FOUND', message: 'Unknown API route', details: null } }, 404))
app.route('/api', api)

/**
 * WebSocket upgrades. The Worker authenticates (cookie session + same-origin check against cross-site
 * WebSocket hijacking) and forwards a trusted identity to the Durable Object.
 */
function originAllowed(c: { req: { header(n: string): string | undefined; url: string }; env: Env }) {
  const origin = c.req.header('origin')
  return !!origin && (origin === new URL(c.req.url).origin || origin === c.env.APP_ORIGIN)
}

app.get('/ws/staff', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.text('Expected WebSocket', 426)
  if (!originAllowed(c)) return c.text('Forbidden origin', 403)
  const r = await resolveStaffSession(c.env, getCookie(c, staffCookieName(c.env)))
  if (!r.ok || r.auth.mfaState === 'pending' || r.auth.mfaState === 'enrol_required') return c.text('Unauthorized', 401)
  const identity: SocketIdentity = {
    kind: 'staff',
    sessionHash: r.auth.sessionHash,
    expiresAt: r.auth.expiresAt,
    userId: r.auth.userId,
    permissions: [...r.auth.permissions],
  }
  const headers = new Headers(c.req.raw.headers)
  headers.set('x-vx-identity', JSON.stringify(identity))
  return hub(c.env).fetch(new Request(c.req.raw.url, { headers }))
})

app.get('/ws/portal', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.text('Expected WebSocket', 426)
  if (!originAllowed(c)) return c.text('Forbidden origin', 403)
  const p = await resolvePortalSession(c.env, c)
  if (!p) return c.text('Unauthorized', 401)
  const identity: SocketIdentity = {
    kind: 'portal',
    sessionHash: p.sessionHash,
    expiresAt: p.expiresAt,
    accessTokenId: p.accessTokenId,
    clientId: p.clientId,
    projectIds: p.projectIds,
  }
  const headers = new Headers(c.req.raw.headers)
  headers.set('x-vx-identity', JSON.stringify(identity))
  return hub(c.env).fetch(new Request(c.req.raw.url, { headers }))
})

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, ctx, new Date(controller.scheduledTime)))
  },
} satisfies ExportedHandler<Env>

export { app }
