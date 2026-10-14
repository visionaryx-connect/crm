// Fetch wrapper for the Worker API. Same-origin cookies carry the session; mutations add the CSRF header.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> | null = null,
  ) {
    super(message)
  }
  get fields(): Record<string, string> {
    return ((this.details?.fields as Record<string, string>) ?? {}) as Record<string, string>
  }
}

let csrfToken = ''
export const setCsrf = (t: string) => {
  csrfToken = t
}

type Listener = (err: ApiError) => void
const authListeners = new Set<Listener>()
/** Subscribe to authentication failures (expired session, MFA required) from any request. */
export function onAuthError(fn: Listener) {
  authListeners.add(fn)
  return () => {
    authListeners.delete(fn)
  }
}

const AUTH_CODES = new Set(['SESSION_EXPIRED', 'UNAUTHENTICATED', 'MFA_REQUIRED', 'MFA_ENROLMENT_REQUIRED'])

const NO_CSRF_PATHS = ['/api/auth/login', '/api/auth/password/forgot', '/api/auth/password/reset', '/api/portal/session']

/** After a full reload the in-memory CSRF token is gone; recover it from the session before mutating. */
async function ensureCsrf() {
  if (csrfToken) return
  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    if (r.ok) csrfToken = ((await r.json()) as { csrfToken?: string }).csrfToken ?? ''
  } catch {
    /* the real request will surface the error */
  }
}

export async function request<T = unknown>(method: string, path: string, body?: unknown, opts: { portal?: boolean; raw?: boolean } = {}): Promise<T> {
  if (method !== 'GET' && !opts.portal && !NO_CSRF_PATHS.includes(path)) await ensureCsrf()
  const headers: Record<string, string> = { accept: 'application/json' }
  if (method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = opts.portal ? portalCsrf : csrfToken
  let payload: BodyInit | undefined
  if (body instanceof FormData) payload = body
  else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.')
  }
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, 'HTTP_' + res.status, 'Request failed')
    return res as unknown as T
  }
  const text = await res.text()
  let json: any = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  if (!res.ok) {
    const e = json?.error
    const err = new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? 'Request failed', e?.details ?? null)
    if (!opts.portal && AUTH_CODES.has(err.code)) authListeners.forEach((l) => l(err))
    throw err
  }
  return json as T
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T = any>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  patch: <T = any>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  del: <T = any>(p: string) => request<T>('DELETE', p),
  upload: <T = any>(p: string, form: FormData) => request<T>('POST', p, form),
}

let portalCsrf = ''
export const setPortalCsrf = (t: string) => {
  portalCsrf = t
}
export const portalApi = {
  get: <T = any>(p: string) => request<T>('GET', p, undefined, { portal: true }),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}, { portal: true }),
}

/** Build a query string, omitting empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) s.set(k, String(v))
  const str = s.toString()
  return str ? `?${str}` : ''
}
