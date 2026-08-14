import { MOTORHEADS_CONTRACT } from "../contracts.js";

export const CUSTOMIZATION_CONTRACT = MOTORHEADS_CONTRACT.toLowerCase();
export const CUSTOMIZATION_CHAIN_ID = 1;
export const CUSTOMIZATION_TOKEN_MIN = 1;
export const CUSTOMIZATION_TOKEN_MAX = 5555;
export const CUSTOMIZATION_SCHEMA_VERSION = 1;
export const CUSTOMIZATION_MAX_BODY_BYTES = 32 * 1024;
export const CUSTOMIZATION_MAX_ITEMS = 16;
export const CUSTOMIZATION_SIWE_STATEMENT =
  "Sign in to save your MotorHeads workshop layout. This does not send a transaction or cost gas.";

export const DEFAULT_AUTH_ORIGINS = Object.freeze([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://motorheadsonline.com",
  "https://www.motorheadsonline.com"
]);

export function flagEnabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

export function integerSetting(env, key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(env?.[key] ?? ""), 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function authOrigins(env = {}) {
  const configured = String(env.CUSTOMIZATION_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_AUTH_ORIGINS);
}

export function authConfig(env = {}) {
  return {
    domain: String(env.CUSTOMIZATION_SIWE_DOMAIN || "motorheadsonline.com").trim(),
    uri: String(env.CUSTOMIZATION_SIWE_URI || "https://motorheadsonline.com").trim(),
    chainId: CUSTOMIZATION_CHAIN_ID,
    nonceTtlSeconds: integerSetting(env, "CUSTOMIZATION_NONCE_TTL_SECONDS", 600, { min: 60, max: 3600 }),
    sessionTtlSeconds: integerSetting(env, "CUSTOMIZATION_SESSION_TTL_SECONDS", 86400, { min: 300, max: 604800 }),
    cookieSecure: String(env.CUSTOMIZATION_COOKIE_SECURE || "true").toLowerCase() !== "false",
    sessionTouchSeconds: integerSetting(env, "CUSTOMIZATION_SESSION_TOUCH_SECONDS", 300, { min: 60, max: 3600 })
  };
}

export function rateLimitConfig(env = {}) {
  return {
    nonce: {
      limit: integerSetting(env, "CUSTOMIZATION_NONCE_RATE_LIMIT", 20, { min: 1, max: 10000 }),
      windowSeconds: integerSetting(env, "CUSTOMIZATION_NONCE_RATE_WINDOW_SECONDS", 900, { min: 1, max: 86400 })
    },
    verify: {
      limit: integerSetting(env, "CUSTOMIZATION_VERIFY_RATE_LIMIT", 10, { min: 1, max: 10000 }),
      windowSeconds: integerSetting(env, "CUSTOMIZATION_VERIFY_RATE_WINDOW_SECONDS", 900, { min: 1, max: 86400 })
    },
    write: {
      limit: integerSetting(env, "CUSTOMIZATION_WRITE_RATE_LIMIT", 30, { min: 1, max: 10000 }),
      windowSeconds: integerSetting(env, "CUSTOMIZATION_WRITE_RATE_WINDOW_SECONDS", 3600, { min: 1, max: 86400 })
    }
  };
}
