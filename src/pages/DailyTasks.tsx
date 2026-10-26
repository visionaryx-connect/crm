import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { fmtDate, todayIST } from '@/lib/format'
import { Avatar, EmptyState, PageHeader, QueryState } from '@/components/ui'
import { TaskStatusBadge, PriorityMark } from '@/components/status'

type DailyTask = {
  id: string; title: string; project_id: string; project_name: string; project_reference: string
  status: string; priority: string; start_date: string | null; due_date: string | null
  user_id: string | null; user_name: string | null; avatar_color: string | null
}

export default function DailyTasks() {
  const [date, setDate] = useState(todayIST)
  const [status, setStatus] = useState('all')
  const [employee, setEmployee] = useState('all')
  const [project, setProject] = useState('all')
  const q = useQuery({
    queryKey: ['daily-tasks', date],
    queryFn: () => api.get<{ date: string; tasks: DailyTask[] }>(`/api/tasks/daily?date=${encodeURIComponent(date)}`),
  })
  const tasks = q.data?.tasks ?? []
  const people = useMemo(() => [...new Map(tasks.filter(t => t.user_id).map(t => [t.user_id!, t.user_name!])).entries()].sort((a,b) => a[1].localeCompare(b[1])), [tasks])
  const projects = useMemo(() => [...new Map(tasks.map(t => [t.project_id, t.project_name])).entries()].sort((a,b) => a[1].localeCompare(b[1])), [tasks])
  const filtered = tasks.filter(t => (status === 'all' || t.status === status) && (employee === 'all' || (employee === 'unassigned' ? !t.user_id : t.user_id === employee)) && (project === 'all' || t.project_id === project))
  const groups = [...new Map(filtered.map(t => [t.user_id ?? 'unassigned', { name: t.user_name ?? 'Unassigned', color: t.avatar_color, rows: [] as DailyTask[] }])).entries()]
  for (const t of filtered) groups.find(([key]) => key === (t.user_id ?? 'unassigned'))?.[1].rows.push(t)
  groups.sort((a,b) => a[1].name.localeCompare(b[1].name))
  const uniqueCount = new Set(filtered.map(t => t.id)).size

  return (
    <div>
      <PageHeader eyebrow="Team visibility" title="Today's tasks" meta={<span>Read-only team view · Tasks visible to you through your projects · Asia/Kolkata</span>} />
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4">
        <label className="flex flex-col gap-1 text-xs text-muted">Date
          <input type="date" value={date} onChange={e => setDate(e.target.value || todayIST())} className="h-9 rounded-md border border-line-strong bg-canvas px-3 text-sm text-ink" />
        </label>
        <button type="button" onClick={() => setDate(todayIST())} className="h-9 rounded-md border border-line px-3 text-sm text-ink hover:bg-subtle">Today</button>
        <label className="flex flex-col gap-1 text-xs text-muted">Employee
          <select value={employee} onChange={e => setEmployee(e.target.value)} className="h-9 rounded-md border border-line-strong bg-canvas px-2 text-sm text-ink">
            <option value="all">All employees</option><option value="unassigned">Unassigned</option>
            {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Project
          <select value={project} onChange={e => setProject(e.target.value)} className="h-9 rounded-md border border-line-strong bg-canvas px-2 text-sm text-ink">
            <option value="all">All projects</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Status
          <select value={status} onChange={e => setStatus(e.target.value)} className="h-9 rounded-md border border-line-strong bg-canvas px-2 text-sm text-ink">
            <option value="all">All statuses</option>
            <option value="backlog">Backlog</option><option value="todo">To do</option><option value="in_progress">In progress</option>
            <option value="in_review">In review</option><option value="blocked">Blocked</option><option value="completed">Completed</option>
          </select>
        </label>
      </div>
      <QueryState q={q}>
        {() => <>
          <p className="mb-4 text-sm text-muted">{fmtDate(date)} · {uniqueCount} unique tasks · {groups.length} employee groups</p>
          {groups.length === 0 ? <EmptyState title="No scheduled tasks" body="No visible tasks match this date and these filters. Tasks without start or due dates do not appear on the daily board." /> :
            <div className="space-y-4">{groups.map(([id, g]) =>
              <section key={id} className="overflow-hidden rounded-xl border border-line bg-surface">
                <div className="flex items-center justify-between border-b border-line px-4 py-3">
                  <div className="flex items-center gap-2"><Avatar name={g.name} color={g.color} size={28} /><h2 className="font-semibold text-ink">{g.name}</h2></div>
                  <span className="text-xs text-muted">{g.rows.length} {g.rows.length === 1 ? 'task' : 'tasks'}</span>
                </div>
                <div className="divide-y divide-line">{g.rows.map(t =>
                  <div key={`${id}-${t.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><PriorityMark priority={t.priority} /><Link className="font-medium text-ink hover:underline" to={`/tasks/${t.id}`}>{t.title}</Link></div>
                      <p className="pl-5 text-xs text-muted">{t.project_name} · {t.priority} priority · Due {fmtDate(t.due_date)}</p>
                    </div>
                    <TaskStatusBadge status={t.status} />
                  </div>)}</div>
              </section>)}</div>}
        </>}
      </QueryState>
      <p className="mt-4 text-xs text-muted">A task appears on its due date or during its scheduled start-to-due range. Historical dates display current task statuses, not a historical snapshot.</p>
    </div>
  )
}
