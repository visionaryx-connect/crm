import { Link } from 'react-router'
import { ArrowRight, Sparkles } from 'lucide-react'
import { PageHeader, Panel, Section } from '@/components/ui'
import { PROJECT_STEPS, Stepper, TASK_STEPS } from '@/components/Workflow'

const PROJECT_FLOW = [
  { n: '01', who: 'Account manager', title: 'Client', body: 'Add the client and its contacts under Clients. Record meetings and requirements in Relationship history.' },
  { n: '02', who: 'Project manager', title: 'Plan', body: 'Create the project, add the team (give reviewers “review authority”), add milestones, then create tasks with an owner, due date and estimate.' },
  { n: '03', who: 'Team', title: 'Deliver', body: 'Owners start tasks, log time and submit finished work. Reviewers approve it or send it back with notes. Progress updates itself.' },
  { n: '04', who: 'Project manager', title: 'Share', body: 'Upload deliverables, approve them internally, then share with the client. Post client-visible updates.' },
  { n: '05', who: 'Client', title: 'Approve', body: 'The client opens their secure link, reviews deliverables and approves or requests changes.' },
  { n: '06', who: 'Project manager', title: 'Close', body: 'When every task is done and every deliverable approved, set the project to Completed.' },
]

const TASK_ROLES = [
  { role: 'Project manager / lead', does: ['Create tasks and assign an owner, due date and estimate', 'Set dependencies (“can’t start until…”)', 'Approve submissions or request revisions', 'Reassign, reschedule, cancel or reopen'] },
  { role: 'Task owner', does: ['Start work when you begin', 'Tick the checklist and log time', 'Mark Blocked with a reason if stuck', 'Submit for review with a short note'] },
  { role: 'Reviewer', does: ['Open “Awaiting my review” in My work', 'Approve — the task counts as done', 'Or request revisions — explain what to change'] },
]

const AUTOMATIONS = [
  ['Task gets an owner while in Backlog', 'It moves to To do.'],
  ['First task of a project starts', 'Project moves from Planning to In progress.'],
  ['First task in a milestone starts', 'Milestone moves to In progress.'],
  ['Every task in a milestone is approved', 'Milestone becomes Achieved; the team is notified.'],
  ['Everything a task depends on is done', 'Task moves to To do; its owner gets “Ready to start”.'],
  ['Every task in the project is done', 'Project moves to In review; the PM is asked to close it.'],
  ['Work is reopened', 'Milestone / project automatically go back to In progress.'],
  ['Target date passes (checked daily 08:00 IST)', 'Project is marked Delayed; the PM is notified.'],
  ['Task due tomorrow / overdue (daily)', 'Owner is reminded; managers get a weekly overdue notice.'],
]

export default function Guide() {
  return (
    <div>
      <PageHeader eyebrow="Help" title="How work flows" meta={<span>The short version of how projects and tasks move through Visionary X Operations.</span>} />

      <Section title="A project, start to finish">
        <ol className="grid gap-px overflow-hidden rounded-[14px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {PROJECT_FLOW.map((s) => (
            <li key={s.n} className="bg-surface p-5">
              <div className="flex items-baseline justify-between">
                <span className="display text-[34px] text-ink">{s.title}</span>
                <span className="outline-text display text-[34px]">{s.n}</span>
              </div>
              <p className="mt-1 text-[10.5px] font-medium uppercase tracking-[0.18em] text-muted">{s.who}</p>
              <p className="mt-3 text-[13px] text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[12.5px] text-muted">On every project’s Overview tab, the tracker shows the current stage and exactly what to do next:</p>
        <div className="mt-2"><Stepper steps={PROJECT_STEPS} current={1} /></div>
      </Section>

      <Section title="A task’s life">
        <Stepper steps={TASK_STEPS} current={1} />
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {TASK_ROLES.map((r) => (
            <Panel key={r.role} className="p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink">{r.role}</p>
              <ul className="mt-2 space-y-1.5 text-[13px] text-ink-2">{r.does.map((d) => <li key={d} className="flex gap-2"><ArrowRight className="mt-1 size-3 shrink-0 text-muted" />{d}</li>)}</ul>
            </Panel>
          ))}
        </div>
        <ul className="mt-4 space-y-1 text-[12.5px] text-muted">
          <li>· A task counts towards project progress only when it is <span className="text-ink">Done</span> — for reviewed tasks that means approved, not just submitted.</li>
          <li>· Blocked is a side-track: say what’s in the way; reviewers are notified. Unblock to continue.</li>
          <li>· Tasks with unfinished dependencies can’t be started or submitted.</li>
          <li>· Nobody can approve their own submission (unless they manage the project).</li>
        </ul>
      </Section>

      <Section title="What happens automatically" description="Admins can switch each rule off in Settings → Automations. Every automatic change appears in the project’s Activity tab.">
        <div className="overflow-hidden rounded-[14px] border border-line">
          {AUTOMATIONS.map(([when, then]) => (
            <div key={when} className="grid gap-1 border-b border-line bg-surface px-4 py-3 last:border-b-0 sm:grid-cols-[1fr_1fr] sm:gap-6">
              <span className="flex items-center gap-2 text-[13px] text-ink"><Sparkles className="size-3.5 text-muted" />{when}</span>
              <span className="text-[13px] text-ink-2">{then}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Where to find things">
        <ul className="grid gap-2 text-[13px] text-ink-2 sm:grid-cols-2">
          <li><Link to="/tasks" className="link">My work</Link> — everything assigned to you, grouped by due date, plus your review queue.</li>
          <li><Link to="/projects" className="link">Projects</Link> — each project’s Board, List, Timeline, Milestones and Deliverables.</li>
          <li><Link to="/calendar" className="link">Calendar</Link> — meetings, deadlines, milestones, leave and holidays.</li>
          <li><Link to="/reports" className="link">Reports</Link> — monthly company, project, person and client reports.</li>
        </ul>
      </Section>
    </div>
  )
}
