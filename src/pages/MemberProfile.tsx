import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, Lock, Pencil } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { useDepartments, useMembers } from '@/lib/lookups'
import { fmtDate } from '@/lib/format'
import { Avatar, Badge, Button, Dialog, ErrorState, Field, Input, KeyValue, PageHeader, Panel, SampleTag, Section, Select, SkeletonRows, StatStrip, Table, Td, Textarea, Th, Tr } from '@/components/ui'
import { ProjectStatusBadge } from '@/components/status'

interface ProfileData {
  member: Record<string, any> & { id: string; name: string; email: string; status: string; avatar_color: string | null; is_seed: boolean; skills: string[]; roles: { key: string; name: string }[] }
  projects: { id: string; reference: string; name: string; status: string; role: string; responsibility: string }[]
  work: null | { todo: number; in_progress: number; in_review: number; blocked: number; overdue: number; open_estimate_hours: number }
  permissions: { seeSensitive: boolean; canEdit: boolean; canEditSelf: boolean; canSeeWork: boolean }
}

function EditProfile({ data, onClose }: { data: ProfileData; onClose: () => void }) {
  const m = data.member
  const hr = data.permissions.canEdit
  const members = useMembers()
  const departments = useDepartments()
  const [v, setV] = useState({
    name: m.name, designation: m.designation ?? '', departmentId: m.department_id ?? '', managerUserId: m.manager_user_id ?? '', workPhone: m.work_phone ?? '', personalPhone: m.personal_phone ?? '', personalEmail: m.personal_email ?? '',
    dateOfBirth: m.date_of_birth ?? '', address: m.address ?? '', emergencyContactName: m.emergency_contact_name ?? '', emergencyContactPhone: m.emergency_contact_phone ?? '', joiningDate: m.joining_date ?? '', exitDate: m.exit_date ?? '',
    employmentType: m.employment_type ?? 'full_time', employmentStatus: m.employment_status ?? 'active', weeklyCapacityHours: m.weekly_capacity_hours?.toString() ?? '', skills: (m.skills ?? []).join(', '),
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useAction(
    () => {
      const self = { workPhone: v.workPhone || null, personalPhone: v.personalPhone || null, personalEmail: v.personalEmail, address: v.address || null, emergencyContactName: v.emergencyContactName || null, emergencyContactPhone: v.emergencyContactPhone || null, skills: v.skills.split(',').map((s) => s.trim()).filter(Boolean) }
      const org = hr ? { name: v.name, designation: v.designation, departmentId: v.departmentId || null, managerUserId: v.managerUserId || null, dateOfBirth: v.dateOfBirth || null, joiningDate: v.joiningDate || null, exitDate: v.exitDate || null, employmentType: v.employmentType, employmentStatus: v.employmentStatus, weeklyCapacityHours: v.weeklyCapacityHours === '' ? null : Number(v.weeklyCapacityHours) } : {}
      return api.patch(`/api/team/members/${m.id}`, { ...self, ...org })
    },
    { success: 'Profile updated', invalidate: [['member', m.id], ['team']], onSuccess: onClose, onError: (e) => e instanceof ApiError && setErrors(e.fields) },
  )
  const f = (k: keyof typeof v, label: string, type = 'text', span = false) => <Field label={label} error={errors[k]} className={span ? 'sm:col-span-2' : undefined}><Input type={type} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>
  return (
    <Dialog open onClose={onClose} title="Edit profile" width={720} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {hr && (
          <>
            {f('name', 'Full name')}
            {f('designation', 'Designation')}
            <Field label="Department"><Select value={v.departmentId} onChange={(e) => setV({ ...v, departmentId: e.target.value })}><option value="">—</option>{departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
            <Field label="Reporting manager" error={errors.managerUserId}><Select value={v.managerUserId} onChange={(e) => setV({ ...v, managerUserId: e.target.value })}><option value="">—</option>{members.data?.filter((x) => x.id !== m.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
            <Field label="Employment type"><Select value={v.employmentType} onChange={(e) => setV({ ...v, employmentType: e.target.value })}><option value="full_time">Full-time</option><option value="part_time">Part-time</option><option value="contract">Contract</option><option value="intern">Intern</option></Select></Field>
            <Field label="Employment status"><Select value={v.employmentStatus} onChange={(e) => setV({ ...v, employmentStatus: e.target.value })}><option value="active">Active</option><option value="probation">Probation</option><option value="notice">Notice period</option><option value="exited">Exited</option></Select></Field>
            {f('joiningDate', 'Joining date', 'date')}
            {f('exitDate', 'Exit date', 'date')}
            {f('weeklyCapacityHours', 'Weekly capacity (hours)', 'number')}
            {f('dateOfBirth', 'Date of birth', 'date')}
          </>
        )}
        {f('workPhone', 'Work phone')}
        {f('personalPhone', 'Personal phone')}
        {f('personalEmail', 'Personal email', 'email')}
        {f('emergencyContactName', 'Emergency contact')}
        {f('emergencyContactPhone', 'Emergency contact phone')}
        <Field label="Address" className="sm:col-span-2"><Textarea rows={2} value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} /></Field>
        <Field label="Skills" hint="Comma-separated" className="sm:col-span-2"><Input value={v.skills} onChange={(e) => setV({ ...v, skills: e.target.value })} /></Field>
      </div>
    </Dialog>
  )
}

export default function MemberProfile() {
  const { id = '' } = useParams()
  const q = useQuery({ queryKey: ['member', id], queryFn: () => api.get<ProfileData>(`/api/team/members/${id}`) })
  const [editing, setEditing] = useState(false)
  if (q.isLoading) return <SkeletonRows rows={10} />
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const d = q.data
  const m = d.member
  return (
    <div>
      <PageHeader
        eyebrow={<Link to="/team" className="hover:underline">Team · {m.employee_code}</Link>}
        title={<span className="flex items-center gap-4"><Avatar name={m.name} color={m.avatar_color} size={48} />{m.name}{m.is_seed && <SampleTag />}</span>}
        meta={<><span>{m.designation || 'No designation'}</span><span>{m.department_name ?? 'No department'}</span>{m.roles.map((r) => <Badge key={r.key} tone="outline">{r.name}</Badge>)}{m.status !== 'active' && <Badge tone="highlight">{m.status}</Badge>}</>}
        actions={<>{d.permissions.canSeeWork && <Link to={`/reports?type=member&scopeId=${m.id}`}><Button icon={<BarChart3 className="size-4" />}>Monthly report</Button></Link>}{(d.permissions.canEdit || d.permissions.canEditSelf) && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit profile</Button>}</>}
      />
      {d.work && (
        <div className="mb-8">
          <StatStrip stats={[
            { label: 'To do', value: d.work.todo ?? 0 }, { label: 'In progress', value: d.work.in_progress ?? 0 }, { label: 'In review', value: d.work.in_review ?? 0 },
            { label: 'Blocked', value: d.work.blocked ?? 0, tone: d.work.blocked ? 'danger' : undefined }, { label: 'Overdue', value: d.work.overdue ?? 0, tone: d.work.overdue ? 'danger' : undefined },
            { label: 'Open estimate', value: `${Math.round(d.work.open_estimate_hours ?? 0)} h`, hint: m.weekly_capacity_hours ? `Capacity ${m.weekly_capacity_hours} h/week` : 'No capacity recorded' },
          ]} />
        </div>
      )}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Section title="Projects">
            {d.projects.length === 0 ? <p className="text-[13px] text-muted">Not on any projects you can see.</p> : (
              <Table><thead><tr><Th>Project</Th><Th>Role</Th><Th>Responsibility</Th><Th>Status</Th></tr></thead>
                <tbody>{d.projects.map((p) => <Tr key={p.id}><Td><Link to={`/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link><div className="font-mono text-[11px] text-muted">{p.reference}</div></Td><Td className="capitalize">{p.role}</Td><Td className="text-ink-2">{p.responsibility || '—'}</Td><Td><ProjectStatusBadge status={p.status} /></Td></Tr>)}</tbody>
              </Table>
            )}
          </Section>
          {m.skills.length > 0 && <Section title="Skills"><div className="flex flex-wrap gap-1.5">{m.skills.map((s) => <Badge key={s} tone="accent">{s}</Badge>)}</div></Section>}
        </div>
        <aside className="space-y-6">
          <Panel className="p-4"><KeyValue cols={1} items={[
            { label: 'Work email', value: <a href={`mailto:${m.email}`} className="link">{m.email}</a> },
            { label: 'Work phone', value: m.work_phone },
            { label: 'Reports to', value: m.manager_name },
            { label: 'Joined', value: fmtDate(m.joining_date) },
            { label: 'Employment', value: m.employment_type ? `${String(m.employment_type).replace('_', '-')} · ${m.employment_status}` : null },
          ]} /></Panel>
          {d.permissions.seeSensitive ? (
            <Panel className="p-4">
              <div className="eyebrow mb-3 flex items-center gap-1.5"><Lock className="size-3" /> Private HR details</div>
              <KeyValue cols={1} items={[
                { label: 'Personal phone', value: m.personal_phone }, { label: 'Personal email', value: m.personal_email }, { label: 'Date of birth', value: fmtDate(m.date_of_birth) },
                { label: 'Address', value: m.address }, { label: 'Emergency contact', value: m.emergency_contact_name ? `${m.emergency_contact_name} · ${m.emergency_contact_phone ?? ''}` : null },
              ]} />
            </Panel>
          ) : <p className="flex items-center gap-1.5 text-[12px] text-muted"><Lock className="size-3" /> Private HR details are visible only to HR and the person.</p>}
        </aside>
      </div>
      {editing && <EditProfile data={d} onClose={() => setEditing(false)} />}
    </div>
  )
}
