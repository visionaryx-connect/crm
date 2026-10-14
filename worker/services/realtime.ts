// Publishing side of the realtime system. Callers must only publish AFTER the corresponding D1 write has
// succeeded. Payloads carry ids and minimal display data; clients refetch authoritative state over REST.

import type { RealtimeEnvelope, RealtimeEventName } from '@shared/constants'
import type { Env } from '../env'
import { newId } from '../lib/crypto'

export interface Waiter {
  waitUntil(p: Promise<unknown>): void
}

export type OutgoingEvent = { type: RealtimeEventName; room: string; data: Record<string, unknown> }

export const rooms = {
  user: (id: string) => `user:${id}`,
  project: (id: string) => `project:${id}`,
  company: () => 'company',
  perm: (p: string) => `perm:${p}`,
  portalProject: (id: string) => `portal:project:${id}`,
}

export function hub(env: Env) {
  return env.REALTIME.get(env.REALTIME.idFromName('hub'))
}

export function publish(env: Env, waiter: Waiter, events: OutgoingEvent[]) {
  if (events.length === 0) return
  const at = new Date().toISOString()
  const envelopes: RealtimeEnvelope[] = events.map((e) => ({ id: newId('evt'), at, ...e }))
  waiter.waitUntil(
    hub(env)
      .broadcast(envelopes)
      .catch((err: unknown) => console.error('realtime publish failed', err)),
  )
}

/** Forcefully close sockets after a session/token is revoked. */
export function disconnect(env: Env, waiter: Waiter, target: { sessionHash?: string; userId?: string; accessTokenId?: string }) {
  waiter.waitUntil(hub(env).disconnect(target).catch((err: unknown) => console.error('realtime disconnect failed', err)))
}

export function invalidateMembership(env: Env, waiter: Waiter, userIds: string[]) {
  if (userIds.length === 0) return
  waiter.waitUntil(hub(env).invalidateMembership(userIds).catch(() => undefined))
}
