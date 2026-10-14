import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { CheckSquare, Link2, MessageSquare, Plus } from 'lucide-react'
import { BOARD_COLUMNS, TASK_STATUS_LABEL, type TaskStatus } from '@shared/constants'
import { api, ApiError } from '@/lib/api'
import { Avatar, Button, Dialog, Field, Input, cx } from '@/components/ui'
import { DueText, PriorityMark } from '@/components/status'
import { useToast } from '@/components/toast'
import type { TaskRow } from './types'

const columnAccent: Record<string, string> = {
  backlog: 'bg-line-strong', todo: 'bg-ink-2/40', in_progress: 'bg-forest', blocked: 'bg-danger', in_review: 'bg-info', completed: 'bg-ok',
}

/**
 * Kanban board. Drag a card to change status (the server enforces workflow rules: review via submission,
 * dependencies, permissions). Moving into "In review" opens the submit flow; cards can also be opened and
 * updated from the task page with the keyboard.
 */
export function Board({ tasks, projectId, canManage, onNew }: { tasks: TaskRow[]; projectId: string; canManage: boolean; onNew: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const nav = useNavigate()
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [blockFor, setBlockFor] = useState<{ id: string; sort: number } | null>(null)
  const [reason, setReason] = useState('')
  const cols = useMemo(() => {
    const m = new Map<string, TaskRow[]>(BOARD_COLUMNS.map((c) => [c, []]))
    for (const t of tasks) m.get(t.status)?.push(t)
    for (const list of m.values()) list.sort((a, b) => a.sort_order - b.sort_order)
    return m
  }, [tasks])

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['tasks'] })
    qc.invalidateQueries({ queryKey: ['project', projectId] })
  }

  const move = async (id: string, status: TaskStatus, sortOrder: number, blockedReason?: string) => {
    const t = tasks.find((x) => x.id === id)
    if (!t) return
    if (status === 'in_review') {
      nav(`/tasks/${id}?submit=1`)
      return
    }
    if (status === 'blocked' && !blockedReason && t.status !== 'blocked') {
      setBlockFor({ id, sort: sortOrder })
      return
    }
    // Optimistic update; server state wins on refetch.
    qc.setQueriesData<{ tasks: TaskRow[] } | TaskRow[]>({ queryKey: ['tasks', { projectId }] }, (old) => {
      if (!old) return old
      const list = Array.isArray(old) ? old : old.tasks
      const next = list.map((x) => (x.id === id ? { ...x, status, sort_order: sortOrder } : x))
      return Array.isArray(old) ? next : { ...old, tasks: next }
    })
    try {
      await api.post(`/api/tasks/${id}/move`, { status: status === t.status ? undefined : status, sortOrder, blockedReason })
    } catch (e) {
      toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Move failed' })
    } finally {
      refresh()
    }
  }

  const onDrop = (col: TaskStatus, beforeId: string | null) => {
    if (!dragId) return
    const list = (cols.get(col) ?? []).filter((t) => t.id !== dragId)
    const idx = beforeId ? list.findIndex((t) => t.id === beforeId) : list.length
    const prev = list[idx - 1]?.sort_order
    const next = list[idx]?.sort_order
    const sort = prev === undefined && next === undefined ? Date.now() : prev === undefined ? next! - 1000 : next === undefined ? prev + 1000 : (prev + next) / 2
    move(dragId, col, sort)
    setDragId(null)
    setOver(null)
  }

  return (
    <>
      <div className="-mx-4 overflow-x-auto px-4 pb-2 md:-mx-8 md:px-8">
        <div className="grid min-w-[1080px] grid-cols-6 gap-3">
          {BOARD_COLUMNS.map((col) => {
            const list = cols.get(col) ?? []
            return (
              <section
                key={col}
                aria-label={TASK_STATUS_LABEL[col]}
                onDragOver={(e) => { e.preventDefault(); setOver(col) }}
                onDragLeave={() => setOver((o) => (o === col ? null : o))}
                onDrop={(e) => { e.preventDefault(); onDrop(col, null) }}
                className={cx('flex min-h-[420px] flex-col rounded-lg border bg-porcelain/50 transition-colors', over === col ? 'border-forest/50 bg-forest-50' : 'border-line')}
              >
                <header className="flex items-center gap-2 px-3 py-2.5">
                  <span className={cx('size-2 rounded-full', columnAccent[col])} aria-hidden />
                  <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-2">{TASK_STATUS_LABEL[col]}</h3>
                  <span className="ml-auto font-mono text-[11px] text-muted">{list.length}</span>
                  {col === 'todo' && canManage && <button onClick={onNew} className="text-muted hover:text-forest" aria-label="Add task"><Plus className="size-3.5" /></button>}
                </header>
                <ol className="flex-1 space-y-2 px-2 pb-2">
                  {list.map((t) => (
                    <li
                      key={t.id}
                      draggable
                      onDragStart={(e) => { setDragId(t.id); e.dataTransfer.effectAllowed = 'move' }}
                      onDragEnd={() => { setDragId(null); setOver(null) }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(col, t.id) }}
                      className={cx('group cursor-grab rounded-md border bg-paper p-2.5 shadow-soft transition active:cursor-grabbing', dragId === t.id ? 'opacity-40' : 'border-line hover:border-line-strong', t.overdue && 'border-l-2 border-l-danger')}
                    >
                      <Link to={`/tasks/${t.id}`} className="block focus:outline-none" draggable={false}>
                        <div className="flex items-start gap-1.5">
                          <PriorityMark priority={t.priority} />
                          <span className="text-[13px] leading-snug text-ink group-hover:underline">{t.title}</span>
                        </div>
                        {t.status === 'blocked' && t.blocked_reason && <p className="mt-1.5 line-clamp-2 rounded bg-danger-bg px-1.5 py-1 text-[11.5px] text-danger">{t.blocked_reason}</p>}
                        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
                          <span className="font-mono">#{t.number}</span>
                          {t.subtask_total > 0 && <span className="inline-flex items-center gap-0.5"><CheckSquare className="size-3" />{t.subtask_done}/{t.subtask_total}</span>}
                          {t.comment_count > 0 && <span className="inline-flex items-center gap-0.5"><MessageSquare className="size-3" />{t.comment_count}</span>}
                          {t.open_dependencies > 0 && <span className="inline-flex items-center gap-0.5 text-warn" title="Waiting on dependencies"><Link2 className="size-3" />{t.open_dependencies}</span>}
                          <span className="ml-auto"><DueText date={t.due_date} open={t.status !== 'completed'} /></span>
                          {t.responsible_name && <Avatar name={t.responsible_name} color={t.responsible_color} size={20} />}
                        </div>
                      </Link>
                    </li>
                  ))}
                  {list.length === 0 && <li className="rounded-md border border-dashed border-line px-2 py-6 text-center text-[11.5px] text-faint">Drop tasks here</li>}
                </ol>
              </section>
            )
          })}
        </div>
      </div>
      <Dialog open={!!blockFor} onClose={() => setBlockFor(null)} title="What is blocking this task?" width={440} footer={<><Button variant="ghost" onClick={() => setBlockFor(null)}>Cancel</Button><Button variant="primary" disabled={!reason.trim()} onClick={() => { if (blockFor) move(blockFor.id, 'blocked', blockFor.sort, reason.trim()); setBlockFor(null); setReason('') }}>Mark blocked</Button></>}>
        <Field label="Reason" hint="Reviewers are notified so they can help unblock it."><Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      </Dialog>
    </>
  )
}
