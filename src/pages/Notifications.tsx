import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Bell, CheckCheck, Settings2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { fmtDateTime, relative } from '@/lib/format'
import { Button, Checkbox, Dialog, EmptyState, PageHeader, QueryState, cx } from '@/components/ui'

interface N { id: string; kind: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string }

function Preferences({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ['notifications', 'prefs'], queryFn: () => api.get<{ preferences: { kind: string; label: string; inApp: boolean; locked: boolean }[] }>('/api/notifications/preferences').then((r) => r.preferences) })
  const [local, setLocal] = useState<Record<string, boolean>>({})
  const save = useAction(() => api.put('/api/notifications/preferences', { preferences: Object.entries(local).map(([kind, inApp]) => ({ kind, inApp })) }), { success: 'Preferences saved', invalidate: [['notifications']], onSuccess: onClose })
  return (
    <Dialog open onClose={onClose} title="Notification preferences" description="Choose which in-app notifications you receive. Security notices are always delivered." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <QueryState q={q}>{(prefs) => <div className="space-y-3">{prefs.map((p) => <Checkbox key={p.kind} label={p.label} disabled={p.locked} checked={local[p.kind] ?? p.inApp} onChange={(e) => setLocal({ ...local, [p.kind]: e.target.checked })} />)}</div>}</QueryState>
    </Dialog>
  )
}

export default function Notifications() {
  const [unread, setUnread] = useState(false)
  const [prefs, setPrefs] = useState(false)
  const q = useQuery({ queryKey: ['notifications', { unread }], queryFn: () => api.get<{ notifications: N[]; unread: number }>(`/api/notifications${unread ? '?unread=1' : ''}`) })
  const markAll = useAction(() => api.post('/api/notifications/read', { all: true }), { invalidate: [['notifications']] })
  const markOne = useAction((id: string) => api.post('/api/notifications/read', { ids: [id] }), { invalidate: [['notifications']], silentError: true })
  return (
    <div>
      <PageHeader eyebrow="Inbox" title="Notifications" meta={q.data && <span>{q.data.unread} unread</span>} actions={<><Button variant="ghost" icon={<Settings2 className="size-4" />} onClick={() => setPrefs(true)}>Preferences</Button><Button icon={<CheckCheck className="size-4" />} onClick={() => markAll.mutate()} disabled={!q.data?.unread}>Mark all read</Button></>} />
      <div className="mb-4 flex gap-1 rounded-md border border-line bg-surface p-0.5 text-[12.5px]" role="group" style={{ width: 'fit-content' }}>
        <button className={cx('rounded px-3 py-1', !unread && 'bg-subtle')} onClick={() => setUnread(false)} aria-pressed={!unread}>All</button>
        <button className={cx('rounded px-3 py-1', unread && 'bg-subtle')} onClick={() => setUnread(true)} aria-pressed={unread}>Unread</button>
      </div>
      <QueryState q={q} empty={(d) => (d.notifications.length === 0 ? <EmptyState icon={<Bell className="size-7" strokeWidth={1.4} />} title={unread ? 'No unread notifications' : 'No notifications yet'} /> : null)}>
        {(d) => (
          <ul className="divide-y divide-line/70 rounded-lg border border-line bg-surface">
            {d.notifications.map((n) => {
              const inner = (
                <div className="flex items-start gap-3 px-4 py-3">
                  <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-highlight')} aria-label={n.read_at ? undefined : 'Unread'} />
                  <div className="min-w-0 flex-1">
                    <p className={cx('text-[13.5px]', n.read_at ? 'text-ink-2' : 'font-medium text-ink')}>{n.title}</p>
                    {n.body && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{n.body}</p>}
                  </div>
                  <span className="shrink-0 text-[11.5px] text-muted" title={fmtDateTime(n.created_at)}>{relative(n.created_at)}</span>
                </div>
              )
              return (
                <li key={n.id} className="hover:bg-canvas/70">
                  {n.link ? <Link to={n.link} onClick={() => !n.read_at && markOne.mutate(n.id)}>{inner}</Link> : <button className="w-full text-left" onClick={() => !n.read_at && markOne.mutate(n.id)}>{inner}</button>}
                </li>
              )
            })}
          </ul>
        )}
      </QueryState>
      {prefs && <Preferences onClose={() => setPrefs(false)} />}
    </div>
  )
}
