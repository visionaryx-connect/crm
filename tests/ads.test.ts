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
