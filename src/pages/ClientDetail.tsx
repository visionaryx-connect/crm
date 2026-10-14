import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Archive, BarChart3, Copy, KeyRound, Mail, Pencil, Phone, Plus, Trash2 } from 'lucide-react'
import type { ClientStatus } from '@shared/constants'
import { api, ApiError } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { fmtDate, fmtDateTime, isoToLocalInput, localInputToIso, relative } from '@/lib/format'
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, IconButton, Input, KeyValue, PageHeader, Panel, SampleTag, Section, Select, SkeletonRows, Table, Tabs, Td, Textarea, Th, Tr } from '@/components/ui'
import { ProgressFigure, ProjectStatusBadge } from '@/components/status'
import { useToast } from '@/components/toast'
import { ClientDialog, ClientStatusBadge } from './Clients'

interface Contact { id: string; name: string; title: string | null; email: string | null; phone: string | null; is_primary: number; notes: string }
interface ClientData {
  client: Record<string, any> & { id: string; name: string; reference: string; status: ClientStatus; is_seed: boolean; archived_at: string | null }
  contacts: Contact[]
  services: { id: string; name: string }[]
  projects: { id: string; reference: string; name: string; status: string; progress: number; target_date: string | null; manager_name: string | null }[]
  interactions: { id: string; kind: string; subject: string; body: string; occurred_at: string; created_by_name: string | null; project_id: string | null }[]
  openFeedback: { id: string; project_id: string; project_name: string; kind: string; body: string; status: string; author_name: string; created_at: string }[]
  pendingClientApprovals: number
  portalLinks: null | { id: string; label: string; project_id: string | null; project_name: string | null; token_hint: string; expires_at: string; revoked_at: string | null; last_used_at: string | null; use_count: number; created_at: string; created_by_name: string | null; contact_name: string | null }[]
  can: { manage: boolean; portal: boolean }
}

type Tab = 'overview' | 'contacts' | 'history' | 'portal'

function ContactDialog({ clientId, contact, open, onClose }: { clientId: string; contact?: Contact | null; open: boolean; onClose: () => void }) {
  const [v, setV] = useState({ name: contact?.name ?? '', title: contact?.title ?? '', email: contact?.email ?? '', phone: contact?.phone ?? '', isPrimary: Boolean(contact?.is_primary), notes: contact?.notes ?? '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useAction(() => (contact ? api.put(`/api/clients/${clientId}/contacts/${contact.id}`, v) : api.post(`/api/clients/${clientId}/contacts`, v)), {
    success: contact ? 'Contact updated' : 'Contact added',
    invalidate: [['client', clientId]],
    onSuccess: onClose,
    onError: (e) => e instanceof ApiError && setErrors(e.fields),
  })
  return (
    <Dialog open={open} onClose={onClose} title={contact ? 'Edit contact' : 'Add contact'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required error={errors.name} className="sm:col-span-2"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus /></Field>
        <Field label="Title" error={errors.title}><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field label="Phone" error={errors.phone}><Input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
        <Field label="Email" error={errors.email} hint="Used to verify portal approvals." className="sm:col-span-2"><Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Checkbox label="Primary contact" checked={v.isPrimary} onChange={(e) => setV({ ...v, isPrimary: e.target.checked })} /></div>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  )
}

function InteractionDialog({ clientId, projects, open, onClose }: { clientId: string; projects: ClientData['projects']; open: boolean; onClose: () => void }) {
  const [v, setV] = useState({ kind: 'meeting', subject: '', body: '', occurredAt: isoToLocalInput(new Date().toISOString()), projectId: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useAction(() => api.post(`/api/clients/${clientId}/interactions`, { ...v, occurredAt: localInputToIso(v.occurredAt), projectId: v.projectId || null }), {
    success: 'Recorded',
    invalidate: [['client', clientId]],
    onSuccess: onClose,
    onError: (e) => e instanceof ApiError && setErrors(e.fields),
  })
  return (
    <Dialog open={open} onClose={onClose} title="Record interaction" description="Meetings, calls, requirements and notes build the relationship history." width={560} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type"><Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>{['meeting', 'call', 'email', 'requirement', 'note'].map((k) => <option key={k} value={k}>{k[0]!.toUpperCase() + k.slice(1)}</option>)}</Select></Field>
        <Field label="When (IST)"><Input type="datetime-local" value={v.occurredAt} onChange={(e) => setV({ ...v, occurredAt: e.target.value })} /></Field>
        <Field label="Subject" required error={errors.subject} className="sm:col-span-2"><Input value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} /></Field>
        <Field label="Project" className="sm:col-span-2"><Select value={v.projectId} onChange={(e) => setV({ ...v, projectId: e.target.value })}><option value="">General</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.reference} · {p.name}</option>)}</Select></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={5} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} /></Field>
      </div>
    </Dialog>
  )
}

function PortalLinkDialog({ data, open, onClose }: { data: ClientData; open: boolean; onClose: () => void }) {
  const [v, setV] = useState({ label: 'Project portal', projectId: '', contactId: '', validDays: 30 })
  const [created, setCreated] = useState<{ link: string; expiresAt: string } | null>(null)
  const toast = useToast()
  const save = useAction(() => api.post<{ link: string; expiresAt: string }>(`/api/clients/${data.client.id}/portal-links`, { ...v, projectId: v.projectId || null, contactId: v.contactId || null }), {
    invalidate: [['client', data.client.id]],
    onSuccess: (r) => setCreated(r),
  })
  const close = () => {
    setCreated(null)
    onClose()
  }
  return (
    <Dialog open={open} onClose={close} title={created ? 'Portal link ready' : 'Create portal link'} width={560} footer={created ? <Button variant="primary" onClick={close}>Done</Button> : <><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Create link</Button></>}>
      {created ? (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-2">Copy this link now and send it to the client through a trusted channel. For security it is shown only once and is stored only as a hash.</p>
          <div className="flex items-center gap-2 rounded-md border border-line bg-ivory p-2">
            <code className="flex-1 break-all font-mono text-[12px]">{created.link}</code>
            <IconButton label="Copy link" onClick={() => { navigator.clipboard.writeText(created.link); toast({ tone: 'ok', title: 'Link copied' }) }}><Copy className="size-4" /></IconButton>
          </div>
          <p className="text-[12px] text-muted">Expires {fmtDateTime(created.expiresAt)}. You can revoke it any time from the Portal access tab.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label" hint="Helps you identify the link later." className="sm:col-span-2"><Input value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} /></Field>
          <Field label="Scope" className="sm:col-span-2" hint="Limit to one project, or allow all of this client’s current projects.">
            <Select value={v.projectId} onChange={(e) => setV({ ...v, projectId: e.target.value })}>
              <option value="">All current projects of {data.client.name}</option>
              {data.projects.filter((p) => p.status !== 'archived').map((p) => <option key={p.id} value={p.id}>{p.reference} · {p.name}</option>)}
            </Select>
          </Field>
          <Field label="Recipient contact" hint="Approvals will require this contact’s email."><Select value={v.contactId} onChange={(e) => setV({ ...v, contactId: e.target.value })}><option value="">Any contact on file</option>{data.contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Valid for (days)"><Input type="number" min={1} max={180} value={v.validDays} onChange={(e) => setV({ ...v, validDays: Number(e.target.value) })} /></Field>
        </div>
      )}
    </Dialog>
  )
}

export default function ClientDetail() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) ?? 'overview'
  const q = useQuery({ queryKey: ['client', id], queryFn: () => api.get<ClientData>(`/api/clients/${id}`) })
  const [editing, setEditing] = useState(false)
  const [contact, setContact] = useState<Contact | null | undefined>(undefined)
  const [interaction, setInteraction] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [revoke, setRevoke] = useState<string | null>(null)
  const [archive, setArchive] = useState(false)
  const delContact = useAction((cid: string) => api.del(`/api/clients/${id}/contacts/${cid}`), { success: 'Contact removed', invalidate: [['client', id]] })
  const revokeLink = useAction((lid: string) => api.post(`/api/clients/${id}/portal-links/${lid}/revoke`), { success: 'Link revoked — active portal sessions were closed', invalidate: [['client', id]], onSuccess: () => setRevoke(null) })
  const archiveAction = useAction(() => api.post(`/api/clients/${id}/archive${q.data?.client.archived_at ? '?restore=1' : ''}`), { success: q.data?.client.archived_at ? 'Client restored' : 'Client archived; portal links revoked', invalidate: [['client', id], ['clients']], onSuccess: () => setArchive(false) })

  if (q.isLoading) return <SkeletonRows rows={10} />
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const d = q.data
  const c = d.client

  return (
    <div>
      <PageHeader
        eyebrow={<Link to="/clients" className="hover:underline">Clients · {c.reference}</Link>}
        title={<span className="inline-flex items-center gap-3">{c.name}{c.is_seed && <SampleTag />}</span>}
        meta={<><ClientStatusBadge status={c.status} />{c.industry && <span>{c.industry}</span>}<span>Account manager: <span className="text-ink">{c.account_manager_name ?? 'Unassigned'}</span></span>{d.pendingClientApprovals > 0 && <Badge tone="gold">{d.pendingClientApprovals} awaiting client approval</Badge>}</>}
        actions={
          <>
            <Link to={`/reports?type=client&scopeId=${c.id}`}><Button icon={<BarChart3 className="size-4" />}>Report</Button></Link>
            {d.can.manage && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>}
            {d.can.manage && <Button variant="ghost" icon={<Archive className="size-4" />} onClick={() => setArchive(true)}>{c.archived_at ? 'Restore' : 'Archive'}</Button>}
          </>
        }
      >
        <div className="mt-5 border-b border-line">
          <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'contacts', label: 'Contacts', count: d.contacts.length },
            { value: 'history', label: 'Relationship history', count: d.interactions.length },
            ...(d.can.portal ? [{ value: 'portal' as Tab, label: 'Portal access', count: d.portalLinks?.filter((l) => !l.revoked_at && Date.parse(l.expires_at) > Date.now()).length }] : []),
          ]} />
        </div>
      </PageHeader>

      {tab === 'overview' && (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            <Section title="Projects" actions={<Link to={`/projects?new=1&clientId=${c.id}`}><Button size="sm" icon={<Plus className="size-3.5" />}>New project</Button></Link>}>
              {d.projects.length === 0 ? <EmptyState title="No projects yet" /> : (
                <Table>
                  <thead><tr><Th>Project</Th><Th>Status</Th><Th>Progress</Th><Th>Target</Th></tr></thead>
                  <tbody>{d.projects.map((p) => (
                    <Tr key={p.id}>
                      <Td><Link to={`/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link><div className="font-mono text-[11.5px] text-muted">{p.reference} · {p.manager_name ?? '—'}</div></Td>
                      <Td><ProjectStatusBadge status={p.status} /></Td>
                      <Td><ProgressFigure value={p.progress} compact /></Td>
                      <Td className="text-ink-2">{fmtDate(p.target_date)}</Td>
                    </Tr>
                  ))}</tbody>
                </Table>
              )}
            </Section>
            <Section title="Pending feedback & revisions">
              {d.openFeedback.length === 0 ? <p className="text-[13px] text-muted">Nothing outstanding.</p> : (
                <ul className="space-y-2">{d.openFeedback.map((f) => (
                  <li key={f.id}><Link to={`/projects/${f.project_id}?tab=feedback`} className="block rounded-md border border-line bg-paper px-3 py-2 hover:border-line-strong">
                    <div className="flex items-center gap-2 text-[12px] text-muted"><Badge tone={f.kind === 'revision_request' ? 'warn' : 'gold'}>{f.kind.replace('_', ' ')}</Badge>{f.project_name} · {f.author_name} · {relative(f.created_at)}</div>
                    <p className="mt-1 text-[13px] text-ink">{f.body}</p>
                  </Link></li>
                ))}</ul>
              )}
            </Section>
          </div>
          <aside className="space-y-6">
            <Panel className="p-4">
              <KeyValue cols={1} items={[
                { label: 'Organisation', value: c.organization },
                { label: 'Email', value: c.email ? <a className="link" href={`mailto:${c.email}`}>{c.email}</a> : null },
                { label: 'Phone', value: c.phone },
                { label: 'Website', value: c.website ? <a className="link" href={c.website} target="_blank" rel="noreferrer noopener">{c.website}</a> : null },
                { label: 'Address', value: c.address },
                { label: 'Services', value: d.services.length ? <div className="flex flex-wrap gap-1">{d.services.map((s) => <Badge key={s.id} tone="forest">{s.name}</Badge>)}</div> : null },
                { label: 'Client since', value: fmtDate(c.created_at) },
              ]} />
            </Panel>
            {c.notes && <Panel className="p-4"><div className="eyebrow mb-2">Internal notes</div><p className="whitespace-pre-wrap text-[13px] text-ink-2">{c.notes}</p></Panel>}
          </aside>
        </div>
      )}

      {tab === 'contacts' && (
        <Section title="Contacts" actions={d.can.manage && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setContact(null)}>Add contact</Button>}>
          {d.contacts.length === 0 ? <EmptyState title="No contacts" body="Add the people you work with at this client." /> : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {d.contacts.map((ct) => (
                <Panel key={ct.id} className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-ink">{ct.name} {ct.is_primary ? <Badge tone="gold" className="ml-1">Primary</Badge> : null}</p>
                      <p className="text-[12.5px] text-muted">{ct.title ?? '—'}</p>
                    </div>
                    {d.can.manage && <div className="flex"><IconButton label="Edit contact" onClick={() => setContact(ct)}><Pencil className="size-3.5" /></IconButton><IconButton label="Remove contact" onClick={() => delContact.mutate(ct.id)}><Trash2 className="size-3.5" /></IconButton></div>}
                  </div>
                  <div className="mt-3 space-y-1 text-[13px]">
                    {ct.email && <a href={`mailto:${ct.email}`} className="flex items-center gap-2 text-ink-2 hover:text-forest"><Mail className="size-3.5" />{ct.email}</a>}
                    {ct.phone && <a href={`tel:${ct.phone}`} className="flex items-center gap-2 text-ink-2 hover:text-forest"><Phone className="size-3.5" />{ct.phone}</a>}
                  </div>
                </Panel>
              ))}
            </div>
          )}
        </Section>
      )}

      {tab === 'history' && (
        <Section title="Relationship history" actions={<Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setInteraction(true)}>Record</Button>}>
          {d.interactions.length === 0 ? <EmptyState title="No history yet" body="Record meetings, calls, requirements and notes." /> : (
            <ol className="relative ml-2 space-y-5 border-l border-line pl-6">
              {d.interactions.map((i) => (
                <li key={i.id} className="relative">
                  <span className="absolute -left-[29px] top-1 size-2.5 rounded-full bg-gold ring-4 ring-ivory" aria-hidden />
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted"><Badge tone="outline">{i.kind}</Badge>{fmtDateTime(i.occurred_at)} · {i.created_by_name}</div>
                  <p className="mt-1 font-medium text-ink">{i.subject}</p>
                  {i.body && <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-2">{i.body}</p>}
                </li>
              ))}
            </ol>
          )}
        </Section>
      )}

      {tab === 'portal' && d.portalLinks && (
        <Section title="Client portal access" description="Passwordless, revocable links scoped to this client. Only approved updates, client-visible milestones and shared deliverables are visible." actions={!c.archived_at && <Button size="sm" variant="primary" icon={<KeyRound className="size-3.5" />} onClick={() => setLinkOpen(true)}>Create link</Button>}>
          {d.portalLinks.length === 0 ? <EmptyState title="No portal links issued" /> : (
            <Table>
              <thead><tr><Th>Label</Th><Th>Scope</Th><Th>Status</Th><Th>Last used</Th><Th>Expires</Th><Th /></tr></thead>
              <tbody>{d.portalLinks.map((l) => {
                const active = !l.revoked_at && Date.parse(l.expires_at) > Date.now()
                return (
                  <Tr key={l.id}>
                    <Td><span className="font-medium">{l.label}</span><div className="font-mono text-[11px] text-muted">…{l.token_hint} · by {l.created_by_name ?? '—'}{l.contact_name ? ` · for ${l.contact_name}` : ''}</div></Td>
                    <Td className="text-ink-2">{l.project_name ?? 'All projects'}</Td>
                    <Td>{l.revoked_at ? <Badge tone="danger">Revoked</Badge> : active ? <Badge tone="ok" dot>Active</Badge> : <Badge>Expired</Badge>}</Td>
                    <Td className="text-ink-2">{l.last_used_at ? `${relative(l.last_used_at)} · ${l.use_count}×` : 'Never'}</Td>
                    <Td className="text-ink-2">{fmtDate(l.expires_at)}</Td>
                    <Td align="right">{active && <Button size="sm" variant="danger" onClick={() => setRevoke(l.id)}>Revoke</Button>}</Td>
                  </Tr>
                )
              })}</tbody>
            </Table>
          )}
        </Section>
      )}

      <ClientDialog open={editing} onClose={() => { setEditing(false); q.refetch() }} clientId={c.id} initial={{ name: c.name, organization: c.organization, industry: c.industry, email: c.email ?? '', phone: c.phone, website: c.website ?? '', address: c.address, status: c.status === 'archived' ? 'inactive' : c.status, accountManagerId: c.account_manager_id, notes: c.notes, serviceCategoryIds: d.services.map((s) => s.id) }} />
      {contact !== undefined && <ContactDialog clientId={c.id} contact={contact} open onClose={() => setContact(undefined)} />}
      {interaction && <InteractionDialog clientId={c.id} projects={d.projects} open onClose={() => setInteraction(false)} />}
      <PortalLinkDialog data={d} open={linkOpen} onClose={() => setLinkOpen(false)} />
      <ConfirmDialog open={!!revoke} onClose={() => setRevoke(null)} onConfirm={() => revoke && revokeLink.mutate(revoke)} loading={revokeLink.isPending} danger title="Revoke portal link?" confirmLabel="Revoke" body="Anyone using this link will lose access immediately, including open portal sessions." />
      <ConfirmDialog open={archive} onClose={() => setArchive(false)} onConfirm={() => archiveAction.mutate()} loading={archiveAction.isPending} danger={!c.archived_at} title={c.archived_at ? 'Restore client?' : 'Archive client?'} confirmLabel={c.archived_at ? 'Restore' : 'Archive'} body={c.archived_at ? 'The client will be listed again as inactive.' : 'Archiving hides the client and revokes all portal links. Active projects must be completed or archived first.'} />
    </div>
  )
}
