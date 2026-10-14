// Date utilities. Calendar dates are plain 'YYYY-MM-DD' strings in the company timezone (Asia/Kolkata).
// Timestamps are UTC ISO strings. Asia/Kolkata has no DST, but conversions still go through Intl so the
// timezone stays a single setting.

import { COMPANY_TZ } from './constants'

const dateFmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string) {
  let f = dateFmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    dateFmtCache.set(tz, f)
  }
  return f
}

/** Calendar date (YYYY-MM-DD) of an instant in the company timezone. */
export function localDate(instant: Date | string | number = new Date(), tz = COMPANY_TZ): string {
  const d = instant instanceof Date ? instant : new Date(instant)
  return fmt(tz).format(d)
}

/** Offset in minutes of tz from UTC at the given instant (e.g. +330 for IST). */
export function tzOffsetMinutes(instant: Date, tz = COMPANY_TZ): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000)
}

/** UTC instant for local midnight (00:00) of the given calendar date in tz. */
export function startOfLocalDay(date: string, tz = COMPANY_TZ): Date {
  const guess = new Date(date + 'T00:00:00Z')
  const offset = tzOffsetMinutes(guess, tz)
  return new Date(guess.getTime() - offset * 60000)
}

/** UTC ISO string for a local date + 'HH:MM' time in tz. */
export function localDateTimeToUtc(date: string, time: string, tz = COMPANY_TZ): string {
  const guess = new Date(`${date}T${time}:00Z`)
  const offset = tzOffsetMinutes(guess, tz)
  return new Date(guess.getTime() - offset * 60000).toISOString()
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000)
}

/** 0 = Sunday … 6 = Saturday for a calendar date. */
export function weekday(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay()
}

export function eachDate(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

export function monthBounds(month: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Month must be YYYY-MM')
  const [y, m] = month.split('-').map(Number)
  const start = `${month}-01`
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start, end: `${month}-${String(last).padStart(2, '0')}` }
}

/**
 * Reporting period. Both dates are inclusive local calendar dates. Instants are compared with
 *   fromUtc <= t < toUtc
 * where fromUtc is local midnight of `start` and toUtc is local midnight of the day after `end`.
 */
export interface Period {
  start: string
  end: string
  fromUtc: string
  toUtc: string
}

export function makePeriod(start: string, end: string, tz = COMPANY_TZ): Period {
  if (!isValidDate(start) || !isValidDate(end)) throw new Error('Invalid period dates')
  if (end < start) throw new Error('Period end is before start')
  return {
    start,
    end,
    fromUtc: startOfLocalDay(start, tz).toISOString(),
    toUtc: startOfLocalDay(addDays(end, 1), tz).toISOString(),
  }
}

export function previousMonth(today: string): string {
  const [y, m] = today.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return d.toISOString().slice(0, 7)
}
