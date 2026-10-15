import { z } from 'zod'
import { many, nowIso, one } from '../lib/db'
import { DEFAULT_WORKWEEK, type DayOffSource, type WorkweekSettings } from '@shared/workdays'

export const SETTING_SCHEMAS = {
  'company.profile': z.object({
    name: z.string().trim().min(1).max(120),
    website: z.string().trim().max(200),
    supportEmail: z.string().trim().max(200),
    supportPhone: z.string().trim().max(40),
    address: z.string().trim().max(500),
  }),
  'workdays.weekly': z.object({
    weekdays: z.array(z.number().int().min(0).max(5)).max(6),
    saturday: z.object({
      mode: z.enum(['all_working', 'all_off', 'nth_off']),
      offWeeks: z.array(z.number().int().min(1).max(5)).max(5).optional(),
    }),
  }),
  'workdays.hours': z.object({
    dayStart: z.string().regex(/^\d{2}:\d{2}$/),
    dayEnd: z.string().regex(/^\d{2}:\d{2}$/),
    halfDayHours: z.number().min(1).max(12),
  }),
  'holidays.regions': z.object({ regions: z.array(z.enum(['IN', 'IN-TN', 'COMPANY'])).min(1) }),
  'portal.defaults': z.object({
    linkValidityDays: z.number().int().min(1).max(180),
    sessionHours: z.number().int().min(1).max(24),
    reverifyMinutes: z.number().int().min(5).max(120),
  }),
  'reports.schedule': z.object({ monthlySnapshots: z.boolean() }),
  'automations': z.object({
    projectAutoStart: z.boolean(),
    milestoneAutoStatus: z.boolean(),
    dependencyReady: z.boolean(),
    projectReadyForReview: z.boolean(),
    projectAutoDelayed: z.boolean(),
    assignedBacklogToTodo: z.boolean(),
  }),
} as const

export type SettingKey = keyof typeof SETTING_SCHEMAS
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>

const DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  'company.profile': { name: 'Visionary X', website: 'https://visionary-x.in', supportEmail: '', supportPhone: '', address: '' },
  'workdays.weekly': DEFAULT_WORKWEEK,
  'workdays.hours': { dayStart: '09:30', dayEnd: '18:30', halfDayHours: 4 },
  'holidays.regions': { regions: ['IN', 'IN-TN', 'COMPANY'] },
  'portal.defaults': { linkValidityDays: 30, sessionHours: 8, reverifyMinutes: 15 },
  'reports.schedule': { monthlySnapshots: true },
  automations: { projectAutoStart: true, milestoneAutoStatus: true, dependencyReady: true, projectReadyForReview: true, projectAutoDelayed: true, assignedBacklogToTodo: true },
}

export async function getSetting<K extends SettingKey>(db: D1Database, key: K): Promise<SettingValue<K>> {
  const row = await one<{ value: string }>(db, 'SELECT value FROM company_settings WHERE key = ?', key)
  if (!row) return DEFAULTS[key]
  const parsed = SETTING_SCHEMAS[key].safeParse(JSON.parse(row.value))
  return (parsed.success ? parsed.data : DEFAULTS[key]) as SettingValue<K>
}

export async function getAllSettings(db: D1Database) {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(SETTING_SCHEMAS) as SettingKey[]) out[key] = await getSetting(db, key)
  return out as { [K in SettingKey]: SettingValue<K> }
}

export async function putSetting(db: D1Database, key: SettingKey, value: unknown, userId: string) {
  await db
    .prepare(
      `INSERT INTO company_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), userId, nowIso())
    .run()
}

export async function getWorkweek(db: D1Database): Promise<WorkweekSettings> {
  return getSetting(db, 'workdays.weekly') as Promise<WorkweekSettings>
}

/** Verified day-off holidays (in configured regions) and overrides within [start, end]. */
export async function getDayOffSource(db: D1Database, start: string, end: string): Promise<DayOffSource> {
  const { regions } = await getSetting(db, 'holidays.regions')
  const rh = regions.map(() => '?').join(', ')
  const hols = await many<{ holiday_date: string; name: string }>(
    db,
    `SELECT holiday_date, name FROM holidays
      WHERE holiday_date BETWEEN ? AND ? AND status = 'verified' AND is_day_off = 1 AND region IN (${rh})`,
    start,
    end,
    ...regions,
  )
  const overrides = await many<{ override_date: string; is_working: number; reason: string }>(
    db,
    'SELECT override_date, is_working, reason FROM working_day_overrides WHERE override_date BETWEEN ? AND ?',
    start,
    end,
  )
  const holidays = new Map<string, string[]>()
  for (const h of hols) holidays.set(h.holiday_date, [...(holidays.get(h.holiday_date) ?? []), h.name])
  return {
    holidays,
    overrides: new Map(overrides.map((o) => [o.override_date, { isWorking: Boolean(o.is_working), reason: o.reason }])),
  }
}
