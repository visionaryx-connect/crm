import { useState } from 'react'
import { Link } from 'react-router'
import { api, ApiError } from '@/lib/api'
import { Button, Field, Input } from '@/components/ui'
import { AuthLayout } from './AuthLayout'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ message: string }>('/api/auth/password/forgot', { email })
      setMessage(r.message)
    } catch (err) {
      setError(err instanceof ApiError ? (err.fields.email ?? err.message) : 'Request failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <AuthLayout title="Reset your password" subtitle="For security, an administrator verifies every reset request and sends you a one-time link." footer={<Link to="/login" className="link">Back to sign in</Link>}>
      {message ? (
        <p className="rounded-md border border-forest/20 bg-forest-50 px-3 py-3 text-[13.5px] text-forest-700">{message}</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Work email" error={error ?? undefined} htmlFor="email">
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
          </Field>
          <Button type="submit" variant="primary" loading={busy} className="w-full">Request reset</Button>
        </form>
      )}
    </AuthLayout>
  )
}
