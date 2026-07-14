import { integerSetting } from "./constants.js";
import { changes, requireDatabase } from "./database.js";

const DAY_SECONDS = 24 * 60 * 60;
export const CLEANUP_MAX_ROWS = 500;

export function cleanupConfig(env = {}) {
  return {
    nonceRetentionSeconds: integerSetting(env, "CUSTOMIZATION_NONCE_RETENTION_SECONDS", 7 * DAY_SECONDS, {
      min: DAY_SECONDS,
      max: 90 * DAY_SECONDS
    }),
    sessionRetentionSeconds: integerSetting(env, "CUSTOMIZATION_SESSION_RETENTION_SECONDS", 30 * DAY_SECONDS, {
      min: DAY_SECONDS,
      max: 365 * DAY_SECONDS
    }),
    rateLimitRetentionSeconds: integerSetting(env, "CUSTOMIZATION_RATE_LIMIT_RETENTION_SECONDS", 2 * DAY_SECONDS, {
      min: DAY_SECONDS,
      max: 30 * DAY_SECONDS
    }),
    maxRowsPerTable: integerSetting(env, "CUSTOMIZATION_CLEANUP_MAX_ROWS", CLEANUP_MAX_ROWS, {
      min: 1,
      max: CLEANUP_MAX_ROWS
    })
  };
}

export function buildCleanupCommands({ nowSeconds, ...config }) {
  const nonceCutoff = nowSeconds - config.nonceRetentionSeconds;
  const sessionCutoff = nowSeconds - config.sessionRetentionSeconds;
  const rateLimitCutoff = nowSeconds - config.rateLimitRetentionSeconds;
  const limit = config.maxRowsPerTable;
  return [
    {
      name: "nonces",
      sql: `DELETE FROM mh_auth_nonces WHERE nonce_hash IN (
        SELECT nonce_hash FROM mh_auth_nonces
        WHERE expires_at <= ? OR (consumed_at IS NOT NULL AND consumed_at <= ?)
        ORDER BY expires_at ASC LIMIT ?
      )`,
      bindings: [nonceCutoff, nonceCutoff, limit]
    },
    {
      name: "sessions",
      sql: `DELETE FROM mh_auth_sessions WHERE session_hash IN (
        SELECT session_hash FROM mh_auth_sessions
        WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)
        ORDER BY expires_at ASC LIMIT ?
      )`,
      bindings: [sessionCutoff, sessionCutoff, limit]
    },
    {
      name: "rateLimitBuckets",
      sql: `DELETE FROM mh_rate_limits WHERE bucket_key IN (
        SELECT bucket_key FROM mh_rate_limits
        WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?
      )`,
      bindings: [rateLimitCutoff, limit]
    }
  ];
}

function boundedMaxRows(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(CLEANUP_MAX_ROWS, Math.max(1, Math.trunc(parsed)));
}

export async function cleanupCustomizationData(env = {}, options = {}) {
  const db = requireDatabase(env);
  const defaults = cleanupConfig(env);
  const config = {
    ...defaults,
    ...options,
    maxRowsPerTable: boundedMaxRows(options.maxRowsPerTable, defaults.maxRowsPerTable)
  };
  const nowSeconds = Number.isSafeInteger(config.nowSeconds)
    ? config.nowSeconds
    : Math.floor(Date.now() / 1000);
  const commands = buildCleanupCommands({ ...config, nowSeconds });
  const results = await db.batch(commands.map((command) => db.prepare(command.sql).bind(...command.bindings)));
  return {
    nowSeconds,
    maxRowsPerTable: config.maxRowsPerTable,
    deleted: Object.fromEntries(commands.map((command, index) => [command.name, changes(results?.[index])]))
  };
}
