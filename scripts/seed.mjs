// Development seed. Generates .seed/seed.sql (applied by `npm run db:seed:local`).
//
// Every row it creates is flagged is_seed = 1 (users, departments, clients, projects, events) and uses
// *.test email addresses, so sample data can never be mistaken for company records. NEVER run against production.
//
// Sign-in for all sample accounts uses SEED_PASSWORD below (override with the env var of the same name).
// Two-factor authentication is optional (enable it under Account, or require it per role in Users & roles).

import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const SEED_PASSWORD = process.env.SEED_PASSWORD || 'VisionaryX-dev-2026!'

const b64url = (b) => b.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const hash = (pw) => {
  const salt = randomBytes(16)
  return `pbkdf2-sha256$100000$${b64url(salt)}$${b64url(pbkdf2Sync(pw.normalize('NFKC'), salt, 100000, 32, 'sha256'))}`
}
let seq = 0
const id = (p) => `${p}_seed${String(++seq).padStart(4, '0')}${randomBytes(4).toString('hex')}`
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`)
const out = []
const ins = (table, row) => out.push(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(q).join(', ')});`)

const DAY = 86400000
const now = Date.now()
const ago = (d, h = 10) => new Date(now - d * DAY + (h - 10) * 3600000).toISOString()
const istDate = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 10)
const day = (offset) => istDate(now + offset * DAY)
const nowIso = new Date(now).toISOString()

// ── Departments ──
const deps = {
  DSN: { id: id('dep'), name: 'Design', code: 'DSN' },
  ENG: { id: id('dep'), name: 'Engineering', code: 'ENG' },
  MKT: { id: id('dep'), name: 'Marketing', code: 'MKT' },
  OPS: { id: id('dep'), name: 'Operations', code: 'OPS' },
}

// ── People ──
const people = [
  { key: 'founder', name: 'Arjun Raghavan', role: 'super_admin', dep: 'OPS', title: 'Founder & CEO', code: 'VX-001', color: '#1F4D3A', cap: 40 },
  { key: 'admin', name: 'Meera Krishnan', role: 'admin', dep: 'OPS', title: 'Head of Operations', code: 'VX-002', color: '#5B6B4E', cap: 40 },
  { key: 'hr', name: 'Divya Subramanian', role: 'hr_manager', dep: 'OPS', title: 'HR Manager', code: 'VX-003', color: '#8A7444', cap: 40 },
  { key: 'pm1', name: 'Karthik Narayanan', role: 'project_manager', dep: 'ENG', title: 'Senior Project Manager', code: 'VX-004', color: '#3E5C6B', cap: 40 },
  { key: 'pm2', name: 'Ananya Iyer', role: 'project_manager', dep: 'MKT', title: 'Project Manager', code: 'VX-005', color: '#6B4E5B', cap: 40 },
  { key: 'lead', name: 'Vikram Selvam', role: 'team_lead', dep: 'ENG', title: 'Engineering Lead', code: 'VX-006', color: '#2F3B35', cap: 40 },
  { key: 'dev', name: 'Priya Ramesh', role: 'employee', dep: 'ENG', title: 'Full-stack Developer', code: 'VX-007', color: '#4E5B6B', cap: 40 },
  { key: 'designer', name: 'Rahul Venkatesh', role: 'employee', dep: 'DSN', title: 'UI/UX Designer', code: 'VX-008', color: '#5B6B4E', cap: 32 },
  { key: 'marketer', name: 'Sneha Pillai', role: 'employee', dep: 'MKT', title: 'Digital Marketing Specialist', code: 'VX-009', color: '#8A7444', cap: 40 },
]
const U = {}
for (const p of people) {
  const uid = id('usr')
  U[p.key] = uid
  const email = `${p.name.split(' ')[0].toLowerCase()}@sample.visionary-x.test`
  ins('users', { id: uid, email, name: p.name, password_hash: hash(SEED_PASSWORD), status: 'active', avatar_color: p.color, is_seed: 1, created_at: ago(400), updated_at: ago(400), password_changed_at: ago(400) })
  ins('user_roles', { user_id: uid, role_id: `role_${p.role}`, granted_at: ago(400) })
  p.email = email
}
for (const d of Object.values(deps)) {
  const head = { DSN: 'designer', ENG: 'lead', MKT: 'pm2', OPS: 'admin' }[d.code]
  ins('departments', { id: d.id, name: d.name, code: d.code, description: `${d.name} team`, head_user_id: U[head], is_seed: 1, created_at: ago(400), updated_at: ago(400) })
}
const managerOf = { admin: 'founder', hr: 'admin', pm1: 'admin', pm2: 'admin', lead: 'pm1', dev: 'lead', designer: 'pm1', marketer: 'pm2' }
for (const p of people) {
  ins('employee_profiles', {
    user_id: U[p.key], employee_code: p.code, designation: p.title, department_id: deps[p.dep].id, manager_user_id: managerOf[p.key] ? U[managerOf[p.key]] : null,
    work_phone: `+91 44 4000 ${String(1000 + people.indexOf(p)).slice(-4)}`, joining_date: day(-380 + people.indexOf(p) * 20), employment_type: 'full_time', employment_status: 'active',
    weekly_capacity_hours: p.cap, created_at: ago(400), updated_at: ago(400),
  })
}
const skills = { dev: ['React', 'TypeScript', 'Node.js'], designer: ['Figma', 'Brand identity', 'Prototyping'], marketer: ['SEO', 'Google Ads', 'Content'], lead: ['Architecture', 'Cloudflare', 'Code review'] }
for (const [k, list] of Object.entries(skills)) for (const s of list) ins('employee_skills', { user_id: U[k], skill: s })

// ── Service categories ──
const svc = {}
for (const name of ['Web Development', 'Mobile Apps', 'Branding & Design', 'Digital Marketing', 'Video Production', 'IT Consulting']) {
  svc[name] = id('svc')
  ins('service_categories', { id: svc[name], name, created_at: ago(400) })
}

// ── Clients ──
const clients = [
  { key: 'agri', name: 'Kaveri Agro Foods', org: 'Kaveri Agro Foods Pvt Ltd', industry: 'Food processing', svc: ['Web Development', 'Digital Marketing'], am: 'pm1' },
  { key: 'clinic', name: 'Nila Health Clinics', org: 'Nila Healthcare LLP', industry: 'Healthcare', svc: ['Mobile Apps', 'Branding & Design'], am: 'pm1' },
  { key: 'textile', name: 'Marutham Textiles', org: 'Marutham Textiles', industry: 'Retail & apparel', svc: ['Branding & Design', 'Digital Marketing', 'Video Production'], am: 'pm2' },
  { key: 'edu', name: 'Thamarai Learning', org: 'Thamarai Education Trust', industry: 'Education', svc: ['Web Development'], am: 'pm2' },
]
const C = {}
clients.forEach((c, i) => {
  C[c.key] = id('cli')
  const slug = c.key
  ins('clients', {
    id: C[c.key], reference: `CL-${String(i + 1).padStart(4, '0')}`, name: c.name, organization: c.org, industry: c.industry, email: `hello@${slug}.sample.test`, phone: `+91 98400 ${String(10000 + i * 1111).slice(-5)}`,
    website: `https://${slug}.sample.test`, address: 'Chennai, Tamil Nadu', status: 'active', account_manager_id: U[c.am], notes: 'Sample client created by the development seed.', is_seed: 1, created_by: U.admin, created_at: ago(200 - i * 20), updated_at: ago(30),
  })
  for (const s of c.svc) ins('client_service_categories', { client_id: C[c.key], service_category_id: svc[s] })
  const contactName = ['Lakshmi Sundaram', 'Dr. Senthil Kumar', 'Revathi Murugan', 'Ganesh Babu'][i]
  ins('client_contacts', { id: id('con'), client_id: C[c.key], name: contactName, title: ['Managing Director', 'Medical Director', 'Brand Manager', 'Trustee'][i], email: `${contactName.split(' ').pop().toLowerCase()}@${slug}.sample.test`, phone: `+91 99620 ${String(20000 + i * 1234).slice(-5)}`, is_primary: 1, created_at: ago(190), updated_at: ago(190) })
  ins('client_interactions', { id: id('int'), client_id: C[c.key], kind: 'meeting', subject: 'Kick-off and requirements walkthrough', body: 'Agreed scope, success measures and communication cadence (weekly status call).', occurred_at: ago(150 - i * 15), created_by: U[c.am], created_at: ago(150 - i * 15) })
})

// ── Projects, milestones, tasks ──
const statusHist = (taskId, projectId, steps) => {
  for (const s of steps) ins('task_status_history', { id: id('tsh'), task_id: taskId, project_id: projectId, from_status: s.from ?? null, to_status: s.to, note: s.note ?? '', changed_by: s.by, changed_at: s.at })
}
const projects = [
  {
    key: 'p1', name: 'Kaveri e-commerce relaunch', client: 'agri', pm: 'pm1', svc: 'Web Development', status: 'in_progress', start: -70, target: 35, members: [['lead', 'lead', 1], ['dev', 'member', 0], ['designer', 'member', 0]],
    milestones: [['Discovery & UX', -50, 'achieved'], ['Storefront build', 10, 'in_progress'], ['Launch & handover', 35, 'pending']],
    tasks: [
      ['Stakeholder interviews and sitemap', 0, 'designer', 'completed', -60, -55, 6], ['Wireframes for catalogue and checkout', 0, 'designer', 'completed', -55, -45, 14],
      ['Visual design system', 0, 'designer', 'completed', -45, -30, 18], ['Product catalogue API', 1, 'dev', 'completed', -30, -12, 20],
      ['Cart and checkout flow', 1, 'dev', 'in_review', -14, -2, 24], ['Payment gateway integration', 1, 'lead', 'in_progress', -10, 6, 16],
      ['Inventory sync with ERP', 1, 'dev', 'blocked', -8, 4, 12], ['Performance and accessibility audit', 2, 'lead', 'todo', 15, 25, 8],
      ['Content migration', 2, 'designer', 'todo', 12, 28, 10], ['Go-live checklist and training', 2, 'lead', 'backlog', 28, 34, 6],
    ],
  },
  {
    key: 'p2', name: 'Nila patient booking app', client: 'clinic', pm: 'pm1', svc: 'Mobile Apps', status: 'at_risk', start: -45, target: 20, members: [['lead', 'lead', 1], ['dev', 'member', 0], ['designer', 'member', 0]],
    milestones: [['Prototype sign-off', -20, 'achieved'], ['Beta release', 5, 'in_progress']],
    tasks: [
      ['Booking flow prototype', 0, 'designer', 'completed', -40, -25, 16], ['Doctor availability service', 1, 'dev', 'in_progress', -18, -3, 20],
      ['SMS reminders', 1, 'dev', 'todo', -5, -1, 8], ['Clinic admin dashboard', 1, 'lead', 'in_progress', -12, 8, 24], ['App store submission', 1, 'lead', 'backlog', 10, 18, 4],
    ],
  },
  {
    key: 'p3', name: 'Marutham festive brand campaign', client: 'textile', pm: 'pm2', svc: 'Digital Marketing', status: 'in_progress', start: -30, target: 12, members: [['marketer', 'member', 0], ['designer', 'member', 0]],
    milestones: [['Campaign concept', -15, 'achieved'], ['Launch', 12, 'pending']],
    tasks: [
      ['Campaign concept and moodboard', 0, 'designer', 'completed', -28, -18, 10], ['Social media calendar', 1, 'marketer', 'completed', -16, -6, 8],
      ['Product shoot brief', 1, 'marketer', 'in_progress', -6, 3, 6], ['Ad creatives (static + reels)', 1, 'designer', 'todo', 0, 9, 16], ['Paid media plan', 1, 'marketer', 'todo', 2, 10, 6],
    ],
  },
  {
    key: 'p4', name: 'Thamarai website refresh', client: 'edu', pm: 'pm2', svc: 'Web Development', status: 'completed', start: -120, target: -40, members: [['dev', 'member', 0], ['designer', 'member', 0]],
    milestones: [['Design approved', -90, 'achieved'], ['Site live', -42, 'achieved']],
    tasks: [
      ['Information architecture', 0, 'designer', 'completed', -115, -100, 8], ['Homepage and course pages design', 0, 'designer', 'completed', -100, -88, 16],
      ['CMS build', 1, 'dev', 'completed', -88, -55, 30], ['Launch and redirects', 1, 'dev', 'completed', -50, -43, 6],
    ],
  },
]
const P = {}
let refNo = 0
for (const pr of projects) {
  const pid = id('prj')
  P[pr.key] = pid
  const createdAt = ago(-pr.start + 5)
  const done = pr.tasks.filter((t) => t[3] === 'completed').length
  const progress = Math.round((done / pr.tasks.length) * 1000) / 10
  ins('projects', {
    id: pid, reference: `VX-2026-${String(++refNo).padStart(3, '0')}`, name: pr.name, client_id: C[pr.client], manager_id: U[pr.pm], service_category_id: svc[pr.svc],
    description: `Sample project: ${pr.name}.`, scope: 'Scope as agreed in the signed proposal (sample data).', start_date: day(pr.start), target_date: day(pr.target),
    completed_at: pr.status === 'completed' ? ago(40) : null, status: pr.status, priority: pr.key === 'p2' ? 'high' : 'medium', progress_mode: 'equal', progress,
    estimated_hours: pr.tasks.reduce((s, t) => s + t[6], 0) + 20, client_status_note: pr.status === 'completed' ? 'Delivered and live.' : 'Work is progressing to plan; see milestones for dates.',
    next_task_number: pr.tasks.length + 1, closure_approved_by: pr.status === 'completed' ? U[pr.pm] : null, closure_approved_at: pr.status === 'completed' ? ago(40) : null,
    is_seed: 1, created_by: U[pr.pm], created_at: createdAt, updated_at: ago(1),
  })
  ins('project_members', { project_id: pid, user_id: U[pr.pm], role: 'manager', can_review: 1, responsibility: 'Project manager', added_by: U[pr.pm], added_at: createdAt })
  for (const [m, role, review] of pr.members) ins('project_members', { project_id: pid, user_id: U[m], role, can_review: review, responsibility: people.find((x) => x.key === m).title, added_by: U[pr.pm], added_at: createdAt })
  ins('project_status_history', { id: id('psh'), project_id: pid, from_status: null, to_status: 'planning', note: 'Project created', changed_by: U[pr.pm], changed_at: createdAt })
  ins('project_status_history', { id: id('psh'), project_id: pid, from_status: 'planning', to_status: pr.status === 'completed' ? 'in_progress' : pr.status, note: '', changed_by: U[pr.pm], changed_at: ago(-pr.start) })
  if (pr.status === 'completed') ins('project_status_history', { id: id('psh'), project_id: pid, from_status: 'in_progress', to_status: 'completed', note: 'Closed after client sign-off', changed_by: U[pr.pm], changed_at: ago(40) })
  ins('project_progress_snapshots', { id: id('pps'), project_id: pid, progress: 0, completed_units: 0, total_units: 0, recorded_at: createdAt })

  const mids = pr.milestones.map(([title, due, status], i) => {
    const mid = id('mil')
    ins('milestones', { id: mid, project_id: pid, title, description: '', due_date: day(due), weight: 1, status, achieved_at: status === 'achieved' ? ago(-due + 1) : null, client_visible: 1, sort_order: i + 1, created_at: createdAt, updated_at: ago(2) })
    return mid
  })
  let completedSoFar = 0
  const sorted = pr.tasks.map((t, i) => ({ t, i })).sort((a, b) => a.t[5] - b.t[5])
  pr.tasks.forEach((t, i) => {
    const [title, mIdx, who, status, startOff, dueOff, est] = t
    const tid = id('tsk')
    const created = ago(-startOff + 3)
    const completedAt = status === 'completed' ? ago(-dueOff + (i % 3 === 0 ? -1 : 1)) : null
    ins('tasks', {
      id: tid, project_id: pid, milestone_id: mids[mIdx], number: i + 1, title, description: `Sample task for ${pr.name}.`, status, priority: i % 4 === 1 ? 'high' : 'medium', responsible_id: U[who],
      start_date: day(startOff), due_date: day(dueOff), estimate_hours: est, weight: est >= 16 ? 2 : 1, requires_approval: 1, blocked_reason: status === 'blocked' ? 'Waiting for ERP API credentials from the client' : null,
      sort_order: i, created_by: U[pr.pm], created_at: created, updated_at: completedAt ?? ago(1), submitted_at: status === 'in_review' || status === 'completed' ? (completedAt ?? ago(1)) : null,
      completed_at: completedAt, approved_by: status === 'completed' ? U[pr.pm] : null,
    })
    const steps = [{ to: 'todo', note: 'Task created', by: U[pr.pm], at: created }]
    if (status !== 'backlog' && status !== 'todo') steps.push({ from: 'todo', to: 'in_progress', by: U[who], at: ago(-startOff) })
    if (status === 'blocked') steps.push({ from: 'in_progress', to: 'blocked', note: 'Waiting for ERP API credentials from the client', by: U[who], at: ago(2) })
    if (status === 'in_review' || status === 'completed') {
      const subAt = status === 'completed' ? new Date(Date.parse(completedAt) - 6 * 3600000).toISOString() : ago(1)
      steps.push({ from: 'in_progress', to: 'in_review', note: 'Submitted for review', by: U[who], at: subAt })
      const sid = id('sub')
      ins('task_submissions', { id: sid, task_id: tid, submitted_by: U[who], note: 'Ready for review.', submitted_at: subAt, decision: status === 'completed' ? 'approved' : 'pending', decided_by: status === 'completed' ? U[pr.pm] : null, decided_at: completedAt, decision_note: status === 'completed' ? 'Looks good.' : '' })
      if (status === 'completed') steps.push({ from: 'in_review', to: 'completed', note: 'Approved', by: U[pr.pm], at: completedAt })
    }
    if (status === 'backlog') steps[0].to = 'backlog'
    statusHist(tid, pid, steps)
    if (status !== 'backlog' && status !== 'todo') {
      for (let d = 0; d < Math.min(5, Math.ceil(est / 4)); d++) {
        const wd = Math.max(1, -startOff - d * 2)
        ins('time_entries', { id: id('tme'), task_id: tid, project_id: pid, user_id: U[who], work_date: day(-wd), minutes: 180 + (d % 3) * 60, note: '', created_at: ago(wd), updated_at: ago(wd) })
      }
    }
    if (status === 'completed') {
      completedSoFar++
      ins('project_progress_snapshots', { id: id('pps'), project_id: pid, progress: Math.round((completedSoFar / pr.tasks.length) * 1000) / 10, completed_units: completedSoFar, total_units: pr.tasks.length, recorded_at: completedAt })
    }
  })
  void sorted
  ins('project_updates', { id: id('pup'), project_id: pid, title: 'Fortnightly status', body: 'Key work completed this fortnight and what is coming next (sample).', client_visible: 1, approved_by: U[pr.pm], approved_at: ago(6), created_by: U[pr.pm], created_at: ago(6) })
  ins('project_updates', { id: id('pup'), project_id: pid, title: 'Internal: resourcing note', body: 'Internal-only note — never shown to the client.', client_visible: 0, created_by: U[pr.pm], created_at: ago(3) })
}
ins('client_feedback', { id: id('fbk'), project_id: P.p1, client_id: C.agri, author_name: 'Lakshmi Sundaram', author_email: 'sundaram@agri.sample.test', kind: 'feedback', body: 'Can we show seasonal offers on the homepage banner?', status: 'open', created_at: ago(2) })
ins('client_feedback', { id: id('fbk'), project_id: P.p3, client_id: C.textile, author_name: 'Revathi Murugan', author_email: 'murugan@textile.sample.test', kind: 'revision_request', body: 'Please use warmer colours in the moodboard.', status: 'acknowledged', response: 'Updated moodboard shared in the next update.', responded_by: U.pm2, responded_at: ago(10), created_at: ago(12) })
ins('deliverables', { id: id('dlv'), project_id: P.p1, title: 'Visual design system', description: 'Colour, type and component library', status: 'approved', current_version: 0, approved_by: U.pm1, approved_at: ago(29), created_by: U.designer, created_at: ago(31), updated_at: ago(29) })

// ── Calendar ──
const evt = (title, kind, offDays, hour, mins, extra = {}) => {
  const start = new Date(`${day(offDays)}T${String(hour).padStart(2, '0')}:00:00+05:30`)
  const e = { id: id('evt'), title, description: '', kind, start_at: start.toISOString(), end_at: new Date(start.getTime() + mins * 60000).toISOString(), all_day: 0, organizer_id: U.admin, visibility: 'company', is_seed: 1, created_at: ago(20), updated_at: ago(20), ...extra }
  ins('calendar_events', e)
  return e.id
}
const standup = evt('Weekly all-hands', 'company_event', -7, 10, 30, { recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO' })
void standup
const review = evt('Kaveri checkout review', 'client_meeting', 2, 15, 60, { project_id: P.p1, client_id: C.agri, organizer_id: U.pm1, visibility: 'project', location: 'Google Meet' })
for (const u of ['pm1', 'lead', 'dev']) ins('event_attendees', { event_id: review, user_id: U[u], response: u === 'pm1' ? 'accepted' : 'pending' })
const sprint = evt('Nila sprint planning', 'internal_meeting', 1, 11, 45, { project_id: P.p2, organizer_id: U.pm1, visibility: 'project' })
for (const u of ['pm1', 'lead', 'dev', 'designer']) ins('event_attendees', { event_id: sprint, user_id: U[u], response: 'accepted' })

// ── Holidays (pending verification against the official G.O.) ──
const GO = 'TN G.O.(Ms) No. 708, Public (Misc.) Dept., dated 11.11.2025 (Gazette Extraordinary No. 721)'
const GO_URL = 'https://www.stationeryprinting.tn.gov.in/extraordinary/2025/721_Ex_II_1_2025.pdf'
const hol = [
  ['2026-01-01', "New Year's Day", 'state', 'IN-TN', 1], ['2026-01-15', 'Pongal', 'state', 'IN-TN', 1], ['2026-01-16', 'Thiruvalluvar Day', 'state', 'IN-TN', 1],
  ['2026-01-17', 'Uzhavar Thirunal', 'state', 'IN-TN', 1], ['2026-01-26', 'Republic Day', 'national', 'IN', 1], ['2026-02-01', 'Thai Poosam', 'state', 'IN-TN', 1],
  ['2026-03-19', "Telugu New Year's Day", 'state', 'IN-TN', 1], ['2026-03-21', 'Ramzan (Id-ul-Fitr)', 'state', 'IN-TN', 1], ['2026-03-31', 'Mahaveer Jayanthi', 'state', 'IN-TN', 1],
  ['2026-04-01', 'Annual closing of bank accounts', 'state', 'IN-TN', 0], ['2026-04-03', 'Good Friday', 'state', 'IN-TN', 1], ['2026-04-14', "Tamil New Year's Day / Dr. B.R. Ambedkar's Birthday", 'state', 'IN-TN', 1],
  ['2026-05-01', 'May Day', 'state', 'IN-TN', 1], ['2026-05-28', 'Bakrid (Id-ul-Azha)', 'state', 'IN-TN', 1], ['2026-06-26', 'Muharram', 'state', 'IN-TN', 1],
  ['2026-08-15', 'Independence Day', 'national', 'IN', 1], ['2026-10-02', 'Gandhi Jayanthi', 'national', 'IN', 1],
]
for (const [date, name, kind, region, off] of hol) {
  ins('holidays', { id: id('hol'), holiday_date: date, year: 2026, name, kind, region, is_day_off: off, source: kind === 'national' && date === '2026-10-02' ? 'National holiday (fixed date) — confirm against the G.O. annexure' : GO, source_url: GO_URL, status: 'pending_verification', created_at: nowIso, updated_at: nowIso })
}

// ── Leave & attendance ──
ins('leave_requests', { id: id('lv'), user_id: U.designer, leave_type_id: 'lt_casual', start_date: day(6), end_date: day(7), half_day: 'none', days: 2, reason: 'Family function', status: 'pending', created_at: ago(1), updated_at: ago(1) })
ins('leave_requests', { id: id('lv'), user_id: U.marketer, leave_type_id: 'lt_sick', start_date: day(-9), end_date: day(-9), half_day: 'none', days: 1, reason: 'Unwell', status: 'approved', decided_by: U.hr, decided_at: ago(9), created_at: ago(9), updated_at: ago(9) })
for (let d = 1; d <= 12; d++) {
  const date = day(-d)
  const wd = new Date(date + 'T00:00:00Z').getUTCDay()
  if (wd === 0 || wd === 6) continue
  for (const k of ['dev', 'designer', 'lead', 'marketer']) {
    if (k === 'marketer' && d === 9) continue
    const inAt = new Date(`${date}T09:${String(20 + ((d * 7) % 25)).padStart(2, '0')}:00+05:30`).toISOString()
    const outAt = new Date(`${date}T18:${String(10 + ((d * 5) % 40)).padStart(2, '0')}:00+05:30`).toISOString()
    ins('attendance_records', { id: id('att'), user_id: U[k], work_date: date, check_in_at: inAt, check_out_at: outAt, status: d % 5 === 0 && k === 'dev' ? 'remote' : 'present', source: 'self', created_at: inAt, updated_at: outAt })
  }
}

ins('activity_logs', { id: id('act'), category: 'admin', actor_type: 'system', action: 'seed.loaded', summary: 'Development sample data loaded (is_seed = 1)', created_at: nowIso })

mkdirSync(new URL('../.seed/', import.meta.url), { recursive: true })
writeFileSync(new URL('../.seed/seed.sql', import.meta.url), out.join('\n') + '\n')
console.log(`Seed SQL written (${out.length} statements). Sample accounts:`)
for (const p of people) console.log(`  ${p.role.padEnd(16)} ${p.email}`)
console.log('Password: see SEED_PASSWORD in scripts/seed.mjs')
