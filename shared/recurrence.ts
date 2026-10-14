// Minimal RFC 5545 RRULE support for calendar events:
//   FREQ=DAILY|WEEKLY|MONTHLY ; INTERVAL=n ; BYDAY=MO,TU,.. (weekly only) ; UNTIL=YYYYMMDD ; COUNT=n
// Occurrences keep the local wall-clock time of the first instance in the company timezone.

import { COMPANY_TZ } from './constants'
import { localDate, tzOffsetMinutes } from './dates'

export interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  interval: number
  byDay?: number[]
  until?: string // YYYY-MM-DD inclusive
  count?: number
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

export function parseRule(rule: string): Rule {
  const parts = Object.fromEntries(
    rule.split(';').filter(Boolean).map((p) => {
      const [k, v] = p.split('=')
      return [k?.trim().toUpperCase(), v?.trim().toUpperCase()]
    }),
  ) as Record<string, string | undefined>
  const freq = parts.FREQ
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') throw new Error('FREQ must be DAILY, WEEKLY or MONTHLY')
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) throw new Error('INTERVAL must be 1–52')
  const out: Rule = { freq, interval }
  if (parts.BYDAY) {
    if (freq !== 'WEEKLY') throw new Error('BYDAY is supported only for WEEKLY rules')
    const days = parts.BYDAY.split(',').map((d) => DAY_CODES.indexOf(d))
    if (days.some((d) => d < 0)) throw new Error('BYDAY must use SU,MO,TU,WE,TH,FR,SA')
    out.byDay = [...new Set(days)].sort()
  }
  if (parts.UNTIL) {
    if (!/^\d{8}$/.test(parts.UNTIL)) throw new Error('UNTIL must be YYYYMMDD')
    out.until = `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
  }
  if (parts.COUNT) {
    const c = Number(parts.COUNT)
    if (!Number.isInteger(c) || c < 1 || c > 500) throw new Error('COUNT must be 1–500')
    out.count = c
  }
  return out
}

export interface Occurrence {
  startAt: string
  endAt: string
  index: number
}

/**
 * Expand a recurring event into occurrences overlapping [rangeFrom, rangeTo).
 * Hard-capped to protect Worker CPU time.
 */
export function expandOccurrences(
  startAt: string,
  endAt: string,
  rule: string | null,
  rangeFrom: string,
  rangeTo: string,
  tz = COMPANY_TZ,
  cap = 400,
): Occurrence[] {
  const start = new Date(startAt)
  const durMs = new Date(endAt).getTime() - start.getTime()
  const from = new Date(rangeFrom).getTime()
  const to = new Date(rangeTo).getTime()
  const out: Occurrence[] = []
  const push = (s: Date, index: number) => {
    const e = new Date(s.getTime() + durMs)
    if (e.getTime() > from && s.getTime() < to) out.push({ startAt: s.toISOString(), endAt: e.toISOString(), index })
  }
  if (!rule) {
    push(start, 0)
    return out
  }
  const r = parseRule(rule)
  // Local wall-clock components of the first occurrence.
  const offset = tzOffsetMinutes(start, tz)
  const local = new Date(start.getTime() + offset * 60000)
  const hh = local.getUTCHours()
  const mm = local.getUTCMinutes()
  const firstDate = localDate(start, tz)
  const atLocal = (date: string): Date => {
    const guess = new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`)
    return new Date(guess.getTime() - tzOffsetMinutes(guess, tz) * 60000)
  }
  let produced = 0
  const done = (date: string) => (r.until && date > r.until) || (r.count != null && produced >= r.count)
  const d0 = new Date(firstDate + 'T00:00:00Z')

  for (let step = 0; out.length < cap && step < 5000; step++) {
    const candidates: string[] = []
    if (r.freq === 'DAILY') {
      const d = new Date(d0)
      d.setUTCDate(d.getUTCDate() + step * r.interval)
      candidates.push(d.toISOString().slice(0, 10))
    } else if (r.freq === 'WEEKLY') {
      const weekStart = new Date(d0)
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay() + step * 7 * r.interval)
      const days = r.byDay ?? [d0.getUTCDay()]
      for (const wd of days) {
        const d = new Date(weekStart)
        d.setUTCDate(d.getUTCDate() + wd)
        const iso = d.toISOString().slice(0, 10)
        if (iso >= firstDate) candidates.push(iso)
      }
    } else {
      const y = d0.getUTCFullYear()
      const m = d0.getUTCMonth() + step * r.interval
      const dom = d0.getUTCDate()
      const d = new Date(Date.UTC(y, m, dom))
      if (d.getUTCDate() === dom) candidates.push(d.toISOString().slice(0, 10))
    }
    let stop = false
    for (const date of candidates) {
      if (done(date)) {
        stop = true
        break
      }
      const s = atLocal(date)
      if (s.getTime() >= to) {
        stop = true
        break
      }
      push(s, produced)
      produced++
    }
    if (stop) break
  }
  return out
}
