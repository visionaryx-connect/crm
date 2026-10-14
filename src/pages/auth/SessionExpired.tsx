import { useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui'
import { AuthLayout } from './AuthLayout'

export default function SessionExpired() {
  const nav = useNavigate()
  const from = (useLocation().state as { from?: string } | null)?.from
  return (
    <AuthLayout title="Your session has ended" subtitle="For your security you were signed out after a period of inactivity, a password change, or an administrator action.">
      <Button variant="primary" onClick={() => nav(`/login${from ? `?next=${encodeURIComponent(from)}` : ''}`, { replace: true })}>Sign in again</Button>
    </AuthLayout>
  )
}
