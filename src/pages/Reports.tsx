import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Archive, Download, FileText, Play, Printer, Save } from 'lucide-react'
import { api, qs } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { download, fmtDate, fmtDateShort, fmtDateTime, todayIST, toCsv } from '@/lib/format'
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Panel, Section, Select, SkeletonRows, Table, Td, Th, Tr } from '@/components/ui'

type RType = 'company' | 'project' | 'member' | 'client'
interface ReportDoc {
  meta: { type: RType; title: string; scopeName: string | null; period: { start: string; end: string }; generatedAt: string; timezone: string; definitions: string[] }
  summary: { key: string; label: string; value: number | string | null; note?: string }[]
  charts: Record<string, Record<string, unknown>[]>
  tables: { key: string; title: string; columns: { key: string; label: string }[]; rows: Record<string, unknown>[] }[]
  notes: string[]
}

const prevMonth = () => {
  const t = todayIST()
  const d = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 2, 1))
  return d.toISOString().slice(0, 7)
}
const monthRange = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  const last = new Date(Date.UTC(y!, mo!, 0)).getUTCDate()
  return { start: `${m}-01`, end: `${m}-${String(last).padStart(2, '0')}` }
}

function ReportView({ doc, snapshot }: { doc: ReportDoc; snapshot?: { generatedAt: string; source: string } }) {
  const exportAll = () => {
    const parts = [`${doc.meta.title} — ${doc.meta.scopeName ?? ''}`, `Period,${doc.meta.period.start},${doc.meta.period.end}`, '', toCsv([{ key: 'label', label: 'Metric' }, { key: 'value', label: 'Value' }, { key: 'note', label: 'Note' }], doc.summary.map((s) => ({ ...s, value: s.value ?? 'Not available' })))]
    for (const t of doc.tables) parts.push('', t.title, toCsv(t.columns, t.rows))
    download(`${doc.meta.type}-report-${doc.meta.period.start}-${doc.meta.period.end}.csv`, parts.join('\n'))
  }
  return (
    <article className="animate-fade-in">
      <div className="print-only mb-4">
        <div className="font-display text-[22px]">Visionary X</div>
        <div className="text-[11px] text-muted">Generated {fmtDateTime(snapshot?.generatedAt ?? doc.meta.generatedAt)} · IST</div>
      </div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
        <div>
          <div className="eyebrow">{doc.meta.title}</div>
          <h2 className="font-display text-[24px] text-ink">{doc.meta.scopeName}</h2>
          <p className="text-[13px] text-muted">{fmtDate(doc.meta.period.start)} – {fmtDate(doc.meta.period.end)} · {doc.meta.timezone}{snapshot && <> · <Badge tone="gold">Snapshot {snapshot.source} · {fmtDateTime(snapshot.generatedAt)}</Badge></>}</p>
        </div>
        <div className="no-print flex gap-2">
          <Button icon={<Download className="size-4" />} onClick={exportAll}>CSV</Button>
          <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>Print / PDF</Button>
        </div>
      </header>

      <dl className="mb-8 grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-paper sm:grid-cols-3 lg:grid-cols-5">
        {doc.summary.map((s) => (
          <div key={s.key} className="border-b border-r border-line/70 px-4 py-3">
            <dt className="text-[11px] uppercase tracking-[0.07em] text-muted">{s.label}</dt>
            <dd className="mt-1 font-display text-[22px] leading-tight tabular text-ink">{s.value === null ? <span className="text-[13px] font-sans text-faint">Not available</span> : String(s.value).replace(/_/g, ' ')}</dd>
            {s.note && <dd className="mt-0.5 text-[11px] text-muted">{s.note}</dd>}
          </div>
        ))}
      </dl>

      {doc.charts.completionsByDay && doc.charts.completionsByDay.length > 0 && (
        <Section title="Completions per day">
          <Panel className="px-2 pt-4"><div className="h-[180px]"><ResponsiveContainer width="100%" height="100%"><BarChart data={doc.charts.completionsByDay}><CartesianGrid vertical={false} stroke="#e1dccf" /><XAxis dataKey="day" tickFormatter={(v) => fmtDateShort(String(v))} tick={{ fontSize: 10.5, fill: '#767a74' }} axisLine={false} tickLine={false} /><YAxis allowDecimals={false} width={28} tick={{ fontSize: 10.5, fill: '#767a74' }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} /><Bar dataKey="completed" fill="#1f4d3a" radius={[2, 2, 0, 0]} /></BarChart></ResponsiveContainer></div></Panel>
        </Section>
      )}
      {doc.charts.departmentWorkload && doc.charts.departmentWorkload.length > 0 && (
        <Section title="Department workload">
          <Panel className="px-2 pt-4"><div className="h-[200px]"><ResponsiveContainer width="100%" height="100%"><BarChart data={doc.charts.departmentWorkload}><CartesianGrid vertical={false} stroke="#e1dccf" /><XAxis dataKey="department" tick={{ fontSize: 11, fill: '#464b4f' }} axisLine={false} tickLine={false} /><YAxis width={28} tick={{ fontSize: 10.5, fill: '#767a74' }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} /><Bar dataKey="completed" name="Completed" fill="#1f4d3a" radius={[2, 2, 0, 0]} /><Bar dataKey="open_at_end" name="Open at end" fill="#b39556" radius={[2, 2, 0, 0]} /><Bar dataKey="overdue_at_end" name="Overdue" fill="#b0412e" radius={[2, 2, 0, 0]} /></BarChart></ResponsiveContainer></div></Panel>
        </Section>
      )}
      {doc.charts.progress && doc.charts.progress.length > 1 && (
        <Section title="Progress during the period">
          <Panel className="px-2 pt-4"><div className="h-[180px]"><ResponsiveContainer width="100%" height="100%"><LineChart data={doc.charts.progress}><CartesianGrid vertical={false} stroke="#e1dccf" /><XAxis dataKey="date" tickFormatter={(v) => fmtDateShort(String(v))} tick={{ fontSize: 10.5, fill: '#767a74' }} axisLine={false} tickLine={false} /><YAxis domain={[0, 100]} unit="%" width={36} tick={{ fontSize: 10.5, fill: '#767a74' }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} /><Line type="stepAfter" dataKey="progress" stroke="#1f4d3a" strokeWidth={1.8} dot={{ r: 2.5 }} /></LineChart></ResponsiveContainer></div></Panel>
        </Section>
      )}

      {doc.tables.map((t) => (
        <Section key={t.key} title={`${t.title} · ${t.rows.length}`} actions={t.rows.length > 0 && <Button size="sm" variant="ghost" className="no-print" icon={<Download className="size-3.5" />} onClick={() => download(`${doc.meta.type}-${t.key}.csv`, toCsv(t.columns, t.rows))}>CSV</Button>}>
          {t.rows.length === 0 ? <p className="text-[13px] text-muted">None in this period.</p> : (
            <Table>
              <thead><tr>{t.columns.map((c) => <Th key={c.key}>{c.label}</Th>)}</tr></thead>
              <tbody>{t.rows.map((r, i) => <Tr key={i}>{t.columns.map((c) => <Td key={c.key} className="text-ink-2">{r[c.key] === null || r[c.key] === undefined || r[c.key] === '' ? '—' : String(r[c.key]).replace(/_/g, ' ')}</Td>)}</Tr>)}</tbody>
            </Table>
          )}
        </Section>
      ))}

      {(doc.notes.length > 0 || doc.meta.definitions.length > 0) && (
        <Section title="Notes & definitions">
          <ul className="space-y-1 text-[12.5px] text-muted">{[...doc.notes, ...doc.meta.definitions].map((n) => <li key={n}>· {n}</li>)}</ul>
        </Section>
      )}
    </article>
  )
}

export default function Reports() {
  const [params, setParams] = useSearchParams()
  const scopes = useQuery({ queryKey: ['reports', 'scopes'], queryFn: () => api.get<{ company: boolean; projects: { id: string; reference: string; name: string }[]; members: { id: string; name: string }[]; clients: { id: string; reference: string; name: string }[] }>('/api/reports/scopes') })
  const [type, setType] = useState<RType>((params.get('type') as RType) || 'company')
  const [scopeId, setScopeId] = useState(params.get('scopeId') ?? '')
  const [mode, setMode] = useState<'month' | 'custom'>('month')
  const [month, setMonth] = useState(todayIST().slice(0, 7))
  const [range, setRange] = useState(monthRange(prevMonth()))
  const [run, setRun] = useState<{ type: RType; scopeId: string; start: string; end: string } | null>(null)
  const [snapshotId, setSnapshotId] = useState<string | null>(null)
  useEffect(() => {
    if (scopes.data && !params.get('type') && !scopes.data.company) setType('member')
  }, [scopes.data, params])
  useEffect(() => {
    if (params.get('type') && params.get('scopeId')) setRun({ type: params.get('type') as RType, scopeId: params.get('scopeId')!, ...monthRange(todayIST().slice(0, 7)) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const period = mode === 'month' ? monthRange(month) : range
  const report = useQuery({
    queryKey: ['reports', 'run', run],
    queryFn: () => api.get<{ report: ReportDoc }>(`/api/reports/run${qs({ type: run!.type, scopeId: run!.type === 'company' ? undefined : run!.scopeId, start: run!.start, end: run!.end })}`).then((r) => r.report),
    enabled: !!run && !snapshotId,
  })
  const snapshot = useQuery({ queryKey: ['reports', 'snapshot', snapshotId], queryFn: () => api.get<{ report: ReportDoc; snapshot: { generatedAt: string; source: string } }>(`/api/reports/snapshots/${snapshotId}`), enabled: !!snapshotId })
  const snapshots = useQuery({ queryKey: ['reports', 'snapshots'], queryFn: () => api.get<{ snapshots: { id: string; report_type: RType; scope_name: string | null; period_start: string; period_end: string; source: string; generated_at: string; generated_by_name: string | null }[] }>('/api/reports/snapshots').then((r) => r.snapshots) })
  const save = useAction(() => api.post('/api/reports/snapshots', { type: run!.type, scopeId: run!.type === 'company' ? null : run!.scopeId, start: run!.start, end: run!.end }), { success: 'Snapshot saved — it will not change as data changes', invalidate: [['reports', 'snapshots']] })

  const options = useMemo(() => {
    const s = scopes.data
    if (!s) return []
    if (type === 'project') return s.projects.map((p) => ({ id: p.id, label: `${p.reference} · ${p.name}` }))
    if (type === 'member') return s.members.map((m) => ({ id: m.id, label: m.name }))
    if (type === 'client') return s.clients.map((c) => ({ id: c.id, label: `${c.name} (${c.reference})` }))
    return []
  }, [scopes.data, type])
  const canRun = type === 'company' ? scopes.data?.company : !!scopeId
  const go = () => {
    setSnapshotId(null)
    setRun({ type, scopeId, ...period })
    setParams(type === 'company' ? { type } : { type, scopeId })
  }

  return (
    <div>
      <PageHeader eyebrow="Insight" title="Reports" meta={<span>Figures are computed from recorded activity. Missing data is shown as “Not available”, never estimated.</span>} />
      <Panel className="no-print mb-8 p-4">
        <div className="grid items-end gap-3 md:grid-cols-[160px_minmax(0,1fr)_130px_minmax(0,260px)_auto]">
          <Field label="Report"><Select value={type} onChange={(e) => { setType(e.target.value as RType); setScopeId('') }}>{scopes.data?.company && <option value="company">Company</option>}<option value="project">Project</option><option value="member">Individual</option><option value="client">Client</option></Select></Field>
          <Field label={type === 'company' ? 'Scope' : type === 'project' ? 'Project' : type === 'member' ? 'Person' : 'Client'}>
            {type === 'company' ? <Input value="Visionary X — all work" disabled /> : <Select value={scopeId} onChange={(e) => setScopeId(e.target.value)}><option value="">Choose…</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>}
          </Field>
          <Field label="Period"><Select value={mode} onChange={(e) => setMode(e.target.value as 'month' | 'custom')}><option value="month">Month</option><option value="custom">Custom range</option></Select></Field>
          {mode === 'month' ? (
            <Field label="Month"><Input type="month" value={month} max={todayIST().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} /></Field>
          ) : (
            <div className="grid grid-cols-2 gap-2"><Field label="From"><Input type="date" value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} /></Field><Field label="To"><Input type="date" value={range.end} min={range.start} onChange={(e) => setRange({ ...range, end: e.target.value })} /></Field></div>
          )}
          <div className="flex gap-2"><Button variant="primary" icon={<Play className="size-4" />} disabled={!canRun} onClick={go}>Run</Button>{run && !snapshotId && report.data && <Button icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate()}>Save snapshot</Button>}</div>
        </div>
      </Panel>

      {snapshotId ? (
        snapshot.isLoading ? <SkeletonRows rows={10} /> : snapshot.error ? <ErrorState error={snapshot.error} /> : <ReportView doc={snapshot.data!.report} snapshot={snapshot.data!.snapshot} />
      ) : !run ? (
        <EmptyState icon={<FileText className="size-7" strokeWidth={1.4} />} title="Choose a report and period" body="Monthly reports for the company, a project, a person or a client. Export as CSV or print to PDF." />
      ) : report.isLoading ? <SkeletonRows rows={12} /> : report.error ? <ErrorState error={report.error} retry={() => report.refetch()} /> : report.data ? <ReportView doc={report.data} /> : null}

      <Section title="Saved snapshots" description="Frozen copies, including automatic month-end snapshots generated on the 1st of each month." className="no-print mt-12">
        {snapshots.isLoading ? <SkeletonRows rows={3} /> : !snapshots.data?.length ? <p className="text-[13px] text-muted">No snapshots yet.</p> : (
          <Table>
            <thead><tr><Th>Report</Th><Th>Period</Th><Th>Source</Th><Th>Generated</Th><Th /></tr></thead>
            <tbody>{snapshots.data.slice(0, 30).map((s) => (
              <Tr key={s.id} onClick={() => { setSnapshotId(s.id); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>
                <Td><span className="capitalize text-ink">{s.report_type}</span><div className="text-[12px] text-muted">{s.scope_name}</div></Td>
                <Td className="text-ink-2">{fmtDate(s.period_start)} – {fmtDate(s.period_end)}</Td>
                <Td><Badge tone={s.source === 'scheduled' ? 'forest' : 'outline'}>{s.source}</Badge></Td>
                <Td className="text-ink-2">{fmtDateTime(s.generated_at)}{s.generated_by_name && ` · ${s.generated_by_name}`}</Td>
                <Td align="right"><Archive className="ml-auto size-4 text-muted" /></Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Section>
    </div>
  )
}
