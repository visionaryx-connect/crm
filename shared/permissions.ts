// Single source of truth for permission keys and the default role matrix.
// migrations/0002_access_control.sql is generated from this file by scripts/gen-access-sql.ts.

export const PERMISSIONS = {
  'dashboard.company': { label: 'View company overview', category: 'Overview' },

  'clients.read': { label: 'View clients', category: 'Clients' },
  'clients.manage': { label: 'Create and edit clients', category: 'Clients' },
  'clients.portal': { label: 'Issue and revoke client portal links', category: 'Clients' },

  'projects.read_all': { label: 'View every project', category: 'Projects' },
  'projects.create': { label: 'Create projects', category: 'Projects' },
  'projects.manage_all': { label: 'Manage every project', category: 'Projects' },
  'projects.manage_own': { label: 'Manage projects they lead', category: 'Projects' },

  'tasks.manage_all': { label: 'Manage tasks in any project', category: 'Tasks' },
  'tasks.review_all': { label: 'Review work in any project', category: 'Tasks' },

  'team.read': { label: 'View team directory', category: 'Team' },
  'employees.read_sensitive': { label: 'View private HR fields', category: 'Team' },
  'employees.manage': { label: 'Manage employee profiles', category: 'Team' },
  'departments.manage': { label: 'Manage departments', category: 'Team' },

  'attendance.self': { label: 'Record own attendance', category: 'HR' },
  'attendance.manage': { label: 'Manage and correct attendance', category: 'HR' },
  'leave.request': { label: 'Request leave', category: 'HR' },
  'leave.approve': { label: 'Approve any leave request', category: 'HR' },
  'leave.manage': { label: 'Configure leave types and balances', category: 'HR' },

  'calendar.manage': { label: 'Manage company events', category: 'Calendar' },
  'holidays.manage': { label: 'Maintain and verify holidays', category: 'Calendar' },

  'reports.company': { label: 'Company and client reports', category: 'Reports' },
  'reports.team': { label: 'Department and member reports', category: 'Reports' },

  'files.manage_all': { label: 'Manage all project files', category: 'Files' },

  'users.manage': { label: 'Invite, activate and deactivate users', category: 'Administration' },
  'roles.manage': { label: 'Edit roles and permissions', category: 'Administration' },
  'settings.manage': { label: 'Edit company settings', category: 'Administration' },
  'audit.read': { label: 'Read audit and security logs', category: 'Administration' },
  'security.manage': { label: 'Revoke sessions and manage security', category: 'Administration' },
  'data.export': { label: 'Export company data', category: 'Administration' },
} as const

export type Permission = keyof typeof PERMISSIONS
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[]

export interface RoleDefinition {
  key: string
  name: string
  description: string
  rank: number
  requiresMfa: boolean
  permissions: Permission[]
}

const everyone: Permission[] = ['team.read', 'attendance.self', 'leave.request']

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    description: 'Founder-level access to every module, security setting and export.',
    rank: 0,
    requiresMfa: false,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Runs day-to-day operations: clients, projects, teams and settings.',
    rank: 10,
    requiresMfa: false,
    permissions: [
      ...everyone,
      'dashboard.company',
      'clients.read', 'clients.manage', 'clients.portal',
      'projects.read_all', 'projects.create', 'projects.manage_all', 'projects.manage_own',
      'tasks.manage_all', 'tasks.review_all',
      'departments.manage',
      'calendar.manage', 'holidays.manage',
      'reports.company', 'reports.team',
      'files.manage_all',
      'users.manage', 'settings.manage', 'audit.read',
    ],
  },
  {
    key: 'hr_manager',
    name: 'HR Manager',
    description: 'Employee records, attendance, leave and HR reporting. No client material by default.',
    rank: 20,
    requiresMfa: false,
    permissions: [
      ...everyone,
      'employees.read_sensitive', 'employees.manage', 'departments.manage',
      'attendance.manage', 'leave.approve', 'leave.manage',
      'calendar.manage', 'holidays.manage',
      'reports.team',
    ],
  },
  {
    key: 'project_manager',
    name: 'Project Manager',
    description: 'Plans and delivers projects, reviews work and controls client-visible updates.',
    rank: 30,
    requiresMfa: false,
    permissions: [...everyone, 'clients.read', 'clients.portal', 'projects.create', 'projects.manage_own'],
  },
  {
    key: 'team_lead',
    name: 'Team Lead',
    description: 'Leads a team inside projects; reviews work where review authority is delegated.',
    rank: 40,
    requiresMfa: false,
    permissions: [...everyone],
  },
  {
    key: 'employee',
    name: 'Employee',
    description: 'Works on assigned projects and tasks, logs time and requests leave.',
    rank: 50,
    requiresMfa: false,
    permissions: [...everyone],
  },
]
