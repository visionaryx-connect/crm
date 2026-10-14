import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronLeft, ChevronRight, Download, MapPin, Plus, Repeat } from 'lucide-react'
import { EVENT_KINDS, EVENT_KIND_LABEL } from '@shared/constants'
import { api, ApiError, qs } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAction } from '@/lib/forms'
import { useClientOptions, useDepartments, useMembers } from '@/lib/lookups'
import { fmtDateTime, fmtTime, isoToLocalInput, localInputToIso, todayIST } from '@/lib/format'
import { Badge, Button, Checkbox, Dialog, ErrorState, Field, Input, PageHeader, Select, Spinner, Textarea, cx } from '@/components/ui'
import { useToast } from '@/components/toast'

type View = 'month' | 'week' | 'day' | 'agenda'
interface Item {
  type: 'event' | 'project_deadline' | 'milestone' | 'task_due' | 'leave' | 'holiday'
  id: string
  title: string
  start?: string
  end?: string
  date?: string
  allDay?: boolean
  kind?: string
  eventId?: string
  projectId?: string
  taskId?: string
  verified?: boolean
  dayOff?: boolean
  recurring?: boolean
  location?: string | null
  status?: string
  organizerId?: string
}
interface DayInfo { date: string; kind: string; working: boolean; label?: string }
interface CalData { items: Item[]; days: DayInfo[]; today: string }

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const weekday = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay()
const istDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso))
const istMinutes = (iso: string) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).split(':')
  return Number(p[0]) * 60 + Number(p[1])
}
const monthLabel = (d: string) => new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'))
const dayLabel = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', ...o }).format(new Date(d + 'T00:00:00Z'))

function rangeFor(view: View, anchor: string) {
  if (view === 'month') {
    const first = anchor.slice(0, 8) + '01'
    const start = addDays(first, -((weekday(first) + 6) % 7))
    return { from: start, to: addDays(start, 41) }
  }
  if (view === 'week') {
    const start = addDays(anchor, -((weekday(anchor) + 6) % 7))
    return { from: start, to: addDays(start, 6) }
  }
  if (view === 'day') return { from: anchor, to: anchor }
  return { from: anchor, to: addDays(anchor, 29) }
}

const typeStyle: Record<Item['type'], string> = {
  event: 'bg-forest-100 text-forest-700 border-forest/20',
  project_deadline: 'bg-danger-bg text-danger border-danger/20',
  milestone: 'bg-gold-100 text-gold-700 border-gold/30',
  task_due: 'bg-paper text-ink-2 border-line-strong',
  leave: 'bg-info-bg text-info border-info/20',
  holiday: 'bg-sage text-forest-700 border-sage-deep',
}
const kindStyle: Record<string, string> = { client_meeting: 'bg-gold-100 text-gold-700 border-gold/30', company_event: 'bg-forest text-paper border-forest' }

function itemDates(it: Item): [string, string] {
  if (it.type === 'event') return [istDate(it.start!), istDate(new Date(Date.parse(it.end!) - 1).toISOString())]
  if (it.type === 'leave') return [it.start!, it.end!]
  return [it.date!, it.date!]
}

function Chip({ it, onOpen }: { it: Item; onOpen: (it: Item) => void }) {
  const cls = cx('block w-full truncate rounded-[3px] border px-1.5 py-[1px] text-left text-[11.5px] leading-[18px]', it.type === 'event' && it.kind && kindStyle[it.kind] ? kindStyle[it.kind] : typeStyle[it.type], it.type === 'holiday' && !it.verified && 'border-dashed opacity-70')
  const label = <>{it.type === 'event' && !it.allDay && <span className="font-mono">{fmtTime(it.start)} </span>}{it.recurring && <Repeat className="mr-0.5 inline size-2.5" />}{it.title}</>
  if (it.type === 'task_due' && it.taskId) return <Link to={`/tasks/${it.taskId}`} className={cls} title={it.title}>{label}</Link>
  if ((it.type === 'milestone' || it.type === 'project_deadline') && it.projectId) return <Link to={`/projects/${it.projectId}`} className={cls} title={it.title}>{label}</Link>
  return <button className={cls} title={it.title + (it.type === 'holiday' && !it.verified ? ' (unverified)' : '')} onClick={() => onOpen(it)}>{label}</button>
}

// ───────── Event editor ─────────

const RRULE_PRESETS = [
  { value: '', label: 'Does not repeat' },
  { value: 'FREQ=DAILY', label: 'Every day' },
  { value: 'WEEKLY', label: 'Every week on this day' },
  { value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'Every weekday (Mon–Fri)' },
  { value: 'FREQ=MONTHLY', label: 'Every month on this date' },
  { value: 'custom', label: 'Custom rule…' },
]

function EventDialog({ open, onClose, eventId, defaultDate }: { open: boolean; onClose: () => void; eventId?: string; defaultDate?: string }) {
  const { can, me } = useAuth()
  const members = useMembers(open)
  const clients = useClientOptions(open && can('clients.read'))
  const departments = useDepartments()
  const projects = useQuery({ queryKey: ['projects', { status: 'active', lite: true }], queryFn: () => api.get<{ projects: { id: string; reference: string; name: string }[] }>('/api/projects?status=active').then((r) => r.projects), enabled: open })
  const existing = useQuery({ queryKey: ['calendar', 'event', eventId], queryFn: () => api.get<{ event: any; attendees: { user_id: string }[] }>(`/api/calendar/events/${eventId}`), enabled: open && !!eventId })
  const toast = useToast()
  const date = defaultDate ?? todayIST()
  const blank = { title: '', description: '', kind: 'internal_meeting', start: `${date}T10:00`, end: `${date}T11:00`, allDay: false, location: '', projectId: '', clientId: '', departmentId: '', visibility: 'attendees', rule: '', customRule: '', reminderMinutes: '15', attendeeIds: [me.user.id] as string[] }
  const [v, setV] = useState(blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [conflicts, setConflicts] = useState<{ message: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  useEffect(() => {
    if (!open) return
    setErrors({})
    setConflicts([])
    if (!eventId) setV(blank)
    else if (existing.data) {
      const e = existing.data.event
      const preset = RRULE_PRESETS.find((p) => p.value && p.value === e.recurrence_rule)
      setV({
        title: e.title, description: e.description, kind: e.kind, start: isoToLocalInput(e.start_at), end: isoToLocalInput(e.end_at), allDay: e.all_day, location: e.location ?? '', projectId: e.project_id ?? '',
        clientId: e.client_id ?? '', departmentId: e.department_id ?? '', visibility: e.visibility, rule: e.recurrence_rule ? (preset?.value ?? 'custom') : '', customRule: e.recurrence_rule ?? '',
        reminderMinutes: e.reminder_minutes?.toString() ?? '', attendeeIds: existing.data.attendees.map((a) => a.user_id),
      })
    }
  }, [open, eventId, existing.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const startIso = v.allDay ? localInputToIso(`${v.start.slice(0, 10)}T00:00`) : localInputToIso(v.start)
  const endIso = v.allDay ? localInputToIso(`${addDays(v.end.slice(0, 10), 1)}T00:00`) : localInputToIso(v.end)
  useEffect(() => {
    if (!open || v.attendeeIds.length === 0 || !(Date.parse(endIso) > Date.parse(startIso))) return setConflicts([])
    const t = setTimeout(() => {
      api.post<{ conflicts: { message: string }[] }>('/api/calendar/conflicts', { attendeeIds: v.attendeeIds, startAt: startIso, endAt: endIso, excludeEventId: eventId }).then((r) => setConflicts(r.conflicts)).catch(() => undefined)
    }, 350)
    return () => clearTimeout(t)
  }, [open, startIso, endIso, v.attendeeIds, eventId])

  const rule = v.rule === 'custom' ? v.customRule : v.rule === 'WEEKLY' ? `FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][weekday(v.start.slice(0, 10))]}` : v.rule
  const save = async () => {
    setBusy(true)
    setErrors({})
    const body = { title: v.title, description: v.description, kind: v.kind, startAt: startIso, endAt: endIso, allDay: v.allDay, location: v.location || null, projectId: v.projectId || null, clientId: v.clientId || null, departmentId: v.departmentId || null, visibility: v.visibility, recurrenceRule: rule || null, reminderMinutes: v.reminderMinutes === '' ? null : Number(v.reminderMinutes), attendeeIds: v.attendeeIds }
    try {
      if (eventId) await api.put(`/api/calendar/events/${eventId}`, body)
      else await api.post('/api/calendar/events', body)
      toast({ tone: 'ok', title: eventId ? 'Event updated — attendees notified' : 'Event scheduled — invitations sent' })
      onClose()
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fields).length) setErrors(e.fields)
      else toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Save failed' })
    } finally {
      setBusy(false)
    }
  }
  const shown = members.data?.filter((m) => m.status === 'active' && (!filter || m.name.toLowerCase().includes(filter.toLowerCase()))) ?? []

  return (
    <Dialog open={open} onClose={onClose} title={eventId ? 'Edit event' : 'Schedule'} width={720} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!v.title.trim()} onClick={save}>{eventId ? 'Save' : 'Schedule'}</Button></>}>
      {eventId && existing.isLoading ? <Spinner /> : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" required error={errors.title} className="sm:col-span-2"><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} autoFocus /></Field>
          <Field label="Type"><Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value, visibility: e.target.value === 'company_event' ? 'company' : v.visibility })}>{EVENT_KINDS.filter((k) => k !== 'company_event' || can('calendar.manage')).map((k) => <option key={k} value={k}>{EVENT_KIND_LABEL[k]}</option>)}</Select></Field>
          <Field label="Visible to"><Select value={v.visibility} onChange={(e) => setV({ ...v, visibility: e.target.value })}><option value="attendees">Attendees only</option><option value="project">Project team</option><option value="department">Department</option>{can('calendar.manage') && <option value="company">Whole company</option>}</Select></Field>
          <div className="sm:col-span-2"><Checkbox label="All day" checked={v.allDay} onChange={(e) => setV({ ...v, allDay: e.target.checked })} /></div>
          <Field label={v.allDay ? 'From' : 'Starts (IST)'} error={errors.startAt}><Input type={v.allDay ? 'date' : 'datetime-local'} value={v.allDay ? v.start.slice(0, 10) : v.start} onChange={(e) => setV({ ...v, start: v.allDay ? `${e.target.value}T00:00` : e.target.value, end: v.end < e.target.value ? (v.allDay ? `${e.target.value}T00:00` : e.target.value) : v.end })} /></Field>
          <Field label={v.allDay ? 'To' : 'Ends (IST)'} error={errors.endAt}><Input type={v.allDay ? 'date' : 'datetime-local'} value={v.allDay ? v.end.slice(0, 10) : v.end} onChange={(e) => setV({ ...v, end: v.allDay ? `${e.target.value}T00:00` : e.target.value })} /></Field>
          <Field label="Repeats" error={errors.recurrenceRule}><Select value={v.rule} onChange={(e) => setV({ ...v, rule: e.target.value })}>{RRULE_PRESETS.map((p) => <option key={p.label} value={p.value}>{p.label}</option>)}</Select></Field>
          {v.rule === 'custom' ? <Field label="RRULE" hint="e.g. FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20271231" error={errors.recurrenceRule}><Input value={v.customRule} onChange={(e) => setV({ ...v, customRule: e.target.value })} className="font-mono" /></Field> : (
            <Field label="Reminder"><Select value={v.reminderMinutes} onChange={(e) => setV({ ...v, reminderMinutes: e.target.value })}><option value="">None</option><option value="10">10 minutes before</option><option value="15">15 minutes before</option><option value="30">30 minutes before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></Select></Field>
          )}
          <Field label="Location / link"><Input value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} placeholder="Room or meeting link" /></Field>
          <Field label="Project" error={errors.projectId}><Select value={v.projectId} onChange={(e) => setV({ ...v, projectId: e.target.value })}><option value="">—</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.reference} · {p.name}</option>)}</Select></Field>
          {can('clients.read') && <Field label="Client"><Select value={v.clientId} onChange={(e) => setV({ ...v, clientId: e.target.value })}><option value="">—</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
          {v.visibility === 'department' && <Field label="Department" error={errors.departmentId}><Select value={v.departmentId} onChange={(e) => setV({ ...v, departmentId: e.target.value })}><option value="">Choose…</option>{departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>}
          <Field label={`Attendees · ${v.attendeeIds.length}`} className="sm:col-span-2">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter people" className="mb-2 !h-8" />
            <div className="grid max-h-40 grid-cols-2 gap-x-4 gap-y-1.5 overflow-y-auto rounded-md border border-line p-3 sm:grid-cols-3">
              {shown.map((m) => <Checkbox key={m.id} label={m.name} checked={v.attendeeIds.includes(m.id)} onChange={(e) => setV({ ...v, attendeeIds: e.target.checked ? [...v.attendeeIds, m.id] : v.attendeeIds.filter((x) => x !== m.id) })} />)}
            </div>
          </Field>
          {conflicts.length > 0 && (
            <div className="sm:col-span-2 rounded-md border border-warn/30 bg-warn-bg px-3 py-2 text-[12.5px] text-warn" role="status">
              <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="size-3.5" /> Scheduling conflicts</p>
              <ul className="mt-1 list-disc pl-5">{conflicts.slice(0, 6).map((c, i) => <li key={i}>{c.message}</li>)}</ul>
            </div>
          )}
          <Field label="Agenda / notes" className="sm:col-span-2"><Textarea rows={3} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
        </div>
      )}
    </Dialog>
  )
}

function ItemDialog({ item, onClose, onEdit }: { item: Item | null; onClose: () => void; onEdit: (id: string) => void }) {
  const { me, can } = useAuth()
  const ev = useQuery({ queryKey: ['calendar', 'event', item?.eventId], queryFn: () => api.get<{ event: any; attendees: { user_id: string; name: string; response: string }[]; canEdit: boolean }>(`/api/calendar/events/${item!.eventId}`), enabled: !!item?.eventId })
  const respond = useAction((response: string) => api.post(`/api/calendar/events/${item!.eventId}/respond`, { response }), { success: 'Response saved', invalidate: [['calendar']] })
  const cancel = useAction(() => api.del(`/api/calendar/events/${item!.eventId}`), { success: 'Event cancelled — attendees notified', invalidate: [['calendar']], onSuccess: onClose })
  if (!item) return null
  const e = ev.data?.event
  const mine = ev.data?.attendees.find((a) => a.user_id === me.user.id)
  return (
    <Dialog open onClose={onClose} title={item.title} width={520} footer={item.type === 'event' && ev.data ? (
      <>
        {mine && <><Button size="sm" variant={mine.response === 'declined' ? 'primary' : 'ghost'} onClick={() => respond.mutate('declined')}>Decline</Button><Button size="sm" variant={mine.response === 'accepted' ? 'primary' : 'secondary'} onClick={() => respond.mutate('accepted')}>Accept</Button></>}
        {ev.data.canEdit && <><Button size="sm" variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel event</Button><Button size="sm" onClick={() => { onClose(); onEdit(item.eventId!) }}>Edit</Button></>}
      </>
    ) : undefined}>
      {item.type === 'holiday' ? (
        <div className="space-y-2 text-[13.5px]"><p>{item.date} · {item.kind} holiday</p>{!item.verified && <Badge tone="gold">Pending verification — not yet applied to attendance or leave</Badge>}{item.dayOff === false && <p className="text-muted">Optional / not a day off.</p>}{can('holidays.manage') && <Link to="/settings?tab=holidays" className="link">Manage holidays</Link>}</div>
      ) : item.type === 'leave' ? (
        <p className="text-[13.5px]">{item.start} → {item.end}</p>
      ) : !e ? <Spinner /> : (
        <div className="space-y-3 text-[13.5px]">
          <div className="flex flex-wrap gap-2"><Badge tone="forest">{EVENT_KIND_LABEL[e.kind as keyof typeof EVENT_KIND_LABEL]}</Badge>{e.recurrence_rule && <Badge tone="outline"><Repeat className="size-3" /> {e.recurrence_rule}</Badge>}</div>
          <p className="text-ink">{e.all_day ? 'All day' : `${fmtDateTime(item.start)} – ${fmtTime(item.end)}`}</p>
          {e.location && <p className="flex items-center gap-1.5 text-ink-2"><MapPin className="size-3.5" />{e.location}</p>}
          {e.project_name && <p className="text-ink-2">Project: <Link to={`/projects/${e.project_id}`} className="link">{e.project_name}</Link></p>}
          {e.client_name && <p className="text-ink-2">Client: {e.client_name}</p>}
          <p className="text-ink-2">Organiser: {e.organizer_name ?? '—'}</p>
          {e.description && <p className="whitespace-pre-wrap rounded bg-ivory px-3 py-2 text-ink-2">{e.description}</p>}
          {ev.data!.attendees.length > 0 && <div><div className="eyebrow mb-1">Attendees</div><ul className="grid grid-cols-2 gap-1 text-[12.5px]">{ev.data!.attendees.map((a) => <li key={a.user_id} className="flex items-center gap-1.5"><span className={cx('size-1.5 rounded-full', a.response === 'accepted' ? 'bg-ok' : a.response === 'declined' ? 'bg-danger' : 'bg-line-strong')} />{a.name}</li>)}</ul></div>}
        </div>
      )}
    </Dialog>
  )
}

// ───────── Page ─────────

const TYPE_FILTERS: { key: Item['type']; label: string }[] = [
  { key: 'event', label: 'Meetings & events' }, { key: 'task_due', label: 'Task deadlines' }, { key: 'milestone', label: 'Milestones' }, { key: 'project_deadline', label: 'Project deadlines' }, { key: 'leave', label: 'Leave' }, { key: 'holiday', label: 'Holidays' },
]

export default function CalendarPage() {
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<View>(() => (window.innerWidth < 768 ? 'agenda' : 'month'))
  const [anchor, setAnchor] = useState(todayIST())
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [projectId, setProjectId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [hidden, setHidden] = useState<Item['type'][]>([])
  const [open, setOpen] = useState<Item | null>(null)
  const [editing, setEditing] = useState<{ id?: string; date?: string } | null>(params.get('new') === '1' ? {} : null)
  const departments = useDepartments()
  const projects = useQuery({ queryKey: ['projects', { status: 'active', lite: true }], queryFn: () => api.get<{ projects: { id: string; reference: string; name: string }[] }>('/api/projects?status=active').then((r) => r.projects) })
  const { from, to } = rangeFor(view, anchor)
  const q = useQuery({ queryKey: ['calendar', { from, to, scope, projectId, departmentId }], queryFn: () => api.get<CalData>(`/api/calendar${qs({ from, to, scope, projectId, departmentId })}`), placeholderData: (p) => p })
  useEffect(() => {
    const ev = params.get('event')
    if (ev) setOpen({ type: 'event', id: ev, eventId: ev, title: 'Event' })
  }, [params])

  const items = useMemo(() => (q.data?.items ?? []).filter((i) => !hidden.includes(i.type)), [q.data, hidden])
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>()
    for (const it of items) {
      const [s, e] = itemDates(it)
      for (let d = s < from ? from : s; d <= e && d <= to; d = addDays(d, 1)) m.set(d, [...(m.get(d) ?? []), it])
    }
    for (const list of m.values()) list.sort((a, b) => (a.type === 'holiday' ? -1 : b.type === 'holiday' ? 1 : (a.start ?? '').localeCompare(b.start ?? '')))
    return m
  }, [items, from, to])
  const dayInfo = useMemo(() => new Map((q.data?.days ?? []).map((d) => [d.date, d])), [q.data])
  const today = todayIST()
  const step = (dir: number) => setAnchor((a) => (view === 'month' ? new Date(Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1 + dir, 1)).toISOString().slice(0, 10) : addDays(a, dir * (view === 'week' ? 7 : view === 'day' ? 1 : 30))))
  const title = view === 'month' ? monthLabel(anchor) : view === 'day' ? dayLabel(anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : `${dayLabel(from, { day: 'numeric', month: 'short' })} – ${dayLabel(to, { day: 'numeric', month: 'short', year: 'numeric' })}`

  const timed = (list: Item[]) => list.filter((i) => i.type === 'event' && !i.allDay)
  const allDay = (list: Item[]) => list.filter((i) => !(i.type === 'event' && !i.allDay))

  return (
    <div>
      <PageHeader eyebrow="Schedule" title="Calendar" meta={<span>All times in IST (Asia/Kolkata). Government holidays apply only after verification.</span>} actions={
        <>
          <a href={`/api/calendar/export.ics?year=${anchor.slice(0, 4)}`}><Button icon={<Download className="size-4" />}>Export .ics</Button></a>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ date: anchor })}>Schedule</Button>
        </>
      } />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-md border border-line bg-paper">
          <button className="px-2 py-1.5 hover:bg-porcelain" onClick={() => step(-1)} aria-label="Previous"><ChevronLeft className="size-4" /></button>
          <button className="border-x border-line px-3 py-1.5 text-[12.5px] font-medium hover:bg-porcelain" onClick={() => setAnchor(today)}>Today</button>
          <button className="px-2 py-1.5 hover:bg-porcelain" onClick={() => step(1)} aria-label="Next"><ChevronRight className="size-4" /></button>
        </div>
        <h2 className="min-w-[180px] font-display text-[19px] text-ink">{title}</h2>
        {q.isFetching && <Spinner />}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select className="w-40 !h-8" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project filter"><option value="">All projects</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.reference} · {p.name}</option>)}</Select>
          <Select className="w-36 !h-8" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department filter"><option value="">All departments</option>{departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
          <Select className="w-32 !h-8" value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')} aria-label="Task scope"><option value="mine">My tasks</option><option value="all">All tasks</option></Select>
          <div className="flex rounded-md border border-line bg-paper p-0.5" role="group" aria-label="Calendar view">
            {(['month', 'week', 'day', 'agenda'] as View[]).map((vw) => <button key={vw} onClick={() => setView(vw)} aria-pressed={view === vw} className={cx('rounded px-2.5 py-1 text-[12.5px] capitalize', view === vw ? 'bg-forest text-paper' : 'text-ink-2 hover:bg-porcelain')}>{vw}</button>)}
          </div>
        </div>
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {TYPE_FILTERS.map((t) => (
          <button key={t.key} onClick={() => setHidden((h) => (h.includes(t.key) ? h.filter((x) => x !== t.key) : [...h, t.key]))} aria-pressed={!hidden.includes(t.key)} className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px]', hidden.includes(t.key) ? 'border-line text-faint line-through' : typeStyle[t.key])}>
            {t.label}
          </button>
        ))}
      </div>

      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}

      {view === 'month' && (
        <div className="overflow-hidden rounded-lg border border-line bg-paper">
          <div className="grid grid-cols-7 border-b border-line bg-ivory/70">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">{d}</div>)}</div>
          <div className="grid grid-cols-7">
            {Array.from({ length: 42 }, (_, i) => addDays(from, i)).map((d) => {
              const info = dayInfo.get(d)
              const list = byDay.get(d) ?? []
              const inMonth = d.slice(0, 7) === anchor.slice(0, 7)
              return (
                <div key={d} className={cx('group min-h-[112px] border-b border-r border-line/70 p-1.5 [&:nth-child(7n)]:border-r-0', !inMonth && 'bg-ivory/50', info && !info.working && 'bg-porcelain/50')} onDoubleClick={() => setEditing({ date: d })}>
                  <div className="mb-1 flex items-center justify-between">
                    <button onClick={() => { setAnchor(d); setView('day') }} className={cx('flex size-6 items-center justify-center rounded-full font-mono text-[11.5px]', d === today ? 'bg-forest text-paper' : inMonth ? 'text-ink hover:bg-porcelain' : 'text-faint')}>{Number(d.slice(8))}</button>
                    {info && !info.working && info.kind !== 'holiday' && <span className="text-[10px] uppercase tracking-wider text-faint">{info.kind === 'weekend' ? 'Off' : 'Off'}</span>}
                    {info?.kind === 'override_working' && <span className="text-[10px] text-gold-700" title={info.label}>Working</span>}
                  </div>
                  <div className="space-y-0.5">
                    {list.slice(0, 4).map((it) => <Chip key={it.id + d} it={it} onOpen={setOpen} />)}
                    {list.length > 4 && <button onClick={() => { setAnchor(d); setView('day') }} className="px-1 text-[11px] text-muted hover:text-ink">+{list.length - 4} more</button>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {(view === 'week' || view === 'day') && (() => {
        const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(from, i)) : [anchor]
        const startH = 8
        const endH = 21
        const hourPx = 48
        return (
          <div className="overflow-x-auto rounded-lg border border-line bg-paper">
            <div className={cx('grid', view === 'week' ? 'min-w-[840px] grid-cols-[56px_repeat(7,1fr)]' : 'grid-cols-[56px_1fr]')}>
              <div className="border-b border-line bg-ivory/70" />
              {days.map((d) => {
                const info = dayInfo.get(d)
                return (
                  <div key={d} className={cx('border-b border-l border-line px-2 py-1.5', info && !info.working && 'bg-porcelain/60')}>
                    <div className={cx('text-[11px] uppercase tracking-[0.07em]', d === today ? 'text-forest font-semibold' : 'text-muted')}>{dayLabel(d, { weekday: 'short', day: 'numeric' })}</div>
                    <div className="mt-1 space-y-0.5">{allDay(byDay.get(d) ?? []).map((it) => <Chip key={it.id} it={it} onOpen={setOpen} />)}</div>
                  </div>
                )
              })}
              <div className="relative" style={{ height: (endH - startH) * hourPx }}>
                {Array.from({ length: endH - startH }, (_, h) => <div key={h} className="absolute right-1.5 font-mono text-[10px] text-faint" style={{ top: h * hourPx - 6 }}>{String(startH + h).padStart(2, '0')}:00</div>)}
              </div>
              {days.map((d) => (
                <div key={d} className="relative border-l border-line" style={{ height: (endH - startH) * hourPx }} onDoubleClick={() => setEditing({ date: d })}>
                  {Array.from({ length: endH - startH }, (_, h) => <div key={h} className="absolute inset-x-0 border-t border-line/60" style={{ top: h * hourPx }} />)}
                  {d === today && (() => { const m = istMinutes(new Date().toISOString()); return m >= startH * 60 && m <= endH * 60 ? <div className="absolute inset-x-0 z-10 h-px bg-gold" style={{ top: ((m - startH * 60) / 60) * hourPx }} /> : null })()}
                  {timed(byDay.get(d) ?? []).map((it) => {
                    const s = istDate(it.start!) < d ? startH * 60 : istMinutes(it.start!)
                    const e = istDate(it.end!) > d ? endH * 60 : istMinutes(it.end!)
                    const top = Math.max(0, ((s - startH * 60) / 60) * hourPx)
                    const h = Math.max(22, ((e - s) / 60) * hourPx - 2)
                    return (
                      <button key={it.id} onClick={() => setOpen(it)} className={cx('absolute inset-x-1 overflow-hidden rounded border px-1.5 py-0.5 text-left text-[11.5px] leading-tight', it.kind && kindStyle[it.kind] ? kindStyle[it.kind] : typeStyle.event)} style={{ top, height: h }}>
                        <span className="font-mono text-[10.5px]">{fmtTime(it.start)}</span> <span className="font-medium">{it.title}</span>
                        {it.location && h > 40 && <span className="block truncate opacity-75">{it.location}</span>}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {view === 'agenda' && (
        <div className="space-y-4">
          {Array.from({ length: 30 }, (_, i) => addDays(from, i)).filter((d) => (byDay.get(d) ?? []).length > 0).map((d) => (
            <section key={d} className="grid gap-3 sm:grid-cols-[150px_1fr]">
              <div className="pt-1">
                <div className={cx('font-display text-[17px]', d === today ? 'text-forest' : 'text-ink')}>{dayLabel(d, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                {dayInfo.get(d) && !dayInfo.get(d)!.working && <div className="text-[11.5px] text-muted">{dayInfo.get(d)!.label ?? 'Non-working day'}</div>}
              </div>
              <ul className="divide-y divide-line/70 rounded-lg border border-line bg-paper">
                {(byDay.get(d) ?? []).map((it) => (
                  <li key={it.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <span className="w-24 shrink-0 font-mono text-[11.5px] text-muted">{it.type === 'event' && !it.allDay ? `${fmtTime(it.start)}–${fmtTime(it.end)}` : 'All day'}</span>
                    <span className="min-w-0 flex-1"><Chip it={it} onOpen={setOpen} /></span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {!q.isLoading && items.length === 0 && <p className="py-10 text-center text-[13px] text-muted">Nothing scheduled in this range.</p>}
        </div>
      )}

      <ItemDialog item={open} onClose={() => { setOpen(null); if (params.get('event')) setParams({}) }} onEdit={(id) => setEditing({ id })} />
      {editing && <EventDialog open onClose={() => { setEditing(null); if (params.get('new')) setParams({}) }} eventId={editing.id} defaultDate={editing.date} />}
    </div>
  )
}
