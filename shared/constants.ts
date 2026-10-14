export const PROJECT_STATUSES = [
  'planning', 'not_started', 'in_progress', 'on_hold', 'at_risk', 'delayed', 'in_review', 'completed', 'archived',
] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  planning: 'Planning',
  not_started: 'Not started',
  in_progress: 'In progress',
  on_hold: 'On hold',
  at_risk: 'At risk',
  delayed: 'Delayed',
  in_review: 'In review',
  completed: 'Completed',
  archived: 'Archived',
}

export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'completed', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  completed: 'Completed',
  cancelled: 'Cancelled',
}
/** Statuses a board shows as columns. Cancelled tasks are listed separately. */
export const BOARD_COLUMNS: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'completed']
export const OPEN_TASK_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked']

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export type Priority = (typeof PRIORITIES)[number]
export const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' }

export const CLIENT_STATUSES = ['lead', 'active', 'on_hold', 'inactive', 'archived'] as const
export type ClientStatus = (typeof CLIENT_STATUSES)[number]
export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  lead: 'Lead', active: 'Active', on_hold: 'On hold', inactive: 'Inactive', archived: 'Archived',
}

export const PROJECT_MEMBER_ROLES = ['manager', 'lead', 'member', 'viewer'] as const
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number]

export const DELIVERABLE_STATUSES = ['draft', 'in_review', 'approved', 'shared', 'client_approved', 'changes_requested'] as const
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number]
export const DELIVERABLE_STATUS_LABEL: Record<DeliverableStatus, string> = {
  draft: 'Draft',
  in_review: 'Internal review',
  approved: 'Approved internally',
  shared: 'Shared with client',
  client_approved: 'Client approved',
  changes_requested: 'Changes requested',
}

export const MILESTONE_STATUSES = ['pending', 'in_progress', 'achieved', 'missed'] as const
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]

export const EVENT_KINDS = ['internal_meeting', 'client_meeting', 'company_event', 'deadline', 'reminder', 'other'] as const
export type EventKind = (typeof EVENT_KINDS)[number]
export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  internal_meeting: 'Internal meeting',
  client_meeting: 'Client meeting',
  company_event: 'Company event',
  deadline: 'Deadline',
  reminder: 'Reminder',
  other: 'Other',
}

export const HOLIDAY_KINDS = ['national', 'state', 'company', 'closure', 'optional'] as const
export type HolidayKind = (typeof HOLIDAY_KINDS)[number]

export const ATTENDANCE_STATUSES = ['present', 'half_day', 'absent', 'remote'] as const
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number]

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const

export const COMPANY_TZ = 'Asia/Kolkata'

/** Realtime event names. Internal events never reach client portal sockets. */
export const REALTIME_EVENTS = [
  'task.created', 'task.updated', 'task.assigned', 'task.submitted', 'task.approved', 'task.revision_requested',
  'project.updated', 'project.progress_updated', 'project.milestone_updated',
  'calendar.event_created', 'calendar.event_updated',
  'leave.requested', 'leave.approved',
  'notification.created',
  'client.feedback_received',
] as const
export type RealtimeEventName = (typeof REALTIME_EVENTS)[number] | 'portal.project_updated' | 'portal.deliverable_shared' | 'portal.feedback_answered'

export interface RealtimeEnvelope {
  id: string
  type: RealtimeEventName
  room: string
  at: string
  data: Record<string, unknown>
}
