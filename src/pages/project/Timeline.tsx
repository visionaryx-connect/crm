import { useMemo } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { fmtDateShort, todayIST } from '@/lib/format'
import { EmptyState, ErrorState, SkeletonRows, cx } from '@/components/ui'

interface TimelineData {
  milestones: { id: string; title: string; due_date: string | null; status: string }[]
  tasks: { id: string; number: number; title: string; status: string; start_date: string | null; due_date: string | null; milestone_id: string | null; responsible_name: string | null }[]
  dependencies: { task_id: string; depends_on_task_id: string }[]
}

const DAY = 86400000
const toMs = (d: string) => Date.parse(d + 'T00:00:00Z')
const barColor: Record<string, string> = { completed: 'bg-ok/70', in_progress: 'bg-forest', in_review: 'bg-info', blocked: 'bg-danger', todo: 'bg-ink-2/35', backlog: 'bg-line-strong' }

/** Schedule view: each task is a bar from start to due date, grouped by milestone; diamonds mark milestone dates. */
export function Timeline({ projectId, start, target }: { projectId: string; start: string | null; target: string | null }) {
  const q = useQuery({ queryKey: ['project', projectId, 'timeline'], queryFn: () => api.get<TimelineData>(`/api/projects/${projectId}/timeline`) })
  const model = useMemo(() => {
    const d = q.data
    if (!d) return null
    const dates = [start, target, todayIST(), ...d.tasks.flatMap((t) => [t.start_date, t.due_date]), ...d.milestones.map((m) => m.due_date)].filter(Boolean) as string[]
    if (dates.length === 0) return null
    const min = Math.min(...dates.map(toMs)) - 3 * DAY
    const max = Math.max(...dates.map(toMs)) + 5 * DAY
    const span = max - min
    const pct = (d: string) => ((toMs(d) - min) / span) * 100
    const weeks: { left: number; label: string }[] = []
    for (let t = min; t <= max; t += DAY) {
      const d = new Date(t)
      if (d.getUTCDay() === 1) weeks.push({ left: ((t - min) / span) * 100, label: fmtDateShort(d.toISOString().slice(0, 10)) })
    }
    const groups = [...d.milestones.map((m) => ({ key: m.id, title: m.title, due: m.due_date, status: m.status })), { key: 'none', title: 'No milestone', due: null, status: '' }]
      .map((g) => ({ ...g, tasks: d.tasks.filter((t) => (t.milestone_id ?? 'none') === g.key) }))
      .filter((g) => g.tasks.length || g.key !== 'none')
    return { pct, weeks, groups, today: pct(todayIST()), dayPct: (DAY / span) * 100 }
  }, [q.data, start, target])

  if (q.isLoading) return <SkeletonRows rows={8} />
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  if (!model || q.data!.tasks.length === 0) return <EmptyState title="Nothing to schedule yet" body="Add tasks with start and due dates to see the timeline." />
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-paper">
      <div className="min-w-[900px]">
        <div className="relative ml-[260px] h-8 border-b border-line">
          {model.weeks.map((w, i) => <span key={i} className="absolute top-2 -translate-x-1/2 whitespace-nowrap font-mono text-[10.5px] text-muted" style={{ left: `${w.left}%` }}>{w.label}</span>)}
        </div>
        {model.groups.map((g) => (
          <div key={g.key} className="border-b border-line/70 last:border-b-0">
            <div className="relative flex h-8 items-center bg-ivory/60">
              <div className="w-[260px] shrink-0 truncate px-3 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-2">{g.title}</div>
              <div className="relative h-full flex-1">
                {g.due && <span title={`Milestone due ${g.due}`} className={cx('absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45', g.status === 'achieved' ? 'bg-ok' : 'bg-gold')} style={{ left: `${model.pct(g.due)}%` }} />}
              </div>
            </div>
            {g.tasks.map((t) => {
              const s = t.start_date ?? t.due_date
              const e = t.due_date ?? t.start_date
              return (
                <div key={t.id} className="relative flex h-9 items-center hover:bg-ivory/50">
                  <Link to={`/tasks/${t.id}`} className="w-[260px] shrink-0 truncate px-3 text-[12.5px] text-ink hover:underline"><span className="font-mono text-[11px] text-muted">#{t.number}</span> {t.title}</Link>
                  <div className="relative h-full flex-1">
                    {model.weeks.map((w, i) => <span key={i} className="absolute inset-y-0 w-px bg-line/60" style={{ left: `${w.left}%` }} aria-hidden />)}
                    <span className="absolute inset-y-0 w-px bg-gold" style={{ left: `${model.today}%` }} aria-hidden />
                    {s && e ? (
                      <span className={cx('absolute top-1/2 h-3.5 -translate-y-1/2 rounded-sm', barColor[t.status] ?? 'bg-line-strong')} style={{ left: `${model.pct(s)}%`, width: `max(6px, ${model.pct(e) - model.pct(s) + model.dayPct}%)` }} title={`${t.title}: ${s} → ${e}${t.responsible_name ? ` · ${t.responsible_name}` : ''}`} />
                    ) : (
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-faint">No dates</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
        <div className="flex gap-4 border-t border-line px-3 py-2 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-forest" />In progress</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-info" />In review</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-danger" />Blocked</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-ok/70" />Completed</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rotate-45 bg-gold" />Milestone</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-px bg-gold" />Today</span>
        </div>
      </div>
    </div>
  )
}
