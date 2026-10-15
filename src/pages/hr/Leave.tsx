import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAction } from '@/lib/forms'
import { useLeaveTypes } from '@/lib/lookups'
import { fmtDate, fmtWeekday, relative, todayIST } from '@/lib/format'
import { Badge, Button, Dialog, EmptyState, Field, Input, PageHeader, Panel, QueryState, Section, Select, Table, Tabs, Td, Textarea, Th, Tr, type Tone } from '@/components/ui'

interface LeaveRow { id: string; user_id: string; user_name: string; type_name: string; start_date: string; end_date: string; half_day: string; days: number; reason: string; status: string; decided_by_name: string | null; decided_at: string | null; decision_note: string; created_at: string; department_name: string | null }
const statusTone: Record<string, Tone> = { pending: 'highlight', approved: 'ok', rejected: 'danger', cancelled: 'outline' }

function RequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const types = useLeaveTypes()
  const [v, setV] = useState({ leaveTypeId: 'lt_casual', startDate: todayIST(), endDate: todayIST(), halfDay: 'none', reason: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const preview = useQuery({
    queryKey: ['leave', 'preview', v.startDate, v.endDate, v.halfDay],
    queryFn: () => api.post<{ chargeable: number; days: { date: string; kind: string; working: boolean; label?: string }[] }>('/api/hr/leave/preview', v),
    enabled: open && v.endDate >= v.startDate && (v.halfDay === 'none' || v.startDate === v.endDate),
  })
  const submit = useAction(() => api.post('/api/hr/leave', v), { success: 'Leave requested — your approver has been notified', invalidate: [['leave']], onSuccess: onClose, onError: (e) => e instanceof ApiError && setErrors(e.fields) })
  useEffect(() => { if (open) setErrors({}) }, [open])
  return (
    <Dialog open={open} onClose={onClose} title="Request leave" width={600} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={submit.isPending} disabled={!preview.data?.chargeable} onClick={() => submit.mutate()}>Submit request</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Leave type" error={errors.leaveTypeId} className="sm:col-span-2"><Select value={v.leaveTypeId} onChange={(e) => setV({ ...v, leaveTypeId: e.target.value })}>{types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.annual_quota != null ? ` (${t.annual_quota}/yr)` : ''}</option>)}</Select></Field>
        <Field label="From" error={errors.startDate}><Input type="date" value={v.startDate} onChange={(e) => setV({ ...v, startDate: e.target.value, endDate: e.target.value > v.endDate ? e.target.value : v.endDate })} /></Field>
        <Field label="To" error={errors.endDate}><Input type="date" value={v.endDate} min={v.startDate} onChange={(e) => setV({ ...v, endDate: e.target.value })} /></Field>
        <Field label="Half day" error={errors.halfDay}><Select value={v.halfDay} onChange={(e) => setV({ ...v, halfDay: e.target.value })} disabled={v.startDate !== v.endDate}><option value="none">Full day(s)</option><option value="first_half">First half</option><option value="second_half">Second half</option></Select></Field>
        <div className="flex items-end"><p className="text-[13px] text-ink-2">Chargeable: <span className="font-display font-bold tracking-[-0.02em] text-[20px] text-ink">{preview.data?.chargeable ?? '—'}</span> working day(s)</p></div>
        {preview.data && preview.data.days.some((d) => !d.working) && (
          <div className="sm:col-span-2 rounded-md bg-track/60 px-3 py-2 text-[12.5px] text-accent-strong">
            Not charged: {preview.data.days.filter((d) => !d.working).map((d) => `${fmtWeekday(d.date)}${d.label ? ` (${d.label})` : ''}`).join(', ')}
          </div>
        )}
        <Field label="Reason" className="sm:col-span-2"><Textarea rows={3} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      </div>
    </Dialog>
  )
}

function LeaveTable({ rows, approvals }: { rows: LeaveRow[]; approvals?: boolean }) {
  const [deciding, setDeciding] = useState<{ row: LeaveRow; decision: 'approved' | 'rejected' } | null>(null)
  const [note, setNote] = useState('')
  const decide = useAction(() => api.post(`/api/hr/leave/${deciding!.row.id}/decide`, { decision: deciding!.decision, note }), { success: 'Decision recorded — employee notified', invalidate: [['leave'], ['calendar']], onSuccess: () => { setDeciding(null); setNote('') } })
  const cancel = useAction((id: string) => api.post(`/api/hr/leave/${id}/cancel`), { success: 'Request cancelled', invalidate: [['leave']] })
  return (
    <>
      <Table>
        <thead><tr>{approvals && <Th>Employee</Th>}<Th>Type</Th><Th>Dates</Th><Th align="right">Days</Th><Th>Status</Th><Th>Reason / decision</Th><Th /></tr></thead>
        <tbody>{rows.map((l) => (
          <Tr key={l.id}>
            {approvals && <Td><span className="text-ink">{l.user_name}</span><div className="text-[11.5px] text-muted">{l.department_name ?? ''}</div></Td>}
            <Td className="text-ink">{l.type_name}</Td>
            <Td className="whitespace-nowrap text-ink-2">{fmtDate(l.start_date)}{l.end_date !== l.start_date && <> → {fmtDate(l.end_date)}</>}{l.half_day !== 'none' && <Badge tone="outline" className="ml-1">{l.half_day.replace('_', ' ')}</Badge>}</Td>
            <Td align="right" className="font-mono">{l.days}</Td>
            <Td><Badge tone={statusTone[l.status]}>{l.status}</Badge></Td>
            <Td className="max-w-[280px] text-[12.5px] text-ink-2"><span className="line-clamp-2">{l.reason || '—'}</span>{l.decided_by_name && <span className="block text-muted">{l.decided_by_name} · {relative(l.decided_at)}{l.decision_note && ` — ${l.decision_note}`}</span>}</Td>
            <Td align="right" className="whitespace-nowrap">
              {approvals && l.status === 'pending' && <><Button size="sm" variant="ghost" onClick={() => setDeciding({ row: l, decision: 'rejected' })}>Reject</Button><Button size="sm" variant="primary" onClick={() => setDeciding({ row: l, decision: 'approved' })}>Approve</Button></>}
              {!approvals && ['pending', 'approved'].includes(l.status) && l.start_date > todayIST() && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(l.id)}>Cancel</Button>}
            </Td>
          </Tr>
        ))}</tbody>
      </Table>
      <Dialog open={!!deciding} onClose={() => setDeciding(null)} title={deciding?.decision === 'approved' ? 'Approve leave' : 'Reject leave'} description={deciding ? `${deciding.row.user_name} · ${deciding.row.type_name} · ${deciding.row.days} day(s)` : undefined} footer={<><Button variant="ghost" onClick={() => setDeciding(null)}>Cancel</Button><Button variant={deciding?.decision === 'approved' ? 'primary' : 'danger'} loading={decide.isPending} onClick={() => decide.mutate()}>{deciding?.decision === 'approved' ? 'Approve' : 'Reject'}</Button></>}>
        <Field label="Note to the employee (optional)"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
    </>
  )
}

export default function Leave() {
  const { can, me } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'mine'
  const year = todayIST().slice(0, 4)
  const mine = useQuery({ queryKey: ['leave', 'mine'], queryFn: () => api.get<{ requests: LeaveRow[] }>('/api/hr/leave?scope=mine').then((r) => r.requests) })
  const approvals = useQuery({ queryKey: ['leave', 'approvals'], queryFn: () => api.get<{ requests: LeaveRow[] }>('/api/hr/leave?scope=approvals').then((r) => r.requests.filter((x) => x.user_id !== me.user.id)) })
  const balances = useQuery({ queryKey: ['leave', 'balances', year], queryFn: () => api.get<{ balances: { leave_type_id: string; name: string; code: string; allocated: number | null; adjustment: number; used: number; pending: number; remaining: number | null; is_paid: boolean }[] }>(`/api/hr/leave/balances?year=${year}`).then((r) => r.balances) })
  const pendingCount = approvals.data?.filter((r) => r.status === 'pending').length
  const showApprovals = can('leave.approve') || (approvals.data?.length ?? 0) > 0

  return (
    <div>
      <PageHeader eyebrow="HR" title="Leave" meta={<span>Weekends and verified holidays are never charged.</span>} actions={can('leave.request') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setParams({ new: '1' })}>Request leave</Button>}>
        {showApprovals && <div className="mt-5 border-b border-line"><Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'mine', label: 'My leave' }, { value: 'approvals', label: 'Approvals', count: pendingCount }]} /></div>}
      </PageHeader>
      {tab === 'mine' ? (
        <>
          <Section title={`Balances · ${year}`}>
            <QueryState q={balances}>
              {(rows) => (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {rows.map((b) => (
                    <Panel key={b.leave_type_id} className="p-4">
                      <div className="flex items-baseline justify-between"><span className="text-[12.5px] text-ink-2">{b.name}</span><span className="font-mono text-[10.5px] text-muted">{b.code}</span></div>
                      <div className="mt-2 font-display font-bold tracking-[-0.02em] text-[28px] leading-none tabular">{b.remaining ?? '—'}</div>
                      <div className="mt-1.5 text-[11.5px] text-muted">{b.allocated == null ? 'Not balance-tracked' : `of ${Number(b.allocated) + Number(b.adjustment)} · used ${b.used}${b.pending ? ` · ${b.pending} pending` : ''}`}</div>
                    </Panel>
                  ))}
                </div>
              )}
            </QueryState>
          </Section>
          <Section title="My requests">
            <QueryState q={mine} empty={(d) => (d.length === 0 ? <EmptyState title="No leave requests yet" /> : null)}>{(rows) => <LeaveTable rows={rows} />}</QueryState>
          </Section>
        </>
      ) : (
        <Section title="Requests to decide" description={can('leave.approve') ? 'All employees.' : 'Your direct reports.'}>
          <QueryState q={approvals} empty={(d) => (d.length === 0 ? <EmptyState title="No requests" /> : null)}>{(rows) => <LeaveTable rows={rows} approvals />}</QueryState>
        </Section>
      )}
      <RequestDialog open={params.get('new') === '1'} onClose={() => setParams({})} />
    </div>
  )
}
