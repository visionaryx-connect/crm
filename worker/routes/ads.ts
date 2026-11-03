// Staff API for client ad results (Meta). Phase 1: goals, accounts, campaigns, manual/CSV daily results, publishing.
// Spend is visible here (staff only). The client portal must read through CLIENT_VISIBLE_AD_METRICS instead.
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { adAccountSchema, adCampaignSchema, adGoalsSchema, adMonth, adNoteSchema, adPublishSchema, adResultsSchema, dateStr } from '@shared/schemas'
import { activity } from '../lib/audit'
import { newId } from '../lib/crypto'
import { many, nowIso, one, placeholders } from '../lib/db'
import { badRequest, body, clientIp, conflict, notFound, query, validate } from '../lib/http'
import { requirePermission, requireStaff } from '../lib/session'

const ads = new Hono<AppBindings>()
ads.use('*', requireStaff())

type Auth = AppBindings['Variables']['auth']

/** Same rule as the clients module: clients.read, or the client's account manager. */
async function assertClient(db: D1Database, auth: Auth, clientId: string) {
  const row = await one<{ id: string; name: string; account_manager_id: string | null; ad_results_published_through: string | null }>(
    db, 'SELECT id, name, account_manager_id, ad_results_published_through FROM clients WHERE id = ?', clientId,
  )
  if (!row || !(auth.permissions.has('clients.read') || row.account_manager_id === auth.userId)) throw notFound('Client')
  return row
}

ads.get('/clients/:clientId', async (c) => {
  const a = c.get('auth')
  const clientId = c.req.param('clientId')
  const client = await assertClient(c.env.DB, a, clientId)
  const from = query(c, 'from')
  const to = query(c, 'to')
  if (from) validate(dateStr, from)
  if (to) validate(dateStr, to)
  const where = ['r.client_id = ?']
  const params: unknown[] = [clientId]
  if (from) { where.push('r.date >= ?'); params.push(from) }
  if (to) { where.push('r.date <= ?'); params.push(to) }
  const month = query(c, 'month')
  if (month) validate(adMonth, month)
  const [goals, accounts, campaigns, results, note] = await Promise.all([
    many<{ goal: string; is_primary: number }>(c.env.DB, 'SELECT goal, is_primary FROM client_ad_goals WHERE client_id = ? ORDER BY is_primary DESC, goal', clientId),
    many(c.env.DB, 'SELECT id, platform, external_id, name, created_at FROM ad_accounts WHERE client_id = ? AND archived_at IS NULL ORDER BY name', clientId),
    many(
      c.env.DB,
      `SELECT k.id, k.ad_account_id, k.external_id, k.name, k.created_at FROM ad_campaigns k JOIN ad_accounts acc ON acc.id = k.ad_account_id
        WHERE acc.client_id = ? AND k.archived_at IS NULL AND acc.archived_at IS NULL ORDER BY k.name`,
      clientId,
    ),
    many(
      c.env.DB,
      `SELECT r.campaign_id, r.date, r.metric, r.value, r.source, r.updated_at FROM ad_results_daily r
        WHERE ${where.join(' AND ')} ORDER BY r.date, r.campaign_id, r.metric LIMIT 20000`,
      ...params,
    ),
    month ? one<{ body: string; updated_at: string }>(c.env.DB, 'SELECT body, updated_at FROM ad_report_notes WHERE client_id = ? AND month = ?', clientId, month) : null,
  ])
  return c.json({
    note: note ?? null,
    goals: goals.map((g) => ({ goal: g.goal, isPrimary: Boolean(g.is_primary) })),
    accounts,
    campaigns,
    results,
    publishedThrough: client.ad_results_published_through,
  })
})

ads.put('/clients/:clientId/goals', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const clientId = c.req.param('clientId')
  const client = await assertClient(c.env.DB, a, clientId)
  const input = await body(c, adGoalsSchema)
  const goals = [...new Set(input.goals)]
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM client_ad_goals WHERE client_id = ?').bind(clientId),
    ...goals.map((g) =>
      c.env.DB.prepare('INSERT INTO client_ad_goals (client_id, goal, is_primary, created_at) VALUES (?, ?, ?, ?)').bind(clientId, g, g === input.primary ? 1 : 0, now),
    ),
    activity(c.env.DB, {
      actorId: a.userId, action: 'client.ad_goals_set', entityType: 'client', entityId: clientId,
      summary: `Set ad goals for ${client.name}: ${goals.join(', ') || 'none'}`, changes: { goals, primary: input.primary }, ip: clientIp(c),
    }),
  ])
  return c.json({ ok: true })
})

ads.post('/clients/:clientId/accounts', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const clientId = c.req.param('clientId')
  const client = await assertClient(c.env.DB, a, clientId)
  const input = await body(c, adAccountSchema)
  if (input.externalId) {
    const dup = await one(c.env.DB, "SELECT id FROM ad_accounts WHERE platform = 'meta' AND external_id = ?", input.externalId)
    if (dup) throw conflict('That Meta ad account is already linked to a client')
  }
  const id = newId('ada')
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO ad_accounts (id, client_id, platform, external_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, clientId, 'meta', input.externalId ?? null, input.name, a.userId, nowIso()),
    activity(c.env.DB, { actorId: a.userId, action: 'client.ad_account_added', entityType: 'client', entityId: clientId, summary: `Linked Meta ad account ${input.name} to ${client.name}`, ip: clientIp(c) }),
  ])
  return c.json({ id }, 201)
})

ads.post('/accounts/:accountId/campaigns', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const account = await one<{ id: string; client_id: string; name: string }>(c.env.DB, 'SELECT id, client_id, name FROM ad_accounts WHERE id = ? AND archived_at IS NULL', c.req.param('accountId'))
  if (!account) throw notFound('Ad account')
  await assertClient(c.env.DB, a, account.client_id)
  const input = await body(c, adCampaignSchema)
  const id = newId('adc')
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO ad_campaigns (id, ad_account_id, external_id, name, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, account.id, input.externalId ?? null, input.name, nowIso()),
    activity(c.env.DB, { actorId: a.userId, action: 'client.ad_campaign_added', entityType: 'client', entityId: account.client_id, summary: `Added campaign ${input.name} to ${account.name}`, ip: clientIp(c) }),
  ])
  return c.json({ id }, 201)
})

/** Upsert daily results. Re-sending a row for the same campaign, day and metric replaces its value. */
ads.put('/clients/:clientId/results', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const clientId = c.req.param('clientId')
  const client = await assertClient(c.env.DB, a, clientId)
  const input = await body(c, adResultsSchema)
  const campaignIds = [...new Set(input.rows.map((r) => r.campaignId))]
  if (campaignIds.length > 100) throw badRequest('Upload results for at most 100 campaigns at a time')
  const owned = await many<{ id: string }>(
    c.env.DB,
    `SELECT k.id FROM ad_campaigns k JOIN ad_accounts acc ON acc.id = k.ad_account_id WHERE acc.client_id = ? AND k.id IN (${placeholders(campaignIds.length)})`,
    clientId, ...campaignIds,
  )
  if (owned.length !== campaignIds.length) throw badRequest("Some results refer to a campaign that doesn't belong to this client")
  const now = nowIso()
  const dates = input.rows.map((r) => r.date).sort()
  await c.env.DB.batch([
    ...input.rows.map((r) =>
      c.env.DB.prepare(
        `INSERT INTO ad_results_daily (campaign_id, client_id, date, metric, value, source, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (campaign_id, date, metric) DO UPDATE SET value = excluded.value, source = excluded.source, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).bind(r.campaignId, clientId, r.date, r.metric, r.value, input.source, a.userId, now),
    ),
    activity(c.env.DB, {
      actorId: a.userId, action: 'client.ad_results_saved', entityType: 'client', entityId: clientId,
      summary: `Saved ${input.rows.length} ad result(s) for ${client.name} (${dates[0]} to ${dates[dates.length - 1]}, ${input.source})`, ip: clientIp(c),
    }),
  ])
  return c.json({ saved: input.rows.length })
})

ads.put('/clients/:clientId/notes/:month', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const clientId = c.req.param('clientId')
  const month = validate(adMonth, c.req.param('month'))
  const client = await assertClient(c.env.DB, a, clientId)
  const { body: text } = await body(c, adNoteSchema)
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO ad_report_notes (client_id, month, body, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (client_id, month) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(clientId, month, text, a.userId, nowIso()),
    activity(c.env.DB, { actorId: a.userId, action: 'client.ad_note_saved', entityType: 'client', entityId: clientId, summary: `Updated the ${month} ad note for ${client.name}`, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

/** Make results up to and including `through` visible in the client portal (null hides everything). */
ads.post('/clients/:clientId/publish', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const clientId = c.req.param('clientId')
  const client = await assertClient(c.env.DB, a, clientId)
  const { through } = await body(c, adPublishSchema)
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE clients SET ad_results_published_through = ?, updated_at = ? WHERE id = ?').bind(through, nowIso(), clientId),
    activity(c.env.DB, {
      actorId: a.userId, action: 'client.ad_results_published', entityType: 'client', entityId: clientId,
      summary: through ? `Published ad results for ${client.name} through ${through}` : `Hid ad results from ${client.name}'s portal`,
      changes: { publishedThrough: { from: client.ad_results_published_through, to: through } }, ip: clientIp(c),
    }),
  ])
  return c.json({ publishedThrough: through })
})

export default ads
