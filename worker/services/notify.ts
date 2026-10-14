import type { Env } from '../env'
import { newId } from '../lib/crypto'
import { many, nowIso, placeholders } from '../lib/db'
import { publish, rooms, type Waiter } from './realtime'

export const NOTIFICATION_KINDS = {
  task_assigned: 'New task assignments',
  task_due_soon: 'Task deadlines approaching',
  task_overdue: 'Overdue tasks',
  review_requested: 'Work awaiting review',
  revision_requested: 'Revision requests',
  task_approved: 'Approved work',
  milestone_updated: 'Project milestone updates',
  client_feedback: 'Client feedback',
  leave_decision: 'Leave approvals and rejections',
  leave_requested: 'Leave requests to approve',
  calendar_changed: 'Calendar changes',
  security: 'Important security events',
  mention: 'Comments on your work',
} as const
export type NotificationKind = keyof typeof NOTIFICATION_KINDS

export interface NotificationInput {
  userId: string
  kind: NotificationKind
  title: string
  body?: string
  link?: string
  entityType?: string
  entityId?: string
  dedupeKey?: string
}

/**
 * Persist in-app notifications (respecting preferences; security notices are always delivered), then push a
 * lightweight `notification.created` event to each recipient's personal room.
 */
export async function notify(env: Env, waiter: Waiter, items: NotificationInput[], actorId?: string) {
  const list = items.filter((n) => n.userId !== actorId)
  if (list.length === 0) return
  const userIds = [...new Set(list.map((n) => n.userId))].slice(0, 200)
  const muted = await many<{ user_id: string; kind: string }>(
    env.DB,
    `SELECT user_id, kind FROM notification_preferences WHERE in_app = 0 AND user_id IN (${placeholders(userIds.length)})`,
    ...userIds,
  )
  const mutedSet = new Set(muted.map((m) => `${m.user_id}|${m.kind}`))
  const deliver = list.filter((n) => n.kind === 'security' || !mutedSet.has(`${n.userId}|${n.kind}`))
  if (deliver.length === 0) return
  const now = nowIso()
  const rows = deliver.map((n) => ({ id: newId('ntf'), ...n }))
  await env.DB.batch(
    rows.map((n) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO notifications (id, user_id, kind, title, body, link, entity_type, entity_id, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(n.id, n.userId, n.kind, n.title.slice(0, 200), (n.body ?? '').slice(0, 1000), n.link ?? null, n.entityType ?? null, n.entityId ?? null, n.dedupeKey ?? null, now),
    ),
  )
  publish(
    env,
    waiter,
    rows.map((n) => ({ type: 'notification.created' as const, room: rooms.user(n.userId), data: { id: n.id, kind: n.kind, title: n.title, link: n.link ?? null } })),
  )
}

/** Users who can review work in a project: PM, project members with review rights, project managers of record. */
export async function projectReviewers(db: D1Database, projectId: string): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    db,
    `SELECT manager_id AS user_id FROM projects WHERE id = ? AND manager_id IS NOT NULL
     UNION SELECT user_id FROM project_members WHERE project_id = ? AND (can_review = 1 OR role = 'manager')`,
    projectId,
    projectId,
  )
  return rows.map((r) => r.user_id)
}

/** Active users holding a permission (for approval routing). */
export async function usersWithPermission(db: D1Database, perm: string): Promise<string[]> {
  const rows = await many<{ id: string }>(
    db,
    `SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE rp.permission_key = ? AND u.status = 'active'`,
    perm,
  )
  return rows.map((r) => r.id)
}
