import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { Copy, Download } from 'lucide-react'
import { api, ApiError, setCsrf } from '@/lib/api'
import { download } from '@/lib/format'
import { Button, Field, Input, Spinner } from '@/components/ui'
import { AuthLayout } from './AuthLayout'

export default function SetupMfa() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [codes, setCodes] = useState<string[] | null>(null)
  const started = useRef(false)

  useEffect(() => {
    // Run once: each call generates a new pending secret, so a second (StrictMode) call would invalidate the QR shown.
    if (started.current) return
    started.current = true
    api
      .post<{ secret: string; otpauthUri: string }>('/api/auth/mfa/setup')
      .then(async (s) => {
        setSetup(s)
        setQr(await QRCode.toDataURL(s.otpauthUri, { margin: 1, width: 200, color: { dark: '#0c0c0c', light: '#fbfaf7' } }))
      })
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 401)) nav('/login', { replace: true })
        else if (e instanceof ApiError && e.code === 'MFA_ALREADY_ENABLED') nav('/account', { replace: true })
        else setError(e instanceof ApiError ? e.message : 'Could not start setup')
      })
  }, [nav])

  const enable = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ recoveryCodes: string[]; csrfToken: string }>('/api/auth/mfa/enable', { code: code.trim() })
      setCsrf(r.csrfToken)
      setCodes(r.recoveryCodes)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed')
    } finally {
      setBusy(false)
    }
  }

  if (codes) {
    return (
      <AuthLayout title="Save your recovery codes" subtitle="Each code works once if you lose your device. Store them somewhere safe — they won’t be shown again.">
        <ol className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface p-4 font-mono text-[13.5px]">
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ol>
        <div className="mt-4 flex gap-2">
          <Button icon={<Copy className="size-3.5" />} onClick={() => navigator.clipboard.writeText(codes.join('\n'))}>Copy</Button>
          <Button icon={<Download className="size-3.5" />} onClick={() => download('visionaryx-recovery-codes.txt', codes.join('\n'), 'text/plain')}>Download</Button>
          <Button variant="primary" className="ml-auto" onClick={() => { qc.clear(); nav('/', { replace: true }) }}>Continue</Button>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Set up two-factor authentication" subtitle="Your role has access to sensitive company data, so a second factor is required.">
      {!setup ? (
        error ? <p className="text-danger text-[13px]">{error}</p> : <Spinner />
      ) : (
        <form onSubmit={enable} className="space-y-5">
          <ol className="space-y-4 text-[13.5px] text-ink-2">
            <li>
              <span className="font-medium text-ink">1. Scan this code</span> with an authenticator app (Google Authenticator, 1Password, Microsoft Authenticator).
              <div className="mt-3 flex items-center gap-4">
                {qr && <img src={qr} alt="QR code for authenticator setup" className="size-[150px] rounded border border-line" />}
                <div className="min-w-0 text-[12px] text-muted">
                  Can’t scan? Enter this key:
                  <code className="mt-1 block break-all rounded bg-subtle px-2 py-1 font-mono text-[12px] text-ink">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                </div>
              </div>
            </li>
            <li><span className="font-medium text-ink">2. Enter the 6-digit code</span> it shows.</li>
          </ol>
          <Field label="Verification code" error={error ?? undefined} htmlFor="code">
            <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="font-mono tracking-[0.3em] text-[16px]" />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={code.trim().length !== 6} className="w-full">Turn on two-factor authentication</Button>
        </form>
      )}
    </AuthLayout>
  )
}
