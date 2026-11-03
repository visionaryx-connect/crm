// Client portal: "Campaign performance". Results only: the API never sends spend or cost figures.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownRight, ArrowUpRight, MessageSquareText } from 'lucide-react'
import { AD_GOAL_LABEL, AD_GOAL_METRIC, AD_METRIC_LABEL, CLIENT_VISIBLE_AD_METRICS, type AdGoal, type AdMetric } from '@shared/constants'
import { portalApi } from '@/lib/api'
import { fmtDate } from '@/lib/format'
import { EmptyState, ErrorState, Panel, Section, Select, SkeletonRows, Table, Td, Th, Tr } from '@/components/ui'

type Visible = (typeof CLIENT_VISIBLE_AD_METRICS)[number]
interface PortalAds {
  publishedThrough: string | null
  goals: { goal: AdGoal; isPrimary: boolean }[]
  months: string[]
  month: string | null
  comparedDays: number | null
  totals: Partial<Record<Visible, number>>
  previous: Partial<Record<Visible, number>>
  daily: { date: string; metric: Visible; value: number }[]
  campaigns: { name: string; metric: Visible; value: number }[]
  note: { body: string; updated_at: string } | null
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-IN')
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })

function Change({ now, before, days }: { now: number; before: number | undefined; days: number | null }) {
  if (!before) return <span className="text-[12.5px] text-muted">No earlier month to compare</span>
  const pct = Math.round(((now - before) / before) * 100)
  const up = pct >= 0
  return (
    <span className={`inline-flex items-center gap-1 text-[12.5px] ${up ? 'text-ok' : 'text-warn'}`}>
      {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
      {up ? '+' : ''}{pct}% vs {days ? `the same ${days} day${days === 1 ? '' : 's'} last month` : 'last month'}
    </span>
  )
}

/** Daily bars for one metric. Plain SVG so it stays light and prints well. */
function DailyBars({ data, month, label }: { data: { date: string; value: number }[]; month: string; label: string }) {
  const [y, m] = month.split('-').map(Number)
  const days = new Date(Date.UTC(y!, m!, 0)).getUTCDate()
  const byDay = new Map(data.map((d) => [Number(d.date.slice(8, 10)), d.value]))
  const max = Math.max(1, ...data.map((d) => d.value))
  const W = 640, H = 160, pad = 18, bw = (W - pad * 2) / days
  const [hover, setHover] = useState<number | null>(null)
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full" role="img" aria-label={`${label} per day`}>
        <line x1={pad} x2={W - pad} y1={H} y2={H} stroke="currentColor" className="text-line" />
        {Array.from({ length: days }, (_, i) => {
          const v = byDay.get(i + 1) ?? 0
          const h = (v / max) * (H - 12)
          return (
            <g key={i} onMouseEnter={() => setHover(i + 1)} onMouseLeave={() => setHover(null)}>
              <rect x={pad + i * bw} y={0} width={bw} height={H} fill="transparent" />
              <rect x={pad + i * bw + bw * 0.15} y={H - h} width={bw * 0.7} height={h} rx={2} className={hover === i + 1 ? 'fill-highlight' : 'fill-accent'} />
              {(i === 0 || (i + 1) % 5 === 0) && <text x={pad + i * bw + bw / 2} y={H + 15} textAnchor="middle" className="fill-muted text-[10px]">{i + 1}</text>}
            </g>
          )
        })}
      </svg>
      <p className="h-5 text-[12.5px] text-ink-2">{hover ? <>{fmtDate(`${month}-${String(hover).padStart(2, '0')}`)}: <span className="font-medium text-ink">{fmt(byDay.get(hover) ?? 0)}</span> {label.toLowerCase()}</> : 'Point at a bar to see the day.'}</p>
    </div>
  )
}

export default function CampaignPerformance() {
  const [month, setMonth] = useState<string | undefined>()
  const q = useQuery({ queryKey: ['portal', 'ads', month ?? 'latest'], queryFn: () => portalApi.get<PortalAds>(`/api/portal/ads${month ? `?month=${month}` : ''}`) })
  if (q.isLoading) return <SkeletonRows rows={6} />
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const d = q.data
  if (!d.month) return <EmptyState title="Your campaign results will appear here" body="Your account manager publishes them once they have been checked." />

  const goals = d.goals.length ? d.goals : []
  const primary = goals.find((g) => g.isPrimary)?.goal
  const headline: Visible[] = goals.map((g) => AD_GOAL_METRIC[g.goal]).filter((m): m is Visible => m !== 'spend')
  const main = primary ? (AD_GOAL_METRIC[primary] as Visible) : (headline[0] ?? 'link_clicks')
  const supporting = (['impressions', 'link_clicks', 'landing_page_views', 'follows', 'profile_visits', 'call_taps', 'leads'] as Visible[])
    .filter((m) => m !== main && d.totals[m] !== undefined)
    .slice(0, 3)
  const campaignMetrics = [main, ...supporting]
  const byCampaign = new Map<string, Partial<Record<AdMetric, number>>>()
  for (const r of d.campaigns) byCampaign.set(r.name, { ...byCampaign.get(r.name), [r.metric]: r.value })
  const isPartial = d.publishedThrough && d.publishedThrough.startsWith(d.month) && d.publishedThrough < new Date(Date.UTC(Number(d.month.slice(0, 4)), Number(d.month.slice(5)), 0)).toISOString().slice(0, 10)

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow mb-1">Meta ads · {goals.map((g) => AD_GOAL_LABEL[g.goal]).join(' · ') || 'Results'}</div>
          <h1 className="display text-[34px] text-ink">Campaign performance</h1>
          <p className="mt-1 text-[13px] text-muted">{isPartial ? `Results up to ${fmtDate(d.publishedThrough)}` : monthLabel(d.month)}</p>
        </div>
        {d.months.length > 1 && (
          <Select value={d.month} onChange={(e) => setMonth(e.target.value)} className="w-48" aria-label="Month">
            {d.months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </Select>
        )}
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <Panel className="p-5">
          <div className="eyebrow">{AD_METRIC_LABEL[main].label}</div>
          <div className="mt-2 font-display text-[44px] font-bold leading-none tracking-[-0.02em] tabular">{fmt(d.totals[main] ?? 0)}</div>
          <div className="mt-2"><Change now={d.totals[main] ?? 0} before={d.previous[main]} days={d.comparedDays} /></div>
          <p className="mt-2 text-[12.5px] text-muted">{AD_METRIC_LABEL[main].help}</p>
        </Panel>
        {supporting.map((m) => (
          <Panel key={m} className="p-5">
            <div className="eyebrow">{AD_METRIC_LABEL[m].label}</div>
            <div className="mt-2 font-display text-[26px] font-bold leading-none tabular">{fmt(d.totals[m] ?? 0)}</div>
            <div className="mt-2"><Change now={d.totals[m] ?? 0} before={d.previous[m]} days={d.comparedDays} /></div>
            <p className="mt-2 text-[12px] text-muted">{AD_METRIC_LABEL[m].help}</p>
          </Panel>
        ))}
      </div>

      {d.note && (
        <Panel className="mt-6 p-5">
          <div className="eyebrow mb-2 inline-flex items-center gap-1.5"><MessageSquareText className="size-3.5" />Note from your account manager</div>
          <p className="whitespace-pre-wrap text-[14px] text-ink-2">{d.note.body}</p>
        </Panel>
      )}

      <Section title={`${AD_METRIC_LABEL[main].label} per day`} className="mt-8">
        <Panel className="p-4"><DailyBars month={d.month} label={AD_METRIC_LABEL[main].label} data={d.daily.filter((x) => x.metric === main)} /></Panel>
      </Section>

      <Section title="By campaign">
        <Table>
          <thead><tr><Th>Campaign</Th>{campaignMetrics.map((m) => <Th key={m} align="right">{AD_METRIC_LABEL[m].label}</Th>)}</tr></thead>
          <tbody>{[...byCampaign.entries()].map(([name, row]) => (
            <Tr key={name}><Td className="font-medium">{name}</Td>{campaignMetrics.map((m) => <Td key={m} align="right">{fmt(row[m] ?? 0)}</Td>)}</Tr>
          ))}</tbody>
        </Table>
      </Section>
    </div>
  )
}
