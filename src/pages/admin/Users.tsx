import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Copy, KeyRound, LogOut, Plus, ShieldOff, UserCheck, UserX } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAction } from '@/lib/forms'
import { useDepartments, useMembers } from '@/lib/lookups'
import { fmtDateTime, relative } from '@/lib/format'
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, IconButton, Input, PageHeader, QueryState, SampleTag, Section, Select, Table, Tabs, Td, Textarea, Th, Tr } from '@/components/ui'
import { useToast } from '@/components/toast'

interface UserRow { id: string; name: string; email: string; status: string; mfa_enabled: boolean; last_login_at: string | null; locked_until: string | null; is_seed: boolean; employee_code: string | null; designation: string | null; department_name: string | null; roles: string[]; active_sessions: number }
interface Role { id: string; key: string; name: string; description: string; is_system: boolean; requires_mfa: boolean; rank: number; user_count: number; permissions: string[] }
interface RolesData { roles: Role[]; permissions: { key: string; label: string; category: string }[] }

function LinkResult({ link, purpose, onClose }: { link: string; purpose: string; onClose: () => void }) {
  const toast = useToast()
  return (
    <Dialog open onClose={onClose} title={purpose === 'activation' ? 'Activation link' : 'Password reset link'} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <p className="mb-3 text-[13px] text-ink-2">Send this one-time link to the person through a trusted channel (it is shown only once and expires automatically). Verify their identity first for reset requests.</p>
      <div className="flex items-center gap-2 rounded-md border border-line bg-canvas p-2"><code className="flex-1 break-all font-mono text-[12px]">{link}</code><IconButton label="Copy" onClick={() => { navigator.clipboard.writeText(link); toast({ tone: 'ok', title: 'Copied' }) }}><Copy className="size-4" /></IconButton></div>
    </Dialog>
  )
}

function InviteDialog({ roles, onClose, onLink }: { roles: Role[]; onClose: () => void; onLink: (l: string) => void }) {
  const departments = useDepartments()
  const members = useMembers()
  const [v, setV] = useState({ name: '', email: '', roleKeys: ['employee'], employeeCode: '', designation: '', departmentId: '', managerUserId: '', joiningDate: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useAction(() => api.post<{ activationLink: string }>('/api/admin/users', { ...v, departmentId: v.departmentId || null, managerUserId: v.managerUserId || null, joiningDate: v.joiningDate || null }), {
    success: 'User invited',
    invalidate: [['admin', 'users'], ['team']],
    onSuccess: (r) => { onClose(); onLink(r.activationLink) },
    onError: (e) => e instanceof ApiError && setErrors(e.fields),
  })
  return (
    <Dialog open onClose={onClose} title="Invite a team member" description="They’ll set their own password from a one-time activation link." width={640} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Create & get link</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" required error={errors.name}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus /></Field>
        <Field label="Work email" required error={errors.email}><Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        <Field label="Employee ID" required error={errors.employeeCode}><Input value={v.employeeCode} onChange={(e) => setV({ ...v, employeeCode: e.target.value })} className="font-mono" /></Field>
        <Field label="Designation"><Input value={v.designation} onChange={(e) => setV({ ...v, designation: e.target.value })} /></Field>
        <Field label="Department"><Select value={v.departmentId} onChange={(e) => setV({ ...v, departmentId: e.target.value })}><option value="">—</option>{departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
        <Field label="Reporting manager"><Select value={v.managerUserId} onChange={(e) => setV({ ...v, managerUserId: e.target.value })}><option value="">—</option>{members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <Field label="Joining date"><Input type="date" value={v.joiningDate} onChange={(e) => setV({ ...v, joiningDate: e.target.value })} /></Field>
        <Field label="Roles" error={errors.roleKeys} className="sm:col-span-2">
          <div className="grid grid-cols-2 gap-2 rounded-md border border-line p-3">{roles.map((r) => <Checkbox key={r.key} label={r.name} description={r.requires_mfa ? 'Requires 2FA' : undefined} checked={v.roleKeys.includes(r.key)} onChange={(e) => setV({ ...v, roleKeys: e.target.checked ? [...v.roleKeys, r.key] : v.roleKeys.filter((k) => k !== r.key) })} />)}</div>
        </Field>
      </div>
    </Dialog>
  )
}

function RolesEditor({ user, roles, onClose }: { user: UserRow; roles: Role[]; onClose: () => void }) {
  const [keys, setKeys] = useState(user.roles)
  const save = useAction(() => api.put(`/api/admin/users/${user.id}/roles`, { roleKeys: keys }), { success: 'Roles updated — the user must sign in again', invalidate: [['admin', 'users']], onSuccess: onClose })
  return (
    <Dialog open onClose={onClose} title={`Roles · ${user.name}`} description="Changing roles signs the user out everywhere so new permissions (and any 2FA requirement) apply immediately." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!keys.length} loading={save.isPending} onClick={() => save.mutate()}>Save roles</Button></>}>
      <div className="space-y-2.5">{roles.map((r) => <Checkbox key={r.key} label={r.name} description={r.description} checked={keys.includes(r.key)} onChange={(e) => setKeys(e.target.checked ? [...keys, r.key] : keys.filter((k) => k !== r.key))} />)}</div>
    </Dialog>
  )
}

function UsersTab({ roles }: { roles: Role[] }) {
  const { me, can } = useAuth()
  const [params] = useSearchParams()
  const q = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api.get<{ users: UserRow[] }>('/api/admin/users').then((r) => r.users) })
  const [inviting, setInviting] = useState(false)
  const [link, setLink] = useState<{ link: string; purpose: string } | null>(null)
  const [rolesFor, setRolesFor] = useState<UserRow | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'deactivate' | 'activate' | 'mfa' | 'sessions'; user: UserRow } | null>(null)
  const issue = useAction((id: string) => api.post<{ link: string; purpose: string }>(`/api/admin/users/${id}/link`), { onSuccess: (r) => setLink(r) })
  const act = useAction(
    () => {
      const c = confirm!
      if (c.kind === 'mfa') return api.post(`/api/admin/users/${c.user.id}/reset-mfa`)
      if (c.kind === 'sessions') return api.post(`/api/admin/users/${c.user.id}/revoke-sessions`)
      return api.post(`/api/admin/users/${c.user.id}/status`, { status: c.kind === 'deactivate' ? 'deactivated' : 'active' })
    },
    { success: 'Done', invalidate: [['admin', 'users'], ['team']], onSuccess: () => setConfirm(null) },
  )
  const focus = params.get('focus')
  return (
    <Section title="People with access" actions={can('users.manage') && <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setInviting(true)}>Invite</Button>}>
      <QueryState q={q}>
        {(rows) => (
          <Table>
            <thead><tr><Th>User</Th><Th>Roles</Th><Th>Status</Th><Th>2FA</Th><Th>Last sign-in</Th><Th /></tr></thead>
            <tbody>{rows.map((u) => (
              <Tr key={u.id} className={focus === u.id ? 'bg-highlight-soft/40' : undefined}>
                <Td><span className="text-ink">{u.name}</span>{u.is_seed && <SampleTag />}<div className="text-[12px] text-muted">{u.email}{u.employee_code && ` · ${u.employee_code}`}</div></Td>
                <Td><div className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r} tone="outline">{roles.find((x) => x.key === r)?.name ?? r}</Badge>)}</div></Td>
                <Td>{u.status === 'active' ? (u.locked_until && Date.parse(u.locked_until) > Date.now() ? <Badge tone="warn">Locked</Badge> : <Badge tone="ok">Active</Badge>) : u.status === 'invited' ? <Badge tone="highlight">Invited</Badge> : <Badge tone="danger">Deactivated</Badge>}</Td>
                <Td>{u.mfa_enabled ? <Badge tone="accent">On</Badge> : <span className="text-[12px] text-faint">Off</span>}</Td>
                <Td className="text-ink-2">{u.last_login_at ? relative(u.last_login_at) : 'Never'}{u.active_sessions > 0 && <span className="text-[11.5px] text-muted"> · {u.active_sessions} session(s)</span>}</Td>
                <Td align="right" className="whitespace-nowrap">
                  {u.id !== me.user.id && can('users.manage') && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setRolesFor(u)}>Roles</Button>
                      {u.status !== 'deactivated' && <IconButton label={u.status === 'invited' ? 'New activation link' : 'Issue password reset link'} onClick={() => issue.mutate(u.id)}><KeyRound className="size-3.5" /></IconButton>}
                      {u.status === 'deactivated' ? <IconButton label="Reactivate" onClick={() => setConfirm({ kind: 'activate', user: u })}><UserCheck className="size-3.5" /></IconButton> : <IconButton label="Deactivate" onClick={() => setConfirm({ kind: 'deactivate', user: u })}><UserX className="size-3.5" /></IconButton>}
                    </>
                  )}
                  {u.id !== me.user.id && can('security.manage') && (
                    <>
                      {u.mfa_enabled && <IconButton label="Reset 2FA (lost device)" onClick={() => setConfirm({ kind: 'mfa', user: u })}><ShieldOff className="size-3.5" /></IconButton>}
                      {u.active_sessions > 0 && <IconButton label="Sign out everywhere" onClick={() => setConfirm({ kind: 'sessions', user: u })}><LogOut className="size-3.5" /></IconButton>}
                    </>
                  )}
                </Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </QueryState>
      {inviting && <InviteDialog roles={roles} onClose={() => setInviting(false)} onLink={(l) => setLink({ link: l, purpose: 'activation' })} />}
      {link && <LinkResult {...link} onClose={() => setLink(null)} />}
      {rolesFor && <RolesEditor user={rolesFor} roles={roles} onClose={() => setRolesFor(null)} />}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => act.mutate()}
        loading={act.isPending}
        danger={confirm?.kind !== 'activate'}
        title={confirm?.kind === 'deactivate' ? 'Deactivate account?' : confirm?.kind === 'activate' ? 'Reactivate account?' : confirm?.kind === 'mfa' ? 'Reset two-factor authentication?' : 'Sign out everywhere?'}
        confirmLabel="Confirm"
        body={confirm?.kind === 'deactivate' ? `${confirm.user.name} will be signed out immediately and can no longer sign in. Their history is kept.` : confirm?.kind === 'mfa' ? 'Use only after verifying their identity. They will need to enrol a new authenticator at next sign-in.' : confirm?.kind === 'sessions' ? 'All of their active sessions and live connections end now.' : 'They will be able to sign in again.'}
      />
    </Section>
  )
}

function RoleDialog({ role, perms, onClose }: { role: Role | null; perms: RolesData['permissions']; onClose: () => void }) {
  const [v, setV] = useState({ name: role?.name ?? '', description: role?.description ?? '', requiresMfa: role?.requires_mfa ?? false, permissions: role?.permissions ?? [] })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useAction(() => (role ? api.put(`/api/admin/roles/${role.id}`, v) : api.post('/api/admin/roles', v)), { success: 'Role saved', invalidate: [['admin', 'roles']], onSuccess: onClose, onError: (e) => e instanceof ApiError && setErrors(e.fields) })
  const cats = [...new Set(perms.map((p) => p.category))]
  return (
    <Dialog open onClose={onClose} title={role ? `Edit ${role.name}` : 'New role'} width={720} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save role</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={errors.name}><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <div className="flex items-end"><Checkbox label="Require two-factor authentication" checked={v.requiresMfa} onChange={(e) => setV({ ...v, requiresMfa: e.target.checked })} /></div>
        <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
        <div className="space-y-4 sm:col-span-2">
          {cats.map((c) => (
            <fieldset key={c}>
              <legend className="eyebrow mb-1.5">{c}</legend>
              <div className="grid gap-2 sm:grid-cols-2">{perms.filter((p) => p.category === c).map((p) => <Checkbox key={p.key} label={p.label} description={<span className="font-mono">{p.key}</span>} checked={v.permissions.includes(p.key)} onChange={(e) => setV({ ...v, permissions: e.target.checked ? [...v.permissions, p.key] : v.permissions.filter((x) => x !== p.key) })} />)}</div>
            </fieldset>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

function RolesTab({ data }: { data: RolesData }) {
  const { can } = useAuth()
  const [edit, setEdit] = useState<Role | null | undefined>(undefined)
  const cats = [...new Set(data.permissions.map((p) => p.category))]
  return (
    <Section title="Roles & permission matrix" description="Permissions are enforced by the server on every request and live connection; hiding a menu is never relied on." actions={can('roles.manage') && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEdit(null)}>New role</Button>}>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th className="sticky left-0 border-b border-line bg-canvas px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">Permission</th>
              {data.roles.map((r) => (
                <th key={r.id} className="min-w-[96px] border-b border-l border-line bg-canvas px-2 py-2 text-center align-bottom">
                  <button disabled={!can('roles.manage') || r.key === 'super_admin'} onClick={() => setEdit(r)} className="text-[12px] font-medium text-ink enabled:hover:underline">{r.name}</button>
                  <div className="text-[10.5px] font-normal text-muted">{r.user_count} user(s){r.requires_mfa ? ' · 2FA' : ''}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => [
              <tr key={c}><td colSpan={data.roles.length + 1} className="bg-subtle/50 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-highlight-ink">{c}</td></tr>,
              ...data.permissions.filter((p) => p.category === c).map((p) => (
                <tr key={p.key} className="border-b border-line/50">
                  <td className="sticky left-0 bg-surface px-3 py-1.5 text-ink-2">{p.label}</td>
                  {data.roles.map((r) => <td key={r.id} className="border-l border-line/50 text-center">{r.permissions.includes(p.key) ? <span className="text-accent" aria-label="Granted">●</span> : <span className="text-line-strong" aria-label="Not granted">·</span>}</td>)}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      {edit !== undefined && <RoleDialog role={edit} perms={data.permissions} onClose={() => setEdit(undefined)} />}
    </Section>
  )
}

function SessionsTab() {
  const q = useQuery({ queryKey: ['admin', 'sessions'], queryFn: () => api.get<{ staff: { id: string; user_id: string; name: string; email: string; created_at: string; last_seen_at: string; ip: string | null; user_agent: string | null; mfa_state: string }[]; portal: { id: string; client_name: string; label: string; created_at: string; last_seen_at: string; ip: string | null }[] }>('/api/admin/sessions') })
  return (
    <QueryState q={q}>
      {(d) => (
        <>
          <Section title={`Staff sessions · ${d.staff.length}`}>
            {d.staff.length === 0 ? <EmptyState title="No active sessions" /> : (
              <Table><thead><tr><Th>User</Th><Th>Started</Th><Th>Last active</Th><Th>IP</Th><Th>Device</Th></tr></thead>
                <tbody>{d.staff.map((s) => <Tr key={s.id}><Td>{s.name}<div className="text-[11.5px] text-muted">{s.email}</div></Td><Td className="text-ink-2">{fmtDateTime(s.created_at)}</Td><Td className="text-ink-2">{relative(s.last_seen_at)}</Td><Td className="font-mono text-[11.5px]">{s.ip ?? '—'}</Td><Td className="max-w-[260px] truncate text-[11.5px] text-muted">{s.user_agent}</Td></Tr>)}</tbody>
              </Table>
            )}
          </Section>
          <Section title={`Client portal sessions · ${d.portal.length}`}>
            {d.portal.length === 0 ? <p className="text-[13px] text-muted">No clients are signed in to the portal.</p> : (
              <Table><thead><tr><Th>Client</Th><Th>Link</Th><Th>Started</Th><Th>Last active</Th><Th>IP</Th></tr></thead>
                <tbody>{d.portal.map((s) => <Tr key={s.id}><Td>{s.client_name}</Td><Td className="text-ink-2">{s.label}</Td><Td className="text-ink-2">{fmtDateTime(s.created_at)}</Td><Td className="text-ink-2">{relative(s.last_seen_at)}</Td><Td className="font-mono text-[11.5px]">{s.ip ?? '—'}</Td></Tr>)}</tbody>
              </Table>
            )}
          </Section>
        </>
      )}
    </QueryState>
  )
}

export default function Users() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'users'
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api.get<RolesData>('/api/admin/roles'), enabled: can('users.manage', 'roles.manage') })
  return (
    <div>
      <PageHeader eyebrow="Administration" title="Users & roles" meta={<span>Invite people, assign roles and manage account security.</span>}>
        <div className="mt-5 border-b border-line"><Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'users', label: 'Users' }, { value: 'roles', label: 'Roles & permissions' }, ...(can('security.manage') ? [{ value: 'sessions', label: 'Active sessions' }] : [])]} /></div>
      </PageHeader>
      {tab === 'sessions' ? <SessionsTab /> : !roles.data ? <QueryState q={roles}>{() => null}</QueryState> : tab === 'roles' ? <RolesTab data={roles.data} /> : <UsersTab roles={roles.data.roles} />}
    </div>
  )
}
