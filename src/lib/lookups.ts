import { useQuery } from '@tanstack/react-query'
import { api } from './api'

export interface MemberLite {
  id: string
  name: string
  email: string
  designation: string | null
  department_id: string | null
  department_name: string | null
  avatar_color: string | null
  status: string
  roles: string[]
}

export const useMembers = (enabled = true) =>
  useQuery({ queryKey: ['team', 'members'], queryFn: () => api.get<{ members: MemberLite[] }>('/api/team/members').then((r) => r.members), staleTime: 5 * 60_000, enabled })

export const useDepartments = () =>
  useQuery({ queryKey: ['departments'], queryFn: () => api.get<{ departments: { id: string; name: string; code: string; head_user_id: string | null; head_name: string | null; member_count: number; description: string }[] }>('/api/team/departments').then((r) => r.departments), staleTime: 5 * 60_000 })

export const useServiceCategories = () =>
  useQuery({ queryKey: ['service-categories'], queryFn: () => api.get<{ categories: { id: string; name: string }[] }>('/api/team/service-categories').then((r) => r.categories), staleTime: 10 * 60_000 })

export const useClientOptions = (enabled = true) =>
  useQuery({ queryKey: ['clients', 'options'], queryFn: () => api.get<{ clients: { id: string; name: string; reference: string }[] }>('/api/clients').then((r) => r.clients), staleTime: 60_000, enabled })

export const useLeaveTypes = () =>
  useQuery({ queryKey: ['leave', 'types'], queryFn: () => api.get<{ types: { id: string; code: string; name: string; annual_quota: number | null; is_paid: number; active: number }[] }>('/api/hr/leave-types').then((r) => r.types), staleTime: 10 * 60_000 })
