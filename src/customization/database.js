import { ApiError } from "./http.js";

export function requireDatabase(env = {}) {
  if (!env.DB || typeof env.DB.prepare !== "function") {
    throw new ApiError(503, "CUSTOMIZATION_DATABASE_UNAVAILABLE", "Customization storage is unavailable.", { retryable: true });
  }
  return env.DB;
}

export function changes(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}
