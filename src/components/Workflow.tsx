// Visual workflow guidance: where a task/project is in its life, and what the viewer should do next.
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowRight, Check, Sparkles } from 'lucide-react'
import { cx } from './ui'

export interface Step {
  key: string
  label: string
  hint: string
}

export const TASK_STEPS: Step[] = [
  { key: 'todo', label: 'To do', hint: 'Planned and assigned' },
  { key: 'in_progress', label: 'In progress', hint: 'Being worked on' },
  { key: 'in_review', label: 'In review', hint: 'Waiting for approval' },
  { key: 'completed', label: 'Done', hint: 'Approved · counts in progress' },
]

export const PROJECT_STEPS: Step[] = [
  { key: 'planning', label: 'Plan', hint: 'Team, milestones, tasks' },
  { key: 'in_progress', label: 'Deliver', hint: 'Tasks move across the board' },
  { key: 'in_review', label: 'Review', hint: 'Approve deliverables' },
  { key: 'completed', label: 'Closed', hint: 'Signed off' },
]

const taskStepIndex = (status: string) => (status === 'backlog' ? 0 : status === 'blocked' ? 1 : status === 'cancelled' ? -1 : TASK_STEPS.findIndex((s) => s.key === status))
const projectStepIndex = (status: string) =>
  ({ planning: 0, not_started: 0, in_progress: 1, at_risk: 1, delayed: 1, on_hold: 1, in_review: 2, completed: 3, archived: 3 })[status] ?? 0

/** Horizontal step tracker. */
export function Stepper({ steps, current, warning }: { steps: Step[]; current: number; warning?: string | null }) {
  return (
    <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-line bg-line sm:grid-cols-4" aria-label="Workflow progress">
      {steps.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={s.key} aria-current={active ? 'step' : undefined} className={cx('flex items-start gap-3 bg-surface px-4 py-3', active && 'bg-subtle')}>
            <span
              className={cx(
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold',
                done ? 'border-ink bg-ink text-canvas' : active ? (warning ? 'border-warn text-warn' : 'border-ink text-ink') : 'border-line-strong text-faint',
              )}
            >
              {done ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className={cx('block text-[11px] font-semibold uppercase tracking-[0.14em]', done || active ? 'text-ink' : 'text-faint')}>{s.label}</span>
              <span className={cx('block text-[12px]', active && warning ? 'text-warn' : 'text-muted')}>{active && warning ? warning : s.hint}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** "What happens next" call-out with an optional action. */
export function NextStep({ title, body, action, auto }: { title: string; body: ReactNode; action?: ReactNode; auto?: ReactNode }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[14px] border border-line bg-surface px-4 py-3">
      <ArrowRight className="size-4 shrink-0 text-ink" />
      <div className="min-w-[220px] flex-1">
        <p className="text-[13.5px] font-semibold text-ink">{title}</p>
        <p className="text-[12.5px] text-ink-2">{body}</p>
        {auto && (
          <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted">
            <Sparkles className="size-3" /> {auto}
          </p>
        )}
      </div>
      {action}
    </div>
  )
}

export interface TaskWorkflowInput {
  status: string
  requiresApproval: boolean
  isAssignee: boolean
  canReview: boolean
  canEdit: boolean
  openDependencies: number
  blockedReason: string | null
  hasPendingSubmission: boolean
}

/** Plain-language guidance for a task, tailored to the viewer's role. */
export function taskGuidance(t: TaskWorkflowInput): { current: number; warning: string | null; title: string; body: string; auto?: string } {
  const current = taskStepIndex(t.status)
  if (t.status === 'cancelled') return { current: -1, warning: null, title: 'This task was cancelled', body: 'It no longer counts towards project progress. A project manager can reopen it.' }
  if (t.status === 'completed') return { current: 3, warning: null, title: 'Done', body: t.requiresApproval ? 'The work was approved and now counts in project progress.' : 'Marked complete; it counts in project progress.', auto: 'When every task in a milestone is done, the milestone is marked achieved automatically.' }
  if (t.openDependencies > 0) {
    return { current, warning: 'Waiting on other tasks', title: `Waiting on ${t.openDependencies} other task${t.openDependencies === 1 ? '' : 's'}`, body: 'You can start once the tasks it depends on are completed.', auto: 'When they finish, this task moves to To do and its owner is notified.' }
  }
  if (t.status === 'blocked') return { current, warning: 'Blocked', title: 'Blocked', body: `${t.blockedReason ?? 'Something is in the way.'} Unblock it once the issue is resolved.` }
  if (t.status === 'in_review') {
    if (t.canReview && t.hasPendingSubmission) return { current, warning: null, title: 'Your review is needed', body: 'Check the submission, then Approve it or Request revisions with a note explaining what to change.' }
    return { current, warning: null, title: 'Waiting for a reviewer', body: 'The project manager or a reviewer will approve it or send it back with notes. You will be notified either way.' }
  }
  if (t.status === 'in_progress') {
    if (t.isAssignee) return t.requiresApproval
      ? { current, warning: null, title: 'When you finish, submit it for review', body: 'Add a short note about what you did. Your project manager approves it, and then it counts as done.' }
      : { current, warning: null, title: 'When you finish, mark it complete', body: 'This task does not need a review.' }
    return { current, warning: null, title: 'In progress', body: 'The assignee is working on it.' }
  }
  // backlog / todo
  if (t.status === 'backlog') return { current: 0, warning: 'Parked in backlog', title: 'Not scheduled yet', body: t.canEdit ? 'Give it an owner and a due date to move it into To do.' : 'A project manager will schedule it.', auto: 'Assigning an owner moves it to To do automatically.' }
  if (t.isAssignee) return { current, warning: null, title: 'Ready for you to start', body: 'Click Start work when you begin, and log your time as you go.', auto: 'Starting the first task of a project or milestone moves it to In progress automatically.' }
  return { current, warning: null, title: 'Waiting to be started', body: 'The assignee will start it.' }
}

/** Plain-language guidance for a project. */
export function projectGuidance(p: { status: string; totalTasks: number; openTasks: number; pendingDeliverables: number; members: number; milestones: number; canManage: boolean }) {
  const current = projectStepIndex(p.status)
  const warning = p.status === 'at_risk' ? 'At risk' : p.status === 'delayed' ? 'Delayed — past target date' : p.status === 'on_hold' ? 'On hold' : null
  if (p.status === 'completed' || p.status === 'archived') return { current: 3, warning: null, title: 'Project closed', body: 'All work and deliverables were approved and the project was signed off.' }
  if (current === 0) {
    const missing = [p.members <= 1 && 'add the team', p.milestones === 0 && 'add milestones', p.totalTasks === 0 && 'create tasks'].filter(Boolean)
    return {
      current, warning, title: missing.length ? `Plan the work: ${missing.join(', ')}` : 'Ready to start',
      body: p.canManage ? 'Use the Team, Milestones and Board tabs. Assign each task an owner and a due date.' : 'The project manager is planning the work.',
      auto: 'The project moves to Deliver automatically when the first task starts.',
    }
  }
  if (current === 2) return { current, warning, title: p.pendingDeliverables ? `Approve ${p.pendingDeliverables} deliverable(s), then close` : 'All work is done — close the project', body: p.canManage ? 'Open Settings and set the status to Completed. Closing requires every task done and every deliverable approved.' : 'The project manager will close the project.' }
  return {
    current, warning,
    title: p.openTasks ? `${p.openTasks} task${p.openTasks === 1 ? '' : 's'} still open` : 'No open tasks',
    body: 'Owners move their tasks across the board; reviewers approve submissions. Progress updates itself as work is approved.',
    auto: 'When every task is done the project moves to Review automatically and you are notified.',
  }
}

export function GuideLink() {
  return (
    <Link to="/guide" className="text-[12px] text-muted underline-offset-4 hover:text-ink hover:underline">
      How the workflow works
    </Link>
  )
}
