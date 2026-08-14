import { sha256Hex } from "./crypto.js";
import { requireDatabase } from "./database.js";
import { ApiError } from "./http.js";

const UPSERT_BUCKET_SQL = `
INSERT INTO mh_rate_limits (bucket_key, window_started_at, request_count, expires_at)
VALUES (?, ?, 1, ?)
ON CONFLICT(bucket_key) DO UPDATE SET
  window_started_at = CASE
    WHEN mh_rate_limits.expires_at <= excluded.window_started_at THEN excluded.window_started_at
    ELSE mh_rate_limits.window_started_at
  END,
  request_count = CASE
    WHEN mh_rate_limits.expires_at <= excluded.window_started_at THEN 1
    ELSE mh_rate_limits.request_count + 1
  END,
  expires_at = CASE
    WHEN mh_rate_limits.expires_at <= excluded.window_started_at THEN excluded.expires_at
    ELSE mh_rate_limits.expires_at
  END
RETURNING request_count, expires_at`;

export async function enforceRateLimit(env, { namespace, identity, limit, windowSeconds, now = Math.floor(Date.now() / 1000) }) {
  const db = requireDatabase(env);
  const bucketKey = await sha256Hex(`${namespace}\0${identity}`);
  const row = await db.prepare(UPSERT_BUCKET_SQL)
    .bind(bucketKey, now, now + windowSeconds)
    .first();
  if (!row) throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "Rate-limit storage is unavailable.", { retryable: true });
  if (Number(row.request_count) > limit) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please try again later.", {
      retryable: true,
      details: { retryAfterSeconds: Math.max(1, Number(row.expires_at) - now) }
    });
  }
  return { remaining: Math.max(0, limit - Number(row.request_count)), expiresAt: Number(row.expires_at) };
}
