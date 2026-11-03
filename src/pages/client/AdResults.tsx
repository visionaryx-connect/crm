// Staff-side "Ad results" tab on the client page: goals, Meta account & campaigns, daily results, publishing.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useToast } from '@/components/toast'
import { Plus, Send, Upload } from 'lucide-react'
import { parseMetaCsv, type MetaCsvResult } from '@shared/metaCsv'
import { AD_GOALS, AD_GOAL_LABEL, AD_GOAL_METRIC, AD_METRICS, AD_METRIC_LABEL, type AdGoal, type AdMetric } from '@shared/constants'
import { api, ApiError } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { fmtDate, todayIST } from '@/lib/format'
import { Badge, Button, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, Panel, Section, Select, SkeletonRows, StatStrip, Table, Td, Th, Tr } from '@/components/ui'

interface AdData {
  goals: { goal: AdGoal; isPrimary: boolean }[]
  accounts: { id: string; name: string; external_id: string | null }[]
  campaigns: { id: string; ad_account_id: string; name: string }[]
  results: { campaign_id: string; date: string; metric: AdMetric; value: number; source: string }[]
  publishedThrough: string | null
}

const fmtNum = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
const monthStart = (d: string) => `${d.slice(0, 7)}-01`
const monthEnd = (d: string) => {
  const [y, m] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

function GoalsPanel({ clientId, data, canManage }: { clientId: string; data: AdData; canManage: boolean }) {
  const [goals, setGoals] = useState<AdGoal[]>(data.goals.map((g) => g.goal))
  const [primary, setPrimary] = useState<AdGoal | ''>(data.goals.find((g) => g.isPrimary)?.goal ?? '')
  const [error, setError] = useState('')
  const save = useAction(() => api.put(`/api/ads/clients/${clientId}/goals`, { goals, primary: primary || null }), {
    success: 'Goals saved',
    invalidate: [['ads', clientId]],
    onError: (e) => e instanceof ApiError && setError(e.fields.primary ?? e.message),
  })
  const toggle = (g: AdGoal, on: boolean) => {
    const next = on ? [...goals, g] : goals.filter((x) => x !== g)
    setGoals(next)
    if (!next.includes(primary as AdGoal)) setPrimary(next[0] ?? '')
  }
  return (
    <Panel className="p-4">
      <div className="eyebrow mb-3">What should the ads achieve?</div>
      <div className="space-y-2">
        {AD_GOALS.map((g) => (
          <Checkbox key={g} label={AD_GOAL_LABEL[g]} description={`Headline number: ${AD_METRIC_LABEL[AD_GOAL_METRIC[g]].label}`} checked={goals.includes(g)} disabled={!canManage} onChange={(e) => toggle(g, e.target.checked)} />
        ))}
      </div>
      {goals.length > 1 && (
        <Field label="Main goal" className="mt-3" error={error}>
          <Select value={primary} disabled={!canManage} onChange={(e) => setPrimary(e.target.value as AdGoal)}>
            {goals.map((g) => <option key={g} value={g}>{AD_GOAL_LABEL[g]}</option>)}
          </Select>
        </Field>
      )}
      {canManage && <Button size="sm" variant="primary" className="mt-3" loading={save.isPending} onClick={() => save.mutate()}>Save goals</Button>}
    </Panel>
  )
}

function AccountsPanel({ clientId, data, canManage }: { clientId: string; data: AdData; canManage: boolean }) {
  const [acc, setAcc] = useState({ name: '', externalId: '' })
  const [camp, setCamp] = useState({ accountId: '', name: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const addAcc = useAction(() => api.post(`/api/ads/clients/${clientId}/accounts`, { name: acc.name, externalId: acc.externalId || null }), {
    success: 'Ad account linked', invalidate: [['ads', clientId]], onSuccess: () => { setAcc({ name: '', externalId: '' }); setErrors({}) },
    onError: (e) => e instanceof ApiError && setErrors(e.fields),
  })
  const addCamp = useAction(() => api.post(`/api/ads/accounts/${camp.accountId || data.accounts[0]?.id}/campaigns`, { name: camp.name }), {
    success: 'Campaign added', invalidate: [['ads', clientId]], onSuccess: () => setCamp({ ...camp, name: '' }),
    onError: (e) => e instanceof ApiError && setErrors(e.fields),
  })
  return (
    <Panel className="p-4">
      <div className="eyebrow mb-3">Meta ad account & campaigns</div>
      {data.accounts.length === 0 ? <p className="text-[13px] text-muted">No ad account linked yet.</p> : (
        <ul className="space-y-3">
          {data.accounts.map((a) => (
            <li key={a.id}>
              <p className="font-medium text-ink">{a.name} {a.external_id && <span className="font-mono text-[11.5px] text-muted">{a.external_id}</span>}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {data.campaigns.filter((k) => k.ad_account_id === a.id).map((k) => <Badge key={k.id} tone="outline">{k.name}</Badge>)}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Account name" error={errors.name}><Input value={acc.name} onChange={(e) => setAcc({ ...acc, name: e.target.value })} /></Field>
            <Field label="Meta account id" error={errors.externalId}><Input placeholder="act_1234567890" value={acc.externalId} onChange={(e) => setAcc({ ...acc, externalId: e.target.value })} /></Field>
            <Button size="sm" icon={<Plus className="size-3.5" />} loading={addAcc.isPending} onClick={() => addAcc.mutate()}>Link</Button>
          </div>
          {data.accounts.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="Account"><Select value={camp.accountId} onChange={(e) => setCamp({ ...camp, accountId: e.target.value })}>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
              <Field label="Campaign name"><Input value={camp.name} onChange={(e) => setCamp({ ...camp, name: e.target.value })} /></Field>
              <Button size="sm" icon={<Plus className="size-3.5" />} loading={addCamp.isPending} disabled={!camp.name.trim()} onClick={() => addCamp.mutate()}>Add</Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

function ResultsDialog({ clientId, data, open, onClose }: { clientId: string; data: AdData; open: boolean; onClose: () => void }) {
  const [date, setDate] = useState(todayIST())
  const [campaignId, setCampaignId] = useState(data.campaigns[0]?.id ?? '')
  const [values, setValues] = useState<Partial<Record<AdMetric, string>>>({})
  const [error, setError] = useState('')
  const rows = AD_METRICS.filter((m) => values[m] !== undefined && values[m] !== '').map((m) => ({ campaignId, date, metric: m, value: Number(values[m]) }))
  const save = useAction(() => api.put(`/api/ads/clients/${clientId}/results`, { source: 'manual', rows }), {
    success: 'Results saved', invalidate: [['ads', clientId]], onSuccess: () => { setValues({}); onClose() },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save'),
  })
  return (
    <Dialog open={open} onClose={onClose} title="Enter daily results" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={rows.length === 0 || !campaignId} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date" required><Input type="date" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Campaign" required><Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>{data.campaigns.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</Select></Field>
        {AD_METRICS.map((m) => (
          <Field key={m} label={AD_METRIC_LABEL[m].label} hint={AD_METRIC_LABEL[m].help}>
            <Input type="number" min={0} step="any" value={values[m] ?? ''} onChange={(e) => setValues({ ...values, [m]: e.target.value })} />
          </Field>
        ))}
      </div>
      <p className="mt-3 text-[12.5px] text-muted">Leave a box empty to skip it. Saving the same day again replaces its numbers.</p>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
    </Dialog>
  )
}

function CsvDialog({ clientId, data, open, onClose }: { clientId: string; data: AdData; open: boolean; onClose: () => void }) {
  const [accountId, setAccountId] = useState(data.accounts[0]?.id ?? '')
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<MetaCsvResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const qc = useQueryClient()
  const toast = useToast()
  const known = new Map(data.campaigns.filter((k) => k.ad_account_id === accountId).map((k) => [k.name.trim().toLowerCase(), k.id]))
  const newCampaigns = parsed?.campaigns.filter((n) => !known.has(n.toLowerCase())) ?? []
  const dates = parsed?.rows.map((r) => r.date).sort() ?? []

  const onFile = async (f: File | undefined) => {
    setError('')
    setParsed(null)
    if (!f) return
    if (f.size > 5 * 1024 * 1024) return setError('That file is larger than 5 MB. Export a shorter date range.')
    setFileName(f.name)
    setParsed(parseMetaCsv(await f.text()))
  }

  const run = async () => {
    if (!parsed) return
    setBusy(true)
    setError('')
    try {
      const ids = new Map(known)
      for (const name of newCampaigns) {
        const r = await api.post<{ id: string }>(`/api/ads/accounts/${accountId}/campaigns`, { name })
        ids.set(name.toLowerCase(), r.id)
      }
      const rows = parsed.rows.map((r) => ({ campaignId: ids.get(r.campaign.toLowerCase())!, date: r.date, metric: r.metric, value: r.value }))
      for (let i = 0; i < rows.length; i += 2000) await api.put(`/api/ads/clients/${clientId}/results`, { source: 'csv', rows: rows.slice(i, i + 2000) })
      toast({ tone: 'ok', title: `Imported ${rows.length.toLocaleString('en-IN')} results` })
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Import failed. Nothing after the last saved batch was imported.')
    } finally {
      setBusy(false)
      qc.invalidateQueries({ queryKey: ['ads', clientId] })
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Upload Meta Ads CSV" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!parsed || parsed.rows.length === 0 || !accountId} onClick={run}>Import</Button></>}>
      <div className="space-y-4">
        <p className="text-[13px] text-ink-2">In Ads Manager: open <span className="text-ink">Reports</span>, set <span className="text-ink">Breakdown → By time → Day</span>, then <span className="text-ink">Export table data → .csv</span>. Re-uploading the same days replaces their numbers.</p>
        <Field label="Ad account"><Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="CSV file"><Input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} /></Field>
        {parsed && (
          <Panel className="p-3 text-[13px]">
            <p className="font-medium text-ink">{fileName}</p>
            {parsed.rows.length > 0 && (
              <ul className="mt-2 space-y-1 text-ink-2">
                <li>{parsed.rows.length.toLocaleString('en-IN')} results from {fmtDate(dates[0])} to {fmtDate(dates[dates.length - 1])}</li>
                <li>Columns: {parsed.columns.map((m) => AD_METRIC_LABEL[m].label).join(', ')}</li>
                <li>{parsed.campaigns.length} campaign(s){newCampaigns.length > 0 && <> · <span className="text-ink">{newCampaigns.length} new, will be added:</span> {newCampaigns.join(', ')}</>}</li>
              </ul>
            )}
            {parsed.warnings.map((w) => <p key={w} className="mt-2 text-warn">{w}</p>)}
          </Panel>
        )}
        {error && <p className="text-[13px] text-danger">{error}</p>}
      </div>
    </Dialog>
  )
}

export default function AdResults({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  const [month, setMonth] = useState(todayIST().slice(0, 7))
  const from = monthStart(`${month}-01`)
  const to = monthEnd(from)
  const q = useQuery({ queryKey: ['ads', clientId, month], queryFn: () => api.get<AdData>(`/api/ads/clients/${clientId}?from=${from}&to=${to}`) })
  const [entering, setEntering] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [through, setThrough] = useState('')
  const publish = useAction((t: string | null) => api.post(`/api/ads/clients/${clientId}/publish`, { through: t }), { success: 'Portal updated', invalidate: [['ads', clientId]] })

  const totals = useMemo(() => {
    const t: Partial<Record<AdMetric, number>> = {}
    for (const r of q.data?.results ?? []) t[r.metric] = (t[r.metric] ?? 0) + r.value
    return t
  }, [q.data])
  const byCampaign = useMemo(() => {
    const m = new Map<string, Partial<Record<AdMetric, number>>>()
    for (const r of q.data?.results ?? []) {
      const row = m.get(r.campaign_id) ?? {}
      row[r.metric] = (row[r.metric] ?? 0) + r.value
      m.set(r.campaign_id, row)
    }
    return m
  }, [q.data])

  if (q.isLoading) return <SkeletonRows rows={8} />
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const d = q.data
  const primary = d.goals.find((g) => g.isPrimary)?.goal
  const shownMetrics = AD_METRICS.filter((m) => m !== 'spend' && totals[m] !== undefined)

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        <Section
          title="Results"
          description="Daily numbers from Meta. Clients never see spend or cost figures."
          actions={<div className="flex items-center gap-2"><Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-40" />{canManage && d.accounts.length > 0 && <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => setUploading(true)}>Upload CSV</Button>}{canManage && d.campaigns.length > 0 && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEntering(true)}>Enter results</Button>}</div>}
        >
          {d.results.length === 0 ? (
            <EmptyState title="No results for this month" body={d.campaigns.length === 0 ? 'Link the Meta ad account and add a campaign first.' : 'Enter the numbers from Meta Ads Manager.'} />
          ) : (
            <>
              <StatStrip stats={[
                ...(primary ? [{ label: `${AD_METRIC_LABEL[AD_GOAL_METRIC[primary]].label} ★`, hint: "Main goal", value: fmtNum(totals[AD_GOAL_METRIC[primary]] ?? 0) }] : []),
                ...shownMetrics.filter((m) => !primary || m !== AD_GOAL_METRIC[primary]).slice(0, 2).map((m) => ({ label: AD_METRIC_LABEL[m].label, value: fmtNum(totals[m] ?? 0) })),
                { label: 'Spend', hint: 'Internal only', value: fmtNum(totals.spend ?? 0) },
              ]} />
              <div className="mt-6">
                <Table>
                  <thead><tr><Th>Campaign</Th>{shownMetrics.map((m) => <Th key={m} align="right">{AD_METRIC_LABEL[m].label}</Th>)}<Th align="right">Spend (internal)</Th></tr></thead>
                  <tbody>{d.campaigns.filter((k) => byCampaign.has(k.id)).map((k) => {
                    const row = byCampaign.get(k.id)!
                    return <Tr key={k.id}><Td className="font-medium">{k.name}</Td>{shownMetrics.map((m) => <Td key={m} align="right">{fmtNum(row[m] ?? 0)}</Td>)}<Td align="right" className="text-muted">{fmtNum(row.spend ?? 0)}</Td></Tr>
                  })}</tbody>
                </Table>
              </div>
            </>
          )}
        </Section>
      </div>
      <aside className="grid gap-6 items-start sm:grid-cols-2 xl:grid-cols-1 xl:content-start">
        <Panel className="p-4">
          <div className="eyebrow mb-2">Client portal</div>
          <p className="text-[13px] text-ink-2">{d.publishedThrough ? <>Client can see results up to <span className="font-medium text-ink">{fmtDate(d.publishedThrough)}</span>.</> : 'Nothing published to the client yet.'}</p>
          {canManage && (
            <div className="mt-3 flex items-end gap-2">
              <Field label="Publish up to"><Input type="date" value={through} max={todayIST()} onChange={(e) => setThrough(e.target.value)} /></Field>
              <Button size="sm" icon={<Send className="size-3.5" />} disabled={!through} loading={publish.isPending} onClick={() => publish.mutate(through)}>Publish</Button>
            </div>
          )}
          {canManage && d.publishedThrough && <Button size="sm" variant="ghost" className="mt-2" onClick={() => publish.mutate(null)}>Hide from client</Button>}
        </Panel>
        <GoalsPanel key={d.goals.map((g) => g.goal).join()} clientId={clientId} data={d} canManage={canManage} />
        <AccountsPanel clientId={clientId} data={d} canManage={canManage} />
      </aside>
      {uploading && <CsvDialog clientId={clientId} data={d} open onClose={() => setUploading(false)} />}
      {entering && <ResultsDialog clientId={clientId} data={d} open onClose={() => setEntering(false)} />}
    </div>
  )
}
