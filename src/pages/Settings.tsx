import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Check, Download, FileUp, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { HOLIDAY_KINDS } from '@shared/constants'
import { api, ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAction } from '@/lib/forms'
import { useLeaveTypes } from '@/lib/lookups'
import { fmtDate, fmtWeekday, relative, todayIST } from '@/lib/format'
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Panel, QueryState, Section, Select, Table, Tabs, Td, Th, Tr } from '@/components/ui'
import { useToast } from '@/components/toast'

type Tab = 'company' | 'workdays' | 'holidays' | 'leave' | 'portal'
type Settings = {
  'company.profile': { name: string; website: string; supportEmail: string; supportPhone: string; address: string }
  'workdays.weekly': { weekdays: number[]; saturday: { mode: 'all_working' | 'all_off' | 'nth_off'; offWeeks?: number[] } }
  'workdays.hours': { dayStart: string; dayEnd: string; halfDayHours: number }
  'holidays.regions': { regions: string[] }
  'portal.defaults': { linkValidityDays: number; sessionHours: number; reverifyMinutes: number }
  'reports.schedule': { monthlySnapshots: boolean }
}

function useSettings(enabled: boolean) {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ settings: Settings }>('/api/admin/settings').then((r) => r.settings), enabled })
}
function useSaveSetting<K extends keyof Settings>(key: K) {
  return useAction((value: Settings[K]) => api.put(`/api/admin/settings/${key}`, value), { success: 'Settings saved', invalidate: [['settings'], ['calendar']] })
}

function CompanyTab({ s }: { s: Settings }) {
  const [v, setV] = useState(s['company.profile'])
  const save = useSaveSetting('company.profile')
  return (
    <Panel className="max-w-2xl p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Website"><Input value={v.website} onChange={(e) => setV({ ...v, website: e.target.value })} /></Field>
        <Field label="Client support email" hint="Shown on the client portal."><Input type="email" value={v.supportEmail} onChange={(e) => setV({ ...v, supportEmail: e.target.value })} /></Field>
        <Field label="Client support phone"><Input value={v.supportPhone} onChange={(e) => setV({ ...v, supportPhone: e.target.value })} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} /></Field>
      </div>
      <div className="mt-5 flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(v)}>Save</Button></div>
    </Panel>
  )
}

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
function WorkdaysTab({ s }: { s: Settings }) {
  const [w, setW] = useState(s['workdays.weekly'])
  const [h, setH] = useState(s['workdays.hours'])
  const [r, setR] = useState(s['holidays.regions'])
  const saveW = useSaveSetting('workdays.weekly')
  const saveH = useSaveSetting('workdays.hours')
  const saveR = useSaveSetting('holidays.regions')
  return (
    <div className="grid max-w-4xl gap-6 lg:grid-cols-2">
      <Panel className="p-5">
        <h3 className="font-medium text-ink">Working week</h3>
        <p className="mb-4 text-[12.5px] text-muted">Used for leave calculation, attendance and delivery health. Changes apply going forward.</p>
        <div className="grid grid-cols-2 gap-2">{WD.map((d, i) => <Checkbox key={d} label={d} checked={w.weekdays.includes(i)} onChange={(e) => setW({ ...w, weekdays: e.target.checked ? [...w.weekdays, i].sort() : w.weekdays.filter((x) => x !== i) })} />)}</div>
        <Field label="Saturdays" className="mt-4">
          <Select value={w.saturday.mode} onChange={(e) => setW({ ...w, saturday: { ...w.saturday, mode: e.target.value as Settings['workdays.weekly']['saturday']['mode'] } })}>
            <option value="all_working">Every Saturday is a working day</option>
            <option value="all_off">Every Saturday is off</option>
            <option value="nth_off">Alternate — specific Saturdays off</option>
          </Select>
        </Field>
        {w.saturday.mode === 'nth_off' && (
          <div className="mt-3 flex flex-wrap gap-3">{[1, 2, 3, 4, 5].map((n) => <Checkbox key={n} label={`${n}${['st', 'nd', 'rd', 'th', 'th'][n - 1]} off`} checked={(w.saturday.offWeeks ?? []).includes(n)} onChange={(e) => setW({ ...w, saturday: { ...w.saturday, offWeeks: e.target.checked ? [...(w.saturday.offWeeks ?? []), n].sort() : (w.saturday.offWeeks ?? []).filter((x) => x !== n) } })} />)}</div>
        )}
        <div className="mt-5 flex justify-end"><Button variant="primary" loading={saveW.isPending} onClick={() => saveW.mutate(w)}>Save working week</Button></div>
      </Panel>
      <div className="space-y-6">
        <Panel className="p-5">
          <h3 className="mb-4 font-medium text-ink">Office hours (IST)</h3>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Start"><Input type="time" value={h.dayStart} onChange={(e) => setH({ ...h, dayStart: e.target.value })} /></Field>
            <Field label="End"><Input type="time" value={h.dayEnd} onChange={(e) => setH({ ...h, dayEnd: e.target.value })} /></Field>
            <Field label="Half day (h)" hint="Below this = half day"><Input type="number" min={1} max={12} value={h.halfDayHours} onChange={(e) => setH({ ...h, halfDayHours: Number(e.target.value) })} /></Field>
          </div>
          <div className="mt-4 flex justify-end"><Button variant="primary" loading={saveH.isPending} onClick={() => saveH.mutate(h)}>Save hours</Button></div>
        </Panel>
        <Panel className="p-5">
          <h3 className="font-medium text-ink">Holiday calendars applied</h3>
          <p className="mb-3 text-[12.5px] text-muted">Only verified holidays from these regions count as days off.</p>
          <div className="space-y-2">{[['IN', 'National (India)'], ['IN-TN', 'Tamil Nadu'], ['COMPANY', 'Company holidays & closures']].map(([k, l]) => <Checkbox key={k} label={l} checked={r.regions.includes(k!)} onChange={(e) => setR({ regions: e.target.checked ? [...r.regions, k!] : r.regions.filter((x) => x !== k) })} />)}</div>
          <div className="mt-4 flex justify-end"><Button variant="primary" loading={saveR.isPending} disabled={r.regions.length === 0} onClick={() => saveR.mutate(r)}>Save</Button></div>
        </Panel>
      </div>
    </div>
  )
}

interface Holiday { id: string; holiday_date: string; name: string; kind: string; region: string; is_day_off: number; source: string; source_url: string | null; status: string; verified_by_name: string | null; verified_at: string | null }

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (ch === '"') q = false
      else field += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { cur.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      cur.push(field); field = ''
      if (cur.some((c) => c.trim())) rows.push(cur)
      cur = []
    } else field += ch
  }
  cur.push(field)
  if (cur.some((c) => c.trim())) rows.push(cur)
  const [head, ...body] = rows
  if (!head) return []
  const keys = head.map((h) => h.trim().toLowerCase())
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])))
}

function HolidayDialog({ edit, onClose }: { edit: Holiday | null; onClose: () => void }) {
  const [v, setV] = useState({ date: edit?.holiday_date ?? todayIST(), name: edit?.name ?? '', kind: edit?.kind ?? 'company', region: edit?.region ?? 'COMPANY', isDayOff: edit ? Boolean(edit.is_day_off) : true, source: edit?.source ?? '', sourceUrl: edit?.source_url ?? '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useAction(() => (edit ? api.put(`/api/calendar/holidays/${edit.id}`, v) : api.post('/api/calendar/holidays', v)), { success: 'Saved — pending verification', invalidate: [['holidays'], ['calendar']], onSuccess: onClose, onError: (e) => e instanceof ApiError && setErrors(e.fields) })
  return (
    <Dialog open onClose={onClose} title={edit ? 'Correct holiday' : 'Add holiday'} description="Every change returns the record to “pending verification”." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date" error={errors.date}><Input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label="Name" error={errors.name}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="Kind"><Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>{HOLIDAY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
        <Field label="Region"><Select value={v.region} onChange={(e) => setV({ ...v, region: e.target.value })}><option value="IN">India (national)</option><option value="IN-TN">Tamil Nadu</option><option value="COMPANY">Company</option></Select></Field>
        <Field label="Official source" hint="e.g. G.O. number and date — required to verify." className="sm:col-span-2" error={errors.source}><Input value={v.source} onChange={(e) => setV({ ...v, source: e.target.value })} /></Field>
        <Field label="Source URL" className="sm:col-span-2" error={errors.sourceUrl}><Input value={v.sourceUrl} onChange={(e) => setV({ ...v, sourceUrl: e.target.value })} placeholder="https://" /></Field>
        <div className="sm:col-span-2"><Checkbox label="Day off for the company" description="Untick for restricted/optional holidays that are not office closures." checked={v.isDayOff} onChange={(e) => setV({ ...v, isDayOff: e.target.checked })} /></div>
      </div>
    </Dialog>
  )
}

function HolidaysTab() {
  const [year, setYear] = useState(Number(todayIST().slice(0, 4)))
  const q = useQuery({ queryKey: ['holidays', year], queryFn: () => api.get<{ holidays: Holiday[]; overrides: { override_date: string; is_working: number; reason: string; created_by_name: string | null }[]; canManage: boolean }>(`/api/calendar/holidays?year=${year}`) })
  const [edit, setEdit] = useState<Holiday | null | undefined>(undefined)
  const [del, setDel] = useState<Holiday | null>(null)
  const [ov, setOv] = useState({ date: todayIST(), isWorking: true, reason: '' })
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const verify = useAction((x: { id: string; status: 'verified' | 'rejected' }) => api.post(`/api/calendar/holidays/${x.id}/verify`, { status: x.status }), { success: 'Recorded', invalidate: [['holidays'], ['calendar'], ['dashboard']] })
  const remove = useAction((id: string) => api.del(`/api/calendar/holidays/${id}`), { success: 'Deleted', invalidate: [['holidays'], ['calendar']], onSuccess: () => setDel(null) })
  const addOv = useAction(() => api.post('/api/calendar/overrides', ov), { success: 'Override saved', invalidate: [['holidays'], ['calendar']], onSuccess: () => setOv({ ...ov, reason: '' }) })
  const delOv = useAction((d: string) => api.del(`/api/calendar/overrides/${d}`), { success: 'Override removed', invalidate: [['holidays'], ['calendar']] })
  const importFile = async (f?: File) => {
    if (!f) return
    try {
      const text = await f.text()
      const raw = f.name.endsWith('.json') ? (JSON.parse(text) as Record<string, string>[]) : parseCsv(text)
      const holidays = raw.map((r) => ({ date: r.date, name: r.name, kind: r.kind || 'state', region: r.region || 'IN-TN', isDayOff: !['0', 'false', 'no'].includes(String(r.is_day_off ?? '1').toLowerCase()), source: r.source ?? '', sourceUrl: r.source_url || null }))
      const r = await api.post<{ count: number }>('/api/calendar/holidays/import', { holidays })
      toast({ tone: 'ok', title: `Imported ${r.count} holiday(s)`, body: 'Verify each against the official notification before it takes effect.' })
      q.refetch()
    } catch (e) {
      toast({ tone: 'error', title: 'Import failed', body: e instanceof ApiError ? Object.entries(e.fields).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join('; ') || e.message : 'Use CSV columns: date,name,kind,region,is_day_off,source,source_url' })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  return (
    <div>
      <div className="mb-4 rounded-lg border border-gold/30 bg-gold-100/40 px-4 py-3 text-[13px] text-ink-2">
        <p className="flex items-center gap-2 font-medium text-gold-700"><ShieldCheck className="size-4" />Source of truth: official government notifications</p>
        <p className="mt-1">Load each year from the Government of India list and the Tamil Nadu G.O. under the Negotiable Instruments Act. Imported or edited holidays stay <em>pending</em> and have no effect on leave or attendance until someone verifies them against the recorded source.</p>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28" aria-label="Year">{[-1, 0, 1, 2].map((d) => { const y = Number(todayIST().slice(0, 4)) + d; return <option key={y} value={y}>{y}</option> })}</Select>
        <div className="ml-auto flex flex-wrap gap-2">
          <a href={`/api/calendar/export.ics?year=${year}&holidays=1`}><Button icon={<Download className="size-4" />}>Export .ics</Button></a>
          <input ref={fileRef} type="file" accept=".csv,.json" className="hidden" onChange={(e) => importFile(e.target.files?.[0])} />
          <Button icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()}>Import CSV / JSON</Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit(null)}>Add holiday</Button>
        </div>
      </div>
      <QueryState q={q} empty={(d) => (d.holidays.length === 0 ? <EmptyState title={`No holidays recorded for ${year}`} body="Import the official list as CSV (date,name,kind,region,is_day_off,source,source_url) or add them one by one." /> : null)}>
        {(d) => (
          <Table>
            <thead><tr><Th>Date</Th><Th>Holiday</Th><Th>Region</Th><Th>Source</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>{d.holidays.map((h) => (
              <Tr key={h.id}>
                <Td className="whitespace-nowrap font-mono text-[12px]">{fmtWeekday(h.holiday_date)}</Td>
                <Td><span className="text-ink">{h.name}</span><div className="text-[11.5px] capitalize text-muted">{h.kind}{!h.is_day_off && ' · not a day off'}</div></Td>
                <Td><Badge tone="outline">{h.region}</Badge></Td>
                <Td className="max-w-[260px] text-[12px] text-ink-2"><span className="line-clamp-2">{h.source || <span className="text-danger">No source recorded</span>}</span>{h.source_url && <a href={h.source_url} target="_blank" rel="noreferrer noopener" className="link text-[11.5px]">Open source</a>}</Td>
                <Td>{h.status === 'verified' ? <><Badge tone="ok">Verified</Badge><div className="text-[11px] text-muted">{h.verified_by_name} · {relative(h.verified_at)}</div></> : h.status === 'rejected' ? <Badge tone="danger">Rejected</Badge> : <Badge tone="gold">Pending</Badge>}</Td>
                <Td align="right" className="whitespace-nowrap">
                  {h.status !== 'verified' && <IconButton label="Verify" onClick={() => verify.mutate({ id: h.id, status: 'verified' })}><Check className="size-4 text-ok" /></IconButton>}
                  {h.status === 'pending_verification' && <IconButton label="Reject" onClick={() => verify.mutate({ id: h.id, status: 'rejected' })}><X className="size-4 text-danger" /></IconButton>}
                  <IconButton label="Correct" onClick={() => setEdit(h)}><Pencil className="size-3.5" /></IconButton>
                  <IconButton label="Delete" onClick={() => setDel(h)}><Trash2 className="size-3.5" /></IconButton>
                </Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </QueryState>

      <Section title="Working-day exceptions" description="Compensatory working days or one-off closures that override the weekly pattern." className="mt-10">
        <Panel className="mb-3 flex flex-wrap items-end gap-3 p-4">
          <Field label="Date"><Input type="date" value={ov.date} onChange={(e) => setOv({ ...ov, date: e.target.value })} /></Field>
          <Field label="Becomes"><Select value={ov.isWorking ? '1' : '0'} onChange={(e) => setOv({ ...ov, isWorking: e.target.value === '1' })}><option value="1">Working day</option><option value="0">Day off</option></Select></Field>
          <Field label="Reason" className="min-w-[240px] flex-1"><Input value={ov.reason} onChange={(e) => setOv({ ...ov, reason: e.target.value })} /></Field>
          <Button variant="primary" disabled={!ov.reason.trim()} loading={addOv.isPending} onClick={() => addOv.mutate()}>Add</Button>
        </Panel>
        {q.data?.overrides.length ? (
          <ul className="divide-y divide-line/70 rounded-lg border border-line bg-paper">{q.data.overrides.map((o) => (
            <li key={o.override_date} className="flex items-center gap-3 px-4 py-2 text-[13px]"><span className="w-36 font-mono text-[12px]">{fmtDate(o.override_date)}</span><Badge tone={o.is_working ? 'forest' : 'gold'}>{o.is_working ? 'Working' : 'Off'}</Badge><span className="flex-1 text-ink-2">{o.reason}</span><IconButton label="Remove" onClick={() => delOv.mutate(o.override_date)}><Trash2 className="size-3.5" /></IconButton></li>
          ))}</ul>
        ) : <p className="text-[13px] text-muted">No exceptions for {year}.</p>}
      </Section>
      {edit !== undefined && <HolidayDialog edit={edit} onClose={() => setEdit(undefined)} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} loading={remove.isPending} danger title="Delete holiday?" confirmLabel="Delete" body={del ? `${del.name} on ${fmtDate(del.holiday_date)} will be removed from the calendar.` : ''} />
    </div>
  )
}

function LeaveTypesTab() {
  const q = useLeaveTypes()
  const [edit, setEdit] = useState<{ id: string; name: string; annualQuota: string; isPaid: boolean; active: boolean } | null>(null)
  const save = useAction(() => api.put(`/api/hr/leave-types/${edit!.id}`, { name: edit!.name, annualQuota: edit!.annualQuota === '' ? null : Number(edit!.annualQuota), isPaid: edit!.isPaid, active: edit!.active }), { success: 'Leave type saved', invalidate: [['leave']], onSuccess: () => setEdit(null) })
  return (
    <Section title="Leave types" description="Annual quota is the default allocation; per-person balances can be adjusted.">
      <QueryState q={q}>{(rows) => (
        <Table>
          <thead><tr><Th>Type</Th><Th>Code</Th><Th align="right">Annual quota</Th><Th>Paid</Th><Th /></tr></thead>
          <tbody>{rows.map((t) => <Tr key={t.id}><Td className="text-ink">{t.name}</Td><Td className="font-mono text-[12px]">{t.code}</Td><Td align="right" className="font-mono">{t.annual_quota ?? 'Not tracked'}</Td><Td>{t.is_paid ? 'Paid' : 'Unpaid'}</Td><Td align="right"><IconButton label="Edit" onClick={() => setEdit({ id: t.id, name: t.name, annualQuota: t.annual_quota?.toString() ?? '', isPaid: Boolean(t.is_paid), active: Boolean(t.active) })}><Pencil className="size-3.5" /></IconButton></Td></Tr>)}</tbody>
        </Table>
      )}</QueryState>
      {edit && (
        <Dialog open onClose={() => setEdit(null)} title="Edit leave type" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Annual quota (days)" hint="Blank = not balance-tracked"><Input type="number" min={0} value={edit.annualQuota} onChange={(e) => setEdit({ ...edit, annualQuota: e.target.value })} /></Field>
            <Checkbox label="Paid leave" checked={edit.isPaid} onChange={(e) => setEdit({ ...edit, isPaid: e.target.checked })} />
            <Checkbox label="Active" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />
          </div>
        </Dialog>
      )}
    </Section>
  )
}

function PortalTab({ s }: { s: Settings }) {
  const [p, setP] = useState(s['portal.defaults'])
  const [r, setR] = useState(s['reports.schedule'])
  const saveP = useSaveSetting('portal.defaults')
  const saveR = useSaveSetting('reports.schedule')
  return (
    <div className="grid max-w-4xl gap-6 lg:grid-cols-2">
      <Panel className="p-5">
        <h3 className="mb-4 font-medium text-ink">Client portal</h3>
        <div className="grid gap-3">
          <Field label="Default link validity (days)"><Input type="number" min={1} max={180} value={p.linkValidityDays} onChange={(e) => setP({ ...p, linkValidityDays: Number(e.target.value) })} /></Field>
          <Field label="Portal session length (hours)" hint="Clients re-open their link after this."><Input type="number" min={1} max={24} value={p.sessionHours} onChange={(e) => setP({ ...p, sessionHours: Number(e.target.value) })} /></Field>
          <Field label="Re-verification window (minutes)" hint="Approvals require confirming the contact email within this window."><Input type="number" min={5} max={120} value={p.reverifyMinutes} onChange={(e) => setP({ ...p, reverifyMinutes: Number(e.target.value) })} /></Field>
        </div>
        <div className="mt-4 flex justify-end"><Button variant="primary" loading={saveP.isPending} onClick={() => saveP.mutate(p)}>Save</Button></div>
      </Panel>
      <Panel className="p-5">
        <h3 className="mb-2 font-medium text-ink">Scheduled reports</h3>
        <Checkbox label="Generate month-end snapshots" description="On the 1st of each month (08:00 IST) the company report and each active project report for the previous month are frozen." checked={r.monthlySnapshots} onChange={(e) => setR({ monthlySnapshots: e.target.checked })} />
        <div className="mt-4 flex justify-end"><Button variant="primary" loading={saveR.isPending} onClick={() => saveR.mutate(r)}>Save</Button></div>
      </Panel>
    </div>
  )
}

export default function SettingsPage() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const manage = can('settings.manage')
  const tabs = [
    ...(manage ? [{ value: 'company' as Tab, label: 'Company' }, { value: 'workdays' as Tab, label: 'Working days' }] : []),
    ...(can('holidays.manage') ? [{ value: 'holidays' as Tab, label: 'Holidays' }] : []),
    ...(can('leave.manage') ? [{ value: 'leave' as Tab, label: 'Leave types' }] : []),
    ...(manage ? [{ value: 'portal' as Tab, label: 'Portal & reports' }] : []),
  ]
  const tab = (params.get('tab') as Tab) || tabs[0]?.value || 'holidays'
  const s = useSettings(manage)
  useEffect(() => {
    if (!tabs.some((t) => t.value === tab) && tabs[0]) setParams({ tab: tabs[0].value })
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <PageHeader eyebrow="Administration" title="Settings" meta={<span>Rules here drive calculations everywhere — nothing is hard-coded per year.</span>}>
        <div className="mt-5 border-b border-line"><Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={tabs} /></div>
      </PageHeader>
      {tab === 'holidays' && <HolidaysTab />}
      {tab === 'leave' && <LeaveTypesTab />}
      {['company', 'workdays', 'portal'].includes(tab) && (
        <QueryState q={s}>{(data) => (tab === 'company' ? <CompanyTab s={data} /> : tab === 'workdays' ? <WorkdaysTab s={data} /> : <PortalTab s={data} />)}</QueryState>
      )}
    </div>
  )
}
