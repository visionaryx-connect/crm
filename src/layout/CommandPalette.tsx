import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Briefcase, CornerDownLeft, FolderKanban, ListChecks, Search, User } from 'lucide-react'
import { api, qs } from '@/lib/api'
import { cx, Spinner } from '@/components/ui'

interface Result {
  type: 'project' | 'task' | 'client' | 'person'
  id: string
  title: string
  subtitle: string
  href: string
}
const ICON = { project: FolderKanban, task: ListChecks, client: Briefcase, person: User }

const SHORTCUTS: Result[] = [
  { type: 'task', id: 'mine', title: 'My work', subtitle: 'Tasks assigned to me', href: '/tasks' },
  { type: 'project', id: 'projects', title: 'All projects', subtitle: 'Projects', href: '/projects' },
  { type: 'person', id: 'leave', title: 'Request leave', subtitle: 'HR', href: '/hr/leave?new=1' },
  { type: 'project', id: 'calendar', title: 'Company calendar', subtitle: 'Calendar', href: '/calendar' },
]

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [active, setActive] = useState(0)
  const nav = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 160)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      setQ('')
      setActive(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
    if (!open && d.open) d.close()
  }, [open])

  const search = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<{ results: Result[] }>(`/api/dashboard/search${qs({ q: debounced })}`),
    enabled: open && debounced.length >= 2,
    staleTime: 30_000,
  })
  const results = debounced.length >= 2 ? (search.data?.results ?? []) : SHORTCUTS
  const go = (r: Result) => {
    onClose()
    nav(r.href)
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose() }} onClick={(e) => e.target === dialogRef.current && onClose()} className="mx-auto mt-[12vh] w-[calc(100vw-32px)] max-w-[580px] bg-transparent p-0">
      {open && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-pop animate-rise">
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search className="size-4 text-muted" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => { setQ(e.target.value); setActive(0) }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
                if (e.key === 'Enter' && results[active]) go(results[active]!)
              }}
              placeholder="Search projects, tasks, clients, people…"
              className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
              aria-label="Search"
              role="combobox"
              aria-expanded
              aria-controls="palette-results"
            />
            {search.isFetching && <Spinner />}
          </div>
          <ul id="palette-results" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
            {debounced.length < 2 && <li className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Jump to</li>}
            {results.length === 0 && debounced.length >= 2 && !search.isFetching && <li className="px-3 py-6 text-center text-[13px] text-muted">No matches for “{debounced}”.</li>}
            {results.map((r, i) => {
              const Icon = ICON[r.type]
              return (
                <li key={`${r.type}-${r.id}`} role="option" aria-selected={i === active}>
                  <button onMouseEnter={() => setActive(i)} onClick={() => go(r)} className={cx('flex w-full items-center gap-3 rounded-md px-3 py-2 text-left', i === active && 'bg-accent-faint')}>
                    <Icon className="size-4 shrink-0 text-muted" strokeWidth={1.7} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-ink">{r.title}</span>
                      <span className="block truncate font-mono text-[11px] text-muted">{r.subtitle}</span>
                    </span>
                    {i === active && <CornerDownLeft className="size-3.5 text-muted" />}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </dialog>
  )
}
