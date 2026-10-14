// Passwordless client portal.
//
// Flow: staff issue a link `/portal/access#t=<secret>`. The secret lives in the URL fragment, so it is never
// sent to the server in a URL, logged, or leaked via Referer. The SPA posts it once to /api/portal/session,
// which validates (rate-limited) against the stored SHA-256 hash and sets a short-lived HttpOnly, SameSite=Strict
// portal session cookie; the SPA then replaces the URL with a clean /portal path.
//
// Every portal query is constrained to the token's client and project scope AND to client-visible records:
// approved milestones, published updates, deliverables that were explicitly shared, and the client's own feedback.
// Internal comments, tasks, staff data, estimates, unshared files and other clients are never selected.

import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppBindings, Env, PortalAuth } from '../env'
import { portalDecisionSchema, portalFeedbackSchema, portalReverifySchema } from '@shared/schemas'
import { activity } from '../lib/audit'
import { newId, randomToken, sha256Hex } from '../lib/crypto'
import { many, nowIso, one, placeholders } from '../lib/db'
import { ApiError, body, clientIp, conflict, notFound } from '../lib/http'
import { rateLimit } from '../lib/ratelimit'
import { assertCsrf, assertSameOrigin, clearCookie, portalCookieName, setSessionCookie } from '../lib/session'
import { notify, projectReviewers } from '../services/notify'
import { publish, rooms } from '../services/realtime'
import { getSetting } from '../services/settings'

const portal = new Hono<AppBindings>()

const IDLE_MS = 60 * 60 * 1000

async function scopeProjects(db: D1Database, clientId: string, projectId: string | null): Promise<string[]> {
  const rows = await many<{ id: string }>(
    db,
    `SELECT id FROM projects WHERE client_id = ? AND archived_at IS NULL ${projectId ? 'AND id = ?' : ''}`,
    clientId,
    ...(projectId ? [projectId] : []),
  )
  return rows.map((r) => r.id)
}

/** Resolve the portal session from its cookie, re-checking the underlying link on every request. */
export async function resolvePortalSession(env: Env, c: Context<AppBindings>): Promise<PortalAuth | null> {
  const token = getCookie(c, portalCookieName(env))
  if (!token || token.length > 128) return null
  const hash = await sha256Hex(token)
  const row = await one<{
    id: string; access_token_id: string; client_id: string; verified_at: string; verified_email: string | null; expires_at: string; last_seen_at: string; revoked_at: string | null
    t_revoked: string | null; t_expires: string; t_project: string | null; c_archived: string | null
  }>(
    env.DB,
    `SELECT ps.id, ps.access_token_id, ps.client_id, ps.verified_at, ps.verified_email, ps.expires_at, ps.last_seen_at, ps.revoked_at,
            t.revoked_at AS t_revoked, t.expires_at AS t_expires, t.project_id AS t_project, cl.archived_at AS c_archived
       FROM portal_sessions ps JOIN client_access_tokens t ON t.id = ps.access_token_id JOIN clients cl ON cl.id = ps.client_id
      WHERE ps.token_hash = ?`,
    hash,
  )
  if (!row) return null
  const now = Date.now()
  if (row.revoked_at || row.t_revoked || row.c_archived || now >= Date.parse(row.expires_at) || now >= Date.parse(row.t_expires) || now - Date.parse(row.last_seen_at) > IDLE_MS) {
    if (!row.revoked_at) await env.DB.prepare('UPDATE portal_sessions SET revoked_at = ? WHERE id = ?').bind(nowIso(), row.id).run()
    return null
  }
  if (now - Date.parse(row.last_seen_at) > 60_000) await env.DB.prepare('UPDATE portal_sessions SET last_seen_at = ? WHERE id = ?').bind(nowIso(), row.id).run()
  return {
    kind: 'portal',
    portalSessionId: row.id,
    sessionHash: hash,
    accessTokenId: row.access_token_id,
    clientId: row.client_id,
    projectIds: await scopeProjects(env.DB, row.client_id, row.t_project),
    verifiedAt: row.verified_at,
    verifiedEmail: row.verified_email,
    expiresAt: new Date(Math.min(Date.parse(row.expires_at), Date.parse(row.t_expires), now + IDLE_MS)).toISOString(),
  }
}

/** Exchange a link secret for a portal session. */
portal.post('/session', async (c) => {
  assertSameOrigin(c)
  const ip = clientIp(c) ?? 'unknown'
  await rateLimit(c.env.DB, `portal:ip:${ip}`, 20, 15 * 60)
  const { token } = await body(c, z.object({ token: z.string().min(20).max(128) }))
  const hash = await sha256Hex(token)
  const t = await one<{ id: string; client_id: string; project_id: string | null; expires_at: string; revoked_at: string | null; contact_email: string | null; label: string }>(
    c.env.DB,
    `SELECT t.id, t.client_id, t.project_id, t.expires_at, t.revoked_at, cc.email AS contact_email, t.label FROM client_access_tokens t LEFT JOIN client_contacts cc ON cc.id = t.contact_id
      JOIN clients cl ON cl.id = t.client_id WHERE t.token_hash = ? AND cl.archived_at IS NULL`,
    hash,
  )
  if (!t || t.revoked_at || Date.parse(t.expires_at) <= Date.now()) {
    await activity(c.env.DB, { category: 'security', actorType: 'client', action: 'portal.access_denied', summary: t ? `Expired or revoked portal link used (${t.label})` : 'Invalid portal link presented', ip }).run()
    throw new ApiError(401, 'PORTAL_LINK_INVALID', 'This access link is invalid, expired or has been revoked. Please ask your Visionary X contact for a new link.')
  }
  const { sessionHours } = await getSetting(c.env.DB, 'portal.defaults')
  const secret = randomToken(32)
  const now = new Date()
  const expires = new Date(Math.min(now.getTime() + sessionHours * 3600_000, Date.parse(t.expires_at))).toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO portal_sessions (id, token_hash, access_token_id, client_id, verified_at, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(newId('pse'), await sha256Hex(secret), t.id, t.client_id, now.toISOString(), now.toISOString(), now.toISOString(), expires, ip, (c.req.header('user-agent') ?? '').slice(0, 300)),
    c.env.DB.prepare('UPDATE client_access_tokens SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?').bind(now.toISOString(), t.id),
    activity(c.env.DB, { category: 'security', actorType: 'client', actorId: t.client_id, action: 'portal.session_started', entityType: 'client', entityId: t.client_id, projectId: t.project_id, summary: `Client opened the portal via “${t.label}”`, ip }),
  ])
  setSessionCookie(c, portalCookieName(c.env), secret, Math.floor((Date.parse(expires) - now.getTime()) / 1000), 'Strict')
  return c.json({ ok: true, expiresAt: expires })
})

portal.use('/*', async (c, next) => {
  if (c.req.path.endsWith('/portal/session') && c.req.method === 'POST') return next()
  const p = await resolvePortalSession(c.env, c)
  if (!p) throw new ApiError(401, 'PORTAL_SESSION_EXPIRED', 'Your portal session has ended. Open your access link again.')
  // Portal mutations require a same-origin request with a CSRF header derived from the session.
  if (!['GET', 'HEAD'].includes(c.req.method)) assertCsrf(c, p.portalSessionId)
  c.set('portal', p)
  await next()
})

function assertProject(p: PortalAuth, projectId: string) {
  if (!p.projectIds.includes(projectId)) throw notFound('Project')
}

portal.get('/me', async (c) => {
  const p = c.get('portal')
  const client = await one<{ name: string; reference: string }>(c.env.DB, 'SELECT name, reference FROM clients WHERE id = ?', p.clientId)
  const company = await getSetting(c.env.DB, 'company.profile')
  const projects = p.projectIds.length
    ? await many<{ id: string; reference: string; name: string; status: string; progress: number; target_date: string | null; client_status_note: string; manager_name: string | null; manager_email: string | null }>(
        c.env.DB,
        `SELECT p.id, p.reference, p.name, p.status, p.progress, p.target_date, p.client_status_note, u.name AS manager_name, u.email AS manager_email
           FROM projects p LEFT JOIN users u ON u.id = p.manager_id WHERE p.id IN (${placeholders(p.projectIds.length)}) ORDER BY p.target_date`,
        ...p.projectIds,
      )
    : []
  const { reverifyMinutes } = await getSetting(c.env.DB, 'portal.defaults')
  return c.json({
    client,
    projects,
    support: { company: company.name, email: company.supportEmail || null, phone: company.supportPhone || null, website: company.website },
    csrfToken: p.portalSessionId,
    expiresAt: p.expiresAt,
    verifiedRecently: Date.now() - Date.parse(p.verifiedAt) < reverifyMinutes * 60_000 && Boolean(p.verifiedEmail),
  })
})

portal.get('/projects/:id', async (c) => {
  const p = c.get('portal')
  const id = c.req.param('id')
  assertProject(p, id)
  const project = await one(
    c.env.DB,
    `SELECT p.id, p.reference, p.name, p.status, p.progress, p.start_date, p.target_date, p.completed_at, p.client_status_note, p.description,
            u.name AS manager_name, u.email AS manager_email, ep.work_phone AS manager_phone
       FROM projects p LEFT JOIN users u ON u.id = p.manager_id LEFT JOIN employee_profiles ep ON ep.user_id = u.id WHERE p.id = ?`,
    id,
  )
  const milestones = await many(c.env.DB, `SELECT id, title, description, due_date, status, achieved_at FROM milestones WHERE project_id = ? AND client_visible = 1 ORDER BY sort_order, due_date`, id)
  const updates = await many(c.env.DB, `SELECT id, title, body, approved_at AS published_at FROM project_updates WHERE project_id = ? AND client_visible = 1 ORDER BY approved_at DESC LIMIT 50`, id)
  const deliverables = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT d.id, d.title, d.description, d.status, d.shared_at, d.client_decision_at FROM deliverables d WHERE d.project_id = ? AND d.status IN ('shared','client_approved','changes_requested') AND d.shared_at IS NOT NULL ORDER BY d.shared_at DESC`,
    id,
  )
  const files = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT a.id, a.deliverable_id, a.version, a.file_name, a.content_type, a.size_bytes, a.created_at FROM attachments a JOIN deliverables d ON d.id = a.deliverable_id
      WHERE d.project_id = ? AND a.client_visible = 1 AND a.deleted_at IS NULL ORDER BY a.version DESC`,
    id,
  )
  const feedback = await many(c.env.DB, `SELECT id, deliverable_id, kind, body, author_name, status, response, responded_at, created_at FROM client_feedback WHERE project_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 100`, id, p.clientId)
  // Client-facing timeline: published updates, achieved milestones, shared deliverables and the client's own messages.
  const timeline = [
    ...(updates as { id: string; title: string; published_at: string }[]).map((u) => ({ type: 'update', at: u.published_at, title: u.title })),
    ...(milestones as { title: string; achieved_at: string | null; status: string }[]).filter((m) => m.achieved_at).map((m) => ({ type: 'milestone', at: m.achieved_at!, title: `Milestone achieved: ${m.title}` })),
    ...deliverables.map((d) => ({ type: 'deliverable', at: d.shared_at as string, title: `Shared for review: ${d.title}` })),
    ...(feedback as { kind: string; created_at: string; author_name: string }[]).map((f) => ({ type: 'feedback', at: f.created_at, title: `${f.author_name} sent ${f.kind.replace('_', ' ')}` })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1))
  return c.json({
    project,
    milestones,
    updates,
    deliverables: deliverables.map((d) => ({ ...d, files: files.filter((f) => f.deliverable_id === d.id) })),
    feedback,
    timeline,
  })
})

portal.get('/files/:id', async (c) => {
  const p = c.get('portal')
  if (!c.env.FILES) throw new ApiError(503, 'STORAGE_DISABLED', 'File storage is not configured.')
  const f = await one<{ storage_key: string; file_name: string; content_type: string; project_id: string }>(
    c.env.DB,
    `SELECT a.storage_key, a.file_name, a.content_type, a.project_id FROM attachments a JOIN deliverables d ON d.id = a.deliverable_id
      WHERE a.id = ? AND a.client_visible = 1 AND a.deleted_at IS NULL AND d.status IN ('shared','client_approved','changes_requested')`,
    c.req.param('id'),
  )
  if (!f || !p.projectIds.includes(f.project_id)) throw notFound('File')
  const obj = await c.env.FILES.get(f.storage_key)
  if (!obj) throw notFound('File')
  await activity(c.env.DB, { category: 'activity', actorType: 'client', actorId: p.clientId, action: 'portal.file_downloaded', entityType: 'attachment', entityId: c.req.param('id'), projectId: f.project_id, summary: `Client downloaded ${f.file_name}`, ip: clientIp(c) }).run()
  return new Response(obj.body, {
    headers: {
      'content-type': f.content_type,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  })
})

portal.post('/feedback', async (c) => {
  const p = c.get('portal')
  await rateLimit(c.env.DB, `portal:feedback:${p.portalSessionId}`, 20, 60 * 60)
  const input = await body(c, portalFeedbackSchema)
  assertProject(p, input.projectId)
  if (input.deliverableId) {
    const d = await one(c.env.DB, `SELECT 1 AS x FROM deliverables WHERE id = ? AND project_id = ? AND shared_at IS NOT NULL`, input.deliverableId, input.projectId)
    if (!d) throw notFound('Deliverable')
  }
  const id = newId('fbk')
  const project = await one<{ reference: string; name: string }>(c.env.DB, 'SELECT reference, name FROM projects WHERE id = ?', input.projectId)
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO client_feedback (id, project_id, client_id, deliverable_id, portal_session_id, author_name, author_email, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.projectId, p.clientId, input.deliverableId ?? null, p.portalSessionId, input.authorName, p.verifiedEmail, input.kind, input.body, nowIso()),
    activity(c.env.DB, { actorType: 'client', actorId: p.clientId, action: 'client.feedback_received', entityType: 'client_feedback', entityId: id, projectId: input.projectId, summary: `Client ${input.kind.replace('_', ' ')} from ${input.authorName}`, ip: clientIp(c) }),
  ])
  const recipients = await projectReviewers(c.env.DB, input.projectId)
  const am = await one<{ account_manager_id: string | null }>(c.env.DB, 'SELECT account_manager_id FROM clients WHERE id = ?', p.clientId)
  await notify(c.env, c.executionCtx, [...new Set([...recipients, ...(am?.account_manager_id ? [am.account_manager_id] : [])])].map((u) => ({
    userId: u, kind: 'client_feedback' as const, title: `Client ${input.kind.replace('_', ' ')}: ${project?.reference}`, body: input.body.slice(0, 160), link: `/projects/${input.projectId}?tab=feedback`, entityType: 'client_feedback', entityId: id,
  })))
  publish(c.env, c.executionCtx, [
    { type: 'client.feedback_received', room: rooms.project(input.projectId), data: { projectId: input.projectId, feedbackId: id } },
    { type: 'portal.project_updated', room: rooms.portalProject(input.projectId), data: { projectId: input.projectId } },
  ])
  return c.json({ id }, 201)
})

/** Step-up verification: confirm the email of a contact on file before sensitive actions (approvals). */
portal.post('/verify', async (c) => {
  const p = c.get('portal')
  await rateLimit(c.env.DB, `portal:verify:${p.portalSessionId}`, 5, 15 * 60)
  const { email } = await body(c, portalReverifySchema)
  const t = await one<{ contact_id: string | null }>(c.env.DB, 'SELECT contact_id FROM client_access_tokens WHERE id = ?', p.accessTokenId)
  const match = await one<{ id: string }>(
    c.env.DB,
    `SELECT id FROM client_contacts WHERE client_id = ? AND email = ? ${t?.contact_id ? 'AND id = ?' : ''}
     UNION SELECT id FROM clients WHERE id = ? AND email = ? ${t?.contact_id ? 'AND 0' : ''}`,
    p.clientId, email, ...(t?.contact_id ? [t.contact_id] : []), p.clientId, email,
  )
  if (!match) {
    await activity(c.env.DB, { category: 'security', actorType: 'client', actorId: p.clientId, action: 'portal.verify_failed', summary: 'Portal step-up verification failed', ip: clientIp(c) }).run()
    throw new ApiError(401, 'VERIFY_FAILED', 'That email does not match the contact on file for this link.')
  }
  await c.env.DB.prepare('UPDATE portal_sessions SET verified_at = ?, verified_email = ? WHERE id = ?').bind(nowIso(), email, p.portalSessionId).run()
  return c.json({ ok: true })
})

portal.post('/deliverables/:id/decision', async (c) => {
  const p = c.get('portal')
  const id = c.req.param('id')
  const d = await one<{ project_id: string; status: string; title: string }>(c.env.DB, 'SELECT project_id, status, title FROM deliverables WHERE id = ?', id)
  if (!d || !p.projectIds.includes(d.project_id)) throw notFound('Deliverable')
  const { reverifyMinutes } = await getSetting(c.env.DB, 'portal.defaults')
  if (!p.verifiedEmail || Date.now() - Date.parse(p.verifiedAt) > reverifyMinutes * 60_000) {
    throw new ApiError(401, 'REVERIFY_REQUIRED', 'Please confirm your email address before approving or requesting changes.')
  }
  if (d.status !== 'shared') throw conflict('This deliverable is not awaiting your decision')
  const input = await body(c, portalDecisionSchema)
  const now = nowIso()
  const fid = newId('fbk')
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE deliverables SET status = ?, client_decision_at = ?, updated_at = ? WHERE id = ?').bind(input.decision, now, now, id),
    c.env.DB.prepare(`INSERT INTO client_feedback (id, project_id, client_id, deliverable_id, portal_session_id, author_name, author_email, kind, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(fid, d.project_id, p.clientId, id, p.portalSessionId, input.authorName, p.verifiedEmail, input.decision === 'client_approved' ? 'approval' : 'revision_request', input.note || 'Approved', input.decision === 'client_approved' ? 'resolved' : 'open', now),
    activity(c.env.DB, { actorType: 'client', actorId: p.clientId, action: input.decision === 'client_approved' ? 'deliverable.client_approved' : 'deliverable.client_changes_requested', entityType: 'deliverable', entityId: id, projectId: d.project_id, summary: `${input.authorName} (${p.verifiedEmail}) ${input.decision === 'client_approved' ? 'approved' : 'requested changes to'} “${d.title}”`, ip: clientIp(c) }),
  ])
  const recipients = await projectReviewers(c.env.DB, d.project_id)
  await notify(c.env, c.executionCtx, recipients.map((u) => ({ userId: u, kind: 'client_feedback' as const, title: `Client ${input.decision === 'client_approved' ? 'approved' : 'requested changes to'} “${d.title}”`, body: input.note, link: `/projects/${d.project_id}?tab=deliverables` })))
  publish(c.env, c.executionCtx, [
    { type: 'client.feedback_received', room: rooms.project(d.project_id), data: { projectId: d.project_id, deliverableId: id } },
    { type: 'portal.project_updated', room: rooms.portalProject(d.project_id), data: { projectId: d.project_id } },
  ])
  return c.json({ ok: true })
})

portal.post('/logout', async (c) => {
  const p = c.get('portal')
  await c.env.DB.prepare('UPDATE portal_sessions SET revoked_at = ? WHERE id = ?').bind(nowIso(), p.portalSessionId).run()
  clearCookie(c, portalCookieName(c.env))
  return c.json({ ok: true })
})

export default portal
