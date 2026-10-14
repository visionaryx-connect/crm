// RealtimeHub — a single Durable Object that holds every live WebSocket (hibernation API) and fans out events.
//
// Security model
//  * Sockets are only accepted from the Worker, which has already validated the session cookie and Origin.
//    The identity arrives in the internal `X-VX-Identity` header; the DO is not reachable from the internet.
//  * Delivery is decided per socket at send time:
//      staff:  user:<self>, company, perm:<p> for permissions held, project:<id> when the user can read the
//              project (checked against D1, cached ≤60 s) AND the socket subscribed to it (or to projects:*).
//      portal: only portal:project:<id> rooms for projects in the token's scope. Portal sockets never receive
//              any room outside the `portal:` namespace, regardless of subscription.
//  * Sessions are re-validated against D1 every 2 minutes; expired/revoked sockets are closed (4401).
//  * Incoming messages are size-limited and rate-limited; unknown message types are rejected.

import { DurableObject } from 'cloudflare:workers'
import type { RealtimeEnvelope } from '@shared/constants'
import type { Env } from '../env'
import { projectAccess } from '../lib/authz'
import { loadPermissions } from '../lib/session'

const MAX_MESSAGE_BYTES = 2048
const MAX_SUBSCRIPTIONS = 25
const REVALIDATE_MS = 2 * 60 * 1000
const MEMBERSHIP_TTL_MS = 60 * 1000
const MSG_WINDOW_MS = 10_000
const MSG_WINDOW_LIMIT = 40

export interface SocketIdentity {
  kind: 'staff' | 'portal'
  sessionHash: string
  expiresAt: string
  userId?: string
  permissions?: string[]
  accessTokenId?: string
  clientId?: string
  projectIds?: string[]
}

interface Attachment extends SocketIdentity {
  subs: string[]
  checkedAt: number
}

const PORTAL_EVENT_TYPES = new Set(['portal.project_updated', 'portal.deliverable_shared', 'portal.feedback_answered'])

export class RealtimeHub extends DurableObject<Env> {
  private membership = new Map<string, { ids: Map<string, boolean>; loadedAt: number }>()
  private msgCounts = new Map<WebSocket, { start: number; n: number }>()

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
    const raw = request.headers.get('x-vx-identity')
    if (!raw) return new Response('Forbidden', { status: 403 })
    const identity = JSON.parse(raw) as SocketIdentity
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    const att: Attachment = { ...identity, subs: [], checkedAt: Date.now() }
    if (identity.kind === 'portal') att.subs = (identity.projectIds ?? []).map((id) => `portal:project:${id}`)
    server.serializeAttachment(att)
    server.send(JSON.stringify({ type: 'welcome', at: new Date().toISOString(), kind: identity.kind, expiresAt: identity.expiresAt }))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === 'string' ? message.length : message.byteLength
    if (size > MAX_MESSAGE_BYTES) return ws.close(1009, 'Message too large')
    if (!this.allowMessage(ws)) return ws.close(1008, 'Rate limit exceeded')
    const att = ws.deserializeAttachment() as Attachment
    if (!(await this.stillValid(ws, att))) return

    let msg: { type?: unknown; rooms?: unknown; id?: unknown }
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
    } catch {
      return this.sendError(ws, 'BAD_MESSAGE', 'Messages must be JSON')
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }))
      return
    }
    if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
      if (!Array.isArray(msg.rooms) || msg.rooms.length > MAX_SUBSCRIPTIONS || msg.rooms.some((r) => typeof r !== 'string' || r.length > 100)) {
        return this.sendError(ws, 'BAD_MESSAGE', 'rooms must be an array of up to 25 room names')
      }
      if (att.kind === 'portal') return this.sendError(ws, 'FORBIDDEN_ROOM', 'Portal connections cannot change subscriptions')
      const requested = msg.rooms as string[]
      if (msg.type === 'unsubscribe') {
        att.subs = att.subs.filter((s) => !requested.includes(s))
      } else {
        const granted: string[] = []
        const denied: string[] = []
        for (const room of requested) {
          if (await this.staffMayJoin(att, room)) granted.push(room)
          else denied.push(room)
        }
        att.subs = [...new Set([...att.subs, ...granted])].slice(0, MAX_SUBSCRIPTIONS)
        if (denied.length) this.sendError(ws, 'FORBIDDEN_ROOM', 'Not authorised for some rooms', { rooms: denied })
        ws.send(JSON.stringify({ type: 'subscribed', rooms: att.subs }))
      }
      ws.serializeAttachment(att)
      return
    }
    this.sendError(ws, 'BAD_MESSAGE', 'Unknown message type')
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.msgCounts.delete(ws)
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing')
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.msgCounts.delete(ws)
  }

  /** RPC: deliver events (already persisted in D1) to every authorised socket. */
  async broadcast(events: RealtimeEnvelope[]): Promise<{ delivered: number }> {
    let delivered = 0
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (!att) continue
      if (!(await this.stillValid(ws, att))) continue
      for (const ev of events) {
        if (await this.shouldDeliver(att, ev)) {
          try {
            ws.send(JSON.stringify({ type: 'event', event: ev }))
            delivered++
          } catch {
            /* socket went away mid-send */
          }
        }
      }
    }
    return { delivered }
  }

  /** RPC: close sockets belonging to a revoked session, user or portal token. */
  async disconnect(target: { sessionHash?: string; userId?: string; accessTokenId?: string }): Promise<number> {
    let closed = 0
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (!att) continue
      if (
        (target.sessionHash && att.sessionHash === target.sessionHash) ||
        (target.userId && att.userId === target.userId) ||
        (target.accessTokenId && att.accessTokenId === target.accessTokenId)
      ) {
        ws.close(4401, 'Session revoked')
        closed++
      }
    }
    return closed
  }

  /** RPC: drop cached project membership after membership changes. */
  async invalidateMembership(userIds: string[]): Promise<void> {
    for (const id of userIds) this.membership.delete(id)
  }

  /** RPC (diagnostics/tests): number of open sockets by kind. */
  async stats(): Promise<{ staff: number; portal: number }> {
    let staff = 0
    let portal = 0
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att?.kind === 'portal') portal++
      else if (att) staff++
    }
    return { staff, portal }
  }

  // ───────────── internals ─────────────

  private allowMessage(ws: WebSocket): boolean {
    const now = Date.now()
    const c = this.msgCounts.get(ws)
    if (!c || now - c.start > MSG_WINDOW_MS) {
      this.msgCounts.set(ws, { start: now, n: 1 })
      return true
    }
    c.n++
    return c.n <= MSG_WINDOW_LIMIT
  }

  private sendError(ws: WebSocket, code: string, message: string, details?: unknown) {
    ws.send(JSON.stringify({ type: 'error', code, message, details }))
  }

  /** Expiry check on every touch, plus periodic re-validation against D1 (revocation, role changes). */
  private async stillValid(ws: WebSocket, att: Attachment): Promise<boolean> {
    const now = Date.now()
    if (now >= Date.parse(att.expiresAt)) {
      ws.close(4401, 'Session expired')
      return false
    }
    if (now - att.checkedAt < REVALIDATE_MS) return true
    const table = att.kind === 'staff' ? 'sessions' : 'portal_sessions'
    const row = await this.env.DB.prepare(`SELECT revoked_at, expires_at FROM ${table} WHERE token_hash = ?`)
      .bind(att.sessionHash)
      .first<{ revoked_at: string | null; expires_at: string }>()
    if (!row || row.revoked_at || now >= Date.parse(row.expires_at)) {
      ws.close(4401, 'Session expired')
      return false
    }
    if (att.kind === 'staff' && att.userId) {
      const user = await this.env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(att.userId).first<{ status: string }>()
      if (user?.status !== 'active') {
        ws.close(4401, 'Account inactive')
        return false
      }
      att.permissions = [...(await loadPermissions(this.env.DB, att.userId)).permissions]
      this.membership.delete(att.userId)
    }
    if (att.kind === 'portal' && att.accessTokenId) {
      const tok = await this.env.DB.prepare('SELECT revoked_at, expires_at FROM client_access_tokens WHERE id = ?')
        .bind(att.accessTokenId)
        .first<{ revoked_at: string | null; expires_at: string }>()
      if (!tok || tok.revoked_at || now >= Date.parse(tok.expires_at)) {
        ws.close(4401, 'Access revoked')
        return false
      }
    }
    att.checkedAt = now
    ws.serializeAttachment(att)
    return true
  }

  private async staffMayJoin(att: Attachment, room: string): Promise<boolean> {
    if (!att.userId) return false
    if (room === 'projects:*') return true // still filtered per project at delivery time
    const m = /^project:([A-Za-z0-9_]{1,64})$/.exec(room)
    if (m) return this.canReadProject(att, m[1])
    return false
  }

  private async canReadProject(att: Attachment, projectId: string): Promise<boolean> {
    if (!att.userId) return false
    const perms = att.permissions ?? []
    if (perms.includes('projects.read_all')) return true
    const now = Date.now()
    let cache = this.membership.get(att.userId)
    if (!cache || now - cache.loadedAt > MEMBERSHIP_TTL_MS) {
      cache = { ids: new Map(), loadedAt: now }
      this.membership.set(att.userId, cache)
    }
    const known = cache.ids.get(projectId)
    if (known !== undefined) return known
    const access = await projectAccess(this.env.DB, { userId: att.userId, permissions: perms }, projectId)
    const ok = Boolean(access?.canRead)
    cache.ids.set(projectId, ok)
    return ok
  }

  private async shouldDeliver(att: Attachment, ev: RealtimeEnvelope): Promise<boolean> {
    if (att.kind === 'portal') {
      // Hard isolation: portal sockets only ever see portal-namespaced rooms they were scoped to at connect.
      return ev.room.startsWith('portal:') && PORTAL_EVENT_TYPES.has(ev.type) && att.subs.includes(ev.room)
    }
    if (ev.room.startsWith('portal:')) return false
    if (ev.room === `user:${att.userId}`) return true
    if (ev.room === 'company') return true
    if (ev.room.startsWith('perm:')) return (att.permissions ?? []).includes(ev.room.slice(5))
    if (ev.room.startsWith('project:')) {
      if (!att.subs.includes(ev.room) && !att.subs.includes('projects:*')) return false
      return this.canReadProject(att, ev.room.slice(8))
    }
    return false
  }
}
