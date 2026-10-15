import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Download, LogIn, LogOut, Pencil } from 'lucide-react'
import { ATTENDANCE_STATUSES } from '@shared/constants'
import { api, ApiError, qs } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { useDepartments, useMembers } from '@/lib/lookups'
import { download, fmtTime, fmtWeekday, relative, todayIST, toCsv } from '@/lib/format'
import { Badge, Button, Dialog, EmptyState, Field, Input, PageHeader, Panel, QueryState, Section, Select, Table, Tabs, Td, Textarea, Th, Tr, cx } from '@/components/ui'

interface Cell { date: string; status: string; checkIn: string | null; checkOut: string | null; source: string | null; leaveType: string | null; label: string | null }
interface Sheet { month: string; days: { date: string; working: boolean; kind: string; label?: string }[]; people: { userId: string; name: string; cells: Cell[]; summary: Record<string, number> }[]; canManage: boolean }

const CELL: Record<string, { cls: string; short: string; label: string }> = {
  present: { cls: 'bg-ok/80 text-surface', short: 'P', label: 'Present' },
  remote: { cls: 'bg-accent-hover text-surface', short: 'R', label: 'Remote' },
  half_day: { cls: 'bg-highlight text-surface', short: '½', label: 'Half day' },
  absent: { cls: 'bg-danger text-surface', short: 'A', label: 'Absent' },
  leave: { cls: 'bg-info-bg text-info', short: 'L', label: 'Leave' },
  holiday: { cls: 'bg-track text-accent-strong', short: 'H', label: 'Holiday' },
  weekend: { cls: 'bg-subtle text-faint', short: '·', label: 'Weekly off' },
  no_record: { cls: 'border border-dashed border-line-strong text-faint', short: '?', label: 'No record' },
  upcoming: { cls: 'text-faint', short: '', label: 'Upcoming' },
  not_employed: { cls: 'text-faint', short: '', label: 'Not employed' },
}

function TodayPanel() {
  const q = useQuery({ queryKey: ['attendance', 'today'], queryFn: () => api.get<{ record: { check_in_at: string | null; check_out_at: string | null; status: string } | null; day: { working: boolean; kind: string; label?: string } }>('/api/hr/attendance/today') })
  const checkIn = useAction((remote: boolean) => api.post(`/api/hr/attendance/check-in${remote ? '?remote=1' : ''}`), { success: 'Checked in', invalidate: [['attendance']] })
  const checkOut = useAction(() => api.post('/api/hr/attendance/check-out'), { success: 'Checked out', invalidate: [['attendance']] })
  const r = q.data?.record
  return (
    <Panel className="flex flex-wrap items-center gap-6 p-5">
      <div>
        <div className="eyebrow">Today · {fmtWeekday(todayIST())}</div>
        <p className="mt-1 text-[13.5px] text-ink-2">{q.data && !q.data.day.working ? `Non-working day${q.data.day.label ? ` — ${q.data.day.label}` : ''}` : r?.check_in_at ? <>In at <span className="font-medium text-ink">{fmtTime(r.check_in_at)}</span>{r.check_out_at && <> · out at <span className="font-medium text-ink">{fmtTime(r.check_out_at)}</span></>}{r.status === 'remote' && <Badge tone="accent" className="ml-2">Remote</Badge>}</> : 'Not checked in yet'}</p>
      </div>
      <div className="ml-auto flex gap-2">
        {!r?.check_in_at && <><Button icon={<LogIn className="size-4" />} variant="primary" loading={checkIn.isPending} onClick={() => checkIn.mutate(false)}>Check in</Button><Button onClick={() => checkIn.mutate(true)}>Working remotely</Button></>}
        {r?.check_in_at && !r.check_out_at && <Button icon={<LogOut className="size-4" />} loading={checkOut.isPending} onClick={() => checkOut.mutate()}>Check out</Button>}
      </div>
    </Panel>
  )
}

function CorrectionDialog({ open, onClose, date }: { open: boolean; onClose: () => void; date?: string }) {
  const [v, setV] = useState({ workDate: date ?? todayIST(), requestedCheckIn: '09:30', requestedCheckOut: '18:30', requestedStatus: 'present', reason: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useAction(() => api.post('/api/hr/attendance/corrections', v), { success: 'Correction requested — HR will review it', invalidate: [['attendance']], onSuccess: onClose, onError: (e) => e instanceof ApiError && setErrors(e.fields) })
  return (
    <Dialog open={open} onClose={onClose} title="Request attendance correction" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Submit</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date" error={errors.workDate}><Input type="date" max={todayIST()} value={v.workDate} onChange={(e) => setV({ ...v, workDate: e.target.value })} /></Field>
        <Field label="Status"><Select value={v.requestedStatus} onChange={(e) => setV({ ...v, requestedStatus: e.target.value })}>{ATTENDANCE_STATUSES.map((s) => <option key={s} value={s}>{CELL[s]?.label ?? s}</option>)}</Select></Field>
        <Field label="Check-in (IST)"><Input type="time" value={v.requestedCheckIn} onChange={(e) => setV({ ...v, requestedCheckIn: e.target.value })} /></Field>
        <Field label="Check-out (IST)"><Input type="time" value={v.requestedCheckOut} onChange={(e) => setV({ ...v, requestedCheckOut: e.target.value })} /></Field>
        <Field label="Reason" required error={errors.reason} className="sm:col-span-2"><Textarea rows={3} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
      </div>
    </Dialog>
  )
}

function ManualEdit({ userId, name, date, onClose }: { userId: string; name: string; date: string; onClose: () => void }) {
  const [v, setV] = useState({ status: 'present', checkIn: '09:30', checkOut: '18:30', note: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useAction(() => api.put('/api/hr/attendance', { userId, workDate: date, ...v, checkIn: v.checkIn || null, checkOut: v.checkOut || null }), { success: 'Attendance updated (audited)', invalidate: [['attendance']], onSuccess: onClose, onError: (e) => e instanceof ApiError && setErrors(e.fields) })
  return (
    <Dialog open onClose={onClose} title={`Edit attendance · ${name}`} description={`${fmtWeekday(date)} — historical edits are recorded in the audit log with the before/after values.`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Status"><Select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>{ATTENDANCE_STATUSES.map((s) => <option key={s} value={s}>{CELL[s]?.label}</option>)}</Select></Field>
        <Field label="In"><Input type="time" value={v.checkIn} onChange={(e) => setV({ ...v, checkIn: e.target.value })} /></Field>
        <Field label="Out"><Input type="time" value={v.checkOut} onChange={(e) => setV({ ...v, checkOut: e.target.value })} /></Field>
        <Field label="Reason for edit" required error={errors.note} className="sm:col-span-3"><Input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      </div>
    </Dialog>
  )
}

function Corrections() {
  const q = useQuery({ queryKey: ['attendance', 'corrections'], queryFn: () => api.get<{ corrections: { id: string; user_name: string; work_date: string; requested_status: string; requested_check_in: string | null; requested_check_out: string | null; reason: string; status: string; decided_by_name: string | null; created_at: string }[]; canManage: boolean }>('/api/hr/attendance/corrections') })
  const decide = useAction((v: { id: string; decision: 'approved' | 'rejected' }) => api.post(`/api/hr/attendance/corrections/${v.id}/decide`, { decision: v.decision }), { success: 'Decision recorded', invalidate: [['attendance']] })
  return (
    <QueryState q={q} empty={(d) => (d.corrections.length === 0 ? <EmptyState title="No correction requests" /> : null)}>
      {(d) => (
        <Table>
          <thead><tr><Th>Employee</Th><Th>Date</Th><Th>Requested</Th><Th>Reason</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>{d.corrections.map((c) => (
            <Tr key={c.id}>
              <Td>{c.user_name}<div className="text-[11.5px] text-muted">{relative(c.created_at)}</div></Td>
              <Td>{fmtWeekday(c.work_date)}</Td>
              <Td className="text-ink-2">{CELL[c.requested_status]?.label} {c.requested_check_in && `· ${c.requested_check_in}–${c.requested_check_out ?? '?'}`}</Td>
              <Td className="max-w-[260px] text-[12.5px] text-ink-2">{c.reason}</Td>
              <Td><Badge tone={c.status === 'pending' ? 'highlight' : c.status === 'approved' ? 'ok' : 'danger'}>{c.status}</Badge>{c.decided_by_name && <div className="text-[11px] text-muted">{c.decided_by_name}</div>}</Td>
              <Td align="right" className="whitespace-nowrap">{d.canManage && c.status === 'pending' && <><Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: c.id, decision: 'rejected' })}>Reject</Button><Button size="sm" variant="primary" onClick={() => decide.mutate({ id: c.id, decision: 'approved' })}>Approve</Button></>}</Td>
            </Tr>
          ))}</tbody>
        </Table>
      )}
    </QueryState>
  )
}

export default function Attendance() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'sheet'
  const [month, setMonth] = useState(todayIST().slice(0, 7))
  const [departmentId, setDepartmentId] = useState('')
  const [userId, setUserId] = useState('')
  const [correction, setCorrection] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ userId: string; name: string; date: string } | null>(null)
  const departments = useDepartments()
  const members = useMembers()
  const q = useQuery({ queryKey: ['attendance', 'sheet', month, departmentId, userId], queryFn: () => api.get<Sheet>(`/api/hr/attendance${qs({ month, departmentId, userId })}`) })
  const exportCsv = (s: Sheet) => {
    const cols = [{ key: 'name', label: 'Employee' }, ...['working_days', 'present', 'remote', 'half_day', 'leave', 'absent', 'no_record', 'holiday', 'weekend'].map((k) => ({ key: k, label: k.replace('_', ' ') }))]
    download(`attendance-${s.month}.csv`, toCsv(cols, s.people.map((p) => ({ name: p.name, ...p.summary }))))
  }
  return (
    <div>
      <PageHeader eyebrow="HR" title="Attendance" meta={<span>Weekends and verified holidays are never counted as absences. Days with no record are flagged, not assumed absent.</span>} actions={<Button onClick={() => setCorrection(todayIST())}>Request correction</Button>}>
        <div className="mt-5 border-b border-line"><Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'sheet', label: 'Monthly sheet' }, { value: 'corrections', label: 'Corrections' }]} /></div>
      </PageHeader>
      {tab === 'sheet' ? (
        <>
          <div className="mb-6"><TodayPanel /></div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" aria-label="Month" />
            {q.data?.canManage && (
              <>
                <Select className="w-44" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department"><option value="">All departments</option>{departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
                <Select className="w-44" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person"><option value="">Everyone</option>{members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
              </>
            )}
            {q.data && <Button className="ml-auto" icon={<Download className="size-4" />} onClick={() => exportCsv(q.data!)}>Export CSV</Button>}
          </div>
          <QueryState q={q} empty={(d) => (d.people.length === 0 ? <EmptyState title="No one to show" /> : null)}>
            {(s) => (
              <>
                <div className="overflow-x-auto rounded-lg border border-line bg-surface">
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr>
                        <th className="sticky left-0 z-10 min-w-[160px] border-b border-line bg-canvas px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">Employee</th>
                        {s.days.map((d) => <th key={d.date} className={cx('border-b border-line px-0.5 py-1 text-center font-mono text-[10px] font-normal', d.working ? 'text-muted' : 'bg-subtle/60 text-faint')} title={d.label}>{Number(d.date.slice(8))}<div className="text-[9px]">{'SMTWTFS'[new Date(d.date + 'T00:00:00Z').getUTCDay()]}</div></th>)}
                        <th className="border-b border-line px-2 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">Present</th>
                        <th className="border-b border-line px-2 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">Leave</th>
                        <th className="border-b border-line px-2 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">No rec.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.people.map((p) => (
                        <tr key={p.userId} className="border-b border-line/60 last:border-b-0">
                          <td className="sticky left-0 z-10 bg-surface px-3 py-1.5 text-[12.5px] text-ink">{p.name}<div className="text-[10.5px] text-muted">{p.summary.working_days} working days</div></td>
                          {p.cells.map((c) => {
                            const st = CELL[c.status] ?? CELL.upcoming!
                            const editable = s.canManage && c.date <= todayIST() && !['weekend', 'holiday', 'not_employed', 'upcoming'].includes(c.status)
                            return (
                              <td key={c.date} className="px-[1px] py-1 text-center">
                                <button disabled={!editable} onClick={() => setEdit({ userId: p.userId, name: p.name, date: c.date })} title={`${fmtWeekday(c.date)} · ${st.label}${c.leaveType ? ` (${c.leaveType})` : ''}${c.checkIn ? ` · ${fmtTime(c.checkIn)}–${c.checkOut ? fmtTime(c.checkOut) : '…'}` : ''}${c.source && c.source !== 'self' ? ` · ${c.source}` : ''}${c.label ? ` · ${c.label}` : ''}`} className={cx('mx-auto flex size-[22px] items-center justify-center rounded-[3px] font-mono text-[10px]', st.cls, editable && 'hover:ring-2 hover:ring-highlight')}>
                                  {st.short}
                                </button>
                              </td>
                            )
                          })}
                          <td className="px-2 text-right font-mono">{p.summary.present + p.summary.remote + p.summary.half_day * 0.5}</td>
                          <td className="px-2 text-right font-mono">{p.summary.leave}</td>
                          <td className={cx('px-2 text-right font-mono', p.summary.no_record > 0 && 'text-warn')}>{p.summary.no_record}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-[11.5px] text-muted">{Object.entries(CELL).filter(([k]) => !['upcoming', 'not_employed'].includes(k)).map(([k, v]) => <span key={k} className="inline-flex items-center gap-1.5"><span className={cx('flex size-4 items-center justify-center rounded-[3px] font-mono text-[9px]', v.cls)}>{v.short}</span>{v.label}</span>)}{s.canManage && <span className="inline-flex items-center gap-1"><Pencil className="size-3" />Click a cell to edit (audited)</span>}</div>
              </>
            )}
          </QueryState>
        </>
      ) : (
        <Section title="Correction requests"><Corrections /></Section>
      )}
      {correction && <CorrectionDialog open onClose={() => setCorrection(null)} date={correction} />}
      {edit && <ManualEdit {...edit} onClose={() => setEdit(null)} />}
    </div>
  )
}
