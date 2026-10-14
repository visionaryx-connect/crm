import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PRIORITIES, PRIORITY_LABEL } from '@shared/constants'
import { api, ApiError } from '@/lib/api'
import { useToast } from './toast'
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea } from './ui'

export interface ProjectContext {
  projectId: string
  members: { user_id: string; name: string; role: string }[]
  milestones: { id: string; title: string }[]
}

interface TaskValues {
  title: string
  description: string
  milestoneId: string
  priority: string
  responsibleId: string
  assigneeIds: string[]
  startDate: string
  dueDate: string
  estimateHours: string
  weight: string
  requiresApproval: boolean
  dependsOn: string[]
  status: 'todo' | 'backlog'
}

const empty: TaskValues = { title: '', description: '', milestoneId: '', priority: 'medium', responsibleId: '', assigneeIds: [], startDate: '', dueDate: '', estimateHours: '', weight: '1', requiresApproval: true, dependsOn: [], status: 'todo' }

/** Create or edit a task. Server-side validation is authoritative; errors map back onto fields. */
export function TaskDialog({ open, onClose, ctx, taskId, initial, onSaved }: { open: boolean; onClose: () => void; ctx: ProjectContext; taskId?: string; initial?: Partial<TaskValues>; onSaved?: (id: string) => void }) {
  const [v, setV] = useState<TaskValues>({ ...empty, ...initial })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const qc = useQueryClient()
  const others = useQuery({
    queryKey: ['tasks', { projectId: ctx.projectId, lite: true }],
    queryFn: () => api.get<{ tasks: { id: string; number: number; title: string; status: string }[] }>(`/api/tasks?projectId=${ctx.projectId}`).then((r) => r.tasks),
    enabled: open,
  })
  useEffect(() => {
    if (open) {
      setV({ ...empty, ...initial })
      setErrors({})
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const contributors = ctx.members.filter((m) => m.role !== 'viewer')
  const set = <K extends keyof TaskValues>(k: K, val: TaskValues[K]) => setV((s) => ({ ...s, [k]: val }))

  const save = async () => {
    setBusy(true)
    setErrors({})
    const payload = {
      title: v.title,
      description: v.description,
      milestoneId: v.milestoneId || null,
      priority: v.priority,
      responsibleId: v.responsibleId || null,
      assigneeIds: v.assigneeIds.filter((a) => a !== v.responsibleId),
      startDate: v.startDate || null,
      dueDate: v.dueDate || null,
      estimateHours: v.estimateHours === '' ? null : Number(v.estimateHours),
      weight: Number(v.weight) || 1,
      requiresApproval: v.requiresApproval,
      dependsOn: v.dependsOn,
    }
    try {
      let id = taskId
      if (taskId) await api.patch(`/api/tasks/${taskId}`, payload)
      else id = (await api.post<{ id: string }>('/api/tasks', { ...payload, projectId: ctx.projectId, status: v.status })).id
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['project', ctx.projectId] })
      if (taskId) qc.invalidateQueries({ queryKey: ['task', taskId] })
      toast({ tone: 'ok', title: taskId ? 'Task updated' : 'Task created' })
      onSaved?.(id!)
      onClose()
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fields).length) setErrors(e.fields)
      else toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Save failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={taskId ? 'Edit task' : 'New task'} width={680} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save} disabled={!v.title.trim()}>{taskId ? 'Save changes' : 'Create task'}</Button></>}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save() }}>
        <Field label="Title" required error={errors.title} className="sm:col-span-2"><Input value={v.title} onChange={(e) => set('title', e.target.value)} autoFocus /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea rows={3} value={v.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Responsible" error={errors.responsibleId}>
          <Select value={v.responsibleId} onChange={(e) => set('responsibleId', e.target.value)}><option value="">Unassigned</option>{contributors.map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</Select>
        </Field>
        <Field label="Milestone" error={errors.milestoneId}>
          <Select value={v.milestoneId} onChange={(e) => set('milestoneId', e.target.value)}><option value="">None</option>{ctx.milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</Select>
        </Field>
        <Field label="Priority"><Select value={v.priority} onChange={(e) => set('priority', e.target.value)}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</Select></Field>
        {!taskId ? (
          <Field label="Start in"><Select value={v.status} onChange={(e) => set('status', e.target.value as 'todo' | 'backlog')}><option value="todo">To do</option><option value="backlog">Backlog</option></Select></Field>
        ) : <div className="hidden sm:block" />}
        <Field label="Start date" error={errors.startDate}><Input type="date" value={v.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
        <Field label="Due date" error={errors.dueDate}><Input type="date" value={v.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></Field>
        <Field label="Estimate (hours)" error={errors.estimateHours} hint="Approved effort; drives effort-weighted progress."><Input type="number" min={0} step="0.5" value={v.estimateHours} onChange={(e) => set('estimateHours', e.target.value)} /></Field>
        <Field label="Complexity weight" error={errors.weight} hint="1 = standard. Used when no estimate exists."><Input type="number" min={0.1} step="0.5" value={v.weight} onChange={(e) => set('weight', e.target.value)} /></Field>
        <Field label="Additional assignees" className="sm:col-span-2">
          <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-md border border-line p-3">
            {contributors.filter((m) => m.user_id !== v.responsibleId).map((m) => (
              <Checkbox key={m.user_id} label={m.name} checked={v.assigneeIds.includes(m.user_id)} onChange={(e) => set('assigneeIds', e.target.checked ? [...v.assigneeIds, m.user_id] : v.assigneeIds.filter((x) => x !== m.user_id))} />
            ))}
            {contributors.length <= 1 && <span className="text-[12.5px] text-muted">Add people to the project team to assign them.</span>}
          </div>
        </Field>
        <Field label="Depends on" error={errors.dependsOn} className="sm:col-span-2" hint="Work can’t start until these are completed.">
          <Select multiple value={v.dependsOn} onChange={(e) => set('dependsOn', Array.from(e.target.selectedOptions).map((o) => o.value))} className="!h-28 py-1">
            {others.data?.filter((t) => t.id !== taskId && t.status !== 'cancelled').map((t) => <option key={t.id} value={t.id}>#{t.number} {t.title}</option>)}
          </Select>
        </Field>
        <div className="sm:col-span-2"><Checkbox label="Requires review before completion" description="Completion (and project progress) only counts once a reviewer approves the submission." checked={v.requiresApproval} onChange={(e) => set('requiresApproval', e.target.checked)} /></div>
      </form>
    </Dialog>
  )
}
