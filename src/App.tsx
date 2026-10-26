import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '@/lib/api'
import { AuthGate, useAuth } from '@/lib/auth'
import { RealtimeProvider } from '@/lib/realtime'
import { ToastProvider } from '@/components/toast'
import { AppShell } from '@/layout/AppShell'
import { BrandMark, EmptyState, SkeletonRows } from '@/components/ui'
import { Lock } from 'lucide-react'

const Login = lazy(() => import('@/pages/auth/Login'))
const VerifyMfa = lazy(() => import('@/pages/auth/VerifyMfa'))
const SetupMfa = lazy(() => import('@/pages/auth/SetupMfa'))
const SetPassword = lazy(() => import('@/pages/auth/SetPassword'))
const ForgotPassword = lazy(() => import('@/pages/auth/ForgotPassword'))
const SessionExpired = lazy(() => import('@/pages/auth/SessionExpired'))
const Dashboard = lazy(() => import('@/pages/Dashboard'))
const Clients = lazy(() => import('@/pages/Clients'))
const ClientDetail = lazy(() => import('@/pages/ClientDetail'))
const Projects = lazy(() => import('@/pages/Projects'))
const ProjectWorkspace = lazy(() => import('@/pages/ProjectWorkspace'))
const MyWork = lazy(() => import('@/pages/MyWork'))
const DailyTasks = lazy(() => import('@/pages/DailyTasks'))
const TaskDetail = lazy(() => import('@/pages/TaskDetail'))
const CalendarPage = lazy(() => import('@/pages/Calendar'))
const Team = lazy(() => import('@/pages/Team'))
const MemberProfile = lazy(() => import('@/pages/MemberProfile'))
const Leave = lazy(() => import('@/pages/hr/Leave'))
const Attendance = lazy(() => import('@/pages/hr/Attendance'))
const Notifications = lazy(() => import('@/pages/Notifications'))
const Reports = lazy(() => import('@/pages/Reports'))
const Files = lazy(() => import('@/pages/Files'))
const Settings = lazy(() => import('@/pages/Settings'))
const Users = lazy(() => import('@/pages/admin/Users'))
const Audit = lazy(() => import('@/pages/admin/Audit'))
const Account = lazy(() => import('@/pages/Account'))
const Guide = lazy(() => import('@/pages/Guide'))
const PortalAccess = lazy(() => import('@/pages/portal/PortalAccess'))
const PortalApp = lazy(() => import('@/pages/portal/PortalApp'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
})

function Splash() {
  return (
    <div className="flex h-dvh items-center justify-center bg-canvas">
      <div className="flex items-center gap-3 text-muted">
        <BrandMark size={34} className="animate-pulse" />
        <span className="text-[11px] font-medium uppercase tracking-[0.2em]">Visionary X</span>
      </div>
    </div>
  )
}

const PageFallback = () => (
  <div className="pt-4">
    <SkeletonRows rows={8} />
  </div>
)

/** Client-side guard for nicer UX. The API enforces every permission regardless. */
function RequirePerm({ perms, children }: { perms: string[]; children: ReactNode }) {
  const { can } = useAuth()
  if (!can(...perms)) {
    return <EmptyState icon={<Lock className="size-7" strokeWidth={1.4} />} title="Access restricted" body="Your role doesn’t include this area. If you need it, ask an administrator to adjust your permissions." />
  }
  return <>{children}</>
}

function Workspace() {
  return (
    <AuthGate fallback={<Splash />}>
      <RealtimeProvider>
        <AppShell>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route index element={<Dashboard />} />
              <Route path="clients" element={<Clients />} />
              <Route path="clients/:id" element={<ClientDetail />} />
              <Route path="projects" element={<Projects />} />
              <Route path="projects/:id" element={<ProjectWorkspace />} />
              <Route path="tasks" element={<MyWork />} />
              <Route path="today" element={<DailyTasks />} />
              <Route path="tasks/:id" element={<TaskDetail />} />
              <Route path="calendar" element={<CalendarPage />} />
              <Route path="team" element={<RequirePerm perms={['team.read']}><Team /></RequirePerm>} />
              <Route path="team/:id" element={<RequirePerm perms={['team.read']}><MemberProfile /></RequirePerm>} />
              <Route path="hr/leave" element={<Leave />} />
              <Route path="hr/attendance" element={<Attendance />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="reports" element={<Reports />} />
              <Route path="files" element={<Files />} />
              <Route path="settings" element={<RequirePerm perms={['settings.manage', 'holidays.manage', 'departments.manage', 'leave.manage']}><Settings /></RequirePerm>} />
              <Route path="admin/users" element={<RequirePerm perms={['users.manage', 'roles.manage', 'security.manage']}><Users /></RequirePerm>} />
              <Route path="admin/audit" element={<RequirePerm perms={['audit.read', 'security.manage']}><Audit /></RequirePerm>} />
              <Route path="account" element={<Account />} />
              <Route path="guide" element={<Guide />} />
              <Route path="access-denied" element={<EmptyState icon={<Lock className="size-7" />} title="Access denied" body="You don’t have permission to view that page." />} />
              <Route path="*" element={<EmptyState title="Page not found" body="Check the address, or use search (⌘K) to find what you need." />} />
            </Routes>
          </Suspense>
        </AppShell>
      </RealtimeProvider>
    </AuthGate>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Suspense fallback={<Splash />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/login/verify" element={<VerifyMfa />} />
              <Route path="/security/setup-mfa" element={<SetupMfa />} />
              <Route path="/activate" element={<SetPassword mode="activation" />} />
              <Route path="/reset-password" element={<SetPassword mode="reset" />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/session-expired" element={<SessionExpired />} />
              <Route path="/portal/access" element={<PortalAccess />} />
              <Route path="/portal/*" element={<PortalApp />} />
              <Route path="/dashboard" element={<Navigate to="/" replace />} />
              <Route path="/*" element={<Workspace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}
