import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { api, ApiError, setCsrf } from '@/lib/api'
import { Button, Field, Input } from '@/components/ui'
import { AuthLayout } from './AuthLayout'

export default function VerifyMfa() {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const nav = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const next = params.get('next')?.startsWith('/') && !params.get('next')?.startsWith('//') ? params.get('next')! : '/'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ csrfToken: string }>('/api/auth/mfa/verify', { code: code.trim() })
      setCsrf(r.csrfToken)
      qc.clear()
      nav(next, { replace: true })
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'UNAUTHENTICATED' || err.code === 'SESSION_EXPIRED')) nav('/login', { replace: true })
      setError(err instanceof ApiError ? err.message : 'Verification failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Two-step verification" subtitle={recovery ? 'Enter one of your one-time recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={recovery ? 'Recovery code' : 'Verification code'} error={error ?? undefined} htmlFor="code">
          <Input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            placeholder={recovery ? 'xxxxx-xxxxx' : '123456'}
            className="font-mono tracking-[0.3em] text-[16px]"
            maxLength={recovery ? 11 : 6}
          />
        </Field>
        <div className="flex items-center justify-between">
          <button type="button" className="text-[13px] text-accent hover:underline" onClick={() => { setRecovery((r) => !r); setCode(''); setError(null) }}>
            {recovery ? 'Use authenticator code' : 'Use a recovery code'}
          </button>
          <Button type="submit" variant="primary" loading={busy} disabled={code.trim().length < 6}>Verify</Button>
        </div>
      </form>
    </AuthLayout>
  )
}
