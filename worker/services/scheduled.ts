// Daily scheduled job (Cron Trigger, 08:00 IST):
//  * deadline reminders (due tomorrow) and overdue notices — deduplicated per task per day
//  * session / token / rate-limit housekeeping
//  * purge soft-deleted file objects past the retention window
//  * on the 1st of the month: frozen report snapshots for the previous month

import type { Env } from '../env'
import { addDays, localDate, monthBounds, previousMonth } from '@shared/dates'
import { activity } from '../lib/audit'
import { newId } from '../lib/crypto'
import { many, nowIso } from '../lib/db'
import { pruneRateLimits } from '../lib/ratelimit'
import { notify } from './notify'
import type { Waiter } from './realtime'
import { companyReport, projectReport } from './reports'
import { getSetting } from './settings'

export const FILE_RETENTION_DAYS = 30

export async function runScheduled(env: Env, waiter: Waiter, at: Date) {
  const today = localDate(at)
  await deadlineReminders(env, waiter, today)
  await housekeeping(env, at)
  if (today.endsWith('-01')) await monthlySnapshots(env, today)
}

export async function deadlineReminders(env: Env, waiter: Waiter, today: string) {
  const tomorrow = addDays(today, 1)
  const dueSoon = await many<{ id: string; number: number; title: string; responsible_id: string; reference: string }>(
    env.DB,
    `SELECT t.id, t.number, t.title, t.responsible_id, p.reference FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.due_date = ? AND t.responsible_id IS NOT NULL AND t.status IN ('backlog','todo','in_progress','blocked') AND p.archived_at IS NULL`,
    tomorrow,
  )
  const overdue = await many<{ id: string; number: number; title: string; responsible_id: string; reference: string; due_date: string; manager_id: string | null }>(
    env.DB,
    `SELECT t.id, t.number, t.title, t.responsible_id, p.reference, t.due_date, p.manager_id FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.due_date < ? AND t.responsible_id IS NOT NULL AND t.status IN ('backlog','todo','in_progress','blocked') AND p.archived_at IS NULL`,
    today,
  )
  await notify(env, waiter, dueSoon.map((t) => ({ userId: t.responsible_id, kind: 'task_due_soon' as const, title: `Due tomorrow: ${t.reference}-${t.number} ${t.title}`, link: `/tasks/${t.id}`, entityType: 'task', entityId: t.id, dedupeKey: `due:${t.id}:${tomorrow}` })))
  await notify(
    env,
    waiter,
    overdue.flatMap((t) => [
      { userId: t.responsible_id, kind: 'task_overdue' as const, title: `Overdue since ${t.due_date}: ${t.reference}-${t.number} ${t.title}`, link: `/tasks/${t.id}`, entityType: 'task', entityId: t.id, dedupeKey: `overdue:${t.id}:${today}` },
      // Managers get one notice per overdue task per week, not daily.
      ...(t.manager_id && t.manager_id !== t.responsible_id
        ? [{ userId: t.manager_id, kind: 'task_overdue' as const, title: `Overdue: ${t.reference}-${t.number} ${t.title}`, link: `/tasks/${t.id}`, entityType: 'task', entityId: t.id, dedupeKey: `overdue-mgr:${t.id}:${weekKey(today)}` }]
        : []),
    ]),
  )
  return { dueSoon: dueSoon.length, overdue: overdue.length }
}

function weekKey(date: string) {
  const d = new Date(date + 'T00:00:00Z')
  const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return `${d.getUTCFullYear()}-w${Math.ceil(((d.getTime() - onejan.getTime()) / 86400_000 + onejan.getUTCDay() + 1) / 7)}`
}

async function housekeeping(env: Env, at: Date) {
  const now = at.toISOString()
  const old = new Date(at.getTime() - 90 * 86400_000).toISOString()
  await env.DB.batch([
    env.DB.prepare(`UPDATE sessions SET revoked_at = ?, revoked_reason = 'expired' WHERE revoked_at IS NULL AND expires_at < ?`).bind(now, now),
    env.DB.prepare('DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?').bind(old, old),
    env.DB.prepare('DELETE FROM portal_sessions WHERE expires_at < ?').bind(old),
    env.DB.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').bind(old),
    env.DB.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?').bind(new Date(at.getTime() - 180 * 86400_000).toISOString()),
  ])
  await pruneRateLimits(env.DB)
  if (env.FILES) {
    const cutoff = new Date(at.getTime() - FILE_RETENTION_DAYS * 86400_000).toISOString()
    const expired = await many<{ id: string; storage_key: string }>(env.DB, `SELECT id, storage_key FROM attachments WHERE deleted_at IS NOT NULL AND deleted_at < ? AND storage_key NOT LIKE 'purged:%' LIMIT 200`, cutoff)
    for (const f of expired) {
      await env.FILES.delete(f.storage_key)
      await env.DB.prepare(`UPDATE attachments SET storage_key = 'purged:' || id WHERE id = ?`).bind(f.id).run()
    }
  }
}

export async function monthlySnapshots(env: Env, today: string) {
  const { monthlySnapshots: enabled } = await getSetting(env.DB, 'reports.schedule')
  if (!enabled) return
  const month = previousMonth(today)
  const { start, end } = monthBounds(month)
  const exists = await many(env.DB, `SELECT 1 AS x FROM report_snapshots WHERE source = 'scheduled' AND report_type = 'company' AND period_start = ?`, start)
  if (exists.length) return
  const now = nowIso()
  const company = await companyReport(env.DB, start, end)
  const stmts = [
    env.DB.prepare('INSERT INTO report_snapshots (id, report_type, scope_id, period_start, period_end, source, payload, generated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)').bind(newId('rpt'), 'company', start, end, 'scheduled', JSON.stringify(company), now),
  ]
  const active = await many<{ id: string }>(env.DB, `SELECT id FROM projects WHERE created_at < ? AND (archived_at IS NULL OR archived_at >= ?)`, company.meta.period.toUtc, company.meta.period.fromUtc)
  for (const p of active.slice(0, 40)) {
    const doc = await projectReport(env.DB, p.id, start, end)
    stmts.push(env.DB.prepare('INSERT INTO report_snapshots (id, report_type, scope_id, period_start, period_end, source, payload, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(newId('rpt'), 'project', p.id, start, end, 'scheduled', JSON.stringify(doc), now))
  }
  stmts.push(activity(env.DB, { actorType: 'system', action: 'report.scheduled_snapshots', summary: `Generated monthly snapshots for ${month} (${stmts.length} reports)` }))
  await env.DB.batch(stmts)
}
