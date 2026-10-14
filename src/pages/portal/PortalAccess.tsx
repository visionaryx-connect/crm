import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ShieldCheck } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Spinner } from '@/components/ui'

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
    <div className="flex min-h-dvh items-center justify-center bg-ivory px-5">
      <div className="w-full max-w-md text-center">
        <span className="mx-auto mb-6 flex size-10 items-center justify-center rounded-[6px] bg-forest font-display text-lg text-paper">X</span>
        {error ? (
          <>
            <h1 className="font-display text-[26px] text-ink">Link unavailable</h1>
            <p className="mt-3 text-[14px] text-ink-2">{error}</p>
          </>
        ) : (
          <>
            <h1 className="font-display text-[26px] text-ink">Opening your project portal</h1>
            <p className="mt-3 flex items-center justify-center gap-2 text-[13.5px] text-muted"><ShieldCheck className="size-4 text-forest" /> Verifying your secure link <Spinner /></p>
          </>
        )}
      </div>
    </div>
  )
}
