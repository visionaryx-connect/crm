import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useToast } from './toast'
import { Button, Dialog, Field, Input, Select, Textarea } from './ui'

type Preview = {
  projectId: string | null; projectName: string | null
  responsibleId: string | null; responsibleName: string | null
  title: string; description: string; status: 'todo' | 'backlog'
  priority: string; dueDate: string | null; startDate: string | null
  assigneeIds: string[]; milestoneId: null; estimateHours: null
  weight: number; requiresApproval: boolean; dependsOn: string[]
}
type Result = { preview: Preview; warnings: string[]; readyToCreate: boolean }

/** AI is preview-only. All real writes go through the existing authenticated task creation endpoint. */
export function AiTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [draft, setDraft] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const qc = useQueryClient()
  const resetClose = () => { if (busy || saving) return; setPrompt(''); setDraft(null); onClose() }
  const generate = async () => {
    setBusy(true); setDraft(null)
    try { setDraft(await api.post<Result>('/api/tasks/ai-preview', { prompt })) }
    catch (e) { toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'AI preview failed' }) }
    finally { setBusy(false) }
  }
  const change = <K extends keyof Preview>(key: K, value: Preview[K]) =>
    setDraft(old => old ? { ...old, preview: { ...old.preview, [key]: value } } : old)
  const create = async () => {
    if (!draft?.readyToCreate || !draft.preview.projectId || !draft.preview.title.trim()) return
    setSaving(true)
    try {
      const v = draft.preview
      await api.post('/api/tasks', {
        projectId: v.projectId, title: v.title, description: v.description,
        responsibleId: v.responsibleId, assigneeIds: v.assigneeIds,
        status: v.status, priority: v.priority, dueDate: v.dueDate, startDate: v.startDate,
        milestoneId: v.milestoneId, estimateHours: v.estimateHours, weight: v.weight,
        requiresApproval: v.requiresApproval, dependsOn: v.dependsOn,
      })
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      toast({ tone: 'ok', title: 'AI task created' })
      setPrompt(''); setDraft(null); onClose()
    } catch (e) {
      toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Task creation failed' })
    } finally { setSaving(false) }
  }
  return <Dialog open={open} onClose={resetClose} title={<span className="inline-flex items-center gap-2"><Sparkles className="size-5" /> Assign task with AI</span>} width={680}
    description="Describe a task, review the result, and confirm before assigning it."
    footer={<><Button variant="ghost" onClick={resetClose}>Cancel</Button><Button variant="primary" disabled={!draft?.readyToCreate || !draft.preview.title.trim()} loading={saving} onClick={create}>Confirm & Create</Button></>}>
    <div className="space-y-4">
      <Field label="Task instruction"><Textarea rows={4} value={prompt} onChange={e => { setPrompt(e.target.value); setDraft(null) }} placeholder="Assign Krishna to create three creatives for TEST by Friday. High priority." /></Field>
      <div className="flex justify-end"><Button loading={busy} disabled={!prompt.trim()} icon={<Sparkles className="size-4" />} onClick={generate}>Generate preview</Button></div>
      {draft && <section className="space-y-3 rounded-lg border border-line p-4" aria-label="Generated task preview">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Review task before creating</p>
        {draft.warnings.length > 0 && <div role="alert" className="rounded-md border border-warn/30 bg-warn-bg p-3 text-sm text-warn">{draft.warnings.map(w => <p key={w}>{w}</p>)}<p className="mt-2">Revise the prompt and generate again to resolve these issues.</p></div>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Project"><Input value={draft.preview.projectName ?? ''} disabled /></Field>
          <Field label="Responsible"><Input value={draft.preview.responsibleName ?? 'Unassigned'} disabled /></Field>
          <Field label="Title" className="sm:col-span-2"><Input maxLength={200} value={draft.preview.title} onChange={e => change('title', e.target.value)} /></Field>
          <Field label="Description" className="sm:col-span-2"><Textarea rows={3} value={draft.preview.description} onChange={e => change('description', e.target.value)} /></Field>
          <Field label="Priority"><Select value={draft.preview.priority} onChange={e => change('priority', e.target.value)}>{['low','medium','high','urgent'].map(x => <option key={x} value={x}>{x}</option>)}</Select></Field>
          <Field label="Due date"><Input type="date" value={draft.preview.dueDate ?? ''} onChange={e => change('dueDate', e.target.value || null)} /></Field>
        </div>
        <p className="text-xs text-muted">Employee and project are verified by the server. To change either, edit your prompt and regenerate.</p>
      </section>}
    </div>
  </Dialog>
}
