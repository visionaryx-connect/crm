import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { todayIST } from '@/lib/format'
import { EmptyState, PageHeader, QueryState, Section, Tabs } from '@/components/ui'
import { TaskTable } from './project/TaskTable'
import type { TaskRow } from './project/types'

type View = 'mine' | 'review' | 'overdue' | 'done'

export default function MyWork() {
  const [params, setParams] = useSearchParams()
  const view = (params.get('view') as View) || 'mine'
  const url = view === 'mine' ? '/api/tasks?mine=1&status=open' : view === 'review' ? '/api/tasks?review=1' : view === 'overdue' ? '/api/tasks?overdue=1' : '/api/tasks?mine=1&status=completed'
  const q = useQuery({ queryKey: ['tasks', { view }], queryFn: () => api.get<{ tasks: TaskRow[] }>(url).then((r) => r.tasks) })
  const counts = useQuery({ queryKey: ['tasks', { view: 'counts' }], queryFn: async () => ({ review: (await api.get<{ tasks: TaskRow[] }>('/api/tasks?review=1')).tasks.length }) })

  const today = todayIST()
  const weekEnd = new Date(Date.parse(today) + 7 * 86400000).toISOString().slice(0, 10)
  const groups = (rows: TaskRow[]) => [
    { key: 'overdue', title: 'Overdue', rows: rows.filter((t) => t.due_date && t.due_date < today) },
    { key: 'today', title: 'Due today', rows: rows.filter((t) => t.due_date === today) },
    { key: 'week', title: 'Next 7 days', rows: rows.filter((t) => t.due_date && t.due_date > today && t.due_date <= weekEnd) },
    { key: 'later', title: 'Later', rows: rows.filter((t) => t.due_date && t.due_date > weekEnd) },
    { key: 'none', title: 'No due date', rows: rows.filter((t) => !t.due_date) },
  ].filter((g) => g.rows.length)

  return (
    <div>
      <PageHeader eyebrow="Tasks" title="My work" meta={<span>Tasks assigned to you across every project you belong to.</span>}>
        <div className="mt-5 border-b border-line">
          <Tabs value={view} onChange={(v) => setParams({ view: v })} tabs={[
            { value: 'mine', label: 'Assigned to me' },
            { value: 'review', label: 'Awaiting my review', count: counts.data?.review },
            { value: 'overdue', label: 'Overdue (visible to me)' },
            { value: 'done', label: 'Completed' },
          ]} />
        </div>
      </PageHeader>
      <QueryState q={q} empty={(d) => (d.length === 0 ? <EmptyState title={view === 'review' ? 'Nothing awaits your review' : view === 'overdue' ? 'Nothing is overdue' : view === 'done' ? 'No completed tasks yet' : 'You’re all caught up'} body={view === 'mine' ? 'New assignments will appear here and in your notifications.' : undefined} /> : null)}>
        {(rows) =>
          view === 'mine' ? (
            <div>{groups(rows).map((g) => <Section key={g.key} title={`${g.title} · ${g.rows.length}`}><TaskTable tasks={g.rows} showProject /></Section>)}</div>
          ) : (
            <TaskTable tasks={rows} showProject />
          )
        }
      </QueryState>
    </div>
  )
}
