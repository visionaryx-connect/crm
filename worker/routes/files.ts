import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { deliverableSchema, deliverableStatusSchema } from '@shared/schemas'
import { activity } from '../lib/audit'
import { requireProject, readableProjectsFilter } from '../lib/authz'
import { newId, randomToken, sha256Bytes } from '../lib/crypto'
import { many, nowIso, one } from '../lib/db'
import { ApiError, body, clientIp, conflict, forbidden, notFound, query } from '../lib/http'
import { requireStaff } from '../lib/session'
import { notify } from '../services/notify'
import { publish, rooms } from '../services/realtime'

const files = new Hono<AppBindings>()
files.use('*', requireStaff())

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Allow-list of file types. Each entry lists accepted extensions and an optional magic-byte check. */
const TYPES: { mime: string; ext: string[]; magic?: (b: Uint8Array) => boolean }[] = [
  { mime: 'application/pdf', ext: ['pdf'], magic: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { mime: 'image/png', ext: ['png'], magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: ['jpg', 'jpeg'], magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: ['webp'], magic: (b) => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 },
  { mime: 'image/gif', ext: ['gif'], magic: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { mime: 'application/zip', ext: ['zip'], magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: ['docx'], magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: ['xlsx'], magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: ['pptx'], magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { mime: 'text/plain', ext: ['txt', 'md'], magic: (b) => !b.slice(0, 512).includes(0) },
  { mime: 'text/csv', ext: ['csv'], magic: (b) => !b.slice(0, 512).includes(0) },
  { mime: 'video/mp4', ext: ['mp4'], magic: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
]

export function detectType(fileName: string, head: Uint8Array): string | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  const t = TYPES.find((x) => x.ext.includes(ext))
  if (!t) return null
  if (t.magic && !t.magic(head)) return null
  return t.mime
}

function safeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').slice(0, 180) || 'file'
}

function requireStorage(env: AppBindings['Bindings']): R2Bucket {
  if (!env.FILES) throw new ApiError(503, 'STORAGE_DISABLED', 'File storage (R2) is not configured for this deployment.')
  return env.FILES
}

files.post('/upload', async (c) => {
  const a = c.get('auth')
  const bucket = requireStorage(c.env)
  const projectId = query(c, 'projectId')
  if (!projectId) throw new ApiError(422, 'VALIDATION_FAILED', 'projectId is required')
  const access = await requireProject(c.env.DB, a, projectId, 'read')
  const taskId = query(c, 'taskId') ?? null
  const deliverableId = query(c, 'deliverableId') ?? null
  let isAssignee = false
  if (taskId) {
    const t = await one<{ responsible_id: string | null }>(c.env.DB, 'SELECT responsible_id FROM tasks WHERE id = ? AND project_id = ?', taskId, projectId)
    if (!t) throw notFound('Task')
    isAssignee = t.responsible_id === a.userId || Boolean(await one(c.env.DB, 'SELECT 1 AS x FROM task_assignees WHERE task_id = ? AND user_id = ?', taskId, a.userId))
  }
  if (!access.canContribute && !isAssignee) throw forbidden('Only project contributors can upload files')
  let deliverable: { id: string; status: string; current_version: number; title: string } | null = null
  if (deliverableId) {
    deliverable = await one(c.env.DB, 'SELECT id, status, current_version, title FROM deliverables WHERE id = ? AND project_id = ?', deliverableId, projectId)
    if (!deliverable) throw notFound('Deliverable')
    if (['approved', 'shared', 'client_approved'].includes(deliverable.status) && !access.canManage) throw conflict('This deliverable is approved. Ask the project manager to reopen it before uploading a new version.')
  }
  const len = Number(c.req.header('content-length') ?? '0')
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Files must be 25 MB or smaller')
  const form = await c.req.parseBody()
  const file = form.file
  if (!(file instanceof File)) throw new ApiError(422, 'VALIDATION_FAILED', 'Attach a file in the "file" field')
  if (file.size === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'The file is empty')
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Files must be 25 MB or smaller')
  const buf = new Uint8Array(await file.arrayBuffer())
  const name = safeFileName(file.name)
  const mime = detectType(name, buf.slice(0, 16))
  if (!mime) throw new ApiError(415, 'UNSUPPORTED_FILE', 'This file type is not allowed, or its contents do not match its extension.')
  const sha = await sha256Bytes(buf)
  const key = `projects/${projectId}/${randomToken(18)}`
  await bucket.put(key, buf, { httpMetadata: { contentType: mime }, customMetadata: { sha256: sha, uploadedBy: a.userId } })
  const id = newId('att')
  const now = nowIso()
  const version = deliverable ? deliverable.current_version + 1 : 1
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO attachments (id, project_id, task_id, deliverable_id, version, file_name, content_type, size_bytes, storage_key, sha256, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, projectId, taskId, deliverableId, version, name, mime, file.size, key, sha, a.userId, now),
    activity(c.env.DB, { actorId: a.userId, action: 'file.uploaded', entityType: deliverable ? 'deliverable' : taskId ? 'task' : 'project', entityId: deliverableId ?? taskId ?? projectId, projectId, summary: deliverable ? `Uploaded v${version} of “${deliverable.title}”` : `Uploaded ${name}`, ip: clientIp(c) }),
  ]
  if (deliverable) {
    stmts.push(
      c.env.DB.prepare(`UPDATE deliverables SET current_version = ?, status = CASE WHEN status IN ('changes_requested','approved','shared','client_approved') THEN 'draft' ELSE status END, updated_at = ? WHERE id = ?`).bind(version, now, deliverable.id),
    )
  }
  try {
    await c.env.DB.batch(stmts)
  } catch (err) {
    await bucket.delete(key)
    throw err
  }
  publish(c.env, c.executionCtx, [{ type: 'project.updated', room: rooms.project(projectId), data: { projectId, fields: ['files'] } }])
  return c.json({ id, version, contentType: mime, size: file.size }, 201)
})

files.get('/', async (c) => {
  const a = c.get('auth')
  const projectId = query(c, 'projectId')
  const f = readableProjectsFilter(a)
  const where = [f.sql, 'a.deleted_at IS NULL']
  const params: unknown[] = [...f.params]
  if (projectId) {
    where.push('a.project_id = ?')
    params.push(projectId)
  }
  const q = query(c, 'q')
  if (q) {
    where.push('a.file_name LIKE ?')
    params.push(`%${q}%`)
  }
  const rows = await many(
    c.env.DB,
    `SELECT a.id, a.project_id, p.reference AS project_reference, p.name AS project_name, a.task_id, t.number AS task_number, t.title AS task_title,
            a.deliverable_id, d.title AS deliverable_title, a.version, a.file_name, a.content_type, a.size_bytes, a.client_visible, a.created_at, u.name AS uploaded_by_name
       FROM attachments a JOIN projects p ON p.id = a.project_id LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN deliverables d ON d.id = a.deliverable_id LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT 500`,
    ...params,
  )
  return c.json({ files: rows, storageEnabled: Boolean(c.env.FILES) })
})

files.get('/:id/download', async (c) => {
  const a = c.get('auth')
  const bucket = requireStorage(c.env)
  const att = await one<{ id: string; project_id: string; storage_key: string; file_name: string; content_type: string; deleted_at: string | null }>(
    c.env.DB,
    'SELECT id, project_id, storage_key, file_name, content_type, deleted_at FROM attachments WHERE id = ?',
    c.req.param('id'),
  )
  if (!att || att.deleted_at) throw notFound('File')
  await requireProject(c.env.DB, a, att.project_id, 'read')
  const obj = await bucket.get(att.storage_key)
  if (!obj) throw notFound('File')
  const inline = c.req.query('inline') === '1' && (att.content_type.startsWith('image/') || att.content_type === 'application/pdf')
  return new Response(obj.body, {
    headers: {
      'content-type': att.content_type,
      'content-length': String(obj.size),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.file_name)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  })
})

/** Soft delete. Objects are purged from R2 by the daily job after the retention window. */
files.delete('/:id', async (c) => {
  const a = c.get('auth')
  const att = await one<{ id: string; project_id: string; uploaded_by: string; file_name: string; client_visible: number; deliverable_id: string | null }>(
    c.env.DB,
    'SELECT id, project_id, uploaded_by, file_name, client_visible, deliverable_id FROM attachments WHERE id = ? AND deleted_at IS NULL',
    c.req.param('id'),
  )
  if (!att) throw notFound('File')
  const access = await requireProject(c.env.DB, a, att.project_id, 'read')
  if (att.uploaded_by !== a.userId && !access.canManage && !a.permissions.has('files.manage_all')) throw forbidden()
  if (att.client_visible) throw conflict('Files already shared with the client are retained for the record and cannot be deleted')
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE attachments SET deleted_at = ?, deleted_by = ? WHERE id = ?').bind(nowIso(), a.userId, att.id),
    activity(c.env.DB, { actorId: a.userId, action: 'file.deleted', entityType: 'attachment', entityId: att.id, projectId: att.project_id, summary: `Deleted ${att.file_name}`, ip: clientIp(c) }),
  ])
  return c.json({ ok: true })
})

// ───────── Deliverables ─────────

files.get('/deliverables', async (c) => {
  const a = c.get('auth')
  const projectId = query(c, 'projectId')
  if (!projectId) throw new ApiError(422, 'VALIDATION_FAILED', 'projectId is required')
  await requireProject(c.env.DB, a, projectId)
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT d.*, t.number AS task_number, t.title AS task_title, m.title AS milestone_title, ab.name AS approved_by_name, sb.name AS shared_by_name, cb.name AS created_by_name
       FROM deliverables d LEFT JOIN tasks t ON t.id = d.task_id LEFT JOIN milestones m ON m.id = d.milestone_id LEFT JOIN users ab ON ab.id = d.approved_by
       LEFT JOIN users sb ON sb.id = d.shared_by LEFT JOIN users cb ON cb.id = d.created_by
      WHERE d.project_id = ? ORDER BY d.updated_at DESC`,
    projectId,
  )
  const versions = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT a.id, a.deliverable_id, a.version, a.file_name, a.content_type, a.size_bytes, a.client_visible, a.created_at, u.name AS uploaded_by_name
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.project_id = ? AND a.deliverable_id IS NOT NULL AND a.deleted_at IS NULL ORDER BY a.version DESC`,
    projectId,
  )
  const feedback = await many<Record<string, unknown>>(c.env.DB, 'SELECT id, deliverable_id, kind, body, author_name, created_at, status FROM client_feedback WHERE project_id = ? AND deliverable_id IS NOT NULL ORDER BY created_at DESC', projectId)
  return c.json({
    deliverables: rows.map((d) => ({ ...d, versions: versions.filter((v) => v.deliverable_id === d.id), clientFeedback: feedback.filter((f) => f.deliverable_id === d.id) })),
  })
})

files.post('/deliverables', async (c) => {
  const a = c.get('auth')
  const projectId = query(c, 'projectId')
  if (!projectId) throw new ApiError(422, 'VALIDATION_FAILED', 'projectId is required')
  await requireProject(c.env.DB, a, projectId, 'contribute')
  const input = await body(c, deliverableSchema)
  if (input.taskId && !(await one(c.env.DB, 'SELECT 1 AS x FROM tasks WHERE id = ? AND project_id = ?', input.taskId, projectId))) throw notFound('Task')
  if (input.milestoneId && !(await one(c.env.DB, 'SELECT 1 AS x FROM milestones WHERE id = ? AND project_id = ?', input.milestoneId, projectId))) throw notFound('Milestone')
  const id = newId('dlv')
  const now = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO deliverables (id, project_id, task_id, milestone_id, title, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, projectId, input.taskId ?? null, input.milestoneId ?? null, input.title, input.description, a.userId, now, now),
    activity(c.env.DB, { actorId: a.userId, action: 'deliverable.created', entityType: 'deliverable', entityId: id, projectId, summary: `Created deliverable “${input.title}”`, ip: clientIp(c) }),
  ])
  publish(c.env, c.executionCtx, [{ type: 'project.updated', room: rooms.project(projectId), data: { projectId, fields: ['deliverables'] } }])
  return c.json({ id }, 201)
})

/**
 * Deliverable approval is separate from task completion:
 *   draft → in_review (contributor) → approved (reviewer) → shared (manager; latest version becomes client-visible)
 *   → client_approved | changes_requested (client, via portal).  return_draft lets a reviewer send it back.
 */
files.post('/deliverables/:id/status', async (c) => {
  const a = c.get('auth')
  const d = await one<{ id: string; project_id: string; status: string; title: string; current_version: number; created_by: string }>(c.env.DB, 'SELECT id, project_id, status, title, current_version, created_by FROM deliverables WHERE id = ?', c.req.param('id'))
  if (!d) throw notFound('Deliverable')
  const access = await requireProject(c.env.DB, a, d.project_id, 'read')
  const { action, note } = await body(c, deliverableStatusSchema)
  const now = nowIso()
  let to: string
  const stmts: D1PreparedStatement[] = []
  if (action === 'submit_review') {
    if (!access.canContribute) throw forbidden()
    if (!['draft', 'changes_requested'].includes(d.status)) throw conflict('Only drafts can be submitted for review')
    if (d.current_version < 1) throw conflict('Upload a file before submitting')
    to = 'in_review'
  } else if (action === 'approve') {
    if (!access.canReview) throw forbidden('You do not have review authority on this project')
    if (d.status !== 'in_review') throw conflict('Only deliverables in review can be approved')
    to = 'approved'
    stmts.push(c.env.DB.prepare('UPDATE deliverables SET approved_by = ?, approved_at = ? WHERE id = ?').bind(a.userId, now, d.id))
  } else if (action === 'return_draft') {
    if (!access.canReview) throw forbidden()
    if (!['in_review', 'approved', 'shared', 'changes_requested'].includes(d.status)) throw conflict('Nothing to send back')
    to = 'draft'
  } else {
    if (!access.canManage) throw forbidden('Only the project manager can share deliverables with the client')
    if (d.status !== 'approved') throw conflict('Approve the deliverable internally before sharing it')
    to = 'shared'
    stmts.push(
      c.env.DB.prepare('UPDATE deliverables SET shared_by = ?, shared_at = ? WHERE id = ?').bind(a.userId, now, d.id),
      c.env.DB.prepare('UPDATE attachments SET client_visible = 1 WHERE deliverable_id = ? AND version = ? AND deleted_at IS NULL').bind(d.id, d.current_version),
    )
  }
  stmts.unshift(c.env.DB.prepare('UPDATE deliverables SET status = ?, updated_at = ? WHERE id = ?').bind(to, now, d.id))
  stmts.push(activity(c.env.DB, { actorId: a.userId, action: `deliverable.${action}`, entityType: 'deliverable', entityId: d.id, projectId: d.project_id, summary: `Deliverable “${d.title}” → ${to.replace('_', ' ')}${note ? `: ${note}` : ''}`, ip: clientIp(c) }))
  await c.env.DB.batch(stmts)
  if (action === 'submit_review') {
    const reviewers = await many<{ user_id: string }>(c.env.DB, `SELECT user_id FROM project_members WHERE project_id = ? AND (can_review = 1 OR role = 'manager')`, d.project_id)
    await notify(c.env, c.executionCtx, reviewers.map((r) => ({ userId: r.user_id, kind: 'review_requested' as const, title: `Deliverable ready for review: ${d.title}`, body: access.project.reference, link: `/projects/${d.project_id}?tab=deliverables` })), a.userId)
  } else if (action === 'approve' || action === 'return_draft') {
    await notify(c.env, c.executionCtx, [{ userId: d.created_by, kind: action === 'approve' ? 'task_approved' : 'revision_requested', title: `${action === 'approve' ? 'Approved' : 'Returned to draft'}: ${d.title}`, body: note, link: `/projects/${d.project_id}?tab=deliverables` }], a.userId)
  }
  publish(c.env, c.executionCtx, [
    { type: 'project.updated', room: rooms.project(d.project_id), data: { projectId: d.project_id, fields: ['deliverables'] } },
    ...(to === 'shared' ? [{ type: 'portal.deliverable_shared' as const, room: rooms.portalProject(d.project_id), data: { projectId: d.project_id, deliverableId: d.id } }] : []),
  ])
  return c.json({ ok: true, status: to })
})

export default files
