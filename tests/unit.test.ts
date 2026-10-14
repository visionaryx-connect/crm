import { describe, expect, it } from 'vitest'
import { calculateProgress, assessHealth } from '@shared/progress'
import { addDays, localDate, makePeriod, monthBounds, previousMonth, startOfLocalDay } from '@shared/dates'
import { classifyDay, isScheduledWorkday, leaveDays, type DayOffSource } from '@shared/workdays'
import { expandOccurrences, parseRule } from '@shared/recurrence'
import { hashPassword, verifyPassword } from '../worker/lib/password'
import { totpAt, verifyTotp, base32Decode, base32Encode } from '../worker/lib/totp'
import { detectType } from '../worker/routes/files'

const t = (status: string, extra: Partial<{ estimate_hours: number | null; weight: number; milestone_id: string | null }> = {}) => ({ status, estimate_hours: null, weight: 1, milestone_id: null, ...extra })

describe('progress calculation', () => {
  it('equal mode: completed / applicable, excluding cancelled', () => {
    const r = calculateProgress('equal', [t('completed'), t('completed'), t('todo'), t('in_review'), t('cancelled')])
    expect(r.progress).toBe(50)
    expect(r.totalUnits).toBe(4)
  })
  it('submissions in review do not count as complete', () => {
    expect(calculateProgress('equal', [t('in_review'), t('in_review')]).progress).toBe(0)
  })
  it('no applicable tasks → hasData false, not 0% delivered', () => {
    const r = calculateProgress('equal', [t('cancelled')])
    expect(r).toEqual({ progress: 0, completedUnits: 0, totalUnits: 0, hasData: false })
  })
  it('effort mode weights by estimate, falling back to weight', () => {
    const r = calculateProgress('effort', [t('completed', { estimate_hours: 30 }), t('todo', { estimate_hours: 10 }), t('todo', { weight: 10 })])
    expect(r.progress).toBe(60)
  })
  it('milestone mode uses milestone weights and the implicit bucket', () => {
    const ms = [{ id: 'm1', weight: 3, status: 'in_progress' }, { id: 'm2', weight: 1, status: 'achieved' }]
    const r = calculateProgress('milestone', [t('completed', { milestone_id: 'm1' }), t('todo', { milestone_id: 'm1' }), t('completed')], ms)
    // m1: 3 × 0.5 = 1.5, m2 (no tasks, achieved): 1, loose bucket: 1 × 1 → 3.5 / 5
    expect(r.progress).toBe(70)
  })
  it('health is separate from progress', () => {
    const h = assessHealth({ status: 'in_progress', progress: 90, hasData: true, startDate: '2026-01-01', targetDate: '2026-02-01', today: '2026-02-10', overdueTasks: 0, blockedTasks: 0 })
    expect(h.health).toBe('at_risk')
    expect(h.reasons[0]).toMatch(/Target date/)
    expect(assessHealth({ status: 'completed', progress: 100, hasData: true, startDate: null, targetDate: null, today: '2026-01-01', overdueTasks: 9, blockedTasks: 9 }).health).toBe('not_applicable')
  })
})

describe('dates and reporting periods (Asia/Kolkata)', () => {
  it('converts instants to local dates', () => {
    expect(localDate('2026-09-30T18:29:59.000Z')).toBe('2026-09-30')
    expect(localDate('2026-09-30T18:30:00.000Z')).toBe('2026-10-01')
  })
  it('period boundaries are local midnight, end-exclusive', () => {
    const p = makePeriod('2026-09-01', '2026-09-30')
    expect(p.fromUtc).toBe('2026-08-31T18:30:00.000Z')
    expect(p.toUtc).toBe('2026-09-30T18:30:00.000Z')
    expect(startOfLocalDay('2026-01-01').toISOString()).toBe('2025-12-31T18:30:00.000Z')
  })
  it('month bounds and previous month', () => {
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' })
    expect(previousMonth('2026-01-01')).toBe('2025-12')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('rejects inverted periods', () => {
    expect(() => makePeriod('2026-02-02', '2026-02-01')).toThrow()
  })
})

describe('working days and holidays', () => {
  const ww = { weekdays: [1, 2, 3, 4, 5], saturday: { mode: 'nth_off' as const, offWeeks: [2, 4] } }
  const src: DayOffSource = { holidays: new Map([['2026-10-02', ['Gandhi Jayanthi']]]), overrides: new Map([['2026-10-24', { isWorking: true, reason: 'Compensatory working day' }]]) }
  it('applies the alternate-Saturday rule from settings', () => {
    expect(isScheduledWorkday('2026-10-03', ww)).toBe(true) // 1st Saturday
    expect(isScheduledWorkday('2026-10-10', ww)).toBe(false) // 2nd Saturday
    expect(isScheduledWorkday('2026-10-04', ww)).toBe(false) // Sunday
  })
  it('holidays and overrides win over the weekly pattern', () => {
    expect(classifyDay('2026-10-02', ww, src).kind).toBe('holiday')
    expect(classifyDay('2026-10-24', ww, src)).toMatchObject({ kind: 'override_working', working: true })
  })
  it('leave never charges weekends or holidays', () => {
    // Thu 1 Oct → Mon 5 Oct: Thu, (Fri holiday), Sat 1st working, (Sun) , Mon = 3 days
    expect(leaveDays('2026-10-01', '2026-10-05', 'none', ww, src)).toBe(3)
    expect(leaveDays('2026-10-05', '2026-10-05', 'first_half', ww, src)).toBe(0.5)
    expect(leaveDays('2026-10-02', '2026-10-02', 'none', ww, src)).toBe(0)
  })
})

describe('recurrence', () => {
  it('parses and validates rules', () => {
    expect(parseRule('FREQ=WEEKLY;BYDAY=MO,WE')).toMatchObject({ freq: 'WEEKLY', byDay: [1, 3] })
    expect(() => parseRule('FREQ=YEARLY')).toThrow()
    expect(() => parseRule('FREQ=DAILY;BYDAY=MO')).toThrow()
  })
  it('expands weekly events keeping local time', () => {
    const occ = expandOccurrences('2026-10-05T04:30:00.000Z', '2026-10-05T05:00:00.000Z', 'FREQ=WEEKLY;BYDAY=MO', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')
    expect(occ.map((o) => o.startAt)).toEqual(['2026-10-05T04:30:00.000Z', '2026-10-12T04:30:00.000Z', '2026-10-19T04:30:00.000Z', '2026-10-26T04:30:00.000Z'])
  })
  it('respects COUNT and UNTIL', () => {
    expect(expandOccurrences('2026-10-01T04:30:00.000Z', '2026-10-01T05:00:00.000Z', 'FREQ=DAILY;COUNT=3', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z')).toHaveLength(3)
    expect(expandOccurrences('2026-10-01T04:30:00.000Z', '2026-10-01T05:00:00.000Z', 'FREQ=DAILY;UNTIL=20261004', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z')).toHaveLength(4)
  })
  it('monthly skips months without that day', () => {
    const occ = expandOccurrences('2027-01-31T04:30:00.000Z', '2027-01-31T05:00:00.000Z', 'FREQ=MONTHLY', '2027-01-01T00:00:00Z', '2027-05-01T00:00:00Z')
    expect(occ.map((o) => o.startAt.slice(0, 10))).toEqual(['2027-01-31', '2027-03-31'])
  })
})

describe('credentials', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('a long passphrase 42')
    expect(h).toMatch(/^pbkdf2-sha256\$100000\$/)
    expect(await verifyPassword('a long passphrase 42', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
    expect(await verifyPassword('anything', null)).toBe(false)
  })
  it('TOTP matches RFC 6238 test vector and rejects replays', async () => {
    const secret = base32Encode(new TextEncoder().encode('12345678901234567890'))
    expect(base32Decode(secret)).toEqual(new TextEncoder().encode('12345678901234567890'))
    // RFC 6238 SHA-1, T = 59 s → 94287082 (8 digits) → 287082 (6 digits)
    expect(await totpAt(secret, 1)).toBe('287082')
    const now = 59_000
    const step = await verifyTotp(secret, '287082', null, now)
    expect(step).toBe(1)
    expect(await verifyTotp(secret, '287082', step, now)).toBeNull()
  })
  it('file type detection checks magic bytes', () => {
    expect(detectType('a.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe('application/pdf')
    expect(detectType('evil.pdf', new Uint8Array([0x4d, 0x5a, 0, 0]))).toBeNull()
    expect(detectType('script.exe', new Uint8Array([0x4d, 0x5a]))).toBeNull()
  })
})
