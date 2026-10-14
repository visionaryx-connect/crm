import type { RealtimeHub } from './do/RealtimeHub'

export interface Env {
  DB: D1Database
  /** Optional: R2 bucket for attachments. When unbound, uploads are disabled with a clear error. */
  FILES?: R2Bucket
  REALTIME: DurableObjectNamespace<RealtimeHub>
  ASSETS?: Fetcher
  APP_ENV: 'development' | 'staging' | 'production' | 'test'
  APP_ORIGIN: string
  COMPANY_TIMEZONE: string
  SESSION_SECRET: string
  DATA_KEY: string
}

export interface StaffAuth {
  kind: 'staff'
  userId: string
  name: string
  email: string
  sessionId: string
  sessionHash: string
  csrfToken: string
  expiresAt: string
  roles: { key: string; name: string; rank: number; requiresMfa: boolean }[]
  permissions: Set<string>
  mfaState: 'none' | 'pending' | 'verified' | 'enrol_required'
  mfaEnabled: boolean
}

export interface PortalAuth {
  kind: 'portal'
  portalSessionId: string
  sessionHash: string
  accessTokenId: string
  clientId: string
  /** Projects this session may see. Computed from the token scope on every request. */
  projectIds: string[]
  verifiedAt: string
  verifiedEmail: string | null
  expiresAt: string
}

export type AppBindings = {
  Bindings: Env
  Variables: {
    auth: StaffAuth
    portal: PortalAuth
    requestId: string
  }
}
