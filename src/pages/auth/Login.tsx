import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { loginSchema, type LoginInput } from '@shared/schemas'
import { api, ApiError, setCsrf } from '@/lib/api'
import { applyServerErrors } from '@/lib/forms'
import { Button, Field, Input } from '@/components/ui'
import { AuthLayout } from './AuthLayout'

export default function Login() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } })
  const next = params.get('next')
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null)
    try {
      const r = await api.post<{ mfa: 'required' | 'enrol' | null; csrfToken: string }>('/api/auth/login', values)
      setCsrf(r.csrfToken)
      qc.clear()
      if (r.mfa === 'required') nav(`/login/verify?next=${encodeURIComponent(safeNext)}`)
      else if (r.mfa === 'enrol') nav('/security/setup-mfa')
      else nav(safeNext, { replace: true })
    } catch (e) {
      if (!applyServerErrors(e, form.setError)) setError(e instanceof ApiError ? e.message : 'Sign-in failed')
    }
  })

  return (
    <AuthLayout title="Sign in" subtitle="Use your Visionary X work account." footer={<>Client looking for project updates? Use the secure link your project manager sent you.</>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && <div role="alert" className="rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-[13px] text-danger">{error}</div>}
        <Field label="Work email" error={form.formState.errors.email?.message} htmlFor="email">
          <Input id="email" type="email" autoComplete="username" autoFocus aria-invalid={!!form.formState.errors.email} {...form.register('email')} />
        </Field>
        <Field label="Password" error={form.formState.errors.password?.message} htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!form.formState.errors.password} {...form.register('password')} />
        </Field>
        <div className="flex items-center justify-between pt-1">
          <Link to="/forgot-password" className="text-[13px] text-forest hover:underline">Forgot password?</Link>
          <Button type="submit" variant="primary" loading={form.formState.isSubmitting} className="min-w-28">Sign in</Button>
        </div>
      </form>
    </AuthLayout>
  )
}
