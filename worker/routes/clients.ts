import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { clientContactSchema, clientInteractionSchema, clientSchema, portalLinkSchema } from '@shared/schemas'
import { activity } from '../lib/audit'
import { newId, randomToken, sha256Hex } from '../lib/crypto'
import { diff, many, nowIso, one } from '../lib/db'
import { ApiError, body, clientIp, conflict, notFound, query } from '../lib/http'
import { requirePermission, requireStaff } from '../lib/session'
import { readableProjectsFilter } from '../lib/authz'
import { disconnect } from '../services/realtime'

const clients = new Hono<AppBindings>()
clients.use('*', requireStaff())

/** Account managers may read their own clients even without clients.read. */
async function assertClientRead(db: D1Database, auth: AppBindings['Variables']['auth'], clientId: string) {
  const row = await one<{ id: string; name: string; account_manager_id: string | null; archived_at: string | null }>(db, 'SELECT id, name, account_manager_id, archived_at FROM clients WHERE id = ?', clientId)
  if (!row) throw notFound('Client')
  if (auth.permissions.has('clients.read') || row.account_manager_id === auth.userId) return row
  throw notFound('Client')
}

async function nextClientReference(db: D1Database) {
  const r = await one<{ n: number }>(db, `SELECT COALESCE(MAX(CAST(SUBSTR(reference, 4) AS INTEGER)), 0) AS n FROM clients WHERE reference LIKE 'CL-%'`)
  return `CL-${String((r?.n ?? 0) + 1).padStart(4, '0')}`
}

clients.get('/', async (c) => {
  const a = c.get('auth')
  const where: string[] = []
  const params: unknown[] = []
  if (!a.permissions.has('clients.read')) {
    where.push('c.account_manager_id = ?')
    params.push(a.userId)
  }
  const status = query(c, 'status')
  if (status === 'archived') where.push('c.archived_at IS NOT NULL')
  else {
    where.push('c.archived_at IS NULL')
    if (status) {
      where.push('c.status = ?')
      params.push(status)
    }
  }
  const q = query(c, 'q')
  if (q) {
    where.push('(c.name LIKE ? OR c.organization LIKE ? OR c.email LIKE ? OR c.reference LIKE ?)')
    params.push(...Array(4).fill(`%${q}%`))
  }
  const manager = query(c, 'managerId')
  if (manager) {
    where.push('c.account_manager_id = ?')
    params.push(manager)
  }
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT c.id, c.reference, c.name, c.organization, c.industry, c.email, c.phone, c.status, c.is_seed, c.created_at, c.updated_at,
            c.account_manager_id, u.name AS account_manager_name,
            (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id AND p.archived_at IS NULL AND p.status NOT IN ('completed','archived')) AS active_projects,
            (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id) AS total_projects,
            (SELECT COUNT(*) FROM client_feedback f WHERE f.client_id = c.id AND f.status = 'open') AS open_feedback,
            (SELECT MIN(p.target_date) FROM projects p WHERE p.client_id = c.id AND p.status NOT IN ('completed','archived') AND p.target_date >= date('now')) AS next_deadline
       FROM clients c LEFT JOIN users u ON u.id = c.account_manager_id
      WHERE ${where.join(' AND ')} ORDER BY c.name LIMIT 500`,
    ...params,
  )
  return c.json({ clients: rows.map((r) => ({ ...r, is_seed: Boolean(r.is_seed) })) })
})

clients.get('/:id', async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  await assertClientRead(c.env.DB, a, id)
  const client = await one<Record<string, unknown>>(c.env.DB, 'SELECT c.*, u.name AS account_manager_name FROM clients c LEFT JOIN users u ON u.id = c.account_manager_id WHERE c.id = ?', id)
  const f = readableProjectsFilter(a)
  const [contacts, services, projects, interactions, feedback, tokens] = await Promise.all([
    many(c.env.DB, 'SELECT * FROM client_contacts WHERE client_id = ? ORDER BY is_primary DESC, name', id),
    many(c.env.DB, 'SELECT s.id, s.name FROM client_service_categories cs JOIN service_categories s ON s.id = cs.service_category_id WHERE cs.client_id = ?', id),
    many(
      c.env.DB,
      `SELECT p.id, p.reference, p.name, p.status, p.progress, p.start_date, p.target_date, p.completed_at, p.priority, u.name AS manager_name
         FROM projects p LEFT JOIN users u ON u.id = p.manager_id WHERE p.client_id = ? AND ${f.sql} ORDER BY p.archived_at IS NOT NULL, p.target_date`,
      id,
      ...f.params,
    ),
    many(c.env.DB, 'SELECT i.*, u.name AS created_by_name FROM client_interactions i LEFT JOIN users u ON u.id = i.created_by WHERE i.client_id = ? ORDER BY i.occurred_at DESC LIMIT 100', id),
    many(
      c.env.DB,
      `SELECT f.id, f.project_id, p.name AS project_name, f.kind, f.body, f.status, f.author_name, f.created_at, f.deliverable_id
         FROM client_feedback f JOIN projects p ON p.id = f.project_id WHERE f.client_id = ? AND f.status <> 'resolved' AND ${f.sql} ORDER BY f.created_at DESC`,
      id,
      ...f.params,
    ),
    a.permissions.has('clients.portal')
      ? many(
          c.env.DB,
          `SELECT t.id, t.label, t.project_id, p.name AS project_name, t.token_hint, t.expires_at, t.revoked_at, t.last_used_at, t.use_count, t.created_at, u.name AS created_by_name,
                  cc.name AS contact_name
             FROM client_access_tokens t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.created_by LEFT JOIN client_contacts cc ON cc.id = t.contact_id
            WHERE t.client_id = ? ORDER BY t.created_at DESC`,
          id,
        )
      : Promise.resolve(null),
  ])
  const pendingApprovals = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE p.client_id = ? AND d.status = 'shared'`,
    id,
  )
  return c.json({
    client: { ...client, is_seed: Boolean(client?.is_seed) },
    contacts,
    services,
    projects,
    interactions,
    openFeedback: feedback,
    pendingClientApprovals: pendingApprovals?.n ?? 0,
    portalLinks: tokens,
    can: { manage: a.permissions.has('clients.manage'), portal: a.permissions.has('clients.portal') },
  })
})

/** Possible duplicates by email/phone/name before creating. */
clients.post('/check-duplicates', requirePermission('clients.manage'), async (c) => {
  const input = await body(c, clientSchema.partial())
  const rows = await many(
    c.env.DB,
    `SELECT id, reference, name, organization, email, phone FROM clients
      WHERE archived_at IS NULL AND ((? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND phone = ?) OR (? IS NOT NULL AND lower(name) = lower(?))) LIMIT 5`,
    input.email ?? null, input.email ?? null, input.phone ?? null, input.phone ?? null, input.name ?? null, input.name ?? null,
  )
  return c.json({ duplicates: rows })
})

clients.post('/', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const input = await body(c, clientSchema)
  const dup = await one<{ reference: string; name: string }>(
    c.env.DB,
    `SELECT reference, name FROM clients WHERE archived_at IS NULL AND ((? IS NOT NULL AND email = ?) OR lower(name) = lower(?))`,
    input.email, input.email, input.name,
  )
  if (dup && c.req.query('force') !== '1') {
    throw new ApiError(409, 'DUPLICATE_CLIENT', `This looks like an existing client: ${dup.name} (${dup.reference}).`, { reference: dup.reference })
  }
  const id = newId('cli')
  const now = nowIso()
  const reference = await nextClientReference(c.env.DB)
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO clients (id, reference, name, organization, industry, email, phone, website, address, status, account_manager_id, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, reference, input.name, input.organization ?? null, input.industry ?? null, input.email, input.phone ?? null, input.website || null, input.address ?? null, input.status, input.accountManagerId ?? null, input.notes, a.userId, now, now),
    ...input.serviceCategoryIds.map((s) => c.env.DB.prepare('INSERT INTO client_service_categories (client_id, service_category_id) VALUES (?, ?)').bind(id, s)),
    activity(c.env.DB, { actorId: a.userId, action: 'client.created', entityType: 'client', entityId: id, summary: `Created client ${input.name} (${reference})`, ip: clientIp(c) }),
  ])
  return c.json({ id, reference }, 201)
})

clients.put('/:id', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const input = await body(c, clientSchema)
  const before = await one<Record<string, unknown>>(c.env.DB, 'SELECT * FROM clients WHERE id = ?', id)
  if (!before) throw notFound('Client')
  if (input.email) {
    const dup = await one(c.env.DB, 'SELECT 1 AS x FROM clients WHERE email = ? AND id <> ? AND archived_at IS NULL', input.email, id)
    if (dup) throw new ApiError(409, 'CONFLICT', 'Another client uses that email', { fields: { email: 'Already used by another client' } })
  }
  const after = {
    name: input.name, organization: input.organization ?? null, industry: input.industry ?? null, email: input.email, phone: input.phone ?? null,
    website: input.website || null, address: input.address ?? null, status: input.status, account_manager_id: input.accountManagerId ?? null, notes: input.notes,
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE clients SET name = ?, organization = ?, industry = ?, email = ?, phone = ?, website = ?, address = ?, status = ?, account_manager_id = ?, notes = ?, updated_at = ? WHERE id = ?`,
    ).bind(...Object.values(after), nowIso(), id),
    c.env.DB.prepare('DELETE FROM client_service_categories WHERE client_id = ?').bind(id),
    ...input.serviceCategoryIds.map((s) => c.env.DB.prepare('INSERT INTO client_service_categories (client_id, service_category_id) VALUES (?, ?)').bind(id, s)),
    activity(c.env.DB, { actorId: a.userId, action: 'client.updated', entityType: 'client', entityId: id, summary: `Updated client ${input.name}`, changes: diff(before, after), ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

clients.post('/:id/archive', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const id = c.req.param('id')
  const cl = await one<{ name: string; archived_at: string | null }>(c.env.DB, 'SELECT name, archived_at FROM clients WHERE id = ?', id)
  if (!cl) throw notFound('Client')
  const restore = c.req.query('restore') === '1'
  if (!restore) {
    const active = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM projects WHERE client_id = ? AND status NOT IN ('completed','archived')`, id)
    if ((active?.n ?? 0) > 0) throw conflict('Complete or archive this client’s active projects first')
  }
  const now = nowIso()
  const stmts = [
    c.env.DB.prepare(`UPDATE clients SET archived_at = ?, status = ?, updated_at = ? WHERE id = ?`).bind(restore ? null : now, restore ? 'inactive' : 'archived', now, id),
    activity(c.env.DB, { actorId: a.userId, action: restore ? 'client.restored' : 'client.archived', entityType: 'client', entityId: id, summary: `${restore ? 'Restored' : 'Archived'} client ${cl.name}`, ip: clientIp(c) }),
  ]
  if (!restore) stmts.push(c.env.DB.prepare('UPDATE client_access_tokens SET revoked_at = ?, revoked_by = ? WHERE client_id = ? AND revoked_at IS NULL').bind(now, a.userId, id))
  await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

// ───────── Contacts ─────────

clients.post('/:id/contacts', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const clientId = c.req.param('id')
  await assertClientRead(c.env.DB, a, clientId)
  const input = await body(c, clientContactSchema)
  const id = newId('con')
  const now = nowIso()
  const stmts = []
  if (input.isPrimary) stmts.push(c.env.DB.prepare('UPDATE client_contacts SET is_primary = 0 WHERE client_id = ?').bind(clientId))
  stmts.push(
    c.env.DB.prepare('INSERT INTO client_contacts (id, client_id, name, title, email, phone, is_primary, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, clientId, input.name, input.title ?? null, input.email, input.phone ?? null, input.isPrimary ? 1 : 0, input.notes, now, now),
    activity(c.env.DB, { actorId: a.userId, action: 'client.contact_added', entityType: 'client', entityId: clientId, summary: `Added contact ${input.name}`, ip: clientIp(c) }),
  )
  await c.env.DB.batch(stmts)
  return c.json({ id }, 201)
})

clients.put('/:id/contacts/:contactId', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const { id: clientId, contactId } = c.req.param()
  const input = await body(c, clientContactSchema)
  const existing = await one(c.env.DB, 'SELECT id FROM client_contacts WHERE id = ? AND client_id = ?', contactId, clientId)
  if (!existing) throw notFound('Contact')
  const stmts = []
  if (input.isPrimary) stmts.push(c.env.DB.prepare('UPDATE client_contacts SET is_primary = 0 WHERE client_id = ?').bind(clientId))
  stmts.push(
    c.env.DB.prepare('UPDATE client_contacts SET name = ?, title = ?, email = ?, phone = ?, is_primary = ?, notes = ?, updated_at = ? WHERE id = ?')
      .bind(input.name, input.title ?? null, input.email, input.phone ?? null, input.isPrimary ? 1 : 0, input.notes, nowIso(), contactId),
    activity(c.env.DB, { actorId: a.userId, action: 'client.contact_updated', entityType: 'client', entityId: clientId, summary: `Updated contact ${input.name}`, ip: clientIp(c) }),
  )
  await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

clients.delete('/:id/contacts/:contactId', requirePermission('clients.manage'), async (c) => {
  const a = c.get('auth')
  const { id: clientId, contactId } = c.req.param()
  const existing = await one<{ name: string }>(c.env.DB, 'SELECT name FROM client_contacts WHERE id = ? AND client_id = ?', contactId, clientId)
  if (!existing) throw notFound('Contact')
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM client_contacts WHERE id = ?').bind(contactId),
    activity(c.env.DB, { actorId: a.userId, action: 'client.contact_removed', entityType: 'client', entityId: clientId, summary: `Removed contact ${existing.name}`, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

// ───────── Interactions (meetings, calls, requirements, notes) ─────────

clients.post('/:id/interactions', async (c) => {
  const a = c.get('auth')
  const clientId = c.req.param('id')
  const cl = await assertClientRead(c.env.DB, a, clientId)
  if (!a.permissions.has('clients.manage') && cl.account_manager_id !== a.userId) throw new ApiError(403, 'FORBIDDEN', 'Only account managers can record interactions')
  const input = await body(c, clientInteractionSchema)
  if (input.projectId && !(await one(c.env.DB, 'SELECT 1 AS x FROM projects WHERE id = ? AND client_id = ?', input.projectId, clientId))) throw notFound('Project')
  const id = newId('int')
  await c.env.DB.prepare('INSERT INTO client_interactions (id, client_id, project_id, kind, subject, body, occurred_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, clientId, input.projectId ?? null, input.kind, input.subject, input.body, new Date(input.occurredAt).toISOString(), a.userId, nowIso())
    .run()
  return c.json({ id }, 201)
})

// ───────── Portal access links ─────────

clients.post('/:id/portal-links', requirePermission('clients.portal'), async (c) => {
  const a = c.get('auth')
  const clientId = c.req.param('id')
  const cl = await one<{ name: string; archived_at: string | null }>(c.env.DB, 'SELECT name, archived_at FROM clients WHERE id = ?', clientId)
  if (!cl) throw notFound('Client')
  if (cl.archived_at) throw conflict('Archived clients cannot receive portal access')
  const input = await body(c, portalLinkSchema)
  if (input.projectId) {
    const p = await one<{ manager_id: string | null }>(c.env.DB, 'SELECT manager_id FROM projects WHERE id = ? AND client_id = ?', input.projectId, clientId)
    if (!p) throw notFound('Project')
  }
  if (input.contactId && !(await one(c.env.DB, 'SELECT 1 AS x FROM client_contacts WHERE id = ? AND client_id = ?', input.contactId, clientId))) throw notFound('Contact')
  const secret = randomToken(32)
  const id = newId('cat')
  const now = new Date()
  const expires = new Date(now.getTime() + input.validDays * 86400_000).toISOString()
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO client_access_tokens (id, client_id, project_id, contact_id, label, token_hash, token_hint, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, clientId, input.projectId ?? null, input.contactId ?? null, input.label, await sha256Hex(secret), secret.slice(-4), expires, a.userId, now.toISOString()),
    activity(c.env.DB, { category: 'security', actorId: a.userId, action: 'portal.link_created', entityType: 'client', entityId: clientId, projectId: input.projectId ?? null, summary: `Issued portal link "${input.label}" for ${cl.name} (valid ${input.validDays} days)`, ip: clientIp(c) }),
  ])
  // The secret travels in the URL fragment, which browsers never send to servers or in Referer headers.
  return c.json({ id, link: `${new URL(c.req.url).origin}/portal/access#t=${secret}`, expiresAt: expires }, 201)
})

clients.post('/:id/portal-links/:linkId/revoke', requirePermission('clients.portal'), async (c) => {
  const a = c.get('auth')
  const { id: clientId, linkId } = c.req.param()
  const t = await one<{ label: string; revoked_at: string | null }>(c.env.DB, 'SELECT label, revoked_at FROM client_access_tokens WHERE id = ? AND client_id = ?', linkId, clientId)
  if (!t) throw notFound('Portal link')
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE client_access_tokens SET revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?) WHERE id = ?').bind(now, a.userId, linkId),
    c.env.DB.prepare('UPDATE portal_sessions SET revoked_at = ? WHERE access_token_id = ? AND revoked_at IS NULL').bind(now, linkId),
    activity(c.env.DB, { category: 'security', actorId: a.userId, action: 'portal.link_revoked', entityType: 'client', entityId: clientId, summary: `Revoked portal link "${t.label}"`, ip: clientIp(c) }),
  ])
  disconnect(c.env, c.executionCtx, { accessTokenId: linkId })
  return c.json({ ok: true })
})

export default clients
