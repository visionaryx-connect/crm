# Business rules

These rules are implemented in code (references in brackets) and covered by tests in `tests/`.

## Project progress (`shared/progress.ts`)

Progress is always derived from task records; nobody can type a percentage.

- Cancelled tasks are excluded from numerator and denominator.
- A task counts as done only when its status is **Completed**. Tasks that require approval reach Completed only through a reviewer's approval, so submitted-but-unapproved work never moves progress.
- **Equal**: completed ÷ applicable × 100.
- **Effort**: each task is weighted by its approved estimate (hours); tasks without an estimate use their complexity weight (default 1).
- **Milestone**: each milestone contributes its weight; tasks inside a milestone count equally; a milestone without tasks counts only when marked Achieved; tasks with no milestone form an implicit bucket of weight 1.
- With no applicable tasks, the UI says "No tasks yet" instead of 0%.
- Every change writes a progress snapshot, which gives reports exact progress "as of" any date.

## Delivery health (separate from progress)

For active projects only (not Planning, On hold, Completed, Archived). Points: target date passed (+3); progress behind the elapsed-schedule line by >30 points (+2) or >15 points (+1); overdue tasks (+1, or +2 when ≥3); blocked tasks (+1). 0 = On track, 1 = Watch, 2–3 = At risk, ≥4 = Off track. The reasons are shown wherever health is displayed.

## Task workflow (`worker/routes/tasks.ts`)

1. A project manager/lead creates the task and assigns a responsible member (must be a contributing project member).
2. The assignee starts work (blocked while dependencies are open), may mark it Blocked (reason required; reviewers notified).
3. The assignee submits for review with a note → status In review; reviewers are notified.
4. A reviewer (project manager, a member with delegated review authority, or `tasks.review_all`) approves → Completed (progress recalculated), or requests revisions with a mandatory explanation → back to In progress. Reviewers cannot approve their own submissions unless they manage the project.
5. Every transition is written to `task_status_history`; every submission and decision to `task_submissions`; field changes to the activity log.

Tasks that don't require approval can be completed directly by the assignee. Only managers can cancel, reopen completed work, or bulk-edit. Deliverable approval (internal review → approved → shared → client decision) is tracked separately from task completion.

## Project closure

A project can be set to Completed only when no tasks are open and no deliverables are in Draft, In review or Changes requested. The closing user is recorded as the closure approver.

## Reporting periods (`worker/services/reports.ts`)

- A period is an inclusive range of local dates in Asia/Kolkata; instants are compared as `start 00:00 IST ≤ t < (end + 1 day) 00:00 IST`.
- **Created in period**: `created_at` in the period.
- **Completed in period**: a transition to Completed within the period (counted once per task).
- **Open at end**: created before the period end and, per status history, in an open status at that moment.
- **Overdue at end**: open at end with a due date before the period's last day.
- Opening/closing status and progress come from history tables; if no history exists the value is reported as *Not available*.
- Member reports pair counts with complexity (weights), timeliness, review outcomes, logged vs. estimated effort, blockers and workload, and state explicitly that counts alone are not a performance measure.

## Working days, holidays and leave (`shared/workdays.ts`)

- The working week (weekdays + Saturday rule: all working / all off / specific Saturdays off) is a company setting.
- A day is a non-working day when an explicit override says so, when it is a **verified** day-off holiday in an applied region, or when the weekly pattern says so. Overrides can also turn a day into a working day (compensatory Saturday).
- Holidays are entered or imported per year from the official notifications and stay *pending verification* — with no effect — until someone with `holidays.manage` verifies them with a recorded source. Any correction resets verification.
- Leave length counts only working days; half days are 0.5 and must be a single date. Requests are checked against overlapping requests and against balances (allocation + adjustment − approved − pending) for balance-tracked types.

## Attendance

- Weekends, holidays and override days off are never counted as absences; approved full-day leave shows as Leave.
- A past working day without a record shows **No record** (flagged), not Absent. Absent only exists when explicitly recorded.
- Check-out with fewer than the configured half-day hours marks a half day.
- Historical changes go through correction requests (approved by `attendance.manage`) or audited manual edits that store before/after values and a reason.

## Notifications

In-app notifications for assignments, due-tomorrow and overdue tasks (daily 08:00 IST, de-duplicated per task per day; managers weekly), review requests, approvals, revision requests, milestone outcomes, client feedback and decisions, leave requests/decisions, calendar invitations/changes/cancellations, comments on your tasks and security events. Users can mute any kind except security notices.

## Automations (`worker/services/automations.ts`)

State-based rules run after every task/milestone change and from the daily cron; each can be disabled in Settings → Automations and every action is logged as an `automation.*` activity (actor = system) with an `Automation:` note in status history. See [WORKFLOW.md](WORKFLOW.md#5-what-the-software-does-automatically) for the full list. The project review state is only undone automatically when the automation itself set it.
