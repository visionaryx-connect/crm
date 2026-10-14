import { calculateProgress, type ProgressMilestone, type ProgressTask } from '@shared/progress'
import type { Env } from '../env'
import { newId } from '../lib/crypto'
import { many, nowIso, one } from '../lib/db'
import { publish, rooms, type Waiter } from './realtime'

/**
 * Recalculate a project's derived progress from its tasks. Writes a snapshot only when the value changes,
 * which gives reports an exact "progress at date X" history. Publishes project.progress_updated after the write.
 */
export async function recalcProgress(env: Env, waiter: Waiter, projectId: string): Promise<number | null> {
  const project = await one<{ progress_mode: 'equal' | 'effort' | 'milestone'; progress: number }>(env.DB, 'SELECT progress_mode, progress FROM projects WHERE id = ?', projectId)
  if (!project) return null
  const tasks = await many<ProgressTask>(env.DB, 'SELECT status, estimate_hours, weight, milestone_id FROM tasks WHERE project_id = ?', projectId)
  const milestones = await many<ProgressMilestone>(env.DB, 'SELECT id, weight, status FROM milestones WHERE project_id = ?', projectId)
  const r = calculateProgress(project.progress_mode, tasks, milestones)
  const last = await one<{ progress: number; total_units: number }>(env.DB, 'SELECT progress, total_units FROM project_progress_snapshots WHERE project_id = ? ORDER BY recorded_at DESC LIMIT 1', projectId)
  const changed = !last || last.progress !== r.progress || last.total_units !== r.totalUnits
  const now = nowIso()
  const stmts = [env.DB.prepare('UPDATE projects SET progress = ? WHERE id = ?').bind(r.progress, projectId)]
  if (changed) {
    stmts.push(
      env.DB.prepare('INSERT INTO project_progress_snapshots (id, project_id, progress, completed_units, total_units, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(newId('pps'), projectId, r.progress, r.completedUnits, r.totalUnits, now),
    )
  }
  await env.DB.batch(stmts)
  if (project.progress !== r.progress) {
    publish(env, waiter, [
      { type: 'project.progress_updated', room: rooms.project(projectId), data: { projectId, progress: r.progress } },
      { type: 'portal.project_updated', room: rooms.portalProject(projectId), data: { projectId } },
    ])
  }
  return r.progress
}
