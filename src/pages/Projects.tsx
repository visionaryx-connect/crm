import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { z } from 'zod'
import { LayoutList, Plus, Rows3, Search } from 'lucide-react'
import { projectSchema } from '@shared/schemas'
import { PRIORITIES, PRIORITY_LABEL, PROJECT_STATUSES, PROJECT_STATUS_LABEL } from '@shared/constants'
import { api, ApiError, qs } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { applyServerErrors } from '@/lib/forms'
import { useClientOptions, useMembers, useServiceCategories } from '@/lib/lookups'
import { Button, cx, Dialog, EmptyState, Field, Input, PageHeader, Panel, QueryState, SampleTag, Select, Table, Td, Textarea, Th, Tr } from '@/components/ui'
import { DueText, HealthDot, PriorityMark, ProgressFigure, ProjectStatusBadge } from '@/components/status'
import { useToast } from '@/components/toast'

export interface ProjectRow {
  id: string; reference: string; name: string; status: string; priority: string; progress: number; start_date: string | null; target_date: string | null; is_seed: boolean
  client_id: string; client_name: string; manager_id: string | null; manager_name: string | null; service_category: string | null
  total_tasks: number; completed_tasks: number; overdue_tasks: number; blocked_tasks: number; member_count: number; health: string; health_reasons: string[]
}

type ProjectForm = z.input<typeof projectSchema>

export function ProjectDialog({ open, onClose, clientId }: { open: boolean; onClose: () => void; clientId?: string }) {
  const { me, can } = useAuth()
  const clients = useClientOptions(open)
  const members = useMembers(open)
  const services = useServiceCategories()
  const toast = useToast()
  const nav = useNavigate()
  const form = useForm<ProjectForm, unknown, z.output<typeof projectSchema>>({ resolver: zodResolver(projectSchema), defaultValues: { status: 'planning', priority: 'medium', progressMode: 'equal', description: '', scope: '', clientStatusNote: '', clientId: clientId ?? '', managerId: me.user.id } })
  useEffect(() => {
    if (open) form.reset({ status: 'planning', priority: 'medium', progressMode: 'equal', description: '', scope: '', clientStatusNote: '', clientId: clientId ?? '', managerId: me.user.id })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const err = form.formState.errors
  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await api.post<{ id: string; reference: string }>('/api/projects', v)
      toast({ tone: 'ok', title: `Project ${r.reference} created` })
      onClose()
      nav(`/projects/${r.id}`)
    } catch (e) {
      if (!applyServerErrors(e, form.setError)) toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not create project' })
    }
  })
  const nullable = { setValueAs: (v: string) => v || null }
  return (
    <Dialog open={open} onClose={onClose} title="New project" description="A reference (VX-YYYY-NNN) is assigned automatically." width={680} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={form.formState.isSubmitting} onClick={submit}>Create project</Button></>}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        <Field label="Project name" required error={err.name?.message} className="sm:col-span-2"><Input autoFocus {...form.register('name')} aria-invalid={!!err.name} /></Field>
        <Field label="Client" required error={err.clientId?.message}>
          <Select {...form.register('clientId')} aria-invalid={!!err.clientId}><option value="">Choose a client…</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        </Field>
        <Field label="Project manager" hint={can('projects.manage_all') ? undefined : 'You will manage this project.'}>
          <Select {...form.register('managerId', nullable)} disabled={!can('projects.manage_all')}>{members.data?.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
        </Field>
        <Field label="Service"><Select {...form.register('serviceCategoryId', nullable)}><option value="">—</option>{services.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Priority"><Select {...form.register('priority')}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</Select></Field>
        <Field label="Start date" error={err.startDate?.message}><Input type="date" {...form.register('startDate', nullable)} /></Field>
        <Field label="Target deadline" error={err.targetDate?.message}><Input type="date" {...form.register('targetDate', nullable)} /></Field>
        <Field label="Status"><Select {...form.register('status')}>{PROJECT_STATUSES.filter((s) => !['completed', 'archived'].includes(s)).map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABEL[s]}</option>)}</Select></Field>
        <Field label="Progress method" hint="How task completion rolls up into project progress.">
          <Select {...form.register('progressMode')}><option value="equal">Equal — each task counts once</option><option value="effort">Effort — weighted by estimates</option><option value="milestone">Milestones — weighted by milestone</option></Select>
        </Field>
        <Field label="Estimated effort (hours)" error={err.estimatedHours?.message}><Input type="number" min={0} step="1" {...form.register('estimatedHours', { setValueAs: (v) => (v === '' ? null : Number(v)) })} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea rows={2} {...form.register('description')} /></Field>
        <Field label="Approved scope" className="sm:col-span-2" hint="Internal reference for what was agreed."><Textarea rows={3} {...form.register('scope')} /></Field>
      </form>
    </Dialog>
  )
}

export default function Projects() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const [view, setView] = useState<'table' | 'cards'>(() => (window.innerWidth < 768 ? 'cards' : 'table'))
  const status = params.get('status') ?? 'active'
  const mine = params.get('mine') === '1'
  const list = useQuery({ queryKey: ['projects', { q, status, mine }], queryFn: () => api.get<{ projects: ProjectRow[] }>(`/api/projects${qs({ q, status, mine })}`).then((r) => r.projects) })
  const nav = useNavigate()
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next)
  }

  return (
    <div>
      <PageHeader eyebrow="Delivery" title="Projects" meta={list.data && <span>{list.data.length} shown</span>} actions={can('projects.create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => set('new', '1')}>New project</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, reference, client" className="pl-8" aria-label="Search projects" />
        </div>
        <Select value={status} onChange={(e) => set('status', e.target.value)} className="w-44" aria-label="Status filter">
          <option value="active">Active</option>
          <option value="">All (not archived)</option>
          {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABEL[s]}</option>)}
        </Select>
        <label className="ml-1 flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" className="accent-forest" checked={mine} onChange={(e) => set('mine', e.target.checked ? '1' : null)} /> Only mine</label>
        <div className="ml-auto flex rounded-md border border-line bg-paper p-0.5" role="group" aria-label="View">
          <button className={cx('rounded px-2 py-1', view === 'table' && 'bg-porcelain')} onClick={() => setView('table')} aria-pressed={view === 'table'} aria-label="Table view"><LayoutList className="size-4" /></button>
          <button className={cx('rounded px-2 py-1', view === 'cards' && 'bg-porcelain')} onClick={() => setView('cards')} aria-pressed={view === 'cards'} aria-label="Card view"><Rows3 className="size-4" /></button>
        </div>
      </div>
      <QueryState q={list} empty={(d) => (d.length === 0 ? <EmptyState title="No projects here" body={can('projects.create') ? 'Start a project for a client to plan milestones and tasks.' : 'Projects you are added to will appear here.'} /> : null)}>
        {(rows) =>
          view === 'table' ? (
            <Table>
              <thead><tr><Th>Project</Th><Th>Status</Th><Th>Progress</Th><Th>Health</Th><Th align="right">Tasks</Th><Th>Target</Th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <Tr key={p.id} onClick={() => nav(`/projects/${p.id}`)}>
                    <Td>
                      <div className="flex items-center gap-2"><PriorityMark priority={p.priority} /><Link to={`/projects/${p.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-ink hover:underline">{p.name}</Link>{p.is_seed && <SampleTag />}</div>
                      <div className="pl-5 text-[12px] text-muted"><span className="font-mono text-gold-700">{p.reference}</span> · {p.client_name} · {p.manager_name ?? 'No manager'}</div>
                    </Td>
                    <Td><ProjectStatusBadge status={p.status} /></Td>
                    <Td><ProgressFigure value={p.progress} hasData={p.total_tasks > 0} compact /></Td>
                    <Td><HealthDot health={p.health} reasons={p.health_reasons} /></Td>
                    <Td align="right" className="font-mono tabular text-[12.5px]">
                      {p.completed_tasks}/{p.total_tasks}
                      {p.overdue_tasks > 0 && <span className="ml-1.5 text-danger" title="Overdue">·{p.overdue_tasks}!</span>}
                    </Td>
                    <Td><DueText date={p.target_date} open={!['completed', 'archived'].includes(p.status)} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((p) => (
                <Link key={p.id} to={`/projects/${p.id}`}>
                  <Panel className="h-full p-4 transition-colors hover:border-line-strong">
                    <div className="flex items-start justify-between gap-2"><span className="font-mono text-[11px] text-gold-700">{p.reference}</span><ProjectStatusBadge status={p.status} /></div>
                    <p className="mt-1.5 font-display text-[18px] leading-snug text-ink">{p.name}</p>
                    <p className="text-[12.5px] text-muted">{p.client_name}</p>
                    <div className="mt-4"><ProgressFigure value={p.progress} hasData={p.total_tasks > 0} /></div>
                    <div className="mt-3 flex items-center justify-between text-[12px]"><HealthDot health={p.health} reasons={p.health_reasons} /><DueText date={p.target_date} /></div>
                  </Panel>
                </Link>
              ))}
            </div>
          )
        }
      </QueryState>
      <ProjectDialog open={params.get('new') === '1'} onClose={() => set('new', null)} clientId={params.get('clientId') ?? undefined} />
    </div>
  )
}
