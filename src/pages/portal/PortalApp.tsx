import { useEffect, useState } from 'react'
import { Link, Route, Routes, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, FileText, LogOut, Mail, MessageSquarePlus, Phone, ShieldCheck } from 'lucide-react'
import { PROJECT_STATUS_LABEL, type ProjectStatus } from '@shared/constants'
import { ApiError, portalApi, setPortalCsrf } from '@/lib/api'
import { RealtimeProvider } from '@/lib/realtime'
import { bytes, fmtDate, fmtDateTime, relative } from '@/lib/format'
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, Panel, Section, Select, SkeletonRows, Tabs, Textarea, cx } from '@/components/ui'
import { useToast } from '@/components/toast'

interface PortalMe {
  client: { name: string; reference: string }
  projects: { id: string; reference: string; name: string; status: ProjectStatus; progress: number; target_date: string | null; client_status_note: string; manager_name: string | null; manager_email: string | null }[]
  support: { company: string; email: string | null; phone: string | null; website: string }
  csrfToken: string
  expiresAt: string
  verifiedRecently: boolean
}
interface PortalProject {
  project: { id: string; reference: string; name: string; status: ProjectStatus; progress: number; start_date: string | null; target_date: string | null; completed_at: string | null; client_status_note: string; description: string; manager_name: string | null; manager_email: string | null; manager_phone: string | null }
  milestones: { id: string; title: string; description: string; due_date: string | null; status: string; achieved_at: string | null }[]
  updates: { id: string; title: string; body: string; published_at: string }[]
  deliverables: { id: string; title: string; description: string; status: string; shared_at: string; client_decision_at: string | null; files: { id: string; version: number; file_name: string; size_bytes: number }[] }[]
  feedback: { id: string; deliverable_id: string | null; kind: string; body: string; author_name: string; status: string; response: string | null; responded_at: string | null; created_at: string }[]
  timeline: { type: string; at: string; title: string }[]
}

const clientStatus = (s: ProjectStatus) => (s === 'at_risk' || s === 'delayed' ? 'In progress' : PROJECT_STATUS_LABEL[s])

function PortalShell({ me, children }: { me: PortalMe; children: React.ReactNode }) {
  const qc = useQueryClient()
  const logout = async () => {
    await portalApi.post('/api/portal/logout').catch(() => undefined)
    qc.clear()
    window.location.href = '/portal/access'
  }
  return (
    <div className="min-h-dvh bg-ivory">
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 md:px-6">
          <Link to="/portal" className="flex items-center gap-2.5"><span className="flex size-7 items-center justify-center rounded-[5px] bg-forest font-display text-[14px] text-paper">X</span><span className="font-display text-[16px] text-ink">Visionary X</span></Link>
          <span className="hidden text-[12.5px] text-muted sm:inline">· Client portal for {me.client.name}</span>
          <button onClick={logout} className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] text-ink-2 hover:text-ink"><LogOut className="size-3.5" /> Sign out</button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 md:px-6">{children}</main>
      <footer className="mx-auto max-w-5xl px-4 pb-10 text-[12px] text-muted md:px-6">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line pt-4">
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-forest" />Secure session · ends {fmtDateTime(me.expiresAt)}</span>
          {me.support.email && <a href={`mailto:${me.support.email}`} className="hover:text-ink">{me.support.email}</a>}
          {me.support.phone && <span>{me.support.phone}</span>}
          <a href={me.support.website} target="_blank" rel="noreferrer noopener" className="hover:text-ink">{me.support.website.replace(/^https?:\/\//, '')}</a>
        </div>
      </footer>
    </div>
  )
}

function Overview({ me }: { me: PortalMe }) {
  if (me.projects.length === 1) return <ProjectView id={me.projects[0]!.id} me={me} />
  return (
    <div>
      <div className="eyebrow mb-1">{me.client.reference}</div>
      <h1 className="font-display text-[30px] text-ink">Your projects</h1>
      {me.projects.length === 0 ? <div className="mt-6"><EmptyState title="No active projects are shared with this link" /></div> : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {me.projects.map((p) => (
            <Link key={p.id} to={`/portal/projects/${p.id}`}>
              <Panel className="h-full p-5 transition-colors hover:border-line-strong">
                <div className="flex justify-between"><span className="font-mono text-[11px] text-gold-700">{p.reference}</span><Badge tone="forest">{clientStatus(p.status)}</Badge></div>
                <p className="mt-2 font-display text-[19px] text-ink">{p.name}</p>
                <div className="mt-4 flex items-center gap-3"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sage"><div className="h-full rounded-full bg-forest" style={{ width: `${p.progress}%` }} /></div><span className="font-mono text-[12px]">{Math.round(p.progress)}%</span></div>
                <p className="mt-3 text-[12.5px] text-muted">Target delivery {fmtDate(p.target_date)}</p>
              </Panel>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function VerifyDialog({ onClose, onVerified }: { onClose: () => void; onVerified: () => void }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await portalApi.post('/api/portal/verify', { email })
      onVerified()
    } catch (e) {
      setError(e instanceof ApiError ? (e.fields.email ?? e.message) : 'Verification failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title="Confirm it’s you" description="Approvals are recorded against your email. Enter the email address your project manager has on file for you." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Confirm</Button></>}>
      <Field label="Your email" error={error ?? undefined}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
    </Dialog>
  )
}

function ProjectView({ id, me }: { id: string; me: PortalMe }) {
  const q = useQuery({ queryKey: ['project', id, 'portal'], queryFn: () => portalApi.get<PortalProject>(`/api/portal/projects/${id}`) })
  const qc = useQueryClient()
  const toast = useToast()
  const [tab, setTab] = useState<'overview' | 'deliverables' | 'messages' | 'timeline'>('overview')
  const [msg, setMsg] = useState({ kind: 'feedback', authorName: '', body: '', deliverableId: '' })
  const [sending, setSending] = useState(false)
  const [decision, setDecision] = useState<{ id: string; title: string; decision: 'client_approved' | 'changes_requested' } | null>(null)
  const [decisionNote, setDecisionNote] = useState('')
  const [verify, setVerify] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const send = async () => {
    setSending(true)
    setErrors({})
    try {
      await portalApi.post('/api/portal/feedback', { projectId: id, kind: msg.kind, authorName: msg.authorName, body: msg.body, deliverableId: msg.deliverableId || null })
      toast({ tone: 'ok', title: 'Message sent to your project team' })
      setMsg({ ...msg, body: '' })
      qc.invalidateQueries({ queryKey: ['project', id, 'portal'] })
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fields).length) setErrors(e.fields)
      else toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not send' })
    } finally {
      setSending(false)
    }
  }
  const decide = async () => {
    if (!decision) return
    try {
      await portalApi.post(`/api/portal/deliverables/${decision.id}/decision`, { decision: decision.decision, authorName: msg.authorName || 'Client', note: decisionNote })
      toast({ tone: 'ok', title: decision.decision === 'client_approved' ? 'Approved — thank you' : 'Change request sent' })
      setDecision(null)
      setDecisionNote('')
      qc.invalidateQueries({ queryKey: ['project', id, 'portal'] })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REVERIFY_REQUIRED') setVerify(true)
      else toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not record your decision' })
    }
  }

  if (q.isLoading) return <SkeletonRows rows={8} />
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const d = q.data
  const p = d.project
  const awaiting = d.deliverables.filter((x) => x.status === 'shared')
  return (
    <div>
      {me.projects.length > 1 && <Link to="/portal" className="mb-3 inline-block text-[12.5px] text-forest hover:underline">← All projects</Link>}
      <div className="eyebrow mb-1">{p.reference}</div>
      <h1 className="font-display text-[32px] leading-tight text-ink" style={{ fontVariationSettings: '"opsz" 72' }}>{p.name}</h1>
      <div className="mt-6 grid gap-4 md:grid-cols-[1.2fr_1fr]">
        <Panel className="p-5">
          <div className="flex items-baseline justify-between"><span className="eyebrow">Progress</span><Badge tone={p.status === 'completed' ? 'ok' : 'forest'}>{clientStatus(p.status)}</Badge></div>
          <div className="mt-2 font-display text-[48px] leading-none tabular">{Math.round(p.progress)}%</div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-sage"><div className="h-full rounded-full bg-forest" style={{ width: `${p.progress}%` }} /></div>
          {p.client_status_note && <p className="mt-4 rounded bg-ivory px-3 py-2 text-[13.5px] text-ink-2">{p.client_status_note}</p>}
        </Panel>
        <Panel className="p-5 text-[13.5px]">
          <div className="eyebrow mb-3">Delivery</div>
          <dl className="space-y-2">
            <div className="flex justify-between"><dt className="text-muted">Started</dt><dd>{fmtDate(p.start_date)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Target delivery</dt><dd className="font-medium">{fmtDate(p.target_date)}</dd></div>
            {p.completed_at && <div className="flex justify-between"><dt className="text-muted">Delivered</dt><dd>{fmtDate(p.completed_at)}</dd></div>}
          </dl>
          <div className="mt-4 border-t border-line pt-3">
            <div className="eyebrow mb-1.5">Your project manager</div>
            <p className="text-ink">{p.manager_name ?? '—'}</p>
            {p.manager_email && <a href={`mailto:${p.manager_email}`} className="mt-1 flex items-center gap-1.5 text-forest hover:underline"><Mail className="size-3.5" />{p.manager_email}</a>}
            {p.manager_phone && <a href={`tel:${p.manager_phone}`} className="mt-1 flex items-center gap-1.5 text-ink-2"><Phone className="size-3.5" />{p.manager_phone}</a>}
          </div>
        </Panel>
      </div>

      {awaiting.length > 0 && (
        <button onClick={() => setTab('deliverables')} className="mt-4 flex w-full items-center gap-3 rounded-lg border border-gold/40 bg-gold-100/60 px-4 py-3 text-left text-[13.5px] text-gold-700">
          <FileText className="size-4" /><span><span className="font-medium">{awaiting.length} deliverable(s)</span> waiting for your review</span>
        </button>
      )}

      <div className="mt-8 border-b border-line">
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'Milestones & updates' }, { value: 'deliverables', label: 'Deliverables', count: awaiting.length }, { value: 'messages', label: 'Feedback & requests' }, { value: 'timeline', label: 'History' }]} />
      </div>
      <div className="pt-6">
        {tab === 'overview' && (
          <div className="grid gap-8 md:grid-cols-2">
            <Section title="Milestones">
              {d.milestones.length === 0 ? <p className="text-[13px] text-muted">Milestones will appear here.</p> : (
                <ol className="relative ml-1.5 space-y-4 border-l border-line pl-5">
                  {d.milestones.map((m) => (
                    <li key={m.id} className="relative">
                      <span className={cx('absolute -left-[26px] top-1 size-[11px] rotate-45 border-2 border-ivory', m.status === 'achieved' ? 'bg-ok' : m.status === 'in_progress' ? 'bg-forest' : 'bg-gold')} />
                      <p className="font-medium text-ink">{m.title}</p>
                      <p className="text-[12.5px] text-muted">{m.status === 'achieved' ? <span className="text-ok">Achieved {fmtDate(m.achieved_at)}</span> : `Planned ${fmtDate(m.due_date)}`}</p>
                      {m.description && <p className="mt-0.5 text-[13px] text-ink-2">{m.description}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </Section>
            <Section title="Updates from the team">
              {d.updates.length === 0 ? <p className="text-[13px] text-muted">No updates yet.</p> : (
                <ul className="space-y-3">{d.updates.map((u) => <li key={u.id}><Panel className="p-4"><div className="flex justify-between gap-2"><p className="font-medium text-ink">{u.title}</p><span className="shrink-0 text-[12px] text-muted">{fmtDate(u.published_at)}</span></div>{u.body && <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] text-ink-2">{u.body}</p>}</Panel></li>)}</ul>
              )}
            </Section>
          </div>
        )}
        {tab === 'deliverables' && (
          d.deliverables.length === 0 ? <EmptyState title="Nothing shared yet" body="Deliverables appear here once your project team shares them for review." /> : (
            <ul className="space-y-3">{d.deliverables.map((x) => (
              <li key={x.id}>
                <Panel className="p-5">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-display text-[18px] text-ink">{x.title}</p>
                      {x.description && <p className="text-[13px] text-ink-2">{x.description}</p>}
                      <p className="mt-1 text-[12px] text-muted">Shared {fmtDate(x.shared_at)}{x.client_decision_at && ` · decided ${fmtDate(x.client_decision_at)}`}</p>
                    </div>
                    {x.status === 'shared' ? <Badge tone="gold">Awaiting your review</Badge> : x.status === 'client_approved' ? <Badge tone="ok"><CheckCircle2 className="size-3" /> Approved</Badge> : <Badge tone="warn">Changes requested</Badge>}
                  </div>
                  <ul className="mt-3 divide-y divide-line/70 rounded-md border border-line">{x.files.map((f) => (
                    <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-[13px]"><span className="font-mono text-[11px] text-gold-700">v{f.version}</span><span className="min-w-0 flex-1 truncate">{f.file_name}</span><span className="text-[12px] text-muted">{bytes(f.size_bytes)}</span><a href={`/api/portal/files/${f.id}`} className="inline-flex items-center gap-1 text-forest hover:underline"><Download className="size-3.5" />Download</a></li>
                  ))}</ul>
                  {x.status === 'shared' && <div className="mt-4 flex flex-wrap justify-end gap-2"><Button onClick={() => setDecision({ id: x.id, title: x.title, decision: 'changes_requested' })}>Request changes</Button><Button variant="primary" onClick={() => setDecision({ id: x.id, title: x.title, decision: 'client_approved' })}>Approve</Button></div>}
                </Panel>
              </li>
            ))}</ul>
          )
        )}
        {tab === 'messages' && (
          <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_340px]">
            <Section title="Your messages">
              {d.feedback.length === 0 ? <p className="text-[13px] text-muted">No messages yet.</p> : (
                <ul className="space-y-3">{d.feedback.map((f) => (
                  <li key={f.id}><Panel className="p-4">
                    <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted"><Badge tone="outline">{f.kind.replace('_', ' ')}</Badge>{f.author_name} · {relative(f.created_at)}<Badge tone={f.status === 'resolved' ? 'ok' : f.status === 'acknowledged' ? 'gold' : 'neutral'} className="ml-auto">{f.status === 'open' ? 'Received' : f.status}</Badge></div>
                    <p className="mt-2 whitespace-pre-wrap text-[13.5px] text-ink">{f.body}</p>
                    {f.response && <div className="mt-3 rounded-md bg-forest-50 px-3 py-2 text-[13px] text-forest-700"><span className="font-medium">Visionary X</span> · {relative(f.responded_at)}<p className="mt-0.5 whitespace-pre-wrap">{f.response}</p></div>}
                  </Panel></li>
                ))}</ul>
              )}
            </Section>
            <Section title="Send feedback">
              <Panel className="space-y-3 p-4">
                <Field label="Your name" error={errors.authorName}><Input value={msg.authorName} onChange={(e) => setMsg({ ...msg, authorName: e.target.value })} autoComplete="name" /></Field>
                <Field label="Type"><Select value={msg.kind} onChange={(e) => setMsg({ ...msg, kind: e.target.value })}><option value="feedback">General feedback</option><option value="revision_request">Revision request</option><option value="question">Question</option></Select></Field>
                {d.deliverables.length > 0 && <Field label="About"><Select value={msg.deliverableId} onChange={(e) => setMsg({ ...msg, deliverableId: e.target.value })}><option value="">The project in general</option>{d.deliverables.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</Select></Field>}
                <Field label="Message" error={errors.body}><Textarea rows={5} value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} /></Field>
                <Button variant="primary" className="w-full" icon={<MessageSquarePlus className="size-4" />} loading={sending} disabled={!msg.body.trim() || !msg.authorName.trim()} onClick={send}>Send to project team</Button>
              </Panel>
            </Section>
          </div>
        )}
        {tab === 'timeline' && (
          d.timeline.length === 0 ? <p className="text-[13px] text-muted">No history yet.</p> : (
            <ol className="relative ml-2 space-y-4 border-l border-line pl-6">{d.timeline.map((t, i) => (
              <li key={i} className="relative"><span className={cx('absolute -left-[29px] top-1.5 size-2.5 rounded-full ring-4 ring-ivory', t.type === 'milestone' ? 'bg-ok' : t.type === 'deliverable' ? 'bg-gold' : t.type === 'feedback' ? 'bg-info' : 'bg-forest')} /><p className="text-[13.5px] text-ink">{t.title}</p><p className="text-[12px] text-muted">{fmtDateTime(t.at)}</p></li>
            ))}</ol>
          )
        )}
      </div>
      {decision && (
        <Dialog open onClose={() => setDecision(null)} title={decision.decision === 'client_approved' ? `Approve “${decision.title}”` : `Request changes to “${decision.title}”`} footer={<><Button variant="ghost" onClick={() => setDecision(null)}>Cancel</Button><Button variant="primary" disabled={decision.decision === 'changes_requested' && !decisionNote.trim()} onClick={decide}>{decision.decision === 'client_approved' ? 'Approve' : 'Send request'}</Button></>}>
          <div className="space-y-3">
            <Field label="Your name"><Input value={msg.authorName} onChange={(e) => setMsg({ ...msg, authorName: e.target.value })} /></Field>
            <Field label={decision.decision === 'client_approved' ? 'Comments (optional)' : 'What should change?'}><Textarea rows={4} value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} /></Field>
          </div>
        </Dialog>
      )}
      {verify && <VerifyDialog onClose={() => setVerify(false)} onVerified={() => { setVerify(false); decide() }} />}
    </div>
  )
}

function ProjectRoute({ me }: { me: PortalMe }) {
  const { id = '' } = useParams()
  return <ProjectView id={id} me={me} />
}

export default function PortalApp() {
  const q = useQuery({
    queryKey: ['portal', 'me'],
    queryFn: async () => {
      const me = await portalApi.get<PortalMe>('/api/portal/me')
      setPortalCsrf(me.csrfToken)
      return me
    },
    retry: false,
  })
  useEffect(() => {
    document.title = q.data ? `${q.data.client.name} · Visionary X` : 'Visionary X · Client portal'
  }, [q.data])
  if (q.isLoading) return <div className="flex min-h-dvh items-center justify-center bg-ivory"><SkeletonRows rows={3} /></div>
  if (q.error || !q.data) {
    const expired = q.error instanceof ApiError && q.error.status === 401
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ivory px-5">
        <div className="max-w-md text-center">
          <span className="mx-auto mb-6 flex size-10 items-center justify-center rounded-[6px] bg-forest font-display text-lg text-paper">X</span>
          <h1 className="font-display text-[26px] text-ink">{expired ? 'Your portal session has ended' : 'Something went wrong'}</h1>
          <p className="mt-3 text-[14px] text-ink-2">{expired ? 'For your security, portal sessions are short-lived. Open the secure link from your Visionary X project manager again to continue.' : 'Please try again in a moment.'}</p>
        </div>
      </div>
    )
  }
  return (
    <RealtimeProvider path="/ws/portal" subscribe={[]}>
      <PortalShell me={q.data}>
        <Routes>
          <Route index element={<Overview me={q.data} />} />
          <Route path="projects/:id" element={<ProjectRoute me={q.data} />} />
          <Route path="*" element={<Overview me={q.data} />} />
        </Routes>
      </PortalShell>
    </RealtimeProvider>
  )
}
