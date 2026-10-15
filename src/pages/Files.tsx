import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Download, FileStack, Search } from 'lucide-react'
import { api, qs } from '@/lib/api'
import { bytes, relative } from '@/lib/format'
import { Badge, EmptyState, Input, PageHeader, QueryState, Table, Td, Th, Tr } from '@/components/ui'

interface FileRow { id: string; project_id: string; project_reference: string; project_name: string; task_id: string | null; task_number: number | null; task_title: string | null; deliverable_title: string | null; version: number; file_name: string; content_type: string; size_bytes: number; client_visible: number; created_at: string; uploaded_by_name: string | null }

export default function Files() {
  const [q, setQ] = useState('')
  const list = useQuery({ queryKey: ['files', q], queryFn: () => api.get<{ files: FileRow[]; storageEnabled: boolean }>(`/api/files${qs({ q })}`) })
  return (
    <div>
      <PageHeader eyebrow="Documents" title="Documents" meta={<span>Files from projects you can access. Everything is private; downloads are authorised individually.</span>} />
      <div className="relative mb-4 w-full max-w-sm"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-faint" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search file names" className="pl-8" aria-label="Search files" /></div>
      <QueryState q={list} empty={(d) => (d.files.length === 0 ? <EmptyState icon={<FileStack className="size-7" strokeWidth={1.4} />} title={q ? 'No files match' : 'No documents yet'} body={d.storageEnabled ? 'Upload files from a project, task or deliverable.' : 'File storage (R2) is not configured for this deployment.'} /> : null)}>
        {(d) => (
          <Table>
            <thead><tr><Th>File</Th><Th>Project</Th><Th>Linked to</Th><Th>Size</Th><Th>Uploaded</Th><Th /></tr></thead>
            <tbody>{d.files.map((f) => (
              <Tr key={f.id}>
                <Td><span className="font-medium text-ink">{f.file_name}</span>{f.client_visible ? <Badge tone="highlight" className="ml-2">Shared with client</Badge> : null}<div className="font-mono text-[11px] text-muted">{f.content_type}</div></Td>
                <Td><Link to={`/projects/${f.project_id}?tab=files`} className="hover:underline"><span className="font-mono text-[11px] text-highlight-ink">{f.project_reference}</span> {f.project_name}</Link></Td>
                <Td className="text-ink-2">{f.deliverable_title ? `${f.deliverable_title} · v${f.version}` : f.task_id ? <Link to={`/tasks/${f.task_id}`} className="hover:underline">#{f.task_number} {f.task_title}</Link> : '—'}</Td>
                <Td className="font-mono text-[12px] text-muted">{bytes(f.size_bytes)}</Td>
                <Td className="text-ink-2">{f.uploaded_by_name} · {relative(f.created_at)}</Td>
                <Td align="right"><a href={`/api/files/${f.id}/download`} className="inline-flex text-accent" aria-label={`Download ${f.file_name}`}><Download className="size-4" /></a></Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </QueryState>
    </div>
  )
}
