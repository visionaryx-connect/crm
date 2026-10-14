// Working-day rules. Everything here is driven by settings + holiday records; nothing is hard-coded per year.
import { addDays, eachDate, weekday } from './dates'

export interface WorkweekSettings {
  /** Working weekdays among Sunday(0)…Friday(5). Saturday is governed by `saturday`. */
  weekdays: number[]
  saturday: { mode: 'all_working' | 'all_off' | 'nth_off'; offWeeks?: number[] }
}

export const DEFAULT_WORKWEEK: WorkweekSettings = { weekdays: [1, 2, 3, 4, 5], saturday: { mode: 'nth_off', offWeeks: [2, 4] } }

export interface DayOffSource {
  /** Verified holidays that are days off, keyed by date. */
  holidays: Map<string, string[]>
  /** Explicit overrides: true = working, false = day off. */
  overrides: Map<string, { isWorking: boolean; reason: string }>
}

export type DayKind = 'working' | 'weekend' | 'holiday' | 'override_off' | 'override_working'

export interface DayInfo {
  date: string
  kind: DayKind
  working: boolean
  label?: string
}

/** Which Saturday of its month a date is (1-based). */
export function nthWeekdayOfMonth(date: string): number {
  return Math.floor((Number(date.slice(8, 10)) - 1) / 7) + 1
}

export function isScheduledWorkday(date: string, ww: WorkweekSettings): boolean {
  const wd = weekday(date)
  if (wd === 6) {
    if (ww.saturday.mode === 'all_working') return true
    if (ww.saturday.mode === 'all_off') return false
    return !(ww.saturday.offWeeks ?? []).includes(nthWeekdayOfMonth(date))
  }
  return ww.weekdays.includes(wd)
}

export function classifyDay(date: string, ww: WorkweekSettings, src: DayOffSource): DayInfo {
  const ov = src.overrides.get(date)
  if (ov) return { date, kind: ov.isWorking ? 'override_working' : 'override_off', working: ov.isWorking, label: ov.reason }
  const hol = src.holidays.get(date)
  if (hol && hol.length) return { date, kind: 'holiday', working: false, label: hol.join(', ') }
  if (!isScheduledWorkday(date, ww)) return { date, kind: 'weekend', working: false }
  return { date, kind: 'working', working: true }
}

export function workingDaysBetween(start: string, end: string, ww: WorkweekSettings, src: DayOffSource): string[] {
  return eachDate(start, end).filter((d) => classifyDay(d, ww, src).working)
}

/**
 * Leave length in working days. Weekends and verified holidays inside the range are not charged.
 * A half-day request must be a single working day and counts 0.5.
 */
export function leaveDays(
  start: string,
  end: string,
  halfDay: 'none' | 'first_half' | 'second_half',
  ww: WorkweekSettings,
  src: DayOffSource,
): number {
  const days = workingDaysBetween(start, end, ww, src).length
  if (halfDay !== 'none') return days >= 1 && start === end ? 0.5 : days
  return days
}

/** Next working day on or after the given date (bounded search). */
export function nextWorkingDay(date: string, ww: WorkweekSettings, src: DayOffSource): string {
  let d = date
  for (let i = 0; i < 60; i++) {
    if (classifyDay(d, ww, src).working) return d
    d = addDays(d, 1)
  }
  return date
}
