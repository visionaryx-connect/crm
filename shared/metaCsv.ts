// Parses a Meta Ads Manager CSV export into daily result rows. English and Tamil Ads Manager headers are recognised.
// Best export: Reports → Export table data → .csv, with "Breakdown: By time → Day".
// Exports without a Day breakdown are accepted too: each row's totals are stored on its "Reporting ends" date.
import type { AdMetric } from './constants'

export interface MetaCsvRow { campaign: string; date: string; metric: AdMetric; value: number }
export interface MetaCsvResult {
  rows: MetaCsvRow[]; campaigns: string[]; columns: AdMetric[]; warnings: string[]
  /** 'day' = one row per day; 'period' = whole-period totals stored on the period's end date. */
  mode?: 'day' | 'period'
}

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
  // Tamil Ads Manager
  [/^தோன்றல்கள்$/, 'impressions'],
  [/^(பார்வை|சென்றடைதல்)$/, 'reach'],
  [/^செலவிட்ட தொகை$/, 'spend'],
]
/** Name columns in order of preference: campaign, then ad set, then ad. */
const NAME_HEADERS = [
  ['campaign name', 'campaign', 'பிரச்சாரப் பெயர்', 'பிரச்சாரத்தின் பெயர்'],
  ['ad set name', 'விளம்பரத் தொகுப்பின் பெயர்', 'விளம்பரத் தொகுப்புப் பெயர்'],
  ['ad name', 'விளம்பரப்பெயர்', 'விளம்பரப் பெயர்'],
]
const DATE_HEADERS = ['day', 'date', 'நாள்']
const START_HEADERS = ['reporting starts', 'அறிக்கையிடத் தொடங்கியவை']
const END_HEADERS = ['reporting ends', 'அறிக்கையிடல் முடிவடைகிறது']
const RESULTS_HEADERS = ['results', 'விளைவுகள்', 'முடிவுகள்']
const INDICATOR_HEADERS = ['result indicator', 'முடிவுக் குறிகாட்டி']

/** Meta's "Result indicator" values → metric. Unknown indicators are reported, not guessed. */
export function indicatorMetric(ind: string): AdMetric | null {
  const t = ind.trim().toLowerCase().replace(/^actions:/, '')
  if (t === 'reach') return 'reach'
  if (t === 'impressions') return 'impressions'
  if (/click_to_call|call_placed|call_confirm/.test(t)) return 'call_taps'
  if (t === 'link_click') return 'link_clicks'
  if (t === 'landing_page_view') return 'landing_page_views'
  if (/lead/.test(t)) return 'leads'
  if (/like|follow/.test(t)) return 'follows'
  if (/profile_visit/.test(t)) return 'profile_visits'
  return null
}

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

/** undefined = blank cell, null = not a valid non-negative number. */
function num(v: string | undefined): number | null | undefined {
  const raw = (v ?? '').replace(/[,\s₹$]/g, '')
  if (raw === '' || raw === '-') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function parseMetaCsv(text: string): MetaCsvResult {
  const table = parseCsv(text)
  const warnings: string[] = []
  if (table.length < 2) return { rows: [], campaigns: [], columns: [], warnings: ['The file has no data rows.'] }
  const headers = table[0].map(normHeader)
  const col = (names: string[]) => headers.findIndex((h) => names.includes(h))
  const nameCol = NAME_HEADERS.map(col).find((i) => i >= 0) ?? -1
  const dateCol = col(DATE_HEADERS)
  const startCol = col(START_HEADERS)
  const endCol = col(END_HEADERS)
  const resultsCol = col(RESULTS_HEADERS)
  const indicatorCol = col(INDICATOR_HEADERS)
  const mode: 'day' | 'period' = dateCol >= 0 ? 'day' : 'period'
  if (nameCol < 0) warnings.push('No "Campaign name" or "Ad name" column found.')
  if (dateCol < 0 && endCol < 0) warnings.push('No "Day" or "Reporting ends" column found. Export with Breakdown → By time → Day.')
  const metricCols: [number, AdMetric][] = []
  headers.forEach((h, i) => {
    const hit = HEADER_MAP.find(([re]) => re.test(h))
    if (hit && !metricCols.some(([, m]) => m === hit[1])) metricCols.push([i, hit[1]])
  })
  const hasResults = resultsCol >= 0 && indicatorCol >= 0
  if (metricCols.length === 0 && !hasResults) warnings.push('No result columns recognised (e.g. Impressions, Link clicks, Landing page views).')
  if (nameCol < 0 || (dateCol < 0 && endCol < 0) || (metricCols.length === 0 && !hasResults)) {
    return { rows: [], campaigns: [], columns: [], warnings }
  }

  // Summing guards against exports that split one campaign-day over several rows (e.g. by placement).
  const sums = new Map<string, MetaCsvRow>()
  const add = (campaign: string, date: string, metric: AdMetric, value: number) => {
    const key = `${campaign}\u0000${date}\u0000${metric}`
    sums.set(key, { campaign, date, metric, value: (sums.get(key)?.value ?? 0) + value })
  }
  let skipped = 0
  const unknownIndicators = new Set<string>()
  const periods = new Set<string>()
  for (const r of table.slice(1)) {
    const campaign = (r[nameCol] ?? '').trim()
    const date = normDate(r[dateCol >= 0 ? dateCol : endCol] ?? '')
    if (!campaign || !date) { skipped++; continue } // totals row, blank lines
    if (mode === 'period' && startCol >= 0) {
      const start = normDate(r[startCol] ?? '')
      if (start && start !== date) periods.add(`${start} to ${date}`)
    }
    for (const [i, metric] of metricCols) {
      const v = num(r[i])
      if (v === undefined) continue
      if (v === null) { skipped++; continue }
      add(campaign, date, metric, v)
    }
    if (hasResults) {
      const v = num(r[resultsCol])
      const ind = (r[indicatorCol] ?? '').trim()
      if (v === undefined || !ind) continue
      if (v === null) { skipped++; continue }
      const metric = indicatorMetric(ind)
      if (!metric) { unknownIndicators.add(ind); continue }
      // The same number already has its own column (e.g. Reach): don't count it twice.
      if (!metricCols.some(([, m]) => m === metric)) add(campaign, date, metric, v)
    }
  }
  if (skipped) warnings.push(`Skipped ${skipped} row(s) or value(s) without a name, a valid date or a valid number (e.g. the totals row).`)
  if (unknownIndicators.size) warnings.push(`Results not imported for unrecognised result type(s): ${[...unknownIndicators].join(', ')}.`)
  if (periods.size) {
    warnings.push(`This file has no Day breakdown. Totals for ${[...periods].join(', ')} will be saved on the last day of the period, so charts show one spike instead of a daily trend. For daily results, export with Breakdown → By time → Day.`)
  }
  const rows = [...sums.values()]
  return {
    rows,
    campaigns: [...new Set(rows.map((r) => r.campaign))].sort(),
    columns: [...new Set(rows.map((r) => r.metric))],
    warnings,
    mode,
  }
}
