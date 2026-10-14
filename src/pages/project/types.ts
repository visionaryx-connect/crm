export interface ProjectData {
  project: {
    id: string; reference: string; name: string; status: string; priority: string; progress: number; progress_mode: 'equal' | 'effort' | 'milestone'
    client_id: string; client_name: string; client_reference: string; manager_id: string | null; manager_name: string | null; service_category: string | null; service_category_id: string | null
    description: string; scope: string; start_date: string | null; target_date: string | null; completed_at: string | null; estimated_hours: number | null; client_status_note: string
    closure_approved_by_name: string | null; closure_approved_at: string | null; is_seed: boolean; health: string; health_reasons: string[]; total_tasks: number; overdue_tasks: number; blocked_tasks: number
    created_at: string; archived_at: string | null
  }
  members: { user_id: string; name: string; email: string; avatar_color: string | null; designation: string | null; role: 'manager' | 'lead' | 'member' | 'viewer'; can_review: boolean; responsibility: string }[]
  milestones: { id: string; title: string; description: string; due_date: string | null; weight: number; status: string; achieved_at: string | null; client_visible: boolean; task_count: number; completed_count: number; depends_on: string[] }[]
  taskStats: Record<string, number>
  effort: { estimatedHours: number; loggedHours: number; budgetHours: number | null }
  deliverableStats: Record<string, number>
  openFeedback: number
  access: { memberRole: string | null; canManage: boolean; canManageTasks: boolean; canReview: boolean; canContribute: boolean }
}

export interface TaskRow {
  id: string; project_id: string; project_reference: string; project_name: string; number: number; title: string; status: string; priority: string
  due_date: string | null; start_date: string | null; estimate_hours: number | null; weight: number; milestone_id: string | null; milestone_title: string | null
  responsible_id: string | null; responsible_name: string | null; responsible_color: string | null; blocked_reason: string | null; requires_approval: boolean
  sort_order: number; subtask_total: number; subtask_done: number; comment_count: number; open_dependencies: number; logged_minutes: number; overdue: boolean; completed_at: string | null
}
