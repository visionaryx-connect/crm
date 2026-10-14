// Thin helpers over D1. Every query is parameterised — never interpolate user input into SQL.

export const nowIso = () => new Date().toISOString()

export async function one<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null
}

export async function many<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>()
  return r.results ?? []
}

export function stmt(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params)
}

/** Build "?, ?, ?" for IN-clauses. Caller must cap list length. */
export function placeholders(n: number): string {
  if (n < 1) throw new Error('placeholders: empty list')
  return Array.from({ length: n }, () => '?').join(', ')
}

/** Convert SQLite 0/1 integers to booleans for selected keys. */
export function bools<T extends Record<string, unknown>>(row: T, ...keys: (keyof T)[]): T {
  const out = { ...row }
  for (const k of keys) (out as Record<string, unknown>)[k as string] = Boolean(row[k])
  return out
}

/** Map a camelCase patch object to "col = ?" fragments, only for keys present in the patch. */
export function patchColumns(patch: Record<string, unknown>, map: Record<string, string>): { sets: string[]; values: unknown[] } {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
      sets.push(`${col} = ?`)
      const v = patch[key]
      values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v)
    }
  }
  return { sets, values }
}

/** Simple changed-field diff for audit logs. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of Object.keys(after)) {
    if (after[k] === undefined) continue
    const a = before[k] ?? null
    const b = after[k] ?? null
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b }
  }
  return out
}
