// Request schemas shared by the API (authoritative validation) and the UI forms (early feedback).
import { z } from 'zod'
import {
  ATTENDANCE_STATUSES, CLIENT_STATUSES, DELIVERABLE_STATUSES, EVENT_KINDS, HOLIDAY_KINDS, MILESTONE_STATUSES,
  PRIORITIES, PROJECT_MEMBER_ROLES, PROJECT_STATUSES, TASK_STATUSES,
} from './constants'
import { isValidDate } from './dates'

export const dateStr = z.string().refine(isValidDate, 'Use a valid date (YYYY-MM-DD)')
export const optDate = dateStr.nullable().optional()
export const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && /T/.test(s), 'Use a valid date and time')
const trimmed = (max: number) => z.string().trim().max(max)
const req = (max: number, label = 'This field') => z.string().trim().min(1, `${label} is required`).max(max)
const phone = z
  .string()
  .trim()
  .max(32)
  .regex(/^[+()\d\s-]*$/, 'Use digits, spaces, +, - or ()')
const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).pipe(z.string().max(254))
const optEmail = z.union([email, z.literal('')]).optional().transform((v) => (v ? v : null))
const id = z.string().min(1).max(64)
const optId = id.nullable().optional()

// ── Auth ──
export const loginSchema = z.object({ email, password: z.string().min(1, 'Password is required').max(256) })
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(256)
  .refine((p) => /[a-zA-Z]/.test(p) && /\d|[^a-zA-Z]/.test(p), 'Mix letters with numbers or symbols')
export const setPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema })
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema })
export const mfaCodeSchema = z.object({ code: z.string().trim().regex(/^(\d{6}|[a-z0-9]{5}-[a-z0-9]{5})$/i, 'Enter the 6-digit code or a recovery code') })
export const forgotSchema = z.object({ email })

// ── Users & roles ──
export const createUserSchema = z.object({
  name: req(120, 'Name'),
  email,
  roleKeys: z.array(z.string().max(64)).min(1, 'Choose at least one role'),
  employeeCode: req(32, 'Employee ID'),
  designation: trimmed(120).default(''),
  departmentId: optId,
  managerUserId: optId,
  joiningDate: optDate,
})
export const updateUserRolesSchema = z.object({ roleKeys: z.array(z.string().max(64)).min(1) })
export const roleSchema = z.object({
  name: req(80, 'Role name'),
  description: trimmed(300).default(''),
  requiresMfa: z.boolean().default(false),
  permissions: z.array(z.string().max(64)),
})

// ── Departments & employees ──
export const departmentSchema = z.object({
  name: req(80, 'Name'),
  code: req(12, 'Code').regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, - or _'),
  description: trimmed(500).default(''),
  headUserId: optId,
})
export const employeeProfileSchema = z.object({
  name: req(120, 'Name').optional(),
  designation: trimmed(120).optional(),
  departmentId: optId,
  managerUserId: optId,
  workPhone: phone.nullable().optional(),
  personalPhone: phone.nullable().optional(),
  personalEmail: optEmail,
  dateOfBirth: optDate,
  address: trimmed(500).nullable().optional(),
  emergencyContactName: trimmed(120).nullable().optional(),
  emergencyContactPhone: phone.nullable().optional(),
  joiningDate: optDate,
  exitDate: optDate,
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
  employmentStatus: z.enum(['active', 'probation', 'notice', 'exited']).optional(),
  weeklyCapacityHours: z.number().min(0).max(80).nullable().optional(),
  skills: z.array(trimmed(40).min(1)).max(30).optional(),
})

// ── Clients ──
export const clientSchema = z.object({
  name: req(160, 'Client name'),
  organization: trimmed(160).nullable().optional(),
  industry: trimmed(80).nullable().optional(),
  email: optEmail,
  phone: phone.nullable().optional(),
  website: z.union([z.url('Enter a full URL including https://').max(300), z.literal('')]).nullable().optional(),
  address: trimmed(500).nullable().optional(),
  status: z.enum(CLIENT_STATUSES).default('active'),
  accountManagerId: optId,
  notes: trimmed(5000).default(''),
  serviceCategoryIds: z.array(id).max(20).default([]),
})
export const clientContactSchema = z.object({
  name: req(120, 'Name'),
  title: trimmed(120).nullable().optional(),
  email: optEmail,
  phone: phone.nullable().optional(),
  isPrimary: z.boolean().default(false),
  notes: trimmed(1000).default(''),
})
export const clientInteractionSchema = z.object({
  kind: z.enum(['meeting', 'call', 'email', 'note', 'requirement']),
  subject: req(200, 'Subject'),
  body: trimmed(10000).default(''),
  occurredAt: isoInstant,
  projectId: optId,
})
export const portalLinkSchema = z.object({
  label: req(120, 'Label'),
  projectId: optId,
  contactId: optId,
  validDays: z.number().int().min(1).max(180).default(30),
})

// ── Projects ──
export const projectSchema = z.object({
  name: req(160, 'Project name'),
  clientId: id,
  managerId: optId,
  serviceCategoryId: optId,
  description: trimmed(5000).default(''),
  scope: trimmed(10000).default(''),
  startDate: optDate,
  targetDate: optDate,
  status: z.enum(PROJECT_STATUSES).default('planning'),
  priority: z.enum(PRIORITIES).default('medium'),
  progressMode: z.enum(['equal', 'effort', 'milestone']).default('equal'),
  estimatedHours: z.number().min(0).max(100000).nullable().optional(),
  clientStatusNote: trimmed(1000).default(''),
}).refine((p) => !p.startDate || !p.targetDate || p.targetDate >= p.startDate, { message: 'Target date must be on or after the start date', path: ['targetDate'] })
export const projectPatchSchema = z.object({
  name: req(160, 'Project name').optional(),
  managerId: optId,
  serviceCategoryId: optId,
  description: trimmed(5000).optional(),
  scope: trimmed(10000).optional(),
  startDate: optDate,
  targetDate: optDate,
  status: z.enum(PROJECT_STATUSES).optional(),
  statusNote: trimmed(500).optional(),
  priority: z.enum(PRIORITIES).optional(),
  progressMode: z.enum(['equal', 'effort', 'milestone']).optional(),
  estimatedHours: z.number().min(0).max(100000).nullable().optional(),
  clientStatusNote: trimmed(1000).optional(),
})
export const projectMemberSchema = z.object({
  userId: id,
  role: z.enum(PROJECT_MEMBER_ROLES).default('member'),
  canReview: z.boolean().default(false),
  responsibility: trimmed(200).default(''),
})
export const milestoneSchema = z.object({
  title: req(160, 'Title'),
  description: trimmed(2000).default(''),
  dueDate: optDate,
  weight: z.number().positive().max(100).default(1),
  status: z.enum(MILESTONE_STATUSES).default('pending'),
  clientVisible: z.boolean().default(true),
  dependsOn: z.array(id).max(20).default([]),
})
export const projectUpdateSchema = z.object({
  title: req(160, 'Title'),
  body: trimmed(5000).default(''),
  clientVisible: z.boolean().default(false),
})

// ── Tasks ──
export const taskSchema = z.object({
  projectId: id,
  milestoneId: optId,
  title: req(200, 'Title'),
  description: trimmed(10000).default(''),
  status: z.enum(['backlog', 'todo']).default('todo'),
  priority: z.enum(PRIORITIES).default('medium'),
  responsibleId: optId,
  assigneeIds: z.array(id).max(20).default([]),
  startDate: optDate,
  dueDate: optDate,
  estimateHours: z.number().min(0).max(1000).nullable().optional(),
  weight: z.number().positive().max(100).default(1),
  requiresApproval: z.boolean().default(true),
  dependsOn: z.array(id).max(30).default([]),
}).refine((t) => !t.startDate || !t.dueDate || t.dueDate >= t.startDate, { message: 'Due date must be on or after the start date', path: ['dueDate'] })
export const taskPatchSchema = z.object({
  title: req(200, 'Title').optional(),
  description: trimmed(10000).optional(),
  milestoneId: optId,
  priority: z.enum(PRIORITIES).optional(),
  responsibleId: optId,
  assigneeIds: z.array(id).max(20).optional(),
  startDate: optDate,
  dueDate: optDate,
  estimateHours: z.number().min(0).max(1000).nullable().optional(),
  weight: z.number().positive().max(100).optional(),
  requiresApproval: z.boolean().optional(),
  dependsOn: z.array(id).max(30).optional(),
})
export const taskStatusSchema = z.object({
  status: z.enum(TASK_STATUSES),
  note: trimmed(1000).default(''),
  blockedReason: trimmed(500).optional(),
})
export const taskSubmitSchema = z.object({ note: trimmed(2000).default('') })
export const taskReviewSchema = z.object({
  decision: z.enum(['approved', 'revision_requested']),
  note: trimmed(2000).default(''),
}).refine((r) => r.decision === 'approved' || r.note.length > 0, { message: 'Explain what needs to change', path: ['note'] })
export const taskBulkSchema = z.object({
  taskIds: z.array(id).min(1).max(100),
  action: z.enum(['set_status', 'assign', 'set_priority', 'set_due_date']),
  status: z.enum(['backlog', 'todo', 'in_progress', 'blocked', 'cancelled']).optional(),
  responsibleId: optId,
  priority: z.enum(PRIORITIES).optional(),
  dueDate: optDate,
})
export const subtaskSchema = z.object({ title: req(200, 'Title') })
export const commentSchema = z.object({ body: req(5000, 'Comment') })
export const timeEntrySchema = z.object({
  workDate: dateStr,
  minutes: z.number().int().min(1, 'Log at least 1 minute').max(1440),
  note: trimmed(500).default(''),
})

// ── Deliverables ──
export const deliverableSchema = z.object({
  title: req(160, 'Title'),
  description: trimmed(2000).default(''),
  taskId: optId,
  milestoneId: optId,
})
export const deliverableStatusSchema = z.object({
  action: z.enum(['submit_review', 'approve', 'return_draft', 'share']),
  note: trimmed(1000).default(''),
})
export const deliverableStatusEnum = z.enum(DELIVERABLE_STATUSES)

// ── Calendar & HR ──
export const eventSchema = z.object({
  title: req(160, 'Title'),
  description: trimmed(2000).default(''),
  kind: z.enum(EVENT_KINDS),
  startAt: isoInstant,
  endAt: isoInstant,
  allDay: z.boolean().default(false),
  location: trimmed(200).nullable().optional(),
  projectId: optId,
  clientId: optId,
  departmentId: optId,
  visibility: z.enum(['company', 'department', 'project', 'attendees']).default('company'),
  recurrenceRule: trimmed(200).nullable().optional(),
  reminderMinutes: z.number().int().min(0).max(10080).nullable().optional(),
  attendeeIds: z.array(id).max(100).default([]),
}).refine((e) => Date.parse(e.endAt) >= Date.parse(e.startAt), { message: 'End must be after start', path: ['endAt'] })
export const holidaySchema = z.object({
  date: dateStr,
  name: req(120, 'Name'),
  kind: z.enum(HOLIDAY_KINDS),
  region: z.enum(['IN', 'IN-TN', 'COMPANY']),
  isDayOff: z.boolean().default(true),
  source: trimmed(300).default(''),
  sourceUrl: z.union([z.url().max(500), z.literal('')]).nullable().optional(),
})
export const holidayImportSchema = z.object({
  holidays: z.array(holidaySchema).min(1).max(200),
})
export const overrideSchema = z.object({ date: dateStr, isWorking: z.boolean(), reason: req(200, 'Reason') })
export const leaveRequestSchema = z.object({
  leaveTypeId: id,
  startDate: dateStr,
  endDate: dateStr,
  halfDay: z.enum(['none', 'first_half', 'second_half']).default('none'),
  reason: trimmed(1000).default(''),
}).refine((l) => l.endDate >= l.startDate, { message: 'End date must be on or after start date', path: ['endDate'] })
  .refine((l) => l.halfDay === 'none' || l.startDate === l.endDate, { message: 'Half days must be a single date', path: ['halfDay'] })
export const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), note: trimmed(1000).default('') })
export const attendanceCorrectionSchema = z.object({
  workDate: dateStr,
  requestedCheckIn: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  requestedCheckOut: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  requestedStatus: z.enum(ATTENDANCE_STATUSES),
  reason: req(500, 'Reason'),
})
export const attendanceManualSchema = z.object({
  userId: id,
  workDate: dateStr,
  checkIn: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  checkOut: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  status: z.enum(ATTENDANCE_STATUSES),
  note: req(500, 'Reason for the manual edit'),
})

// ── Portal ──
export const portalFeedbackSchema = z.object({
  projectId: id,
  deliverableId: optId,
  kind: z.enum(['feedback', 'revision_request', 'question']),
  authorName: req(120, 'Your name'),
  body: req(5000, 'Message'),
})
export const portalDecisionSchema = z.object({
  decision: z.enum(['client_approved', 'changes_requested']),
  authorName: req(120, 'Your name'),
  note: trimmed(5000).default(''),
}).refine((d) => d.decision === 'client_approved' || d.note.length > 0, { message: 'Tell us what should change', path: ['note'] })
export const portalReverifySchema = z.object({ email })
export const feedbackResponseSchema = z.object({
  status: z.enum(['acknowledged', 'resolved']),
  response: trimmed(5000).nullable().optional(),
})

export type LoginInput = z.infer<typeof loginSchema>
