// Parses a Meta Ads Manager CSV export (broken down by day) into daily result rows.
// Export settings the team should use: Reports → Export table data → .csv, with "Breakdown: By time → Day".
import type { AdMetric } from './constants'

export interface MetaCsvRow { campaign: string; date: string; metric: AdMetric; value: number }
export interface MetaCsvResult { rows: MetaCsvRow[]; campaigns: string[]; columns: AdMetric[]; warnings: string[] }

/** Header (lower-cased, currency suffix removed) → metric. First match wins. */
const HEADER_MAP: [RegExp, AdMetric][] = [
  [/^impressions$/, 'impressions'],
  [/^reach$/, 'reach'],
  [/^link clicks$/, 'link_clicks'],
  [/^(website )?landing page views$/, 'landing_page_views'],
  [/^(page likes|page follows|follows|instagram follows|follows or likes)$/, 'follows'],
  [/^(instagram )?profile visits$/, 'profile_visits'],
  [/^(calls placed|call clicks|clicks to call)$/, 'call_taps'],
  [/^(leads|on-facebook leads|meta leads|website leads)$/, 'leads'],
  [/^amount spent$/, 'spend'],
]
const CAMPAIGN_HEADERS = ['campaign name', 'campaign']
// Not "Reporting starts": without a Day breakdown that column is the period start, and the row is a whole-period total.
const DATE_HEADERS = ['day', 'date']

/** RFC 4180-ish CSV parser: quoted fields, escaped quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((f) => f.trim() !== '')) out.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) out.push(row)
  return out
}

const normHeader = (h: string) => h.trim().toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ')

/** Accepts YYYY-MM-DD, DD/MM/YYYY and DD-MM-YYYY (Indian locale exports). */
export function normDate(v: string): string | null {
  const t = v.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (m) return t
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return null
}

export function parseMetaCsv(text: string): MetaCsvResult {
  const table = parseCsv(text)
  const warnings: string[] = []
  if (table.length < 2) return { rows: [], campaigns: [], columns: [], warnings: ['The file has no data rows.'] }
  const headers = table[0].map(normHeader)
  const campaignCol = headers.findIndex((h) => CAMPAIGN_HEADERS.includes(h))
  const dateCol = headers.findIndex((h) => DATE_HEADERS.includes(h))
  if (campaignCol < 0) warnings.push('No "Campaign name" column found.')
  if (dateCol < 0) warnings.push('No "Day" column found. Export with Breakdown → By time → Day.')
  const metricCols: [number, AdMetric][] = []
  headers.forEach((h, i) => {
    const hit = HEADER_MAP.find(([re]) => re.test(h))
    if (hit && !metricCols.some(([, m]) => m === hit[1])) metricCols.push([i, hit[1]])
  })
  if (metricCols.length === 0) warnings.push('No result columns recognised (e.g. Impressions, Link clicks, Landing page views).')
  if (campaignCol < 0 || dateCol < 0 || metricCols.length === 0) return { rows: [], campaigns: [], columns: [], warnings }

  // Summing guards against exports that split one campaign-day over several rows (e.g. by placement).
  const sums = new Map<string, MetaCsvRow>()
  let skipped = 0
  for (const r of table.slice(1)) {
    const campaign = (r[campaignCol] ?? '').trim()
    const date = normDate(r[dateCol] ?? '')
    if (!campaign || !date) { skipped++; continue } // totals row, blank lines
    for (const [i, metric] of metricCols) {
      const raw = (r[i] ?? '').replace(/[,\s₹$]/g, '')
      if (raw === '' || raw === '-') continue
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0) { skipped++; continue }
      const key = `${campaign}\u0000${date}\u0000${metric}`
      const prev = sums.get(key)
      sums.set(key, { campaign, date, metric, value: (prev?.value ?? 0) + value })
    }
  }
  if (skipped) warnings.push(`Skipped ${skipped} row(s) or value(s) without a campaign, a valid day or a valid number (e.g. the totals row).`)
  const rows = [...sums.values()]
  return { rows, campaigns: [...new Set(rows.map((r) => r.campaign))].sort(), columns: metricCols.map(([, m]) => m), warnings }
}
