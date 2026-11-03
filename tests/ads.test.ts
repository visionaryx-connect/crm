import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { as, call } from './helpers'

async function setup() {
  const admin = await as('super_admin')
  const cl = await call(admin.agent, 'POST', '/api/clients', { name: `Ads client ${Math.random().toString(36).slice(2, 8)}` })
  expect(cl.status).toBe(201)
  const clientId = cl.json.id as string
  const acc = await call(admin.agent, 'POST', `/api/ads/clients/${clientId}/accounts`, { name: 'Main Meta account', externalId: `act_${Date.now()}${Math.floor(Math.random() * 1000)}` })
  expect(acc.status).toBe(201)
  const camp = await call(admin.agent, 'POST', `/api/ads/accounts/${acc.json.id}/campaigns`, { name: 'Spring traffic' })
  expect(camp.status).toBe(201)
  return { admin, clientId, accountId: acc.json.id as string, campaignId: camp.json.id as string }
}

describe('client ad results (staff)', () => {
  it('sets goals with exactly one main goal', async () => {
    const { admin, clientId } = await setup()
    const bad = await call(admin.agent, 'PUT', `/api/ads/clients/${clientId}/goals`, { goals: ['followers'], primary: 'calls' })
    expect(bad.status).toBe(422)
    const ok = await call(admin.agent, 'PUT', `/api/ads/clients/${clientId}/goals`, { goals: ['website_visits', 'followers'], primary: 'website_visits' })
    expect(ok.status).toBe(200)
    const view = await call(admin.agent, 'GET', `/api/ads/clients/${clientId}`)
    expect(view.json.goals).toEqual([
      { goal: 'website_visits', isPrimary: true },
      { goal: 'followers', isPrimary: false },
    ])
  })

  it('upserts daily results and records it in the audit log', async () => {
    const { admin, clientId, campaignId } = await setup()
    const rows = [
      { campaignId, date: '2026-10-01', metric: 'landing_page_views', value: 120 },
      { campaignId, date: '2026-10-01', metric: 'spend', value: 900 },
    ]
    expect((await call(admin.agent, 'PUT', `/api/ads/clients/${clientId}/results`, { rows })).status).toBe(200)
    await call(admin.agent, 'PUT', `/api/ads/clients/${clientId}/results`, { source: 'csv', rows: [{ ...rows[0], value: 130 }] })
    const view = await call(admin.agent, 'GET', `/api/ads/clients/${clientId}?from=2026-10-01&to=2026-10-31`)
    const lpv = view.json.results.find((r: { metric: string }) => r.metric === 'landing_page_views')
    expect(lpv).toMatchObject({ value: 130, source: 'csv' })
    expect(view.json.results).toHaveLength(2)
    const log = await env.DB.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE entity_id = ? AND action = 'client.ad_results_saved'").bind(clientId).first<{ n: number }>()
    expect(log!.n).toBe(2)
  })

  it("rejects results for another client's campaign", async () => {
    const one = await setup()
    const two = await setup()
    const r = await call(one.admin.agent, 'PUT', `/api/ads/clients/${one.clientId}/results`, {
      rows: [{ campaignId: two.campaignId, date: '2026-10-01', metric: 'follows', value: 5 }],
    })
    expect(r.status).toBe(400)
  })

  it('rejects negative values and unknown metrics', async () => {
    const { admin, clientId, campaignId } = await setup()
    const neg = await call(admin.agent, 'PUT', `/api/ads/clients/${clientId}/results`, { rows: [{ campaignId, date: '2026-10-01', metric: 'leads', value: -1 }] })
    expect(neg.status).toBe(422)
    const cpl = await call(admin.agent, 'PUT', `/api/ads/clients/${clientId}/results`, { rows: [{ campaignId, date: '2026-10-01', metric: 'cpl', value: 3 }] })
    expect(cpl.status).toBe(422)
  })

  it('publishes results up to a date', async () => {
    const { admin, clientId } = await setup()
    const r = await call(admin.agent, 'POST', `/api/ads/clients/${clientId}/publish`, { through: '2026-10-31' })
    expect(r.status).toBe(200)
    const view = await call(admin.agent, 'GET', `/api/ads/clients/${clientId}`)
    expect(view.json.publishedThrough).toBe('2026-10-31')
  })

  it('stops employees from editing ad data', async () => {
    const { clientId } = await setup()
    const emp = await as('employee')
    const r = await call(emp.agent, 'PUT', `/api/ads/clients/${clientId}/goals`, { goals: ['calls'], primary: 'calls' })
    expect([403, 404]).toContain(r.status)
    const g = await call(emp.agent, 'GET', `/api/ads/clients/${clientId}`)
    expect(g.status).toBe(404)
  })

  it('rejects linking the same Meta ad account twice', async () => {
    const { admin, clientId } = await setup()
    const ext = `act_9${Date.now()}`
    expect((await call(admin.agent, 'POST', `/api/ads/clients/${clientId}/accounts`, { name: 'A', externalId: ext })).status).toBe(201)
    expect((await call(admin.agent, 'POST', `/api/ads/clients/${clientId}/accounts`, { name: 'B', externalId: ext })).status).toBe(409)
  })
})

async function openPortalFor(admin: Awaited<ReturnType<typeof as>>, clientId: string) {
  const link = await call(admin.agent, 'POST', `/api/clients/${clientId}/portal-links`, { label: 'Ads', validDays: 7 })
  expect(link.status).toBe(201)
  const token = new URL(link.json.link).hash.replace('#t=', '')
  const agent = { cookie: '', csrf: '' }
  expect((await call(agent, 'POST', '/api/portal/session', { token })).status).toBe(200)
  return agent
}

describe('client ad results (portal)', () => {
  it('never returns spend, and only shows published days', async () => {
    const { admin, clientId, campaignId } = await setup()
    await call(admin.agent, 'PUT', `/api/ads/clients/${clientId}/goals`, { goals: ['website_visits'], primary: 'website_visits' })
    await call(admin.agent, 'PUT', `/api/ads/clients/${clientId}/results`, {
      rows: [
        { campaignId, date: '2026-10-01', metric: 'landing_page_views', value: 40 },
        { campaignId, date: '2026-10-01', metric: 'spend', value: 7777 },
        { campaignId, date: '2026-10-20', metric: 'landing_page_views', value: 60 },
        { campaignId, date: '2026-10-20', metric: 'spend', value: 8888 },
      ],
    })
    await call(admin.agent, 'PUT', `/api/ads/clients/${clientId}/notes/2026-10`, { body: 'Launched the Diwali creative.' })
    const agent = await openPortalFor(admin, clientId)

    const before = await call(agent, 'GET', '/api/portal/ads')
    expect(before.json.publishedThrough).toBeNull()
    expect((await call(agent, 'GET', '/api/portal/me')).json.hasAdResults).toBe(false)

    await call(admin.agent, 'POST', `/api/ads/clients/${clientId}/publish`, { through: '2026-10-10' })
    const r = await call(agent, 'GET', '/api/portal/ads?month=2026-10')
    expect(r.status).toBe(200)
    expect(r.json.totals).toEqual({ landing_page_views: 40 })
    expect(r.json.note.body).toBe('Launched the Diwali creative.')
    const raw = JSON.stringify(r.json)
    expect(raw).not.toMatch(/spend|7777|8888/)
    expect((await call(agent, 'GET', '/api/portal/me')).json.hasAdResults).toBe(true)
  })

  it("only shows the portal client's own results", async () => {
    const one = await setup()
    const two = await setup()
    await call(two.admin.agent, 'PUT', `/api/ads/clients/${two.clientId}/results`, { rows: [{ campaignId: two.campaignId, date: '2026-10-01', metric: 'follows', value: 99 }] })
    await call(two.admin.agent, 'POST', `/api/ads/clients/${two.clientId}/publish`, { through: '2026-10-31' })
    await call(one.admin.agent, 'POST', `/api/ads/clients/${one.clientId}/publish`, { through: '2026-10-31' })
    const agent = await openPortalFor(one.admin, one.clientId)
    const r = await call(agent, 'GET', '/api/portal/ads?month=2026-10')
    expect(r.json.totals).toEqual({})
    expect(JSON.stringify(r.json)).not.toContain('99')
  })

  it('compares a partly published month with the same days of the previous month', async () => {
    const { admin, clientId, campaignId } = await setup()
    await call(admin.agent, 'PUT', `/api/ads/clients/${clientId}/results`, {
      rows: [
        { campaignId, date: '2026-10-01', metric: 'follows', value: 10 },
        { campaignId, date: '2026-10-02', metric: 'follows', value: 10 },
        { campaignId, date: '2026-10-25', metric: 'follows', value: 500 },
        { campaignId, date: '2026-11-01', metric: 'follows', value: 15 },
        { campaignId, date: '2026-11-02', metric: 'follows', value: 15 },
      ],
    })
    await call(admin.agent, 'POST', `/api/ads/clients/${clientId}/publish`, { through: '2026-11-02' })
    const agent = await openPortalFor(admin, clientId)
    const r = await call(agent, 'GET', '/api/portal/ads')
    expect(r.json.month).toBe('2026-11')
    expect(r.json.comparedDays).toBe(2)
    expect(r.json.totals).toEqual({ follows: 30 })
    expect(r.json.previous).toEqual({ follows: 20 })
  })
})
