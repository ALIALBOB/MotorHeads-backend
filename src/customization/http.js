import { authOrigins } from "./constants.js";

export class ApiError extends Error {
  constructor(status, code, message, { retryable = false, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function publicCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

export function allowedAuthOrigin(request, env = {}) {
  const origin = request.headers.get("Origin");
  return origin && authOrigins(env).has(origin) ? origin : null;
}

export function assertAuthOrigin(request, env = {}) {
  const origin = allowedAuthOrigin(request, env);
  if (!origin) {
    throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.");
  }
  return origin;
}

export function authCorsHeaders(request, env = {}, methods = "GET,POST,PUT,DELETE,OPTIONS") {
  const origin = allowedAuthOrigin(request, env);
  const headers = {
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "600",
    Vary: "Origin"
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function customizationJson(data, {
  status = 200,
  request,
  env = {},
  cors = "auth",
  methods,
  headers: extraHeaders,
  cacheControl
} = {}) {
  const headers = new Headers(cors === "public" ? publicCorsHeaders() : authCorsHeaders(request, env, methods));
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", cacheControl || (cors === "public" ? "public, max-age=15, stale-while-revalidate=30" : "no-store"));
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    if (value !== undefined && value !== null) headers.append(key, String(value));
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function customizationError(error, options = {}) {
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, "CUSTOMIZATION_INTERNAL_ERROR", "The customization service hit an unexpected error.", { retryable: true });
  const body = {
    error: {
      code: apiError.code,
      message: apiError.message,
      retryable: Boolean(apiError.retryable)
    }
  };
  return customizationJson(body, { cacheControl: "no-store", ...options, status: apiError.status });
}

export function requestEtagMatches(request, etag) {
  return String(request.headers.get("If-None-Match") || "")
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag);
}

export function customizationNotModified({ etag, cacheControl }) {
  const headers = new Headers(publicCorsHeaders());
  headers.set("Cache-Control", cacheControl);
  headers.set("ETag", etag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(null, { status: 304, headers });
}

export function customizationOptions(request, env, { cors = "auth", methods } = {}) {
  if (cors === "auth") assertAuthOrigin(request, env);
  const headers = new Headers(cors === "public" ? publicCorsHeaders() : authCorsHeaders(request, env, methods));
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(null, { status: 204, headers });
}
