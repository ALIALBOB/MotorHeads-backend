const DEFAULT_INDEXER_RUN_LIMIT = 320;
const DEFAULT_RPC_CALL_LIMIT = 5000;
const DEFAULT_REGISTRY_WRITE_LIMIT = 1000;

export function isEmergencyReadOnly(env = {}) {
  return flag(env.EMERGENCY_READ_ONLY) || flag(env.MOTORHEADS_READ_ONLY);
}

export function isPublicReadsBlocked(env = {}) {
  return flag(env.EMERGENCY_BLOCK_PUBLIC_READS) || flag(env.MOTORHEADS_OFFLINE);
}

export function isIndexerDisabled(env = {}) {
  return isEmergencyReadOnly(env) || flag(env.INDEXER_DISABLED) || String(env.INDEXER_ENABLED || "true").toLowerCase() === "false";
}

export function safetySnapshot(env = {}) {
  return {
    emergencyReadOnly: isEmergencyReadOnly(env),
    publicReadsBlocked: isPublicReadsBlocked(env),
    indexerEnabled: !isIndexerDisabled(env),
    budgets: {
      indexerRunsPerDay: readLimit(env.SAFETY_MAX_INDEXER_RUNS_PER_DAY, DEFAULT_INDEXER_RUN_LIMIT),
      rpcCallsPerDay: readLimit(env.SAFETY_MAX_RPC_CALLS_PER_DAY, DEFAULT_RPC_CALL_LIMIT),
      registryWritesPerDay: readLimit(env.SAFETY_MAX_REGISTRY_WRITES_PER_DAY, DEFAULT_REGISTRY_WRITE_LIMIT)
    }
  };
}

export async function guardIndexerRun(env = {}) {
  if (isIndexerDisabled(env)) {
    return blocked("indexer_disabled", "The MotorHeads indexer is disabled by the safety switch.");
  }

  return consumeDailyBudget(env, "indexer_runs", readLimit(env.SAFETY_MAX_INDEXER_RUNS_PER_DAY, DEFAULT_INDEXER_RUN_LIMIT));
}

export async function guardRpcCall(env = {}) {
  return consumeDailyBudget(env, "rpc_calls", readLimit(env.SAFETY_MAX_RPC_CALLS_PER_DAY, DEFAULT_RPC_CALL_LIMIT));
}

export async function guardRegistryWrite(env = {}) {
  if (isEmergencyReadOnly(env)) {
    return blocked("read_only", "MotorHeads writes are disabled by the safety switch.");
  }

  return consumeDailyBudget(env, "registry_writes", readLimit(env.SAFETY_MAX_REGISTRY_WRITES_PER_DAY, DEFAULT_REGISTRY_WRITE_LIMIT));
}

export async function consumeDailyBudget(env = {}, budgetKey, limit) {
  const normalizedLimit = Math.floor(Number(limit) || 0);
  if (normalizedLimit <= 0) {
    return allowed({ disabled: true, budgetKey, limit: normalizedLimit });
  }

  if (!env.DB) {
    return allowed({ untracked: true, budgetKey, limit: normalizedLimit });
  }

  const dayKey = new Date().toISOString().slice(0, 10);
  const row = await env.DB
    .prepare("SELECT used_count, limit_count FROM safety_budget_daily WHERE budget_key = ? AND day_key = ?")
    .bind(budgetKey, dayKey)
    .first();

  const used = Number(row?.used_count || 0);
  if (used >= normalizedLimit) {
    return blocked("daily_budget_exhausted", `Daily safety budget exhausted for ${budgetKey}.`, {
      budgetKey,
      dayKey,
      used,
      limit: normalizedLimit
    });
  }

  const now = new Date().toISOString();
  await env.DB
    .prepare(
      `INSERT INTO safety_budget_daily (budget_key, day_key, used_count, limit_count, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(budget_key, day_key) DO UPDATE SET
        used_count = used_count + 1,
        limit_count = excluded.limit_count,
        updated_at = excluded.updated_at`
    )
    .bind(budgetKey, dayKey, normalizedLimit, now)
    .run();

  return allowed({ budgetKey, dayKey, used: used + 1, limit: normalizedLimit });
}

export function readLimit(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function flag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function allowed(details = {}) {
  return { ok: true, allowed: true, details };
}

function blocked(code, message, details = {}) {
  return { ok: false, allowed: false, code, message, details };
}
