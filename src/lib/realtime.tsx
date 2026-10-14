// Live updates over an authenticated WebSocket. Events are hints: on each one we invalidate the affected
// TanStack queries so the authoritative state is re-read over REST. After a reconnect we refetch everything,
// which recovers anything missed while offline. Event ids are de-duplicated.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { RealtimeEnvelope } from '@shared/constants'
import { useToast } from '@/components/toast'

type Status = 'connecting' | 'live' | 'offline'
const Ctx = createContext<Status>('connecting')
export const useRealtimeStatus = () => useContext(Ctx)

function invalidateFor(qc: QueryClient, ev: RealtimeEnvelope) {
  const d = ev.data as { projectId?: string; taskId?: string }
  const inv = (key: unknown[]) => qc.invalidateQueries({ queryKey: key })
  if (ev.type.startsWith('task.')) {
    inv(['tasks'])
    if (d.taskId) inv(['task', d.taskId])
    if (d.projectId) inv(['project', d.projectId])
    inv(['projects'])
    inv(['dashboard'])
  } else if (ev.type.startsWith('project.') || ev.type === 'client.feedback_received') {
    if (d.projectId) inv(['project', d.projectId])
    inv(['projects'])
    inv(['dashboard'])
    if (ev.type === 'client.feedback_received') inv(['clients'])
  } else if (ev.type.startsWith('calendar.')) {
    inv(['calendar'])
    inv(['holidays'])
  } else if (ev.type.startsWith('leave.')) {
    inv(['leave'])
    inv(['calendar'])
    inv(['dashboard'])
  } else if (ev.type === 'notification.created') {
    inv(['notifications'])
  } else if (ev.type.startsWith('portal.')) {
    if (d.projectId) inv(['project', d.projectId])
    inv(['portal'])
  }
}

export function RealtimeProvider({ children, path = '/ws/staff', subscribe = ['projects:*'] }: { children: ReactNode; path?: string; subscribe?: string[] }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [status, setStatus] = useState<Status>('connecting')
  const seen = useRef<string[]>([])
  const subs = subscribe.join(',')

  useEffect(() => {
    let ws: WebSocket | null = null
    let attempt = 0
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let ping: ReturnType<typeof setInterval> | undefined
    let everConnected = false

    const connect = () => {
      if (stopped) return
      setStatus('connecting')
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}${path}`)
      ws.onopen = () => {
        attempt = 0
        setStatus('live')
        if (subs) ws?.send(JSON.stringify({ type: 'subscribe', rooms: subs.split(',') }))
        if (everConnected) qc.invalidateQueries() // recover state missed while disconnected
        everConnected = true
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping' })), 25_000)
      }
      ws.onmessage = (m) => {
        let msg: { type: string; event?: RealtimeEnvelope }
        try {
          msg = JSON.parse(m.data)
        } catch {
          return
        }
        if (msg.type !== 'event' || !msg.event) return
        const ev = msg.event
        if (seen.current.includes(ev.id)) return
        seen.current = [...seen.current.slice(-199), ev.id]
        invalidateFor(qc, ev)
        if (ev.type === 'notification.created') {
          const d = ev.data as { title?: string; link?: string | null }
          toast({ tone: 'info', title: d.title ?? 'New notification', href: d.link ?? undefined })
        }
      }
      ws.onclose = (e) => {
        clearInterval(ping)
        setStatus('offline')
        if (stopped) return
        // 4401 = session expired/revoked: let the next REST call route to the sign-in screen.
        if (e.code === 4401) {
          qc.invalidateQueries({ queryKey: ['me'] })
          return
        }
        const delay = Math.min(30_000, 1000 * 2 ** attempt++) + Math.random() * 500
        timer = setTimeout(connect, delay)
      }
    }
    connect()
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (!ws || ws.readyState === WebSocket.CLOSED)) {
        attempt = 0
        clearTimeout(timer)
        connect()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(ping)
      document.removeEventListener('visibilitychange', onVisible)
      ws?.close(1000, 'unmount')
    }
  }, [qc, toast, path, subs])

  return <Ctx.Provider value={status}>{children}</Ctx.Provider>
}
