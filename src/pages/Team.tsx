import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAction } from '@/lib/forms'
import { useDepartments, useMembers } from '@/lib/lookups'
import { Avatar, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, IconButton, Input, PageHeader, Panel, QueryState, SampleTag, Section, Select, Table, Tabs, Td, Textarea, Th, Tr, cx } from '@/components/ui'

type Tab = 'directory' | 'workload' | 'departments'

interface DirectoryRow { id: string; name: string; email: string; status: string; avatar_color: string | null; is_seed: boolean; employee_code: string | null; designation: string | null; department_name: string | null; manager_name: string | null; work_phone: string | null; skills: string[]; roles: string[] }
interface WorkloadRow { id: string; name: string; avatar_color: string | null; designation: string | null; department_name: string | null; weekly_capacity_hours: number | null; open_tasks: number; in_progress: number; awaiting_review: number; blocked: number; overdue: number; due_this_week: number; open_estimate_hours: number; open_weight: number; high_priority: number; minutes_30d: number }

function Directory() {
  const [q, setQ] = useState('')
  const [dept, setDept] = useState('')
  const list = useQuery({ queryKey: ['team', 'directory'], queryFn: () => api.get<{ members: DirectoryRow[] }>('/api/team/members').then((r) => r.members) })
  const departments = useDepartments()
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-faint" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people or skills" className="pl-8" aria-label="Search people" /></div>
        <Select value={dept} onChange={(e) => setDept(e.target.value)} className="w-48" aria-label="Department"><option value="">All departments</option>{departments.data?.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}</Select>
      </div>
      <QueryState q={list}>
        {(rows) => {
          const filtered = rows.filter((r) => (!dept || r.department_name === dept) && (!q || `${r.name} ${r.designation} ${r.skills.join(' ')}`.toLowerCase().includes(q.toLowerCase())))
          if (!filtered.length) return <EmptyState title="No one matches" />
          return (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((m) => (
                <Link key={m.id} to={`/team/${m.id}`}>
                  <Panel className="flex h-full gap-3 p-4 transition-colors hover:border-line-strong">
                    <Avatar name={m.name} color={m.avatar_color} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="truncate font-medium text-ink">{m.name}</span>{m.is_seed && <SampleTag />}{m.status === 'invited' && <Badge tone="highlight">Invited</Badge>}</div>
                      <p className="truncate text-[12.5px] text-ink-2">{m.designation || '—'}</p>
                      <p className="truncate text-[12px] text-muted">{m.department_name ?? 'No department'}{m.manager_name && ` · reports to ${m.manager_name}`}</p>
                      {m.skills.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{m.skills.slice(0, 4).map((s) => <Badge key={s} tone="outline">{s}</Badge>)}</div>}
                    </div>
                  </Panel>
                </Link>
              ))}
            </div>
          )
        }}
      </QueryState>
    </div>
  )
}

function Workload() {
  const q = useQuery({ queryKey: ['team', 'workload'], queryFn: () => api.get<{ members: WorkloadRow[]; departments: { name: string; members: number; open_tasks: number; open_estimate_hours: number; overdue: number; blocked: number; capacity: number | null }[]; scope: string }>('/api/team/workload') })
  return (
    <QueryState q={q} empty={(d) => (d.members.length === 0 ? <EmptyState title="No team members in your scope" body="Workload shows your direct reports and department. HR and company reporters see everyone." /> : null)}>
      {(d) => (
        <div>
          <p className="mb-4 max-w-3xl text-[13px] text-muted">Open work is shown with its estimated effort and complexity, review queue, deadlines and blockers. Task counts on their own are not a performance measure. {d.scope === 'team' && 'Showing your direct reports and department.'}</p>
          <Section title="By department">
            <Panel className="px-2 pb-2 pt-4">
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.departments} margin={{ left: 0, right: 12 }}>
                    <CartesianGrid vertical={false} stroke="#262626" />
                    <XAxis dataKey="name" tick={{ fontSize: 11.5, fill: '#cccaca' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#8d8b88' }} axisLine={false} tickLine={false} width={36} />
                    <Tooltip contentStyle={{ background: '#141414', color: '#fbfaf7', fontSize: 12, borderRadius: 6, border: '1px solid #262626' }} />
                    <Bar dataKey="open_estimate_hours" name="Open estimated hours" fill="#fbfaf7" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="capacity" name="Weekly capacity (h)" fill="#8d8b88" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </Section>
          <Section title="People">
            <Table>
              <thead><tr><Th>Person</Th><Th align="right">Open</Th><Th align="right">In progress</Th><Th align="right">In review</Th><Th align="right">Due ≤7d</Th><Th align="right">Overdue</Th><Th align="right">Blocked</Th><Th align="right">Open est. h</Th><Th>Load vs capacity</Th><Th align="right">Logged 30d</Th></tr></thead>
              <tbody>{d.members.map((m) => {
                const cap = m.weekly_capacity_hours
                const ratio = cap ? m.open_estimate_hours / cap : null
                return (
                  <Tr key={m.id}>
                    <Td><Link to={`/team/${m.id}`} className="flex items-center gap-2"><Avatar name={m.name} color={m.avatar_color} size={24} /><span><span className="block text-ink hover:underline">{m.name}</span><span className="block text-[11.5px] text-muted">{m.department_name ?? '—'}</span></span></Link></Td>
                    <Td align="right" className="font-mono">{m.open_tasks}{m.high_priority > 0 && <span className="ml-1 text-warn" title="High/urgent">({m.high_priority}↑)</span>}</Td>
                    <Td align="right" className="font-mono">{m.in_progress}</Td>
                    <Td align="right" className="font-mono">{m.awaiting_review}</Td>
                    <Td align="right" className="font-mono">{m.due_this_week}</Td>
                    <Td align="right" className={cx('font-mono', m.overdue > 0 && 'text-danger')}>{m.overdue}</Td>
                    <Td align="right" className={cx('font-mono', m.blocked > 0 && 'text-danger')}>{m.blocked}</Td>
                    <Td align="right" className="font-mono">{Math.round(m.open_estimate_hours)}</Td>
                    <Td className="min-w-[140px]">{ratio === null ? <span className="text-[12px] text-faint">No capacity recorded</span> : (
                      <div className="flex items-center gap-2"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-track"><div className={cx('h-full rounded-full', ratio > 1.5 ? 'bg-danger' : ratio > 1 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, ratio * 66)}%` }} /></div><span className="w-12 text-right font-mono text-[11px] text-muted">{ratio.toFixed(1)}w</span></div>
                    )}</Td>
                    <Td align="right" className="font-mono">{Math.round(m.minutes_30d / 60)} h</Td>
                  </Tr>
                )
              })}</tbody>
            </Table>
            <p className="mt-2 text-[12px] text-muted">Load = open estimated hours ÷ weekly capacity, expressed in weeks of work.</p>
          </Section>
        </div>
      )}
    </QueryState>
  )
}

function Departments() {
  const { can } = useAuth()
  const q = useDepartments()
  const members = useMembers()
  const [edit, setEdit] = useState<null | { id?: string; name: string; code: string; description: string; headUserId: string }>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [del, setDel] = useState<string | null>(null)
  const save = useAction(() => (edit!.id ? api.put(`/api/team/departments/${edit!.id}`, { ...edit, headUserId: edit!.headUserId || null }) : api.post('/api/team/departments', { ...edit, headUserId: edit!.headUserId || null })), { success: 'Department saved', invalidate: [['departments']], onSuccess: () => setEdit(null), onError: (e) => e instanceof ApiError && setErrors(e.fields) })
  const remove = useAction((id: string) => api.del(`/api/team/departments/${id}`), { success: 'Department archived', invalidate: [['departments']], onSuccess: () => setDel(null) })
  const manage = can('departments.manage')
  return (
    <Section title="Departments" actions={manage && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => { setErrors({}); setEdit({ name: '', code: '', description: '', headUserId: '' }) }}>Add department</Button>}>
      <QueryState q={q}>
        {(rows) => (
          <Table>
            <thead><tr><Th>Department</Th><Th>Code</Th><Th>Head</Th><Th align="right">People</Th><Th /></tr></thead>
            <tbody>{rows.map((d) => (
              <Tr key={d.id}>
                <Td><span className="font-medium text-ink">{d.name}</span>{d.description && <p className="text-[12px] text-muted">{d.description}</p>}</Td>
                <Td className="font-mono text-[12px]">{d.code}</Td>
                <Td className="text-ink-2">{d.head_name ?? '—'}</Td>
                <Td align="right" className="font-mono">{d.member_count}</Td>
                <Td align="right">{manage && <><IconButton label="Edit" onClick={() => { setErrors({}); setEdit({ id: d.id, name: d.name, code: d.code, description: d.description, headUserId: d.head_user_id ?? '' }) }}><Pencil className="size-3.5" /></IconButton><IconButton label="Archive" onClick={() => setDel(d.id)}><Trash2 className="size-3.5" /></IconButton></>}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </QueryState>
      {edit && (
        <Dialog open onClose={() => setEdit(null)} title={edit.id ? 'Edit department' : 'New department'} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={errors.name}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></Field>
            <Field label="Code" error={errors.code}><Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} className="font-mono uppercase" /></Field>
            <Field label="Head of department" className="sm:col-span-2"><Select value={edit.headUserId} onChange={(e) => setEdit({ ...edit, headUserId: e.target.value })}><option value="">—</option>{members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
            <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          </div>
        </Dialog>
      )}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del)} loading={remove.isPending} danger title="Archive department?" confirmLabel="Archive" body="Departments with active members can’t be archived — move people first." />
    </Section>
  )
}

export default function Team() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'directory'
  return (
    <div>
      <PageHeader eyebrow="People" title="Team" meta={<span>Directory, workload and departments</span>}>
        <div className="mt-5 border-b border-line"><Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[{ value: 'directory', label: 'Directory' }, { value: 'workload', label: 'Workload' }, { value: 'departments', label: 'Departments' }]} /></div>
      </PageHeader>
      {tab === 'directory' && <Directory />}
      {tab === 'workload' && <Workload />}
      {tab === 'departments' && <Departments />}
    </div>
  )
}
