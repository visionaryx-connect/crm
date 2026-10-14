import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Download, Search } from 'lucide-react'
import { api, qs } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { download, fmtDateTime } from '@/lib/format'
import { Badge, Button, EmptyState, ErrorState, Input, PageHeader, Select, SkeletonRows, Table, Td, Th, Tr } from '@/components/ui'

interface Entry { id: string; category: string; actor_type: string; actor_name: string | null; action: string; entity_type: string | null; summary: string; changes: unknown; ip: string | null; created_at: string; project_id: string | null }

export default function Audit() {
  const { can } = useAuth()
  const [category, setCategory] = useState('security')
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const list = useInfiniteQuery({
    queryKey: ['admin', 'audit', category, q],
    queryFn: ({ pageParam }) => api.get<{ entries: Entry[]; nextBefore: string | null }>(`/api/admin/audit${qs({ category, q, before: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  })
  const rows = list.data?.pages.flatMap((p) => p.entries) ?? []
  return (
    <div>
      <PageHeader eyebrow="Administration" title="Security & audit log" meta={<span>Immutable record of sign-ins, permission changes, data changes and client portal access.</span>} actions={can('data.export') && <a href="/api/admin/export"><Button icon={<Download className="size-4" />}>Export company data</Button></a>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-44" aria-label="Category"><option value="security">Security events</option><option value="admin">Administrative changes</option><option value="activity">Work activity</option><option value="">Everything</option></Select>
        <div className="relative w-full max-w-sm"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-faint" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search summaries and actions" className="pl-8" aria-label="Search log" /></div>
        {rows.length > 0 && <Button variant="ghost" className="ml-auto" icon={<Download className="size-4" />} onClick={() => download('audit-log.json', JSON.stringify(rows, null, 1), 'application/json')}>Download shown</Button>}
      </div>
      {list.isLoading ? <SkeletonRows rows={10} /> : list.error ? <ErrorState error={list.error} /> : rows.length === 0 ? <EmptyState title="No log entries match" /> : (
        <>
          <Table>
            <thead><tr><Th>When (IST)</Th><Th>Actor</Th><Th>Event</Th><Th>Details</Th><Th>IP</Th></tr></thead>
            <tbody>{rows.map((e) => (
              <Tr key={e.id} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                <Td className="whitespace-nowrap font-mono text-[11.5px] text-muted">{fmtDateTime(e.created_at)}</Td>
                <Td className="text-ink">{e.actor_type === 'user' ? e.actor_name ?? 'Unknown user' : <Badge tone={e.actor_type === 'client' ? 'gold' : 'outline'}>{e.actor_type}</Badge>}</Td>
                <Td><span className="font-mono text-[11.5px] text-ink-2">{e.action}</span></Td>
                <Td className="text-ink-2">{e.summary}{expanded === e.id && e.changes != null && <pre className="mt-2 max-h-60 overflow-auto rounded bg-ivory p-2 font-mono text-[11px] text-ink-2">{JSON.stringify(e.changes, null, 2)}</pre>}</Td>
                <Td className="font-mono text-[11px] text-muted">{e.ip ?? '—'}</Td>
              </Tr>
            ))}</tbody>
          </Table>
          {list.hasNextPage && <div className="mt-4 flex justify-center"><Button loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Load older entries</Button></div>}
        </>
      )}
    </div>
  )
}
