import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Monitor, ShieldCheck } from 'lucide-react'
import { passwordSchema } from '@shared/schemas'
import { api, ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAction } from '@/lib/forms'
import { fmtDateTime, relative } from '@/lib/format'
import { Badge, Button, Dialog, Field, Input, KeyValue, PageHeader, Panel, QueryState, Section } from '@/components/ui'

export default function Account() {
  const { me } = useAuth()
  const nav = useNavigate()
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' })
  const [pwErr, setPwErr] = useState<Record<string, string>>({})
  const [disableOpen, setDisableOpen] = useState(false)
  const [code, setCode] = useState('')
  const sessions = useQuery({ queryKey: ['account', 'sessions'], queryFn: () => api.get<{ sessions: { id: string; created_at: string; last_seen_at: string; ip: string | null; user_agent: string | null; current: boolean }[] }>('/api/auth/sessions').then((r) => r.sessions) })
  const change = useAction(
    () => {
      const p = passwordSchema.safeParse(pw.newPassword)
      if (!p.success) return Promise.reject(new ApiError(422, 'VALIDATION_FAILED', 'Check the form', { fields: { newPassword: p.error.issues[0]!.message } }))
      if (pw.newPassword !== pw.confirm) return Promise.reject(new ApiError(422, 'VALIDATION_FAILED', 'Check the form', { fields: { confirm: 'Passwords do not match' } }))
      return api.post('/api/auth/password/change', { currentPassword: pw.currentPassword, newPassword: pw.newPassword })
    },
    { success: 'Password changed — other sessions were signed out', invalidate: [['account']], onSuccess: () => { setPw({ currentPassword: '', newPassword: '', confirm: '' }); setPwErr({}) }, onError: (e) => e instanceof ApiError && setPwErr(e.fields) },
  )
  const revoke = useAction((id: string) => api.del(`/api/auth/sessions/${id}`), { success: 'Session signed out', invalidate: [['account']] })
  const disable = useAction(() => api.post('/api/auth/mfa/disable', { code }), { success: 'Two-factor authentication turned off', invalidate: [['me']], onSuccess: () => setDisableOpen(false) })
  const mfaRequired = me.roles.some((r) => r.requiresMfa)
  return (
    <div>
      <PageHeader eyebrow="Account" title="Account & security" />
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-8">
          <Section title="Profile">
            <Panel className="p-4"><KeyValue items={[{ label: 'Name', value: me.user.name }, { label: 'Email', value: me.user.email }, { label: 'Employee ID', value: me.user.employeeCode }, { label: 'Roles', value: me.roles.map((r) => r.name).join(', ') }]} /><Link to={`/team/${me.user.id}`} className="link mt-3 inline-block text-[13px]">Edit contact details</Link></Panel>
          </Section>
          <Section title="Two-factor authentication">
            <Panel className="flex items-center gap-4 p-4">
              <ShieldCheck className={me.mfaEnabled ? 'size-6 text-ok' : 'size-6 text-faint'} />
              <div className="flex-1 text-[13px]"><p className="font-medium text-ink">{me.mfaEnabled ? 'On — authenticator app' : 'Off'}</p><p className="text-muted">{mfaRequired ? 'Required for your role.' : 'Recommended for everyone.'}</p></div>
              {!me.mfaEnabled ? <Button variant="primary" onClick={() => nav('/security/setup-mfa')}>Set up</Button> : !mfaRequired && <Button variant="ghost" onClick={() => setDisableOpen(true)}>Turn off</Button>}
            </Panel>
          </Section>
          <Section title="Change password">
            <Panel className="space-y-3 p-4">
              <Field label="Current password" error={pwErr.currentPassword}><Input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
              <Field label="New password" hint="At least 12 characters, mixing letters with numbers or symbols." error={pwErr.newPassword}><Input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
              <Field label="Confirm new password" error={pwErr.confirm}><Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
              <div className="flex justify-end"><Button variant="primary" loading={change.isPending} disabled={!pw.currentPassword || !pw.newPassword} onClick={() => change.mutate()}>Change password</Button></div>
            </Panel>
          </Section>
        </div>
        <Section title="Where you’re signed in">
          <QueryState q={sessions}>
            {(rows) => (
              <ul className="divide-y divide-line/70 rounded-lg border border-line bg-paper">
                {rows.map((s) => (
                  <li key={s.id} className="flex items-start gap-3 px-4 py-3">
                    <Monitor className="mt-0.5 size-4 text-muted" />
                    <div className="min-w-0 flex-1 text-[13px]"><p className="truncate text-ink">{s.user_agent || 'Unknown device'}</p><p className="text-[12px] text-muted">{s.ip ?? 'Unknown IP'} · since {fmtDateTime(s.created_at)} · active {relative(s.last_seen_at)}</p></div>
                    {s.current ? <Badge tone="forest">This device</Badge> : <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>Sign out</Button>}
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
          <p className="mt-3 text-[12px] text-muted">Sessions end after 12 hours of inactivity and at most 7 days after sign-in.</p>
        </Section>
      </div>
      <Dialog open={disableOpen} onClose={() => setDisableOpen(false)} title="Turn off two-factor authentication" footer={<><Button variant="ghost" onClick={() => setDisableOpen(false)}>Cancel</Button><Button variant="danger" loading={disable.isPending} disabled={code.length !== 6} onClick={() => disable.mutate()}>Turn off</Button></>}>
        <Field label="Current 6-digit code"><Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} className="font-mono tracking-[0.3em]" autoFocus /></Field>
      </Dialog>
    </div>
  )
}
