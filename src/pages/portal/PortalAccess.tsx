import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ShieldCheck } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { BrandMark, Spinner } from '@/components/ui'

/**
 * Landing page for passwordless links: /portal/access#t=<secret>.
 * The secret lives in the URL fragment (never sent to servers, logs or Referer). It is posted once, exchanged for a
 * short-lived HttpOnly session cookie, and the address bar is replaced with the clean /portal URL.
 */
export default function PortalAccess() {
  const nav = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t')
    history.replaceState(null, '', '/portal/access')
    if (!token) {
      setError('This link is incomplete. Please open the full link from your Visionary X contact.')
      return
    }
    api
      .post('/api/portal/session', { token })
      .then(() => nav('/portal', { replace: true }))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'We could not verify this link.'))
  }, [nav])
  return (
    <div className="starfield flex min-h-dvh items-center justify-center bg-canvas px-5">
      <div className="w-full max-w-md text-center">
        <BrandMark size={44} className="mx-auto mb-6" />
        {error ? (
          <>
            <h1 className="display text-[28px] text-ink">Link unavailable</h1>
            <p className="mt-3 text-[14px] text-ink-2">{error}</p>
          </>
        ) : (
          <>
            <h1 className="display text-[28px] text-ink">Opening your project portal</h1>
            <p className="mt-3 flex items-center justify-center gap-2 text-[13.5px] text-muted"><ShieldCheck className="size-4 text-accent" /> Verifying your secure link <Spinner /></p>
          </>
        )}
      </div>
    </div>
  )
}
