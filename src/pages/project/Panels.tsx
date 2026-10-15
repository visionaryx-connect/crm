import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Download, Eye, EyeOff, FileUp, Lock, Pencil, Plus, Send, Share2, Trash2, Undo2, Upload, UserMinus } from 'lucide-react'
import { MILESTONE_STATUSES, PROJECT_MEMBER_ROLES } from '@shared/constants'
import { api, ApiError } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { useMembers } from '@/lib/lookups'
import { bytes, fmtDate, fmtDateTime, relative } from '@/lib/format'
import { Avatar, Badge, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Panel, Section, Select, SkeletonRows, Table, Td, Textarea, Th, Tr, cx } from '@/components/ui'
import { DeliverableBadge, DueText } from '@/components/status'
import { useToast } from '@/components/toast'
import type { ProjectData } from './types'

// ───────────── Milestones ─────────────

type Milestone = ProjectData['milestones'][number]

function MilestoneDialog({ projectId, milestones, edit, open, onClose }: { projectId: string; milestones: Milestone[]; edit: Milestone | null; open: boolean; onClose: () => void }) {
  const [v, setV] = useState({ title: edit?.title ?? '', description: edit?.description ?? '', dueDate: edit?.due_date ?? '', weight: String(edit?.weight ?? 1), status: edit?.status ?? 'pending', clientVisible: edit?.client_visible ?? true, dependsOn: edit?.depends_on ?? [] })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useAction(
    () => {
      const body = { ...v, dueDate: v.dueDate || null, weight: Number(v.weight) || 1 }
      return edit ? api.put(`/api/projects/${projectId}/milestones/${edit.id}`, body) : api.post(`/api/projects/${projectId}/milestones`, body)
    },
    { success: edit ? 'Milestone updated' : 'Milestone added', invalidate: [['project', projectId]], onSuccess: onClose, onError: (e) => e instanceof ApiError && setErrors(e.fields) },
  )
  return (
    <Dialog open={open} onClose={onClose} title={edit ? 'Edit milestone' : 'Add milestone'} width={560} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" required error={errors.title} className="sm:col-span-2"><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} autoFocus /></Field>
        <Field label="Due date" error={errors.dueDate}><Input type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} /></Field>
        <Field label="Status"><Select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>{MILESTONE_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</Select></Field>
        <Field label="Weight" hint="Used when progress is milestone-weighted." error={errors.weight}><Input type="number" min={0.1} step="0.5" value={v.weight} onChange={(e) => setV({ ...v, weight: e.target.value })} /></Field>
        <Field label="Depends on" error={errors.dependsOn}>
          <Select multiple value={v.dependsOn} onChange={(e) => setV({ ...v, dependsOn: Array.from(e.target.selectedOptions).map((o) => o.value) })} className="!h-20 py-1">
            {milestones.filter((m) => m.id !== edit?.id).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </Select>
        </Field>
        <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Checkbox label="Visible to the client" description="Shown on the client portal’s milestone timeline." checked={v.clientVisible} onChange={(e) => setV({ ...v, clientVisible: e.target.checked })} /></div>
      </div>
    </Dialog>
  )
}

export function MilestonesPanel({ data }: { data: ProjectData }) {
  const [edit, setEdit] = useState<Milestone | null | undefined>(undefined)
  const [del, setDel] = useState<Milestone | null>(null)
  const pid = data.project.id
  const remove = useAction((id: string) => api.del(`/api/projects/${pid}/milestones/${id}`), { success: 'Milestone removed', invalidate: [['project', pid]], onSuccess: () => setDel(null) })
  const can = data.access.canManage
  return (
    <Section title="Milestones" description={data.project.progress_mode === 'milestone' ? 'Progress is weighted by milestone.' : undefined} actions={can && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEdit(null)}>Add milestone</Button>}>
      {data.milestones.length === 0 ? <EmptyState title="No milestones yet" body="Milestones group tasks into client-meaningful checkpoints." /> : (
        <ol className="relative ml-2 border-l border-line">
          {data.milestones.map((m) => {
            const pct = m.task_count ? Math.round((m.completed_count / m.task_count) * 100) : null
            return (
              <li key={m.id} className="relative mb-4 pl-6 last:mb-0">
                <span className={cx('absolute -left-[6px] top-3 size-[11px] rotate-45 border-2 border-canvas', m.status === 'achieved' ? 'bg-ok' : m.status === 'missed' ? 'bg-danger' : m.status === 'in_progress' ? 'bg-accent' : 'bg-highlight')} aria-hidden />
                <Panel className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
                  <div className="min-w-[220px] flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink">{m.title}</span>
                      {!m.client_visible && <span title="Internal only" className="text-faint"><EyeOff className="size-3.5" /></span>}
                    </div>
                    {m.description && <p className="text-[12.5px] text-muted">{m.description}</p>}
                    {m.depends_on.length > 0 && <p className="text-[11.5px] text-muted">After: {m.depends_on.map((d) => data.milestones.find((x) => x.id === d)?.title).join(', ')}</p>}
                  </div>
                  <Badge tone={m.status === 'achieved' ? 'ok' : m.status === 'missed' ? 'danger' : m.status === 'in_progress' ? 'accent' : 'neutral'}>{m.status.replace('_', ' ')}</Badge>
                  <div className="w-28 text-[12px] text-muted">{pct === null ? 'No tasks' : `${m.completed_count}/${m.task_count} tasks · ${pct}%`}</div>
                  <div className="w-28 text-[12.5px]">{m.achieved_at ? <span className="text-ok">Achieved {fmtDate(m.achieved_at)}</span> : <DueText date={m.due_date} />}</div>
                  <div className="font-mono text-[11px] text-muted">w {m.weight}</div>
                  {can && <div className="flex"><IconButton label="Edit milestone" onClick={() => setEdit(m)}><Pencil className="size-3.5" /></IconButton><IconButton label="Delete milestone" onClick={() => setDel(m)}><Trash2 className="size-3.5" /></IconButton></div>}
                </Panel>
              </li>
            )
          })}
        </ol>
      )}
      {edit !== undefined && <MilestoneDialog projectId={pid} milestones={data.milestones} edit={edit} open onClose={() => setEdit(undefined)} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} loading={remove.isPending} danger title="Delete milestone?" confirmLabel="Delete" body="Its tasks are kept and become unassigned to any milestone." />
    </Section>
  )
}

// ───────────── Deliverables & files ─────────────

interface Deliverable {
  id: string; title: string; description: string; status: string; current_version: number; task_title: string | null; milestone_title: string | null
  approved_by_name: string | null; approved_at: string | null; shared_at: string | null; client_decision_at: string | null; created_by_name: string | null; updated_at: string
  versions: { id: string; version: number; file_name: string; size_bytes: number; client_visible: number; created_at: string; uploaded_by_name: string | null }[]
  clientFeedback: { id: string; kind: string; body: string; author_name: string; created_at: string }[]
}

export function UploadButton({ projectId, taskId, deliverableId, label = 'Upload file', onDone, size = 'sm' }: { projectId: string; taskId?: string; deliverableId?: string; label?: string; onDone?: () => void; size?: 'sm' | 'md' }) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const onFile = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 25 * 1024 * 1024) return toast({ tone: 'error', title: 'Files must be 25 MB or smaller' })
    setBusy(true)
    const fd = new FormData()
    fd.append('file', f)
    const params = new URLSearchParams({ projectId, ...(taskId ? { taskId } : {}), ...(deliverableId ? { deliverableId } : {}) })
    try {
      await api.upload(`/api/files/upload?${params}`, fd)
      toast({ tone: 'ok', title: `Uploaded ${f.name}` })
      onDone?.()
    } catch (e) {
      toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Upload failed' })
    } finally {
      setBusy(false)
      if (ref.current) ref.current.value = ''
    }
  }
  return (
    <>
      <input ref={ref} type="file" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.zip,.docx,.xlsx,.pptx,.txt,.md,.csv,.mp4" />
      <Button size={size} icon={<Upload className="size-3.5" />} loading={busy} onClick={() => ref.current?.click()}>{label}</Button>
    </>
  )
}

export function DeliverablesPanel({ data }: { data: ProjectData }) {
  const pid = data.project.id
  const q = useQuery({ queryKey: ['project', pid, 'deliverables'], queryFn: () => api.get<{ deliverables: Deliverable[] }>(`/api/files/deliverables?projectId=${pid}`).then((r) => r.deliverables) })
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const create = useAction(() => api.post(`/api/files/deliverables?projectId=${pid}`, { title, description }), { success: 'Deliverable created', invalidate: [['project', pid]], onSuccess: () => { setCreating(false); setTitle(''); setDescription('') } })
  const act = useAction((v: { id: string; action: string }) => api.post(`/api/files/deliverables/${v.id}/status`, { action: v.action }), { success: (r: any) => `Deliverable is now ${String(r.status).replace('_', ' ')}`, invalidate: [['project', pid]] })
  return (
    <Section title="Deliverables" description="Approval here is separate from task completion. Only deliverables explicitly shared become visible on the client portal." actions={data.access.canContribute && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>New deliverable</Button>}>
      {q.isLoading ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} /> : q.data!.length === 0 ? <EmptyState title="No deliverables yet" body="Create a deliverable, upload versions, then route it through internal review before sharing with the client." /> : (
        <div className="space-y-3">
          {q.data!.map((d) => (
            <Panel key={d.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{d.title}</span><DeliverableBadge status={d.status} /><span className="font-mono text-[11px] text-muted">v{d.current_version}</span></div>
                  <p className="text-[12.5px] text-muted">{d.description || 'No description'}{d.task_title && ` · Task: ${d.task_title}`}</p>
                  <p className="mt-1 text-[11.5px] text-muted">
                    {d.approved_at && <>Approved by {d.approved_by_name} {relative(d.approved_at)} · </>}
                    {d.shared_at && <>Shared {relative(d.shared_at)} · </>}
                    Updated {relative(d.updated_at)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {data.access.canContribute && <UploadButton projectId={pid} deliverableId={d.id} label={d.current_version ? 'New version' : 'Upload'} onDone={() => q.refetch()} />}
                  {['draft', 'changes_requested'].includes(d.status) && data.access.canContribute && <Button size="sm" icon={<Send className="size-3.5" />} disabled={!d.current_version} onClick={() => act.mutate({ id: d.id, action: 'submit_review' })}>Submit for review</Button>}
                  {d.status === 'in_review' && data.access.canReview && <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => act.mutate({ id: d.id, action: 'approve' })}>Approve</Button>}
                  {['in_review', 'approved', 'shared'].includes(d.status) && data.access.canReview && <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => act.mutate({ id: d.id, action: 'return_draft' })}>Return to draft</Button>}
                  {d.status === 'approved' && data.access.canManage && <Button size="sm" variant="primary" icon={<Share2 className="size-3.5" />} onClick={() => act.mutate({ id: d.id, action: 'share' })}>Share with client</Button>}
                </div>
              </div>
              {d.versions.length > 0 && (
                <ul className="mt-3 divide-y divide-line/70 rounded-md border border-line">
                  {d.versions.map((v) => (
                    <li key={v.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                      <span className="font-mono text-[11px] text-highlight-ink">v{v.version}</span>
                      <span className="min-w-0 flex-1 truncate text-ink">{v.file_name}</span>
                      {v.client_visible ? <Badge tone="highlight"><Eye className="size-3" /> Client can see</Badge> : <span className="inline-flex items-center gap-1 text-[11px] text-faint"><Lock className="size-3" /> Internal</span>}
                      <span className="text-muted">{bytes(v.size_bytes)} · {v.uploaded_by_name} · {relative(v.created_at)}</span>
                      <a href={`/api/files/${v.id}/download`} className="text-accent hover:underline" aria-label={`Download ${v.file_name}`}><Download className="size-3.5" /></a>
                    </li>
                  ))}
                </ul>
              )}
              {d.clientFeedback.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {d.clientFeedback.map((f) => (
                    <div key={f.id} className="rounded-md bg-highlight-soft/50 px-3 py-2 text-[12.5px]"><span className="font-medium">{f.author_name}</span> <span className="text-muted">· {f.kind.replace('_', ' ')} · {relative(f.created_at)}</span><p className="text-ink-2">{f.body}</p></div>
                  ))}
                </div>
              )}
            </Panel>
          ))}
        </div>
      )}
      <Dialog open={creating} onClose={() => setCreating(false)} title="New deliverable" footer={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={!title.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create</Button></>}>
        <div className="space-y-4">
          <Field label="Title" required><Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
          <Field label="Description"><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
      </Dialog>
    </Section>
  )
}

export function FilesPanel({ data }: { data: ProjectData }) {
  const pid = data.project.id
  const q = useQuery({ queryKey: ['project', pid, 'files'], queryFn: () => api.get<{ files: { id: string; file_name: string; content_type: string; size_bytes: number; created_at: string; uploaded_by_name: string | null; task_number: number | null; task_title: string | null; deliverable_title: string | null; version: number; client_visible: number }[]; storageEnabled: boolean }>(`/api/files?projectId=${pid}`) })
  const [del, setDel] = useState<string | null>(null)
  const remove = useAction((id: string) => api.del(`/api/files/${id}`), { success: 'File deleted (retained for 30 days before purge)', invalidate: [['project', pid]], onSuccess: () => setDel(null) })
  return (
    <Section title="Files" description="Private by default. Downloads are authorised per request; nothing is publicly accessible." actions={data.access.canContribute && <UploadButton projectId={pid} onDone={() => q.refetch()} />}>
      {q.isLoading ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} /> : (
        <>
          {!q.data!.storageEnabled && <p className="mb-3 rounded-md border border-highlight/40 bg-highlight-soft/60 px-3 py-2 text-[13px] text-highlight-ink">File storage (Cloudflare R2) is not configured for this deployment, so uploads are disabled.</p>}
          {q.data!.files.length === 0 ? <EmptyState icon={<FileUp className="size-7" strokeWidth={1.4} />} title="No files yet" /> : (
            <Table>
              <thead><tr><Th>File</Th><Th>Linked to</Th><Th>Size</Th><Th>Uploaded</Th><Th /></tr></thead>
              <tbody>{q.data!.files.map((f) => (
                <Tr key={f.id}>
                  <Td><a href={`/api/files/${f.id}/download`} className="font-medium text-ink hover:underline">{f.file_name}</a>{f.client_visible ? <Badge tone="highlight" className="ml-2">Shared</Badge> : null}</Td>
                  <Td className="text-ink-2">{f.deliverable_title ? `Deliverable: ${f.deliverable_title} (v${f.version})` : f.task_title ? `#${f.task_number} ${f.task_title}` : 'Project'}</Td>
                  <Td className="font-mono text-[12px] text-muted">{bytes(f.size_bytes)}</Td>
                  <Td className="text-ink-2">{f.uploaded_by_name} · {relative(f.created_at)}</Td>
                  <Td align="right">{!f.client_visible && <IconButton label="Delete file" onClick={() => setDel(f.id)}><Trash2 className="size-3.5" /></IconButton>}</Td>
                </Tr>
              ))}</tbody>
            </Table>
          )}
        </>
      )}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del)} loading={remove.isPending} danger title="Delete file?" confirmLabel="Delete" body="The file is hidden immediately and permanently purged after the 30-day retention window." />
    </Section>
  )
}

// ───────────── Updates & client feedback ─────────────

export function UpdatesPanel({ data }: { data: ProjectData }) {
  const pid = data.project.id
  const q = useQuery({ queryKey: ['project', pid, 'updates'], queryFn: () => api.get<{ updates: { id: string; title: string; body: string; client_visible: number; created_at: string; created_by_name: string | null; approved_by_name: string | null; approved_at: string | null }[] }>(`/api/projects/${pid}/updates`).then((r) => r.updates) })
  const [v, setV] = useState({ title: '', body: '', clientVisible: false })
  const post = useAction(() => api.post(`/api/projects/${pid}/updates`, v), { success: v.clientVisible ? 'Update published to the client portal' : 'Internal update posted', invalidate: [['project', pid]], onSuccess: () => setV({ title: '', body: '', clientVisible: false }) })
  const toggle = useAction((x: { id: string; visible: boolean }) => api.post(`/api/projects/${pid}/updates/${x.id}/publish?visible=${x.visible ? 1 : 0}`), { success: 'Visibility updated', invalidate: [['project', pid]] })
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Section title="Project updates">
        {q.isLoading ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} /> : q.data!.length === 0 ? <EmptyState title="No updates yet" body="Post progress notes for the team, and publish approved ones to the client." /> : (
          <ol className="space-y-3">
            {q.data!.map((u) => (
              <li key={u.id}>
                <Panel className={cx('p-4', u.client_visible ? 'border-l-2 border-l-highlight' : '')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{u.title}</span>
                    {u.client_visible ? <Badge tone="highlight"><Eye className="size-3" /> Client-visible</Badge> : <Badge tone="outline"><Lock className="size-3" /> Internal</Badge>}
                    <span className="ml-auto text-[12px] text-muted">{u.created_by_name} · {fmtDateTime(u.created_at)}</span>
                  </div>
                  {u.body && <p className="mt-2 whitespace-pre-wrap text-[13px] text-ink-2">{u.body}</p>}
                  {data.access.canManage && <div className="mt-2"><Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: u.id, visible: !u.client_visible })}>{u.client_visible ? 'Withdraw from client' : 'Approve & publish to client'}</Button></div>}
                </Panel>
              </li>
            ))}
          </ol>
        )}
      </Section>
      {data.access.canContribute && (
        <Section title="Post an update">
          <Panel className="space-y-3 p-4">
            <Field label="Title"><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
            <Field label="Details"><Textarea rows={5} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} /></Field>
            {data.access.canManage ? <Checkbox label="Publish to the client portal" description="Only approved, client-appropriate wording." checked={v.clientVisible} onChange={(e) => setV({ ...v, clientVisible: e.target.checked })} /> : <p className="text-[12px] text-muted">Your update stays internal; the project manager decides what the client sees.</p>}
            <Button variant="primary" className="w-full" disabled={!v.title.trim()} loading={post.isPending} onClick={() => post.mutate()}>Post</Button>
          </Panel>
        </Section>
      )}
    </div>
  )
}

export function FeedbackPanel({ data }: { data: ProjectData }) {
  const pid = data.project.id
  const q = useQuery({ queryKey: ['project', pid, 'feedback'], queryFn: () => api.get<{ feedback: { id: string; kind: string; body: string; author_name: string; author_email: string | null; status: string; response: string | null; responded_by_name: string | null; responded_at: string | null; created_at: string; deliverable_title: string | null }[] }>(`/api/projects/${pid}/feedback`).then((r) => r.feedback) })
  const [replying, setReplying] = useState<string | null>(null)
  const [text, setText] = useState('')
  const respond = useAction((v: { id: string; status: 'acknowledged' | 'resolved'; response?: string }) => api.post(`/api/projects/${pid}/feedback/${v.id}/respond`, v), { success: 'Saved — the client can see your reply', invalidate: [['project', pid]], onSuccess: () => { setReplying(null); setText('') } })
  return (
    <Section title="Client feedback" description="Messages and revision requests from the client portal. Replies are visible to the client.">
      {q.isLoading ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} /> : q.data!.length === 0 ? <EmptyState title="No client feedback yet" /> : (
        <ul className="space-y-3">
          {q.data!.map((f) => (
            <li key={f.id}>
              <Panel className="p-4">
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  <Badge tone={f.kind === 'revision_request' ? 'warn' : f.kind === 'approval' ? 'ok' : 'highlight'}>{f.kind.replace('_', ' ')}</Badge>
                  <span className="font-medium text-ink">{f.author_name}</span>{f.author_email && <span>({f.author_email})</span>}
                  <span>· {fmtDateTime(f.created_at)}</span>{f.deliverable_title && <span>· on “{f.deliverable_title}”</span>}
                  <Badge tone={f.status === 'open' ? 'danger' : f.status === 'acknowledged' ? 'highlight' : 'ok'} className="ml-auto">{f.status}</Badge>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[13.5px] text-ink">{f.body}</p>
                {f.response && <div className="mt-3 rounded-md bg-accent-faint px-3 py-2 text-[13px] text-accent-strong"><span className="font-medium">Reply</span> · {f.responded_by_name} {relative(f.responded_at)}<p className="mt-0.5 whitespace-pre-wrap">{f.response}</p></div>}
                {data.access.canManage && f.status !== 'resolved' && (
                  replying === f.id ? (
                    <div className="mt-3 space-y-2">
                      <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply to the client (optional)" />
                      <div className="flex gap-2"><Button size="sm" onClick={() => respond.mutate({ id: f.id, status: 'acknowledged', response: text || undefined })}>Acknowledge</Button><Button size="sm" variant="primary" onClick={() => respond.mutate({ id: f.id, status: 'resolved', response: text || undefined })}>Resolve</Button><Button size="sm" variant="ghost" onClick={() => setReplying(null)}>Cancel</Button></div>
                    </div>
                  ) : <Button size="sm" variant="quiet" className="mt-2" onClick={() => { setReplying(f.id); setText('') }}>Respond</Button>
                )}
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

// ───────────── Team ─────────────

export function TeamPanel({ data }: { data: ProjectData }) {
  const pid = data.project.id
  const people = useMembers()
  const [adding, setAdding] = useState(false)
  const [v, setV] = useState({ userId: '', role: 'member', canReview: false, responsibility: '' })
  const add = useAction(() => api.post(`/api/projects/${pid}/members`, v), { success: 'Team updated', invalidate: [['project', pid]], onSuccess: () => { setAdding(false); setV({ userId: '', role: 'member', canReview: false, responsibility: '' }) } })
  const remove = useAction((uid: string) => api.del(`/api/projects/${pid}/members/${uid}`), { success: 'Removed from project', invalidate: [['project', pid]] })
  const can = data.access.canManage
  const candidates = people.data?.filter((p) => p.status === 'active' && !data.members.some((m) => m.user_id === p.id)) ?? []
  return (
    <Section title="Project team" description="Leads can manage tasks; members with review authority can approve submissions." actions={can && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>Add people</Button>}>
      <Table>
        <thead><tr><Th>Person</Th><Th>Project role</Th><Th>Review authority</Th><Th>Responsibility</Th><Th /></tr></thead>
        <tbody>{data.members.map((m) => (
          <Tr key={m.user_id}>
            <Td><span className="flex items-center gap-2.5"><Avatar name={m.name} color={m.avatar_color} size={26} /><span><span className="block text-ink">{m.name}</span><span className="block text-[12px] text-muted">{m.designation}</span></span></span></Td>
            <Td className="capitalize text-ink-2">{m.role}</Td>
            <Td>{m.can_review || m.role === 'manager' ? <Badge tone="info">Can approve</Badge> : <span className="text-faint">—</span>}</Td>
            <Td className="text-ink-2">{m.responsibility || '—'}</Td>
            <Td align="right">{can && m.role !== 'manager' && <IconButton label={`Remove ${m.name}`} onClick={() => remove.mutate(m.user_id)}><UserMinus className="size-3.5" /></IconButton>}</Td>
          </Tr>
        ))}</tbody>
      </Table>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add to project" footer={<><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!v.userId} loading={add.isPending} onClick={() => add.mutate()}>Add</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Person" className="sm:col-span-2"><Select value={v.userId} onChange={(e) => setV({ ...v, userId: e.target.value })}><option value="">Choose…</option>{candidates.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.designation ?? p.department_name ?? ''}</option>)}</Select></Field>
          <Field label="Role"><Select value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>{PROJECT_MEMBER_ROLES.filter((r) => r !== 'manager').map((r) => <option key={r} value={r}>{r[0]!.toUpperCase() + r.slice(1)}</option>)}</Select></Field>
          <Field label="Responsibility"><Input value={v.responsibility} onChange={(e) => setV({ ...v, responsibility: e.target.value })} placeholder="e.g. Frontend" /></Field>
          <div className="sm:col-span-2"><Checkbox label="Delegate review authority" description="Allows approving submitted work on this project." checked={v.canReview} onChange={(e) => setV({ ...v, canReview: e.target.checked })} /></div>
        </div>
      </Dialog>
    </Section>
  )
}

// ───────────── Activity ─────────────

export function ActivityPanel({ projectId }: { projectId: string }) {
  const q = useQuery({ queryKey: ['project', projectId, 'activity'], queryFn: () => api.get<{ entries: { id: string; summary: string; created_at: string; actor_name: string | null; actor_type: string }[] }>(`/api/projects/${projectId}/activity`).then((r) => r.entries) })
  return (
    <Section title="Activity history">
      {q.isLoading ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} /> : q.data!.length === 0 ? <EmptyState title="No activity yet" /> : (
        <ol className="space-y-0 rounded-lg border border-line bg-surface">
          {q.data!.map((e) => (
            <li key={e.id} className="flex gap-3 border-b border-line/70 px-4 py-2.5 text-[13px] last:border-b-0">
              <span className="w-32 shrink-0 font-mono text-[11px] leading-5 text-muted">{fmtDateTime(e.created_at)}</span>
              <span className="text-ink-2"><span className="font-medium text-ink">{e.actor_type === 'client' ? 'Client' : e.actor_type === 'system' ? '✦ Automation' : e.actor_name ?? 'Someone'}</span> — {e.summary.replace(/^Automation: /, '')}</span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}
