import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { ArrowUpRight, CalendarDays, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { fmtDateShort, fmtWeekday, relative, todayIST } from '@/lib/format'
import { Avatar, EmptyState, ErrorState, Panel, Section, Skeleton, SkeletonRows, StatStrip, cx } from '@/components/ui'
import { DueText, HealthDot, PriorityMark, ProgressFigure, TaskStatusBadge } from '@/components/status'

interface DashboardData {
  today: string
  mine: Record<string, number | null>
  myTasks: { id: string; number: number; title: string; status: string; priority: string; due_date: string | null; project_id: string; project_reference: string; project_name: string }[]
  reviewQueue: { id: string; number: number; title: string; submitted_at: string; project_reference: string; responsible_name: string | null }[]
  projects: { id: string; reference: string; name: string; status: string; progress: number; target_date: string | null; client_name: string; manager_name: string | null; health: string; health_reasons: string[]; total_tasks: number }[]
  milestones: { id: string; title: string; due_date: string; status: string; project_id: string; reference: string }[]
  onLeaveToday: { id: string; name: string; half_day: string; end_date: string }[]
  nextHoliday: { holiday_date: string; name: string } | null
  unverifiedHolidays: number | null
  company: null | {
    totals: Record<string, number>
    throughput: { day: string; n: number }[]
  }
}

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date()))
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

function fillDays(rows: { day: string; n: number }[], days = 30) {
  const map = new Map(rows.map((r) => [r.day, r.n]))
  const out = []
  const end = new Date(todayIST() + 'T00:00:00Z')
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10)
    out.push({ day: d, completed: map.get(d) ?? 0 })
  }
  return out
}

export default function Dashboard() {
  const { me } = useAuth()
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/api/dashboard') })
  const d = q.data

  return (
    <div>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="eyebrow mb-1.5">{fmtWeekday(todayIST())}</div>
          <h1 className="display text-[34px] text-ink">
            {greeting()}, {me.user.name.split(' ')[0]}
          </h1>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted">
            {d ? (
              <>
                <span>
                  <span className="font-medium text-ink">{d.mine.open ?? 0}</span> open tasks · <span className={cx('font-medium', (d.mine.overdue ?? 0) > 0 ? 'text-danger' : 'text-ink')}>{d.mine.overdue ?? 0}</span> overdue ·{' '}
                  <span className="font-medium text-ink">{d.mine.due_week ?? 0}</span> due this week
                </span>
                {d.nextHoliday && (
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays className="size-3.5" /> Next holiday: {d.nextHoliday.name}, {fmtDateShort(d.nextHoliday.holiday_date)}
                  </span>
                )}
              </>
            ) : (
              <Skeleton className="w-72" />
            )}
          </div>
        </div>
      </header>

      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}

      {d?.unverifiedHolidays ? (
        <Link to="/settings?tab=holidays" className="mb-6 flex items-center gap-3 rounded-lg border border-highlight/40 bg-highlight-soft/60 px-4 py-2.5 text-[13px] text-highlight-ink hover:bg-highlight-soft">
          <ShieldAlert className="size-4" />
          <span>
            <span className="font-medium">{d.unverifiedHolidays} holiday record(s)</span> await verification against the official government notification. Unverified holidays are not applied to attendance or leave.
          </span>
          <ArrowUpRight className="ml-auto size-4" />
        </Link>
      ) : null}

      {d?.company && (
        <div className="mb-8">
          <StatStrip
            stats={[
              { label: 'Active clients', value: d.company.totals.active_clients, to: '/clients' },
              { label: 'Active projects', value: d.company.totals.active_projects, to: '/projects' },
              { label: 'Open tasks', value: d.company.totals.open_tasks },
              { label: 'Overdue', value: d.company.totals.overdue_tasks, tone: d.company.totals.overdue_tasks ? 'danger' : undefined, to: '/tasks?view=overdue' },
              { label: 'Done this month', value: d.company.totals.completed_this_month },
              { label: 'Awaiting client', value: d.company.totals.awaiting_client, hint: `${d.company.totals.open_feedback} open feedback` },
            ]}
          />
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Section title="Delivery" description="Active projects you can see, ordered by target date. Health is assessed separately from progress." actions={<Link to="/projects" className="text-[12.5px] text-accent hover:underline">All projects</Link>}>
            {!d ? (
              <Panel className="p-4"><SkeletonRows rows={5} /></Panel>
            ) : d.projects.length === 0 ? (
              <EmptyState title="No active projects" body="Projects you manage or belong to will appear here." />
            ) : (
              <Panel className="divide-y divide-line/70">
                {d.projects.slice(0, 10).map((p) => (
                  <Link key={p.id} to={`/projects/${p.id}`} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 transition-colors hover:bg-canvas/70 xl:grid-cols-[minmax(0,1fr)_150px_92px_70px]">
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-highlight-ink">{p.reference}</span>
                        <span className="truncate font-medium text-ink">{p.name}</span>
                      </div>
                      <div className="truncate text-[12px] text-muted">{p.client_name} · {p.manager_name ?? 'No manager'}</div>
                    </div>
                    <div className="hidden xl:block"><ProgressFigure value={p.progress} hasData={p.total_tasks > 0} compact /></div>
                    <div className="hidden xl:block"><HealthDot health={p.health} reasons={p.health_reasons} /></div>
                    <div className="text-right text-[12.5px]"><DueText date={p.target_date} /></div>
                  </Link>
                ))}
              </Panel>
            )}
          </Section>

          {d?.company && (
            <Section title="Throughput" description="Tasks reaching Completed (after approval) per day, last 30 days.">
              <Panel className="px-2 pb-1 pt-4">
                <div className="h-[150px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={fillDays(d.company.throughput)} margin={{ left: 8, right: 8, top: 4, bottom: 0 }}>
                      <defs>
                        <linearGradient id="tp" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#fbfaf7" stopOpacity={0.22} />
                          <stop offset="100%" stopColor="#fbfaf7" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="day" tickFormatter={(v) => fmtDateShort(v)} tick={{ fontSize: 10.5, fill: '#8d8b88' }} axisLine={false} tickLine={false} interval={6} />
                      <Tooltip formatter={(v) => [v, 'Completed']} labelFormatter={(l) => fmtDateShort(String(l))} contentStyle={{ background: '#141414', color: '#fbfaf7', fontSize: 12, borderRadius: 6, border: '1px solid #262626' }} />
                      <Area type="monotone" dataKey="completed" stroke="#fbfaf7" strokeWidth={1.6} fill="url(#tp)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
            </Section>
          )}
        </div>

        <aside className="min-w-0 space-y-8">
          <Section title="Your next tasks" actions={<Link to="/tasks" className="text-[12.5px] text-accent hover:underline">My work</Link>}>
            {!d ? (
              <SkeletonRows rows={4} />
            ) : d.myTasks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">Nothing assigned to you right now.</p>
            ) : (
              <ul className="space-y-1">
                {d.myTasks.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="block rounded-md px-2.5 py-2 hover:bg-surface">
                      <div className="flex items-start gap-2">
                        <PriorityMark priority={t.priority} />
                        <span className="flex-1 text-[13px] leading-snug text-ink">{t.title}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 pl-5 text-[11.5px]">
                        <span className="font-mono text-muted">{t.project_reference}-{t.number}</span>
                        <TaskStatusBadge status={t.status} />
                        <span className="ml-auto"><DueText date={t.due_date} /></span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {d && d.reviewQueue.length > 0 && (
            <Section title="Awaiting your review" actions={<Link to="/tasks?view=review" className="text-[12.5px] text-accent hover:underline">Review queue</Link>}>
              <ul className="space-y-1">
                {d.reviewQueue.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="block rounded-md border-l-2 border-info/60 bg-surface px-3 py-2 hover:bg-white">
                      <div className="text-[13px] text-ink">{t.title}</div>
                      <div className="mt-0.5 text-[11.5px] text-muted">
                        <span className="font-mono">{t.project_reference}-{t.number}</span> · {t.responsible_name ?? 'Unassigned'} · submitted {relative(t.submitted_at)}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Milestones">
            {!d ? (
              <SkeletonRows rows={3} />
            ) : d.milestones.length === 0 ? (
              <p className="text-[13px] text-muted">No milestones due in the next 30 days.</p>
            ) : (
              <ol className="relative ml-1.5 space-y-3 border-l border-line pl-4">
                {d.milestones.map((m) => (
                  <li key={m.id} className="relative">
                    <span className={cx('absolute -left-[21px] top-1.5 size-2 rounded-full ring-4 ring-canvas', m.due_date < d.today ? 'bg-danger' : 'bg-highlight')} aria-hidden />
                    <Link to={`/projects/${m.project_id}?tab=milestones`} className="block hover:underline">
                      <span className="text-[13px] text-ink">{m.title}</span>
                    </Link>
                    <div className="text-[11.5px] text-muted">
                      <span className="font-mono">{m.reference}</span> · <DueText date={m.due_date} />
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title="Away today">
            {!d ? (
              <Skeleton className="w-40" />
            ) : d.onLeaveToday.length === 0 ? (
              <p className="text-[13px] text-muted">Everyone is in.</p>
            ) : (
              <ul className="space-y-2">
                {d.onLeaveToday.map((p) => (
                  <li key={p.id} className="flex items-center gap-2.5 text-[13px]">
                    <Avatar name={p.name} size={22} />
                    <span className="text-ink">{p.name}</span>
                    <span className="ml-auto text-[11.5px] text-muted">{p.half_day !== 'none' ? 'Half day' : `until ${fmtDateShort(p.end_date)}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </aside>
      </div>
    </div>
  )
}
