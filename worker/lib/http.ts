import type { Context } from 'hono'
import type { ZodType } from 'zod'
import type { AppBindings } from '../env'

export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 503,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'BAD_REQUEST', message, details)
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`)
export const forbidden = (message = 'You do not have permission to do that') => new ApiError(403, 'FORBIDDEN', message)
export const conflict = (message: string, details?: unknown) => new ApiError(409, 'CONFLICT', message, details)

const MAX_JSON_BYTES = 256 * 1024

/** Parse and validate a JSON body. Rejects oversized and non-JSON bodies. */
export async function body<T>(c: Context<AppBindings>, schema: ZodType<T>): Promise<T> {
  const ct = c.req.header('content-type') ?? ''
  if (!ct.includes('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json')
  const len = Number(c.req.header('content-length') ?? '0')
  if (len > MAX_JSON_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
  const text = await c.req.text()
  if (text.length > MAX_JSON_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
  let raw: unknown
  try {
    raw = text ? JSON.parse(text) : {}
  } catch {
    throw badRequest('Malformed JSON')
  }
  return validate(schema, raw)
}

export function validate<T>(schema: ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw)
  if (!r.success) {
    const fields: Record<string, string> = {}
    for (const issue of r.error.issues) {
      const key = issue.path.join('.') || '_'
      if (!fields[key]) fields[key] = issue.message
    }
    throw new ApiError(422, 'VALIDATION_FAILED', 'Some fields need attention', { fields })
  }
  return r.data
}

export function query(c: Context<AppBindings>, key: string): string | undefined {
  const v = c.req.query(key)
  return v === undefined || v === '' ? undefined : v
}

export function clientIp(c: Context<AppBindings>): string | null {
  return c.req.header('cf-connecting-ip') ?? null
}
