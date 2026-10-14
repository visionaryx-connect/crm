import { ApiError } from './http'

/**
 * Fixed-window rate limiter backed by D1 (one atomic UPSERT per check).
 * Suitable for authentication and token-validation endpoints at company scale. For high-volume public
 * endpoints, Cloudflare's Rate Limiting binding or WAF rules are the better tool (see docs/SECURITY.md).
 */
export async function rateLimit(db: D1Database, key: string, limit: number, windowSeconds: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const windowStart = now - (now % windowSeconds)
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>()
  if (row && row.count > limit) {
    const retryAfter = windowStart + windowSeconds - now
    throw new ApiError(429, 'RATE_LIMITED', `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`, { retryAfter })
  }
}

/** Remove stale rows. Called from the daily cron. */
export async function pruneRateLimits(db: D1Database): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 86_400
  await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(cutoff).run()
}
