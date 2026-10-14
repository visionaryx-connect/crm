import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router'
import { api, ApiError, onAuthError, setCsrf } from './api'

export interface Me {
  user: { id: string; name: string; email: string; designation: string; departmentId: string | null; employeeCode: string | null; avatarColor: string | null }
  roles: { key: string; name: string; rank: number; requiresMfa: boolean }[]
  permissions: string[]
  csrfToken: string
  mfaState: 'none' | 'pending' | 'verified' | 'enrol_required'
  mfaEnabled: boolean
  expiresAt: string
}

interface AuthCtx {
  me: Me
  can: (...perms: string[]) => boolean
}

const Ctx = createContext<AuthCtx | null>(null)

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const me = await api.get<Me>('/api/auth/me')
      setCsrf(me.csrfToken)
      return me
    },
    retry: false,
    staleTime: 5 * 60_000,
  })
}

/** Gate for the internal workspace: resolves the session and routes to the right auth screen when needed. */
export function AuthGate({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const q = useMe()
  const nav = useNavigate()
  const loc = useLocation()
  const qc = useQueryClient()

  useEffect(
    () =>
      onAuthError((err) => {
        if (err.code === 'MFA_REQUIRED') nav('/login/verify')
        else if (err.code === 'MFA_ENROLMENT_REQUIRED') nav('/security/setup-mfa')
        else if (err.code === 'SESSION_EXPIRED') {
          qc.clear()
          nav('/session-expired', { replace: true, state: { from: loc.pathname } })
        } else {
          qc.clear()
          nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true })
        }
      }),
    [nav, loc.pathname, loc.search, qc],
  )

  useEffect(() => {
    if (!q.data) return
    if (q.data.mfaState === 'pending') nav('/login/verify', { replace: true })
    else if (q.data.mfaState === 'enrol_required') nav('/security/setup-mfa', { replace: true })
  }, [q.data, nav])

  useEffect(() => {
    if (q.error instanceof ApiError && (q.error.status === 401 || q.error.code === 'UNAUTHENTICATED')) {
      nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true })
    }
  }, [q.error, nav, loc.pathname, loc.search])

  if (!q.data || q.data.mfaState === 'pending' || q.data.mfaState === 'enrol_required') return <>{fallback}</>
  const me = q.data
  const value: AuthCtx = { me, can: (...perms) => perms.some((p) => me.permissions.includes(p)) }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth outside AuthGate')
  return c
}
