import { newId } from './crypto'
import { nowIso } from './db'

export interface ActivityInput {
  category?: 'activity' | 'security' | 'admin'
  actorType?: 'user' | 'client' | 'system'
  actorId?: string | null
  action: string
  entityType?: string | null
  entityId?: string | null
  projectId?: string | null
  summary: string
  changes?: unknown
  ip?: string | null
}

/** Returns a prepared statement so callers can include the log row in the same atomic batch as the change. */
export function activity(db: D1Database, a: ActivityInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO activity_logs (id, category, actor_type, actor_id, action, entity_type, entity_id, project_id, summary, changes, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('act'),
      a.category ?? 'activity',
      a.actorType ?? 'user',
      a.actorId ?? null,
      a.action,
      a.entityType ?? null,
      a.entityId ?? null,
      a.projectId ?? null,
      a.summary.slice(0, 500),
      a.changes === undefined ? null : JSON.stringify(a.changes).slice(0, 8000),
      a.ip ?? null,
      nowIso(),
    )
}

export async function logActivity(db: D1Database, a: ActivityInput): Promise<void> {
  await activity(db, a).run()
}
