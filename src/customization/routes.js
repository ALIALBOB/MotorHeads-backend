import { getAddress, isAddress } from "viem";
import {
  CUSTOMIZATION_CONTRACT,
  CUSTOMIZATION_TOKEN_MAX,
  CUSTOMIZATION_TOKEN_MIN,
  flagEnabled,
  rateLimitConfig
} from "./constants.js";
import { createNonce, logoutSession, requireSession, verifySiwe } from "./auth.js";
import { hashNormalizedState } from "./canonical-state.js";
import { assertCustomizationConfiguration } from "./configuration.js";
import { requestFingerprint } from "./crypto.js";
import {
  ApiError,
  assertAuthOrigin,
  customizationError,
  customizationJson,
  customizationNotModified,
  customizationOptions,
  requestEtagMatches
} from "./http.js";
import { loadTokenManifest } from "./manifest.js";
import { readCurrentOwner } from "./ownership.js";
import { enforceRateLimit } from "./rate-limit.js";
import {
  parseNonceBody,
  parseResetBody,
  parseSaveBody,
  parseVerifyBody,
  readJsonBody
} from "./request-body.js";
import { readCustomization, resetCustomization, saveCustomization } from "./storage.js";
import { validateAndNormalizeState } from "./validation.js";

const AUTH_ROUTE = /^\/v1\/auth\/(nonce|verify|session|logout)$/;
const CUSTOMIZATION_ROUTE = /^\/v1\/customizations\/([^/]+)\/([^/]+)$/;

function routeIdentity(rawContract, rawTokenId) {
  if (!isAddress(rawContract || "")) throw new ApiError(400, "UNSUPPORTED_COLLECTION", "Only the MotorHeads collection is supported by this beta.");
  const contractAddress = getAddress(rawContract).toLowerCase();
  if (contractAddress !== CUSTOMIZATION_CONTRACT) throw new ApiError(400, "UNSUPPORTED_COLLECTION", "Only the MotorHeads collection is supported by this beta.");
  if (!/^\d+$/.test(String(rawTokenId || ""))) throw new ApiError(400, "INVALID_TOKEN_ID", "Token ID must be between 1 and 5555.");
  const tokenId = Number(rawTokenId);
  if (!Number.isSafeInteger(tokenId) || tokenId < CUSTOMIZATION_TOKEN_MIN || tokenId > CUSTOMIZATION_TOKEN_MAX) {
    throw new ApiError(400, "INVALID_TOKEN_ID", "Token ID must be between 1 and 5555.");
  }
  return { contractAddress, tokenId };
}

function requireFeature(env, key, code, message) {
  if (!flagEnabled(env[key])) throw new ApiError(503, code, message, { retryable: false });
}

async function authRoute(request, env, action) {
  if (request.method === "OPTIONS") return customizationOptions(request, env, { methods: "GET,POST,OPTIONS" });
  requireFeature(env, "CUSTOMIZATION_AUTH_ENABLED", "CUSTOMIZATION_AUTH_DISABLED", "Customization authentication is disabled.");
  assertCustomizationConfiguration(env, "auth");
  assertAuthOrigin(request, env);

  if (action === "nonce" && request.method === "POST") {
    const { address } = parseNonceBody(await readJsonBody(request, { optional: true }));
    return customizationJson(await createNonce(request, env, address), { request, env, methods: "POST,OPTIONS" });
  }
  if (action === "verify" && request.method === "POST") {
    const input = parseVerifyBody(await readJsonBody(request));
    const verified = await verifySiwe(request, env, input);
    return customizationJson(
      { authenticated: true, address: verified.address, expiresAt: new Date(verified.expiresAt * 1000).toISOString() },
      { request, env, methods: "POST,OPTIONS", headers: { "Set-Cookie": verified.setCookie } }
    );
  }
  if (action === "session" && request.method === "GET") {
    const session = await requireSession(request, env);
    return customizationJson(
      { authenticated: true, address: session.address, expiresAt: new Date(session.expiresAt * 1000).toISOString() },
      { request, env, methods: "GET,OPTIONS" }
    );
  }
  if (action === "logout" && request.method === "POST") {
    const result = await logoutSession(request, env);
    return customizationJson(
      { authenticated: false },
      { request, env, methods: "POST,OPTIONS", headers: { "Set-Cookie": result.clearCookie } }
    );
  }
  throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method is not allowed for this authentication route.");
}

async function publicRead(request, env, identity) {
  if (request.method === "OPTIONS") return customizationOptions(request, env, { cors: "public", methods: "GET,OPTIONS" });
  if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, PUT, or DELETE for customization state.");
  requireFeature(env, "CUSTOMIZATION_READS_ENABLED", "CUSTOMIZATION_READS_DISABLED", "Customization reads are disabled.");
  assertCustomizationConfiguration(env, "read");
  const customization = await readCustomization(env, identity.contractAddress, identity.tokenId);
  const etag = customization.exists
    ? `"mh-${customization.revision}-${String(customization.stateHash || "").replace(/^0x/, "")}"`
    : `"mh-missing-${customization.revision}"`;
  const cacheControl = customization.exists
    ? "public, max-age=15, stale-while-revalidate=30"
    : "public, max-age=5";
  if (requestEtagMatches(request, etag)) return customizationNotModified({ etag, cacheControl });
  return customizationJson(customization, {
    request,
    env,
    cors: "public",
    methods: "GET,OPTIONS",
    cacheControl,
    headers: { ETag: etag }
  });
}

async function writeRoute(request, env, ctx, identity) {
  requireFeature(env, "CUSTOMIZATION_WRITES_ENABLED", "CUSTOMIZATION_WRITES_DISABLED", "Customization writes are disabled.");
  requireFeature(env, "CUSTOMIZATION_AUTH_ENABLED", "CUSTOMIZATION_AUTH_DISABLED", "Customization authentication is disabled.");
  assertCustomizationConfiguration(env, "write");
  assertAuthOrigin(request, env);
  const session = await requireSession(request, env);
  const writeLimits = rateLimitConfig(env).write;
  await enforceRateLimit(env, {
    namespace: "customization-write",
    identity: await requestFingerprint(request, `${session.sessionHash}:${session.address}`),
    ...writeLimits
  });

  const input = request.method === "PUT"
    ? parseSaveBody(await readJsonBody(request))
    : request.method === "DELETE"
      ? parseResetBody(await readJsonBody(request))
      : null;
  if (!input) throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use PUT or DELETE for authenticated customization writes.");

  const owner = await readCurrentOwner(env, identity.contractAddress, identity.tokenId);
  if (owner !== session.address) throw new ApiError(403, "TOKEN_NOT_OWNED", "The connected wallet does not currently own this MotorHead.");

  if (request.method === "PUT") {
    const tokenManifest = await loadTokenManifest(env, identity.tokenId, ctx);
    const { normalizedState, validator } = validateAndNormalizeState({
      routeContract: identity.contractAddress,
      routeTokenId: identity.tokenId,
      state: input.state,
      tokenManifest
    });
    const { canonicalJson, stateHash } = hashNormalizedState(normalizedState);
    const saved = await saveCustomization(env, {
      contractAddress: identity.contractAddress,
      tokenId: identity.tokenId,
      expectedRevision: input.expectedRevision,
      normalizedState,
      canonicalJson,
      stateHash,
      ownerAddress: owner,
      validator
    });
    return customizationJson({ saved: true, ...saved }, { request, env, methods: "PUT,DELETE,OPTIONS" });
  }
  if (request.method === "DELETE") {
    const reset = await resetCustomization(env, {
      contractAddress: identity.contractAddress,
      tokenId: identity.tokenId,
      expectedRevision: input.expectedRevision,
      ownerAddress: owner
    });
    return customizationJson({ reset: true, revision: reset.revision }, { request, env, methods: "PUT,DELETE,OPTIONS" });
  }
  throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use PUT or DELETE for authenticated customization writes.");
}

export async function routeCustomizationRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  const authMatch = url.pathname.match(AUTH_ROUTE);
  const customizationMatch = url.pathname.match(CUSTOMIZATION_ROUTE);
  if (!authMatch && !customizationMatch) return null;

  const isPublicPolicy = Boolean(customizationMatch && (request.method === "GET" ||
    request.method === "OPTIONS" && String(request.headers.get("Access-Control-Request-Method") || "GET").toUpperCase() === "GET"));
  const responseOptions = { request, env, cors: isPublicPolicy ? "public" : "auth" };
  try {
    if (authMatch) return await authRoute(request, env, authMatch[1]);
    const identity = routeIdentity(customizationMatch[1], customizationMatch[2]);
    if (request.method === "OPTIONS") {
      const requested = String(request.headers.get("Access-Control-Request-Method") || "GET").toUpperCase();
      if (requested === "GET") return customizationOptions(request, env, { cors: "public", methods: "GET,OPTIONS" });
      if (!["PUT", "DELETE"].includes(requested)) throw new ApiError(405, "METHOD_NOT_ALLOWED", "Requested method is not allowed.");
      return customizationOptions(request, env, { methods: "PUT,DELETE,OPTIONS" });
    }
    if (request.method === "GET") return await publicRead(request, env, identity);
    return await writeRoute(request, env, ctx, identity);
  } catch (error) {
    if (!(error instanceof ApiError)) console.error("Unhandled customization route error", error?.name || "Error");
    return customizationError(error, responseOptions);
  }
}
