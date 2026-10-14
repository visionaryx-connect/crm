import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell, BarChart3, Briefcase, CalendarDays, ChevronsLeft, ChevronsRight, CircleUserRound, ClipboardCheck, FileStack, FolderKanban, LayoutGrid, LogOut, Menu,
  Plus, Search, Settings, ShieldCheck, Users, UsersRound, Clock3, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useRealtimeStatus } from '@/lib/realtime'
import { Avatar, cx, Kbd } from '@/components/ui'
import { CommandPalette } from './CommandPalette'

interface NavItem {
  to: string
  label: string
  icon: typeof LayoutGrid
  perm?: string[]
  end?: boolean
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Work',
    items: [
      { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
      { to: '/tasks', label: 'My work', icon: ClipboardCheck },
      { to: '/projects', label: 'Projects', icon: FolderKanban },
      { to: '/clients', label: 'Clients', icon: Briefcase },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/files', label: 'Documents', icon: FileStack },
    ],
  },
  {
    group: 'People',
    items: [
      { to: '/team', label: 'Team', icon: UsersRound, perm: ['team.read'] },
      { to: '/hr/leave', label: 'Leave', icon: CircleUserRound },
      { to: '/hr/attendance', label: 'Attendance', icon: Clock3 },
    ],
  },
  {
    group: 'Insight',
    items: [{ to: '/reports', label: 'Reports', icon: BarChart3 }],
  },
  {
    group: 'Admin',
    items: [
      { to: '/admin/users', label: 'Users & roles', icon: Users, perm: ['users.manage', 'roles.manage', 'security.manage'] },
      { to: '/admin/audit', label: 'Security & audit', icon: ShieldCheck, perm: ['audit.read', 'security.manage'] },
      { to: '/settings', label: 'Settings', icon: Settings, perm: ['settings.manage', 'holidays.manage', 'departments.manage', 'leave.manage'] },
    ],
  },
]

function useCollapsed() {
  const [collapsed, set] = useState(() => {
    try {
      return localStorage.getItem('vx.nav.collapsed') === '1'
    } catch {
      return false
    }
  })
  const toggle = () =>
    set((c) => {
      try {
        localStorage.setItem('vx.nav.collapsed', c ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !c
    })
  return [collapsed, toggle] as const
}

function Sidebar({ collapsed, onToggle, mobile, onNavigate }: { collapsed: boolean; onToggle?: () => void; mobile?: boolean; onNavigate?: () => void }) {
  const { can } = useAuth()
  return (
    <nav aria-label="Main" className={cx('flex h-full flex-col bg-forest-700 text-[#d9e3dc]', collapsed ? 'w-[60px]' : 'w-[228px]')}>
      <div className={cx('flex h-14 items-center border-b border-white/8', collapsed ? 'justify-center' : 'px-4')}>
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-[5px] bg-gold font-display text-[15px] font-semibold text-forest-700" aria-hidden>
            X
          </span>
          {!collapsed && (
            <span className="leading-tight">
              <span className="block font-display text-[15px] text-paper">Visionary X</span>
              <span className="block font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#9db3a5]">Operations</span>
            </span>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-3">
        {NAV.map((g) => {
          const items = g.items.filter((i) => !i.perm || can(...i.perm))
          if (items.length === 0) return null
          return (
            <div key={g.group} className="mb-4">
              {!collapsed && <div className="mb-1 px-4 font-mono text-[9.5px] uppercase tracking-[0.18em] text-[#7f9a89]">{g.group}</div>}
              <ul className="space-y-px px-2">
                {items.map((i) => (
                  <li key={i.to}>
                    <NavLink
                      to={i.to}
                      end={i.end}
                      onClick={onNavigate}
                      title={collapsed ? i.label : undefined}
                      className={({ isActive }) =>
                        cx(
                          'group relative flex h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors',
                          collapsed ? 'justify-center' : 'px-2.5',
                          isActive ? 'bg-white/[0.09] text-paper' : 'text-[#c3d1c8] hover:bg-white/[0.05] hover:text-paper',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-gold" aria-hidden />}
                          <i.icon className="size-[15px] shrink-0" strokeWidth={1.7} />
                          {!collapsed && <span>{i.label}</span>}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
      {!mobile && onToggle && (
        <button onClick={onToggle} className="flex h-10 items-center justify-center gap-2 border-t border-white/8 text-[12px] text-[#9db3a5] hover:text-paper" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <ChevronsRight className="size-4" /> : (<><ChevronsLeft className="size-4" /> Collapse</>)}
        </button>
      )}
    </nav>
  )
}

function LiveIndicator() {
  const s = useRealtimeStatus()
  const label = s === 'live' ? 'Live updates on' : s === 'connecting' ? 'Connecting…' : 'Offline — reconnecting'
  return (
    <span className="hidden items-center gap-1.5 text-[11.5px] text-muted md:inline-flex" title={label}>
      <span className={cx('size-1.5 rounded-full', s === 'live' ? 'bg-ok' : s === 'connecting' ? 'bg-gold animate-pulse' : 'bg-danger')} aria-hidden />
      {s === 'live' ? 'Live' : s === 'connecting' ? 'Connecting' : 'Offline'}
    </span>
  )
}

function UserMenu() {
  const { me } = useAuth()
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  const qc = useQueryClient()
  const logout = async () => {
    try {
      await api.post('/api/auth/logout')
    } finally {
      qc.clear()
      nav('/login', { replace: true })
    }
  }
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-md py-1 pl-1 pr-2 hover:bg-porcelain" aria-haspopup="menu" aria-expanded={open}>
        <Avatar name={me.user.name} color={me.user.avatarColor} size={26} />
        <span className="hidden text-left leading-tight lg:block">
          <span className="block text-[12.5px] font-medium text-ink">{me.user.name}</span>
          <span className="block text-[11px] text-muted">{me.roles[0]?.name}</span>
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 z-40 mt-1 w-56 animate-rise rounded-lg border border-line bg-paper p-1 shadow-pop" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
            <div className="border-b border-line px-3 py-2">
              <p className="text-[13px] font-medium">{me.user.name}</p>
              <p className="truncate text-[12px] text-muted">{me.user.email}</p>
            </div>
            <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] hover:bg-ivory" onClick={() => { setOpen(false); nav(`/team/${me.user.id}`) }}>
              <CircleUserRound className="size-4 text-muted" /> My profile
            </button>
            <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] hover:bg-ivory" onClick={() => { setOpen(false); nav('/account') }}>
              <ShieldCheck className="size-4 text-muted" /> Account & security
            </button>
            <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-danger hover:bg-danger-bg" onClick={logout}>
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function QuickCreate() {
  const { can } = useAuth()
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  const items = [
    can('projects.create') && { label: 'New project', to: '/projects?new=1' },
    can('clients.manage') && { label: 'New client', to: '/clients?new=1' },
    { label: 'Schedule meeting', to: '/calendar?new=1' },
    can('leave.request') && { label: 'Request leave', to: '/hr/leave?new=1' },
  ].filter(Boolean) as { label: string; to: string }[]
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-forest px-2.5 text-[12.5px] font-medium text-paper hover:bg-forest-600" aria-haspopup="menu" aria-expanded={open}>
        <Plus className="size-3.5" /> <span className="hidden sm:inline">Create</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 z-40 mt-1 w-48 animate-rise rounded-lg border border-line bg-paper p-1 shadow-pop">
            {items.map((i) => (
              <button key={i.to} role="menuitem" onClick={() => { setOpen(false); nav(i.to) }} className="block w-full rounded px-3 py-2 text-left text-[13px] hover:bg-ivory">
                {i.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function NotificationBell() {
  const q = useQuery({ queryKey: ['notifications', 'count'], queryFn: () => api.get<{ unread: number }>('/api/notifications/count'), refetchInterval: 120_000 })
  const n = q.data?.unread ?? 0
  return (
    <NavLink to="/notifications" className="relative inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-porcelain" aria-label={`Notifications${n ? `, ${n} unread` : ''}`}>
      <Bell className="size-[17px]" strokeWidth={1.7} />
      {n > 0 && <span className="absolute right-1 top-1 min-w-[15px] rounded-full bg-gold px-1 text-center font-mono text-[9.5px] leading-[15px] text-forest-700">{n > 99 ? '99+' : n}</span>}
    </NavLink>
  )
}

export function AppShell({ children }: { children?: ReactNode }) {
  const [collapsed, toggle] = useCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const loc = useLocation()
  useEffect(() => setMobileOpen(false), [loc.pathname])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-dvh overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-paper focus:px-3 focus:py-2">
        Skip to content
      </a>
      <div className="no-print hidden shrink-0 transition-[width] duration-200 md:block">
        <Sidebar collapsed={collapsed} onToggle={toggle} />
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setMobileOpen(false)} />
          <div className="relative h-full w-[240px] animate-rise">
            <Sidebar collapsed={false} mobile onNavigate={() => setMobileOpen(false)} />
            <button onClick={() => setMobileOpen(false)} className="absolute right-2 top-3 text-paper/80" aria-label="Close menu">
              <X className="size-5" />
            </button>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-14 shrink-0 items-center gap-3 border-b border-line bg-paper/80 px-4 backdrop-blur md:px-6">
          <button className="-ml-1 inline-flex size-8 items-center justify-center rounded-md hover:bg-porcelain md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <button onClick={() => setPaletteOpen(true)} aria-label="Search" className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-line bg-ivory px-2.5 text-left text-[13px] text-muted hover:border-line-strong sm:w-full sm:max-w-[420px]">
            <Search className="size-3.5 shrink-0" />
            <span className="hidden flex-1 truncate sm:block">Search projects, tasks, clients, people</span>
            <span className="hidden sm:inline-flex gap-0.5">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <LiveIndicator />
            <QuickCreate />
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        <main id="main" className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1320px] px-4 py-6 md:px-8 md:py-8">{children ?? <Outlet />}</div>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
