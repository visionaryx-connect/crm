import { ArrowDown, ArrowUp, ChevronsUp, Minus } from 'lucide-react'
import { DELIVERABLE_STATUS_LABEL, PROJECT_STATUS_LABEL, TASK_STATUS_LABEL, type DeliverableStatus, type ProjectStatus, type TaskStatus } from '@shared/constants'
import { Badge, cx, type Tone } from './ui'

const projectTone: Record<ProjectStatus, Tone> = {
  planning: 'neutral', not_started: 'neutral', in_progress: 'accent', on_hold: 'highlight', at_risk: 'warn', delayed: 'danger', in_review: 'info', completed: 'ok', archived: 'outline',
}
export const ProjectStatusBadge = ({ status }: { status: string }) => <Badge tone={projectTone[status as ProjectStatus] ?? 'neutral'}>{PROJECT_STATUS_LABEL[status as ProjectStatus] ?? status}</Badge>

const taskTone: Record<TaskStatus, Tone> = { backlog: 'outline', todo: 'neutral', in_progress: 'accent', in_review: 'info', blocked: 'danger', completed: 'ok', cancelled: 'outline' }
export const TaskStatusBadge = ({ status }: { status: string }) => (
  <Badge tone={taskTone[status as TaskStatus] ?? 'neutral'} dot>
    {TASK_STATUS_LABEL[status as TaskStatus] ?? status}
  </Badge>
)

const delivTone: Record<DeliverableStatus, Tone> = { draft: 'neutral', in_review: 'info', approved: 'accent', shared: 'highlight', client_approved: 'ok', changes_requested: 'warn' }
export const DeliverableBadge = ({ status }: { status: string }) => <Badge tone={delivTone[status as DeliverableStatus] ?? 'neutral'}>{DELIVERABLE_STATUS_LABEL[status as DeliverableStatus] ?? status}</Badge>

export function PriorityMark({ priority, withLabel }: { priority: string; withLabel?: boolean }) {
  const map = {
    urgent: { icon: ChevronsUp, cls: 'text-danger', label: 'Urgent' },
    high: { icon: ArrowUp, cls: 'text-warn', label: 'High' },
    medium: { icon: Minus, cls: 'text-muted', label: 'Medium' },
    low: { icon: ArrowDown, cls: 'text-faint', label: 'Low' },
  } as const
  const m = map[priority as keyof typeof map] ?? map.medium
  const Icon = m.icon
  return (
    <span className={cx('inline-flex items-center gap-1 text-[12px]', m.cls)} title={`${m.label} priority`}>
      <Icon className="size-3.5" strokeWidth={2.2} aria-hidden />
      {withLabel ? m.label : <span className="sr-only">{m.label} priority</span>}
    </span>
  )
}

const healthMap = {
  on_track: { label: 'On track', cls: 'bg-ok', text: 'text-ok' },
  watch: { label: 'Watch', cls: 'bg-highlight', text: 'text-highlight-ink' },
  at_risk: { label: 'At risk', cls: 'bg-warn', text: 'text-warn' },
  off_track: { label: 'Off track', cls: 'bg-danger', text: 'text-danger' },
  not_applicable: { label: '—', cls: 'bg-line-strong', text: 'text-muted' },
} as const

export function HealthDot({ health, reasons, showLabel = true }: { health: string; reasons?: string[]; showLabel?: boolean }) {
  const h = healthMap[health as keyof typeof healthMap] ?? healthMap.not_applicable
  const title = reasons?.length ? `${h.label}: ${reasons.join('; ')}` : h.label
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-[12.5px] font-medium', h.text)} title={title}>
      <span className={cx('size-2 rounded-full', h.cls)} aria-hidden />
      {showLabel ? h.label : <span className="sr-only">{title}</span>}
    </span>
  )
}

export function DueText({ date, open = true }: { date?: string | null; open?: boolean }) {
  if (!date) return <span className="text-faint">—</span>
  const days = Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()) + 'T00:00:00Z')) / 86400000)
  const label = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(new Date(date + 'T12:00:00+05:30'))
  const tone = !open ? 'text-muted' : days < 0 ? 'text-danger font-medium' : days <= 1 ? 'text-warn font-medium' : 'text-ink-2'
  return (
    <span className={cx('tabular whitespace-nowrap', tone)} title={open && days < 0 ? `${-days} day(s) overdue` : undefined}>
      {label}
      {open && days < 0 && <span className="ml-1 text-[11px]">· {-days}d late</span>}
    </span>
  )
}

/** Progress shown as a precise number with a thin rule. "No tasks yet" when there is no data. */
export function ProgressFigure({ value, hasData = true, compact }: { value: number; hasData?: boolean; compact?: boolean }) {
  if (!hasData) return <span className="text-[12px] text-faint">No tasks yet</span>
  return (
    <div className={cx('flex items-center gap-2.5', compact ? 'w-28' : 'w-40')}>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-track" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="w-10 text-right font-mono text-[12px] tabular text-ink-2">{Math.round(value)}%</span>
    </div>
  )
}
