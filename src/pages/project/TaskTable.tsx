import { useState } from 'react'
import { Link } from 'react-router'
import { PRIORITIES, PRIORITY_LABEL } from '@shared/constants'
import { api } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { hours } from '@/lib/format'
import { Avatar, Button, Select, Table, Td, Th, Tr } from '@/components/ui'
import { DueText, PriorityMark, TaskStatusBadge } from '@/components/status'
import type { TaskRow } from './types'

/** Task list with optional bulk operations (managers only). */
export function TaskTable({ tasks, members, canBulk, showProject }: { tasks: TaskRow[]; members?: { user_id: string; name: string; role: string }[]; canBulk?: boolean; showProject?: boolean }) {
  const [selected, setSelected] = useState<string[]>([])
  const [action, setAction] = useState('')
  const [value, setValue] = useState('')
  const bulk = useAction(
    () =>
      api.post('/api/tasks/bulk', {
        taskIds: selected,
        action,
        ...(action === 'set_status' ? { status: value } : action === 'assign' ? { responsibleId: value || null } : action === 'set_priority' ? { priority: value } : { dueDate: value || null }),
      }),
    { success: (r: any) => `Updated ${r.updated} task(s)`, invalidate: [['tasks'], ['project']], onSuccess: () => { setSelected([]); setAction(''); setValue('') } },
  )
  const all = tasks.length > 0 && selected.length === tasks.length

  return (
    <div>
      {canBulk && selected.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/25 bg-accent-faint px-3 py-2 text-[13px]">
          <span className="font-medium text-accent-strong">{selected.length} selected</span>
          <Select className="!h-8 w-40" value={action} onChange={(e) => { setAction(e.target.value); setValue('') }} aria-label="Bulk action">
            <option value="">Choose action…</option>
            <option value="set_status">Change status</option>
            <option value="assign">Reassign</option>
            <option value="set_priority">Set priority</option>
            <option value="set_due_date">Set due date</option>
          </Select>
          {action === 'set_status' && <Select className="!h-8 w-36" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Status"><option value="">…</option><option value="backlog">Backlog</option><option value="todo">To do</option><option value="in_progress">In progress</option><option value="cancelled">Cancelled</option></Select>}
          {action === 'assign' && <Select className="!h-8 w-44" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Assignee"><option value="">Unassigned</option>{members?.filter((m) => m.role !== 'viewer').map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</Select>}
          {action === 'set_priority' && <Select className="!h-8 w-32" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Priority"><option value="">…</option>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</Select>}
          {action === 'set_due_date' && <input type="date" className="h-8 rounded-md border border-line-strong bg-surface px-2" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Due date" />}
          <Button size="sm" variant="primary" disabled={!action || (action !== 'assign' && action !== 'set_due_date' && !value)} loading={bulk.isPending} onClick={() => bulk.mutate()}>Apply</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button>
        </div>
      )}
      <Table>
        <thead>
          <tr>
            {canBulk && <Th className="w-8"><input type="checkbox" aria-label="Select all" className="accent-accent" checked={all} onChange={(e) => setSelected(e.target.checked ? tasks.map((t) => t.id) : [])} /></Th>}
            <Th>Task</Th><Th>Status</Th><Th>Responsible</Th><Th>Milestone</Th><Th align="right">Estimate / logged</Th><Th>Due</Th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <Tr key={t.id}>
              {canBulk && <Td><input type="checkbox" aria-label={`Select ${t.title}`} className="accent-accent" checked={selected.includes(t.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))} /></Td>}
              <Td>
                <div className="flex items-start gap-1.5"><PriorityMark priority={t.priority} /><Link to={`/tasks/${t.id}`} className="font-medium text-ink hover:underline">{t.title}</Link></div>
                <div className="pl-5 font-mono text-[11px] text-muted">{showProject ? `${t.project_reference}-` : '#'}{t.number}{showProject && <span className="font-sans"> · {t.project_name}</span>}{t.open_dependencies > 0 && <span className="font-sans text-warn"> · waiting on {t.open_dependencies}</span>}</div>
              </Td>
              <Td><TaskStatusBadge status={t.status} /></Td>
              <Td>{t.responsible_name ? <span className="inline-flex items-center gap-2"><Avatar name={t.responsible_name} color={t.responsible_color} size={20} /><span className="text-ink-2">{t.responsible_name}</span></span> : <span className="text-faint">Unassigned</span>}</Td>
              <Td className="text-ink-2">{t.milestone_title ?? <span className="text-faint">—</span>}</Td>
              <Td align="right" className="font-mono text-[12px] tabular text-ink-2">{t.estimate_hours != null ? `${t.estimate_hours} h` : '—'} / {hours(t.logged_minutes)}</Td>
              <Td><DueText date={t.due_date} open={!['completed', 'cancelled'].includes(t.status)} /></Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}
