import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { many, nowIso, one } from '../lib/db'
import { body, query } from '../lib/http'
import { requireStaff } from '../lib/session'
import { NOTIFICATION_KINDS } from '../services/notify'

const notifications = new Hono<AppBindings>()
notifications.use('*', requireStaff())

notifications.get('/', async (c) => {
  const a = c.get('auth')
  const unread = query(c, 'unread') === '1'
  const before = query(c, 'before')
  const rows = await many(
    c.env.DB,
    `SELECT id, kind, title, body, link, entity_type, entity_id, read_at, created_at FROM notifications
      WHERE user_id = ? ${unread ? 'AND read_at IS NULL' : ''} ${before ? 'AND created_at < ?' : ''} ORDER BY created_at DESC LIMIT 50`,
    a.userId,
    ...(before ? [before] : []),
  )
  const count = await one<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', a.userId)
  return c.json({ notifications: rows, unread: count?.n ?? 0 })
})

notifications.get('/count', async (c) => {
  const a = c.get('auth')
  const count = await one<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', a.userId)
  return c.json({ unread: count?.n ?? 0 })
})

notifications.post('/read', async (c) => {
  const a = c.get('auth')
  const input = await body(c, z.object({ ids: z.array(z.string()).max(200).optional(), all: z.boolean().optional() }))
  if (input.all) {
    await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(nowIso(), a.userId).run()
  } else if (input.ids?.length) {
    await c.env.DB.batch(input.ids.map((id) => c.env.DB.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').bind(nowIso(), id, a.userId)))
  }
  return c.json({ ok: true })
})

notifications.get('/preferences', async (c) => {
  const a = c.get('auth')
  const rows = await many<{ kind: string; in_app: number }>(c.env.DB, 'SELECT kind, in_app FROM notification_preferences WHERE user_id = ?', a.userId)
  return c.json({
    preferences: Object.entries(NOTIFICATION_KINDS).map(([kind, label]) => ({
      kind,
      label,
      inApp: kind === 'security' ? true : (rows.find((r) => r.kind === kind)?.in_app ?? 1) === 1,
      locked: kind === 'security',
    })),
  })
})

notifications.put('/preferences', async (c) => {
  const a = c.get('auth')
  const input = await body(c, z.object({ preferences: z.array(z.object({ kind: z.string(), inApp: z.boolean() })).max(50) }))
  const valid = input.preferences.filter((p) => p.kind in NOTIFICATION_KINDS && p.kind !== 'security')
  if (valid.length) {
    await c.env.DB.batch(
      valid.map((p) =>
        c.env.DB.prepare(`INSERT INTO notification_preferences (user_id, kind, in_app) VALUES (?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET in_app = excluded.in_app`).bind(a.userId, p.kind, p.inApp ? 1 : 0),
      ),
    )
  }
  return c.json({ ok: true })
})

export default notifications
