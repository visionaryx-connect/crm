import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { passwordSchema } from '@shared/schemas'
import { api, ApiError } from '@/lib/api'
import { Button, Field, Input, Spinner } from '@/components/ui'
import { AuthLayout } from './AuthLayout'

export default function SetPassword({ mode }: { mode: 'activation' | 'reset' }) {
  const nav = useNavigate()
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '')
  const [info, setInfo] = useState<{ name: string; email: string } | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    // Remove the secret from the address bar immediately.
    if (window.location.hash) history.replaceState(null, '', window.location.pathname)
    if (!token) {
      setLinkError('This link is incomplete. Open the full link you were sent.')
      return
    }
    api.get<{ name: string; email: string }>(`/api/auth/token/check?token=${encodeURIComponent(token)}`).then(setInfo).catch((e) => setLinkError(e instanceof ApiError ? e.message : 'This link is not valid.'))
  }, [token])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const p = passwordSchema.safeParse(pw)
    if (!p.success) return setError(p.error.issues[0]?.message ?? 'Choose a stronger password')
    if (pw !== pw2) return setError('Passwords do not match')
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/auth/password/reset', { token, password: pw })
      setDone(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not set the password')
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'activation' ? 'Activate your account' : 'Choose a new password'
  if (linkError) return <AuthLayout title={title}><p className="text-[13.5px] text-danger">{linkError}</p><Link to="/login" className="link mt-4 inline-block text-[13px]">Back to sign in</Link></AuthLayout>
  if (done) return <AuthLayout title="Password saved" subtitle="All other sessions were signed out."><Button variant="primary" onClick={() => nav('/login')}>Sign in</Button></AuthLayout>
  if (!info) return <AuthLayout title={title}><Spinner /></AuthLayout>
  return (
    <AuthLayout title={title} subtitle={<>For <span className="font-medium text-ink">{info.name}</span> · {info.email}</>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password" hint="At least 12 characters, mixing letters with numbers or symbols." htmlFor="pw">
          <Input id="pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </Field>
        <Field label="Confirm password" error={error ?? undefined} htmlFor="pw2">
          <Input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} className="w-full">Save password</Button>
      </form>
    </AuthLayout>
  )
}
