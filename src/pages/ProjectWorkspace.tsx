import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, Copy, Info, Pencil, Plus } from 'lucide-react'
import { PRIORITIES, PRIORITY_LABEL, PROJECT_STATUSES, PROJECT_STATUS_LABEL, TASK_STATUS_LABEL, type TaskStatus } from '@shared/constants'
import { api, ApiError } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { useMembers, useServiceCategories } from '@/lib/lookups'
import { fmtDate, hours } from '@/lib/format'
import { Avatar, Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, KeyValue, PageHeader, Panel, Progress, SampleTag, Section, Select, SkeletonRows, Tabs, Textarea, cx } from '@/components/ui'
import { DueText, HealthDot, PriorityMark, ProjectStatusBadge } from '@/components/status'
import { TaskDialog } from '@/components/TaskDialog'
import { useToast } from '@/components/toast'
import { Board } from './project/Board'
import { TaskTable } from './project/TaskTable'
import { Timeline } from './project/Timeline'
import { ActivityPanel, DeliverablesPanel, FeedbackPanel, FilesPanel, MilestonesPanel, TeamPanel, UpdatesPanel } from './project/Panels'
import type { ProjectData, TaskRow } from './project/types'

type Tab = 'overview' | 'board' | 'list' | 'timeline' | 'milestones' | 'deliverables' | 'files' | 'updates' | 'feedback' | 'team' | 'activity'

const MODE_TEXT = {
  equal: 'Each applicable task counts equally: completed ÷ total (cancelled tasks excluded).',
  effort: 'Tasks are weighted by their approved estimate (or complexity weight when no estimate exists).',
  milestone: 'Milestones contribute by weight; tasks inside each milestone count equally.',
}

function EditProject({ data, open, onClose }: { data: ProjectData; open: boolean; onClose: () => void }) {
  const p = data.project
  const members = useMembers(open)
  const services = useServiceCategories()
  const toast = useToast()
  const [v, setV] = useState({
    name: p.name, description: p.description, scope: p.scope, startDate: p.start_date ?? '', targetDate: p.target_date ?? '', status: p.status, statusNote: '',
    priority: p.priority, progressMode: p.progress_mode, estimatedHours: p.estimated_hours?.toString() ?? '', clientStatusNote: p.client_status_note, managerId: p.manager_id ?? '', serviceCategoryId: p.service_category_id ?? '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [blockers, setBlockers] = useState<string[] | null>(null)
  const save = useAction(
    () =>
      api.patch(`/api/projects/${p.id}`, {
        ...v, startDate: v.startDate || null, targetDate: v.targetDate || null, estimatedHours: v.estimatedHours === '' ? null : Number(v.estimatedHours),
        managerId: v.managerId || null, serviceCategoryId: v.serviceCategoryId || null,
      }),
    {
      success: 'Project updated',
      invalidate: [['project', p.id], ['projects']],
      onSuccess: onClose,
      silentError: true,
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'CLOSURE_BLOCKED') setBlockers((e.details?.reasons as string[]) ?? [])
        else if (e instanceof ApiError && Object.keys(e.fields).length) setErrors(e.fields)
        else toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Save failed' })
      },
    },
  )
  const statusChanged = v.status !== p.status
  return (
    <Dialog open={open} onClose={onClose} title="Project settings" width={720} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setBlockers(null); save.mutate() }}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {blockers && <div className="sm:col-span-2 rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-[13px] text-danger" role="alert"><p className="font-medium">This project can’t be closed yet</p><ul className="mt-1 list-disc pl-5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>}
        <Field label="Name" error={errors.name} className="sm:col-span-2"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Status"><Select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABEL[s]}</option>)}</Select></Field>
        <Field label="Priority"><Select value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })}>{PRIORITIES.map((s) => <option key={s} value={s}>{PRIORITY_LABEL[s]}</option>)}</Select></Field>
        {statusChanged && <Field label="Reason for status change" className="sm:col-span-2" hint={v.status === 'completed' ? 'Closing requires all tasks completed and deliverables approved; your approval is recorded.' : 'Recorded in the status history.'}><Input value={v.statusNote} onChange={(e) => setV({ ...v, statusNote: e.target.value })} /></Field>}
        <Field label="Start date" error={errors.startDate}><Input type="date" value={v.startDate} onChange={(e) => setV({ ...v, startDate: e.target.value })} /></Field>
        <Field label="Target deadline" error={errors.targetDate}><Input type="date" value={v.targetDate} onChange={(e) => setV({ ...v, targetDate: e.target.value })} /></Field>
        <Field label="Project manager"><Select value={v.managerId} onChange={(e) => setV({ ...v, managerId: e.target.value })}>{members.data?.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <Field label="Service"><Select value={v.serviceCategoryId} onChange={(e) => setV({ ...v, serviceCategoryId: e.target.value })}><option value="">—</option>{services.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Progress method" hint={MODE_TEXT[v.progressMode]}><Select value={v.progressMode} onChange={(e) => setV({ ...v, progressMode: e.target.value as typeof v.progressMode })}><option value="equal">Equal</option><option value="effort">Effort-weighted</option><option value="milestone">Milestone-weighted</option></Select></Field>
        <Field label="Estimated effort (h)"><Input type="number" min={0} value={v.estimatedHours} onChange={(e) => setV({ ...v, estimatedHours: e.target.value })} /></Field>
        <Field label="Client-facing status line" className="sm:col-span-2" hint="Shown on the client portal. Keep it approved and client-appropriate."><Input value={v.clientStatusNote} onChange={(e) => setV({ ...v, clientStatusNote: e.target.value })} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
        <Field label="Approved scope" className="sm:col-span-2"><Textarea rows={3} value={v.scope} onChange={(e) => setV({ ...v, scope: e.target.value })} /></Field>
      </div>
    </Dialog>
  )
}

function Overview({ data, tasks }: { data: ProjectData; tasks: TaskRow[] }) {
  const p = data.project
  const stats = data.taskStats
  const order: TaskStatus[] = ['completed', 'in_review', 'in_progress', 'blocked', 'todo', 'backlog']
  const total = order.reduce((s, k) => s + (stats[k] ?? 0), 0)
  const colors: Record<string, string> = { completed: 'bg-ok', in_review: 'bg-info', in_progress: 'bg-forest', blocked: 'bg-danger', todo: 'bg-ink-2/35', backlog: 'bg-line-strong' }
  const overdue = tasks.filter((t) => t.overdue)
  const blocked = tasks.filter((t) => t.status === 'blocked')
  const effortPct = data.effort.estimatedHours ? Math.round((data.effort.loggedHours / data.effort.estimatedHours) * 100) : null
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-8">
        <section className="grid gap-4 sm:grid-cols-2">
          <Panel className="p-5">
            <div className="flex items-baseline justify-between"><span className="eyebrow">Progress</span><span title={MODE_TEXT[p.progress_mode]} className="text-faint"><Info className="size-3.5" /></span></div>
            <div className="mt-2 font-display text-[44px] leading-none tabular text-ink" style={{ fontVariationSettings: '"opsz" 96' }}>{p.total_tasks ? `${Math.round(p.progress)}%` : '—'}</div>
            <p className="mt-2 text-[12px] text-muted">{p.total_tasks ? MODE_TEXT[p.progress_mode] : 'No tasks yet — progress appears once work is planned.'}</p>
            {total > 0 && (
              <>
                <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-sage">{order.map((k) => (stats[k] ? <span key={k} className={colors[k]} style={{ width: `${(stats[k]! / total) * 100}%` }} title={`${TASK_STATUS_LABEL[k]}: ${stats[k]}`} /> : null))}</div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">{order.filter((k) => stats[k]).map((k) => <span key={k} className="inline-flex items-center gap-1"><span className={cx('size-1.5 rounded-full', colors[k])} />{TASK_STATUS_LABEL[k]} {stats[k]}</span>)}</div>
              </>
            )}
          </Panel>
          <Panel className="p-5">
            <span className="eyebrow">Delivery health</span>
            <div className="mt-3"><HealthDot health={p.health} /></div>
            {p.health_reasons.length > 0 ? <ul className="mt-2 space-y-1 text-[13px] text-ink-2">{p.health_reasons.map((r) => <li key={r}>· {r}</li>)}</ul> : <p className="mt-2 text-[13px] text-muted">{p.health === 'on_track' ? 'Schedule and progress are aligned; nothing overdue or blocked.' : 'Health is assessed for active projects only.'}</p>}
            <div className="mt-4 border-t border-line pt-3">
              <span className="eyebrow">Effort</span>
              <p className="mt-1 text-[13px] text-ink-2">{hours(data.effort.loggedHours * 60)} logged of {data.effort.estimatedHours ? `${data.effort.estimatedHours} h estimated` : 'no estimates yet'}{data.effort.budgetHours != null && ` · budget ${data.effort.budgetHours} h`}</p>
              {effortPct !== null && <Progress value={effortPct} tone={effortPct > 100 ? 'danger' : 'gold'} className="mt-2" label="Effort used" />}
            </div>
          </Panel>
        </section>

        {(overdue.length > 0 || blocked.length > 0) && (
          <Section title="Needs attention">
            <ul className="divide-y divide-line/70 rounded-lg border border-line bg-paper">
              {[...blocked, ...overdue.filter((t) => t.status !== 'blocked')].slice(0, 8).map((t) => (
                <li key={t.id}><Link to={`/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-ivory/70">
                  <PriorityMark priority={t.priority} />
                  <span className="flex-1 text-ink">{t.title}</span>
                  {t.status === 'blocked' ? <Badge tone="danger">Blocked{t.blocked_reason ? `: ${t.blocked_reason.slice(0, 40)}` : ''}</Badge> : <DueText date={t.due_date} />}
                  {t.responsible_name && <Avatar name={t.responsible_name} color={t.responsible_color} size={20} />}
                </Link></li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Scope & description">
          <Panel className="space-y-4 p-5 text-[13.5px] text-ink-2">
            <div><div className="eyebrow mb-1">Description</div><p className="whitespace-pre-wrap">{p.description || <span className="text-faint">No description.</span>}</p></div>
            <div><div className="eyebrow mb-1">Approved scope</div><p className="whitespace-pre-wrap">{p.scope || <span className="text-faint">Scope not recorded.</span>}</p></div>
            <div><div className="eyebrow mb-1">Client sees</div><p className="rounded bg-gold-100/50 px-3 py-2 text-ink">{p.client_status_note || <span className="text-faint">No client-facing status yet.</span>}</p></div>
          </Panel>
        </Section>
      </div>
      <aside className="space-y-6">
        <Panel className="p-4">
          <KeyValue cols={1} items={[
            { label: 'Client', value: <Link to={`/clients/${p.client_id}`} className="link">{p.client_name}</Link> },
            { label: 'Project manager', value: p.manager_name },
            { label: 'Service', value: p.service_category },
            { label: 'Schedule', value: <>{fmtDate(p.start_date)} → {fmtDate(p.target_date)}</> },
            { label: 'Priority', value: <PriorityMark priority={p.priority} withLabel /> },
            ...(p.completed_at ? [{ label: 'Closed', value: <>{fmtDate(p.completed_at)} · approved by {p.closure_approved_by_name ?? '—'}</> }] : []),
          ]} />
        </Panel>
        <Panel className="p-4">
          <div className="eyebrow mb-3">Team · {data.members.length}</div>
          <ul className="space-y-2">{data.members.slice(0, 8).map((m) => <li key={m.user_id} className="flex items-center gap-2.5 text-[13px]"><Avatar name={m.name} color={m.avatar_color} size={22} /><span className="flex-1 text-ink">{m.name}</span><span className="text-[11.5px] capitalize text-muted">{m.role}</span></li>)}</ul>
        </Panel>
        <Panel className="p-4">
          <div className="eyebrow mb-2">Deliverables</div>
          {Object.keys(data.deliverableStats).length === 0 ? <p className="text-[13px] text-muted">None yet.</p> : <ul className="space-y-1 text-[13px]">{Object.entries(data.deliverableStats).map(([k, n]) => <li key={k} className="flex justify-between"><span className="capitalize text-ink-2">{k.replace('_', ' ')}</span><span className="font-mono">{n}</span></li>)}</ul>}
        </Panel>
      </aside>
    </div>
  )
}

export default function ProjectWorkspace() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'overview'
  const [editing, setEditing] = useState(false)
  const [newTask, setNewTask] = useState(false)
  const [taskFilter, setTaskFilter] = useState({ responsible: '', milestone: '', showDone: true })
  const nav = useNavigate()
  const q = useQuery({ queryKey: ['project', id], queryFn: () => api.get<ProjectData>(`/api/projects/${id}`) })
  const tasksQ = useQuery({ queryKey: ['tasks', { projectId: id }], queryFn: () => api.get<{ tasks: TaskRow[] }>(`/api/tasks?projectId=${id}`).then((r) => r.tasks), enabled: !!q.data })
  const duplicate = useAction(() => api.post<{ id: string; reference: string }>(`/api/projects/${id}/duplicate`), { success: (r) => `Duplicated as ${r.reference}`, invalidate: [['projects']], onSuccess: (r) => nav(`/projects/${r.id}`) })

  if (q.isLoading) return <SkeletonRows rows={10} />
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const d = q.data
  const p = d.project
  const allTasks = (tasksQ.data ?? []).filter((t) => t.status !== 'cancelled' || tab === 'list')
  const filtered = allTasks.filter((t) => (!taskFilter.responsible || t.responsible_id === taskFilter.responsible) && (!taskFilter.milestone || t.milestone_id === taskFilter.milestone) && (taskFilter.showDone || !['completed', 'cancelled'].includes(t.status)))
  const ctx = { projectId: p.id, members: d.members, milestones: d.milestones }

  return (
    <div>
      <PageHeader
        eyebrow={<span className="flex items-center gap-2"><Link to="/projects" className="hover:underline">Projects</Link><span>/</span><span>{p.reference}</span></span>}
        title={<span className="inline-flex flex-wrap items-center gap-3">{p.name}{p.is_seed && <SampleTag />}</span>}
        meta={<><ProjectStatusBadge status={p.status} /><Link to={`/clients/${p.client_id}`} className="hover:text-ink">{p.client_name}</Link><span>PM: <span className="text-ink">{p.manager_name ?? '—'}</span></span><span>Target <DueText date={p.target_date} open={!['completed', 'archived'].includes(p.status)} /></span><HealthDot health={p.health} reasons={p.health_reasons} /></>}
        actions={
          <>
            {(d.access.canManage || d.access.canReview) && <Link to={`/reports?type=project&scopeId=${p.id}`}><Button icon={<BarChart3 className="size-4" />}>Report</Button></Link>}
            {d.access.canManage && <Button variant="ghost" icon={<Copy className="size-4" />} onClick={() => duplicate.mutate()} loading={duplicate.isPending}>Duplicate</Button>}
            {d.access.canManage && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Settings</Button>}
            {d.access.canManageTasks && !['completed', 'archived'].includes(p.status) && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewTask(true)}>New task</Button>}
          </>
        }
      >
        <div className="mt-5 border-b border-line">
          <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'board', label: 'Board' },
            { value: 'list', label: 'List', count: allTasks.length },
            { value: 'timeline', label: 'Timeline' },
            { value: 'milestones', label: 'Milestones', count: d.milestones.length },
            { value: 'deliverables', label: 'Deliverables' },
            { value: 'files', label: 'Files' },
            { value: 'updates', label: 'Updates' },
            { value: 'feedback', label: 'Client feedback', count: d.openFeedback },
            { value: 'team', label: 'Team', count: d.members.length },
            { value: 'activity', label: 'Activity' },
          ]} />
        </div>
      </PageHeader>

      {(tab === 'board' || tab === 'list') && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Select className="w-44" value={taskFilter.responsible} onChange={(e) => setTaskFilter({ ...taskFilter, responsible: e.target.value })} aria-label="Filter by person"><option value="">Everyone</option>{d.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</Select>
          <Select className="w-48" value={taskFilter.milestone} onChange={(e) => setTaskFilter({ ...taskFilter, milestone: e.target.value })} aria-label="Filter by milestone"><option value="">All milestones</option>{d.milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</Select>
          <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" className="accent-forest" checked={taskFilter.showDone} onChange={(e) => setTaskFilter({ ...taskFilter, showDone: e.target.checked })} /> Show completed</label>
        </div>
      )}

      {tab === 'overview' && <Overview data={d} tasks={tasksQ.data ?? []} />}
      {tab === 'board' && (tasksQ.isLoading ? <SkeletonRows /> : tasksQ.error ? <ErrorState error={tasksQ.error} /> : <Board tasks={filtered.filter((t) => t.status !== 'cancelled')} projectId={p.id} canManage={d.access.canManageTasks} onNew={() => setNewTask(true)} />)}
      {tab === 'list' && (tasksQ.isLoading ? <SkeletonRows /> : filtered.length === 0 ? <EmptyState title="No tasks match" action={d.access.canManageTasks && <Button variant="primary" onClick={() => setNewTask(true)}>Create a task</Button>} /> : <TaskTable tasks={filtered} members={d.members} canBulk={d.access.canManageTasks} />)}
      {tab === 'timeline' && <Timeline projectId={p.id} start={p.start_date} target={p.target_date} />}
      {tab === 'milestones' && <MilestonesPanel data={d} />}
      {tab === 'deliverables' && <DeliverablesPanel data={d} />}
      {tab === 'files' && <FilesPanel data={d} />}
      {tab === 'updates' && <UpdatesPanel data={d} />}
      {tab === 'feedback' && <FeedbackPanel data={d} />}
      {tab === 'team' && <TeamPanel data={d} />}
      {tab === 'activity' && <ActivityPanel projectId={p.id} />}

      {editing && <EditProject data={d} open onClose={() => setEditing(false)} />}
      <TaskDialog open={newTask} onClose={() => setNewTask(false)} ctx={ctx} />
    </div>
  )
}
