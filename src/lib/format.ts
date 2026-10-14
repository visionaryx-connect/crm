// Display formatting. Stored values are UTC instants or IST calendar dates; everything is shown in Asia/Kolkata.
export const TZ = 'Asia/Kolkata'

const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...o })
const fDate = dtf({ day: 'numeric', month: 'short', year: 'numeric' })
const fDateShort = dtf({ day: 'numeric', month: 'short' })
const fDateTime = dtf({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const fTime = dtf({ hour: 'numeric', minute: '2-digit' })
const fWeekday = dtf({ weekday: 'short', day: 'numeric', month: 'short' })

/** A calendar date string (YYYY-MM-DD) is formatted without timezone shifting. */
const asDate = (d: string) => (d.length === 10 ? new Date(`${d}T12:00:00+05:30`) : new Date(d))

export const fmtDate = (d?: string | null) => (d ? fDate.format(asDate(d)) : '—')
export const fmtDateShort = (d?: string | null) => (d ? fDateShort.format(asDate(d)) : '—')
export const fmtWeekday = (d?: string | null) => (d ? fWeekday.format(asDate(d)) : '—')
export const fmtDateTime = (d?: string | null) => (d ? fDateTime.format(new Date(d)) : '—')
export const fmtTime = (d?: string | null) => (d ? fTime.format(new Date(d)) : '—')

export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export function relative(iso?: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const abs = Math.abs(diff)
  const m = Math.round(abs / 60000)
  const suffix = diff >= 0 ? 'ago' : 'from now'
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ${suffix}`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ${suffix}`
  const d = Math.round(h / 24)
  if (d < 14) return `${d} day${d === 1 ? '' : 's'} ${suffix}`
  return fmtDate(iso)
}

/** Days from today (IST) to a date: negative = past. */
export function daysUntil(date?: string | null): number | null {
  if (!date) return null
  const t = todayIST()
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 86400000)
}

export function dueLabel(date?: string | null, open = true): { text: string; tone: 'muted' | 'warn' | 'danger' | 'ok' } {
  const d = daysUntil(date)
  if (d === null) return { text: 'No due date', tone: 'muted' }
  if (!open) return { text: fmtDateShort(date), tone: 'muted' }
  if (d < 0) return { text: `${-d}d overdue`, tone: 'danger' }
  if (d === 0) return { text: 'Due today', tone: 'warn' }
  if (d === 1) return { text: 'Due tomorrow', tone: 'warn' }
  if (d <= 7) return { text: `Due in ${d}d`, tone: 'muted' }
  return { text: fmtDateShort(date), tone: 'muted' }
}

export const hours = (minutes: number) => `${(Math.round((minutes / 60) * 10) / 10).toLocaleString('en-IN')} h`
export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`)
export const initials = (name?: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

/** Convert a datetime-local input value (IST wall clock) to a UTC ISO string. */
export function localInputToIso(v: string): string {
  return new Date(`${v}:00+05:30`).toISOString()
}
export function isoToLocalInput(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60000)
  return d.toISOString().slice(0, 16)
}

export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\n')
}

export function download(filename: string, content: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
