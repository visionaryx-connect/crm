/**
 * Project progress is derived from task records — never typed in by a user.
 *
 * Rules (also documented in docs/BUSINESS_RULES.md):
 *  1. Cancelled tasks are excluded from both numerator and denominator.
 *  2. A task counts as done only when its status is `completed`. Tasks that require approval can only
 *     reach `completed` through a reviewer's approval, so unapproved submissions never move progress.
 *  3. Modes:
 *     - equal:     every applicable task has weight 1.  progress = completed / applicable × 100
 *     - effort:    each task is weighted by its approved estimate (estimate_hours > 0), falling back to its
 *                  explicit `weight` (default 1) when no estimate is recorded.
 *     - milestone: each milestone contributes its `weight`. Inside a milestone, tasks are equally weighted.
 *                  A milestone with no applicable tasks counts as 100% only when it is marked achieved.
 *                  Tasks with no milestone form an implicit bucket of weight 1.
 *  4. When nothing is applicable, progress is 0 and `hasData` is false so the UI can say "no tasks yet"
 *     instead of implying 0% delivery.
 */

export type ProgressMode = 'equal' | 'effort' | 'milestone'

export interface ProgressTask {
  status: string
  estimate_hours: number | null
  weight: number
  milestone_id: string | null
}

export interface ProgressMilestone {
  id: string
  weight: number
  status: string
}

export interface ProgressResult {
  progress: number
  completedUnits: number
  totalUnits: number
  hasData: boolean
}

const round1 = (n: number) => Math.round(n * 10) / 10

function taskUnit(task: ProgressTask, mode: ProgressMode): number {
  if (mode === 'effort') {
    if (task.estimate_hours != null && task.estimate_hours > 0) return task.estimate_hours
    return task.weight > 0 ? task.weight : 1
  }
  return 1
}

export function calculateProgress(
  mode: ProgressMode,
  tasks: ProgressTask[],
  milestones: ProgressMilestone[] = [],
): ProgressResult {
  const applicable = tasks.filter((t) => t.status !== 'cancelled')

  if (mode !== 'milestone') {
    let total = 0
    let done = 0
    for (const t of applicable) {
      const u = taskUnit(t, mode)
      total += u
      if (t.status === 'completed') done += u
    }
    if (total === 0) return { progress: 0, completedUnits: 0, totalUnits: 0, hasData: false }
    return { progress: round1((done / total) * 100), completedUnits: round1(done), totalUnits: round1(total), hasData: true }
  }

  // milestone mode
  const byMilestone = new Map<string | null, ProgressTask[]>()
  for (const t of applicable) {
    const key = t.milestone_id && milestones.some((m) => m.id === t.milestone_id) ? t.milestone_id : null
    const list = byMilestone.get(key) ?? []
    list.push(t)
    byMilestone.set(key, list)
  }
  let totalWeight = 0
  let doneWeight = 0
  for (const m of milestones) {
    const w = m.weight > 0 ? m.weight : 1
    const list = byMilestone.get(m.id) ?? []
    let fraction: number
    if (list.length === 0) fraction = m.status === 'achieved' ? 1 : 0
    else fraction = list.filter((t) => t.status === 'completed').length / list.length
    totalWeight += w
    doneWeight += w * fraction
  }
  const loose = byMilestone.get(null) ?? []
  if (loose.length > 0) {
    totalWeight += 1
    doneWeight += loose.filter((t) => t.status === 'completed').length / loose.length
  }
  if (totalWeight === 0) return { progress: 0, completedUnits: 0, totalUnits: 0, hasData: false }
  return {
    progress: round1((doneWeight / totalWeight) * 100),
    completedUnits: round1(doneWeight),
    totalUnits: round1(totalWeight),
    hasData: true,
  }
}

/**
 * Delivery health is separate from progress. It compares elapsed schedule against progress and looks at
 * overdue/blocked work. Returns a coarse signal plus the reasons, so the UI can explain itself.
 */
export type Health = 'on_track' | 'watch' | 'at_risk' | 'off_track' | 'not_applicable'

export interface HealthInput {
  status: string
  progress: number
  hasData: boolean
  startDate: string | null
  targetDate: string | null
  today: string
  overdueTasks: number
  blockedTasks: number
}

export function assessHealth(i: HealthInput): { health: Health; reasons: string[] } {
  if (['completed', 'archived', 'on_hold', 'planning'].includes(i.status)) return { health: 'not_applicable', reasons: [] }
  const reasons: string[] = []
  let score = 0
  if (i.targetDate && i.today > i.targetDate) {
    reasons.push('Target date has passed')
    score += 3
  } else if (i.startDate && i.targetDate && i.targetDate > i.startDate && i.hasData) {
    const total = daysBetween(i.startDate, i.targetDate)
    const elapsed = Math.max(0, Math.min(total, daysBetween(i.startDate, i.today)))
    const expected = (elapsed / total) * 100
    const gap = expected - i.progress
    if (gap > 30) {
      reasons.push(`Progress is ${Math.round(gap)} points behind schedule`)
      score += 2
    } else if (gap > 15) {
      reasons.push(`Progress is ${Math.round(gap)} points behind schedule`)
      score += 1
    }
  }
  if (i.overdueTasks > 0) {
    reasons.push(`${i.overdueTasks} overdue task${i.overdueTasks === 1 ? '' : 's'}`)
    score += i.overdueTasks >= 3 ? 2 : 1
  }
  if (i.blockedTasks > 0) {
    reasons.push(`${i.blockedTasks} blocked task${i.blockedTasks === 1 ? '' : 's'}`)
    score += 1
  }
  const health: Health = score >= 4 ? 'off_track' : score >= 2 ? 'at_risk' : score === 1 ? 'watch' : 'on_track'
  return { health, reasons }
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000)
}
