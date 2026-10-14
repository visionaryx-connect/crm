// Resource-level authorisation. Role permissions say *what kind* of action is allowed; these helpers decide
// whether it is allowed on *this* record. Unreadable records are reported as 404 so their existence is not leaked.

import type { StaffAuth } from '../env'
import { many, one } from './db'
import { forbidden, notFound } from './http'

export interface ProjectRow {
  id: string
  reference: string
  name: string
  client_id: string
  manager_id: string | null
  status: string
  progress_mode: 'equal' | 'effort' | 'milestone'
  archived_at: string | null
}

export interface ProjectAccess {
  project: ProjectRow
  memberRole: 'manager' | 'lead' | 'member' | 'viewer' | null
  canRead: boolean
  /** Edit project settings, members, milestones, client-visible content. */
  canManage: boolean
  /** Create, assign, reschedule tasks. */
  canManageTasks: boolean
  /** Approve submitted work / request revisions. */
  canReview: boolean
  /** Contribute: comment, log time, upload, update own tasks. */
  canContribute: boolean
}

/** Minimal identity needed for authorisation (shared with the realtime hub, which has no HTTP context). */
export interface Principal {
  userId: string
  permissions: Set<string> | string[]
}

const has = (p: Principal, perm: string) => (p.permissions instanceof Set ? p.permissions.has(perm) : p.permissions.includes(perm))

export async function projectAccess(db: D1Database, principal: Principal, projectId: string): Promise<ProjectAccess | null> {
  const project = await one<ProjectRow & { member_role: ProjectAccess['memberRole']; can_review: number | null }>(
    db,
    `SELECT p.id, p.reference, p.name, p.client_id, p.manager_id, p.status, p.progress_mode, p.archived_at,
            pm.role AS member_role, pm.can_review
       FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
      WHERE p.id = ?`,
    principal.userId,
    projectId,
  )
  if (!project) return null
  const isPm = project.manager_id === principal.userId || project.member_role === 'manager'
  const memberRole = project.member_role ?? (project.manager_id === principal.userId ? 'manager' : null)
  const canRead = has(principal, 'projects.read_all') || memberRole !== null
  const canManage = has(principal, 'projects.manage_all') || (has(principal, 'projects.manage_own') && isPm)
  const canManageTasks = canManage || has(principal, 'tasks.manage_all') || memberRole === 'lead'
  const canReview = canManage || has(principal, 'tasks.review_all') || Boolean(project.can_review)
  const canContribute = canManage || canManageTasks || (memberRole !== null && memberRole !== 'viewer')
  return {
    project,
    memberRole,
    canRead,
    canManage,
    canManageTasks,
    canReview,
    canContribute,
  }
}

type Need = 'read' | 'manage' | 'manageTasks' | 'review' | 'contribute'

export async function requireProject(db: D1Database, auth: StaffAuth, projectId: string, need: Need = 'read'): Promise<ProjectAccess> {
  const access = await projectAccess(db, auth, projectId)
  if (!access || !access.canRead) throw notFound('Project')
  const ok =
    need === 'read' ||
    (need === 'manage' && access.canManage) ||
    (need === 'manageTasks' && access.canManageTasks) ||
    (need === 'review' && access.canReview) ||
    (need === 'contribute' && access.canContribute)
  if (!ok) throw forbidden()
  return access
}

/** SQL fragment + params restricting a `projects p` query to projects the user can read. */
export function readableProjectsFilter(auth: Principal, alias = 'p'): { sql: string; params: unknown[] } {
  if (has(auth, 'projects.read_all')) return { sql: '1 = 1', params: [] }
  return {
    sql: `(${alias}.manager_id = ? OR EXISTS (SELECT 1 FROM project_members pmx WHERE pmx.project_id = ${alias}.id AND pmx.user_id = ?))`,
    params: [auth.userId, auth.userId],
  }
}

export async function readableProjectIds(db: D1Database, auth: Principal): Promise<string[] | 'all'> {
  if (has(auth, 'projects.read_all')) return 'all'
  const rows = await many<{ id: string }>(
    db,
    `SELECT id FROM projects WHERE manager_id = ? UNION SELECT project_id FROM project_members WHERE user_id = ?`,
    auth.userId,
    auth.userId,
  )
  return rows.map((r) => r.id)
}

/** Task-level: assignees may update/submit their own tasks even without task-management rights. */
export async function taskAccess(db: D1Database, auth: StaffAuth, taskId: string) {
  const task = await one<{ id: string; project_id: string; status: string; responsible_id: string | null; requires_approval: number; title: string; number: number }>(
    db,
    'SELECT id, project_id, status, responsible_id, requires_approval, title, number FROM tasks WHERE id = ?',
    taskId,
  )
  if (!task) throw notFound('Task')
  const access = await projectAccess(db, auth, task.project_id)
  if (!access || !access.canRead) throw notFound('Task')
  const isAssignee =
    task.responsible_id === auth.userId ||
    Boolean(await one(db, 'SELECT 1 AS x FROM task_assignees WHERE task_id = ? AND user_id = ?', taskId, auth.userId))
  return { task, access, isAssignee }
}

/**
 * May `actor` see reports / workload / sensitive operational details for `targetUserId`?
 * Self, company reporters, HR, the person's reporting manager, or the head of their department.
 */
export async function canViewMember(db: D1Database, auth: StaffAuth, targetUserId: string): Promise<boolean> {
  if (auth.userId === targetUserId) return true
  if (auth.permissions.has('reports.company') || auth.permissions.has('employees.manage')) return true
  // Otherwise only reporting managers and department heads — including team leads without reports.team.
  const row = await one<{ x: number }>(
    db,
    `SELECT 1 AS x FROM employee_profiles ep LEFT JOIN departments d ON d.id = ep.department_id
      WHERE ep.user_id = ? AND (ep.manager_user_id = ? OR d.head_user_id = ?)`,
    targetUserId,
    auth.userId,
    auth.userId,
  )
  return Boolean(row)
}
