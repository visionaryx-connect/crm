import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { z } from 'zod'
import { Plus, Search } from 'lucide-react'
import { clientSchema } from '@shared/schemas'
import { CLIENT_STATUSES, CLIENT_STATUS_LABEL, type ClientStatus } from '@shared/constants'
import { api, ApiError, qs } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { applyServerErrors } from '@/lib/forms'
import { useMembers, useServiceCategories } from '@/lib/lookups'
import { fmtDateShort } from '@/lib/format'
import { Badge, Button, Checkbox, Dialog, EmptyState, Field, Input, PageHeader, QueryState, SampleTag, Select, Table, Td, Textarea, Th, Tr, type Tone } from '@/components/ui'
import { useToast } from '@/components/toast'

type ClientRow = {
  id: string; reference: string; name: string; organization: string | null; industry: string | null; email: string | null; status: ClientStatus; is_seed: boolean
  account_manager_name: string | null; active_projects: number; total_projects: number; open_feedback: number; next_deadline: string | null
}

const statusTone: Record<ClientStatus, Tone> = { lead: 'info', active: 'forest', on_hold: 'gold', inactive: 'neutral', archived: 'outline' }
export const ClientStatusBadge = ({ status }: { status: ClientStatus }) => <Badge tone={statusTone[status]}>{CLIENT_STATUS_LABEL[status]}</Badge>

type ClientForm = z.input<typeof clientSchema>

export function ClientDialog({ open, onClose, initial, clientId }: { open: boolean; onClose: () => void; initial?: Partial<ClientForm>; clientId?: string }) {
  const members = useMembers(open)
  const services = useServiceCategories()
  const toast = useToast()
  const nav = useNavigate()
  const [dup, setDup] = useState<string | null>(null)
  const form = useForm<ClientForm, unknown, z.output<typeof clientSchema>>({ resolver: zodResolver(clientSchema), defaultValues: { status: 'active', notes: '', serviceCategoryIds: [], ...initial } })
  useEffect(() => {
    if (open) {
      form.reset({ status: 'active', notes: '', serviceCategoryIds: [], ...initial })
      setDup(null)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (force: boolean) =>
    form.handleSubmit(async (values) => {
      try {
        if (clientId) {
          await api.put(`/api/clients/${clientId}`, values)
          toast({ tone: 'ok', title: 'Client updated' })
        } else {
          const r = await api.post<{ id: string; reference: string }>(`/api/clients${force ? '?force=1' : ''}`, values)
          toast({ tone: 'ok', title: `Client ${r.reference} created` })
          nav(`/clients/${r.id}`)
        }
        onClose()
      } catch (e) {
        if (e instanceof ApiError && e.code === 'DUPLICATE_CLIENT') setDup(e.message)
        else if (!applyServerErrors(e, form.setError)) toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Save failed' })
      }
    })()
  const err = form.formState.errors
  const selected = form.watch('serviceCategoryIds') ?? []
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={clientId ? 'Edit client' : 'New client'}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {dup && <Button onClick={() => submit(true)}>Create anyway</Button>}
          <Button variant="primary" loading={form.formState.isSubmitting} onClick={() => submit(false)}>{clientId ? 'Save changes' : 'Create client'}</Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit(false) }}>
        {dup && <div className="sm:col-span-2 rounded-md border border-gold/40 bg-gold-100/60 px-3 py-2 text-[13px] text-gold-700" role="alert">{dup} Check before creating a duplicate.</div>}
        <Field label="Client name" required error={err.name?.message} className="sm:col-span-2"><Input autoFocus {...form.register('name')} aria-invalid={!!err.name} /></Field>
        <Field label="Organisation (legal name)" error={err.organization?.message}><Input {...form.register('organization')} /></Field>
        <Field label="Industry" error={err.industry?.message}><Input {...form.register('industry')} /></Field>
        <Field label="Email" error={err.email?.message}><Input type="email" {...form.register('email')} aria-invalid={!!err.email} /></Field>
        <Field label="Phone" error={err.phone?.message}><Input {...form.register('phone')} placeholder="+91 …" /></Field>
        <Field label="Website" error={err.website?.message}><Input {...form.register('website')} placeholder="https://" /></Field>
        <Field label="Status"><Select {...form.register('status')}>{CLIENT_STATUSES.filter((s) => s !== 'archived').map((s) => <option key={s} value={s}>{CLIENT_STATUS_LABEL[s]}</option>)}</Select></Field>
        <Field label="Account manager" className="sm:col-span-2">
          <Select {...form.register('accountManagerId', { setValueAs: (v) => v || null })}>
            <option value="">Unassigned</option>
            {members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="Services" className="sm:col-span-2">
          <div className="grid grid-cols-2 gap-2 rounded-md border border-line p-3 sm:grid-cols-3">
            {services.data?.map((s) => (
              <Checkbox key={s.id} label={s.name} checked={selected.includes(s.id)} onChange={(e) => form.setValue('serviceCategoryIds', e.target.checked ? [...selected, s.id] : selected.filter((x) => x !== s.id))} />
            ))}
          </div>
        </Field>
        <Field label="Address" className="sm:col-span-2"><Textarea rows={2} {...form.register('address')} /></Field>
        <Field label="Notes" className="sm:col-span-2" hint="Internal only — never shown to the client."><Textarea rows={3} {...form.register('notes')} /></Field>
      </form>
    </Dialog>
  )
}

export default function Clients() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const status = params.get('status') ?? ''
  const list = useQuery({ queryKey: ['clients', { q, status }], queryFn: () => api.get<{ clients: ClientRow[] }>(`/api/clients${qs({ q, status })}`).then((r) => r.clients) })
  const nav = useNavigate()
  const creating = params.get('new') === '1'

  return (
    <div>
      <PageHeader
        eyebrow="CRM"
        title="Clients"
        meta={list.data && <span>{list.data.length} {status === 'archived' ? 'archived' : 'current'} clients</span>}
        actions={can('clients.manage') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: '1' })}>New client</Button>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, reference" className="pl-8" aria-label="Search clients" />
        </div>
        <Select value={status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})} className="w-40" aria-label="Filter by status">
          <option value="">All current</option>
          {CLIENT_STATUSES.map((s) => <option key={s} value={s}>{CLIENT_STATUS_LABEL[s]}</option>)}
        </Select>
      </div>
      <QueryState q={list} empty={(d) => (d.length === 0 ? <EmptyState title={q ? 'No clients match your search' : 'No clients yet'} body={can('clients.manage') ? 'Add your first client to start tracking projects and communication.' : 'Clients you manage will appear here.'} action={can('clients.manage') && !q ? <Button variant="primary" onClick={() => setParams({ new: '1' })}>Add client</Button> : undefined} /> : null)}>
        {(rows) => (
          <Table>
            <thead>
              <tr><Th>Client</Th><Th>Status</Th><Th>Account manager</Th><Th align="right">Active projects</Th><Th align="right">Open feedback</Th><Th>Next deadline</Th></tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <Tr key={c.id} onClick={() => nav(`/clients/${c.id}`)}>
                  <Td>
                    <Link to={`/clients/${c.id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>{c.name}</Link>
                    <div className="flex items-center gap-2 text-[12px] text-muted"><span className="font-mono">{c.reference}</span>{c.industry && <span>· {c.industry}</span>}{c.is_seed && <SampleTag />}</div>
                  </Td>
                  <Td><ClientStatusBadge status={c.status} /></Td>
                  <Td className="text-ink-2">{c.account_manager_name ?? <span className="text-faint">Unassigned</span>}</Td>
                  <Td align="right" className="font-mono tabular">{c.active_projects}<span className="text-faint"> / {c.total_projects}</span></Td>
                  <Td align="right">{c.open_feedback > 0 ? <Badge tone="gold">{c.open_feedback}</Badge> : <span className="text-faint">0</span>}</Td>
                  <Td className="text-ink-2">{fmtDateShort(c.next_deadline)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
      <ClientDialog open={creating} onClose={() => setParams({})} />
    </div>
  )
}
