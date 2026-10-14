import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form'
import { ApiError } from './api'
import { useToast } from '@/components/toast'

/** Push server-side validation errors (422 details.fields) into a react-hook-form instance. Returns true if mapped. */
export function applyServerErrors<T extends FieldValues>(err: unknown, setError: UseFormSetError<T>): boolean {
  if (!(err instanceof ApiError)) return false
  const fields = err.fields
  const keys = Object.keys(fields)
  for (const k of keys) setError(k as Path<T>, { type: 'server', message: fields[k] })
  return keys.length > 0
}

/** Mutation with toast feedback and query invalidation. */
export function useAction<TVars = void, TRes = unknown>(
  fn: (v: TVars) => Promise<TRes>,
  opts: { success?: string | ((r: TRes) => string); invalidate?: QueryKey[]; onSuccess?: (r: TRes, v: TVars) => void; onError?: (e: unknown) => void; silentError?: boolean } = {},
) {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k })
      if (opts.success) toast({ tone: 'ok', title: typeof opts.success === 'function' ? opts.success(r) : opts.success })
      opts.onSuccess?.(r, v)
    },
    onError: (e) => {
      opts.onError?.(e)
      if (opts.silentError) return
      const err = e instanceof ApiError ? e : null
      if (err && Object.keys(err.fields).length && opts.onError) return
      const reasons = (err?.details?.reasons as string[] | undefined)?.join(' · ')
      toast({ tone: 'error', title: err?.message ?? 'Something went wrong', body: reasons })
    },
  })
}
