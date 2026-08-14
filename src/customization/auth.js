import { getAddress, isAddress, recoverMessageAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";
import {
  CUSTOMIZATION_SIWE_STATEMENT,
  authConfig,
  rateLimitConfig
} from "./constants.js";
import { randomHex, requestFingerprint, sha256Hex, userAgentHash } from "./crypto.js";
import { changes, requireDatabase } from "./database.js";
import { ApiError } from "./http.js";
import { walletAddressHasCode } from "./ownership.js";
import { enforceRateLimit } from "./rate-limit.js";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeAddress(address) {
  try {
    return getAddress(address).toLowerCase();
  } catch {
    throw new ApiError(400, "INVALID_WALLET", "Wallet address is invalid.");
  }
}

function timestamp(value) {
  if (!value) return Number.NaN;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Math.floor(parsed / 1000);
}

export function sessionCookieName(env = {}) {
  return authConfig(env).cookieSecure ? "__Host-mh_session" : "mh_session_dev";
}

function cookieValue(request, name) {
  const cookies = String(request.headers.get("Cookie") || "").split(";");
  for (const item of cookies) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return null;
}

export function sessionCookie(env, token, maxAge) {
  const config = authConfig(env);
  const attributes = [
    `${sessionCookieName(env)}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];
  if (config.cookieSecure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie(env) {
  return sessionCookie(env, "", 0);
}

export async function createNonce(request, env, addressHint = null) {
  const db = requireDatabase(env);
  const config = authConfig(env);
  const limits = rateLimitConfig(env).nonce;
  const ipHash = await requestFingerprint(request, "nonce-ip");
  await enforceRateLimit(env, { namespace: "nonce", identity: ipHash, ...limits });

  const nonce = randomHex(16);
  const nonceHash = await sha256Hex(nonce);
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + config.nonceTtlSeconds;
  await db.prepare(`
    INSERT INTO mh_auth_nonces
      (nonce_hash, address_hint, domain, uri, chain_id, issued_at, expires_at, consumed_at, created_ip_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).bind(
    nonceHash,
    addressHint ? normalizeAddress(addressHint) : null,
    config.domain,
    config.uri,
    config.chainId,
    issuedAt,
    expiresAt,
    ipHash
  ).run();

  return {
    nonce,
    issuedAt: new Date(issuedAt * 1000).toISOString(),
    expirationTime: new Date(expiresAt * 1000).toISOString(),
    domain: config.domain,
    uri: config.uri,
    chainId: config.chainId,
    statement: CUSTOMIZATION_SIWE_STATEMENT
  };
}

async function existingRequestSessionHash(request, env) {
  const token = cookieValue(request, sessionCookieName(env));
  if (!token || !/^[0-9a-f]{64}$/i.test(token)) return null;
  return sha256Hex(token);
}

function parseMessage(message) {
  try {
    return parseSiweMessage(message);
  } catch {
    throw new ApiError(400, "MALFORMED_SIWE_MESSAGE", "SIWE message is malformed.");
  }
}

async function rejectFailedWalletVerification(env, address) {
  if (await walletAddressHasCode(env, address)) {
    throw new ApiError(
      501,
      "CONTRACT_WALLET_AUTH_UNSUPPORTED",
      "Smart-contract wallet authentication is not available in this beta."
    );
  }
  throw new ApiError(401, "INVALID_WALLET_SIGNATURE", "SIWE wallet signature is invalid.");
}

export async function verifySiwe(request, env, { message, signature }) {
  const db = requireDatabase(env);
  const config = authConfig(env);
  const limits = rateLimitConfig(env).verify;
  const ipHash = await requestFingerprint(request, "verify-ip");
  await enforceRateLimit(env, { namespace: "verify-ip", identity: ipHash, ...limits });

  const parsed = parseMessage(message);
  if (!parsed || !isAddress(parsed.address || "")) throw new ApiError(400, "MALFORMED_SIWE_MESSAGE", "SIWE message address is invalid.");
  const address = normalizeAddress(parsed.address);
  await enforceRateLimit(env, { namespace: "verify-address", identity: address, ...limits });

  if (parsed.version !== "1") throw new ApiError(401, "SIWE_VERSION_MISMATCH", "SIWE version must be 1.");
  if (parsed.domain !== config.domain) throw new ApiError(401, "SIWE_DOMAIN_MISMATCH", "SIWE domain does not match this service.");
  if (parsed.uri !== config.uri) throw new ApiError(401, "SIWE_URI_MISMATCH", "SIWE URI does not match this service.");
  if (Number(parsed.chainId) !== config.chainId) throw new ApiError(401, "SIWE_CHAIN_MISMATCH", "SIWE chain ID must be Ethereum mainnet.");
  if (parsed.statement !== CUSTOMIZATION_SIWE_STATEMENT) throw new ApiError(401, "SIWE_STATEMENT_MISMATCH", "SIWE statement does not match this service.");
  if (!/^[A-Za-z0-9]{8,}$/.test(String(parsed.nonce || ""))) throw new ApiError(400, "MALFORMED_SIWE_MESSAGE", "SIWE nonce is invalid.");

  const now = nowSeconds();
  const issuedAt = timestamp(parsed.issuedAt);
  const expiration = timestamp(parsed.expirationTime);
  const notBefore = parsed.notBefore ? timestamp(parsed.notBefore) : null;
  if (!Number.isFinite(issuedAt) || issuedAt > now + 60) throw new ApiError(401, "SIWE_ISSUED_AT_INVALID", "SIWE issued-at time is invalid.");
  if (!Number.isFinite(expiration) || expiration <= now) throw new ApiError(401, "SIWE_EXPIRED", "SIWE message has expired.");
  if (notBefore !== null && (!Number.isFinite(notBefore) || notBefore > now)) {
    throw new ApiError(401, "SIWE_NOT_BEFORE_INVALID", "SIWE message is not valid yet.");
  }

  const nonceHash = await sha256Hex(parsed.nonce);
  const nonceRow = await db.prepare(`
    SELECT nonce_hash, address_hint, domain, uri, chain_id, issued_at, expires_at, consumed_at
    FROM mh_auth_nonces WHERE nonce_hash = ?
  `).bind(nonceHash).first();
  if (!nonceRow) throw new ApiError(401, "NONCE_INVALID", "SIWE nonce is invalid or unknown.");
  if (nonceRow.consumed_at !== null && nonceRow.consumed_at !== undefined) throw new ApiError(401, "NONCE_ALREADY_USED", "SIWE nonce has already been used.");
  if (Number(nonceRow.expires_at) < now) throw new ApiError(401, "NONCE_EXPIRED", "SIWE nonce has expired.");
  if (expiration > Number(nonceRow.expires_at)) throw new ApiError(401, "SIWE_EXPIRATION_INVALID", "SIWE expiration exceeds the nonce lifetime.");
  if (Math.abs(issuedAt - Number(nonceRow.issued_at)) > 300) throw new ApiError(401, "SIWE_ISSUED_AT_INVALID", "SIWE issued-at does not match the nonce.");
  if (nonceRow.domain !== config.domain || nonceRow.uri !== config.uri || Number(nonceRow.chain_id) !== config.chainId) {
    throw new ApiError(401, "NONCE_CONTEXT_MISMATCH", "SIWE nonce context does not match this service.");
  }
  if (nonceRow.address_hint && nonceRow.address_hint !== address) throw new ApiError(401, "SIWE_ADDRESS_MISMATCH", "SIWE address does not match the requested nonce.");

  let recovered = null;
  try {
    recovered = normalizeAddress(await recoverMessageAddress({ message, signature }));
  } catch {
    // Wallet type is checked below without exposing message or signature data.
  }
  if (recovered !== address) await rejectFailedWalletVerification(env, address);

  const sessionToken = randomHex(32);
  const sessionHash = await sha256Hex(sessionToken);
  const expiresAt = now + config.sessionTtlSeconds;
  const priorSessionHash = await existingRequestSessionHash(request, env);
  const userAgent = await userAgentHash(request);
  const ipPrefix = await requestFingerprint(request, "session-ip");

  const consumeNonce = db.prepare(`
    UPDATE mh_auth_nonces SET consumed_at = ?, consumed_session_hash = ?
    WHERE nonce_hash = ? AND consumed_at IS NULL AND expires_at >= ?
  `).bind(now, sessionHash, nonceHash, now);
  const insertSession = db.prepare(`
    INSERT INTO mh_auth_sessions
      (session_hash, address, created_at, expires_at, last_seen_at, revoked_at, user_agent_hash, ip_prefix_hash)
    SELECT ?, ?, ?, ?, ?, NULL, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM mh_auth_nonces
      WHERE nonce_hash = ? AND consumed_at = ? AND consumed_session_hash = ?
    )
  `).bind(
    sessionHash,
    address,
    now,
    expiresAt,
    now,
    userAgent,
    ipPrefix,
    nonceHash,
    now,
    sessionHash
  );
  const statements = [consumeNonce, insertSession];
  if (priorSessionHash) {
    statements.push(db.prepare(`
      UPDATE mh_auth_sessions SET revoked_at = ?
      WHERE session_hash = ? AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM mh_auth_nonces
          WHERE nonce_hash = ? AND consumed_at = ? AND consumed_session_hash = ?
        )
    `).bind(now, priorSessionHash, nonceHash, now, sessionHash));
  }

  let results;
  try {
    results = await db.batch(statements);
  } catch {
    throw new ApiError(
      503,
      "AUTH_SESSION_UNAVAILABLE",
      "Wallet session could not be created. Please retry safely.",
      { retryable: true }
    );
  }
  if (changes(results?.[0]) !== 1 || changes(results?.[1]) !== 1) {
    throw new ApiError(401, "NONCE_ALREADY_USED", "SIWE nonce has already been used or expired.");
  }

  return {
    address,
    expiresAt,
    setCookie: sessionCookie(env, sessionToken, config.sessionTtlSeconds)
  };
}

export async function requireSession(request, env, { touch = true } = {}) {
  const db = requireDatabase(env);
  const token = cookieValue(request, sessionCookieName(env));
  if (!token || !/^[0-9a-f]{64}$/i.test(token)) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "A valid wallet session is required.");
  const sessionHash = await sha256Hex(token);
  const row = await db.prepare(`
    SELECT session_hash, address, created_at, expires_at, last_seen_at, revoked_at
    FROM mh_auth_sessions WHERE session_hash = ?
  `).bind(sessionHash).first();
  const now = nowSeconds();
  if (!row || (row.revoked_at !== null && row.revoked_at !== undefined) || Number(row.expires_at) <= now) {
    throw new ApiError(401, "SESSION_INVALID", "Wallet session is invalid, expired, or revoked.");
  }
  if (touch && now - Number(row.last_seen_at) >= authConfig(env).sessionTouchSeconds) {
    await db.prepare(`
      UPDATE mh_auth_sessions SET last_seen_at = ?
      WHERE session_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).bind(now, sessionHash, now).run();
  }
  return {
    address: normalizeAddress(row.address),
    expiresAt: Number(row.expires_at),
    sessionHash
  };
}

export async function logoutSession(request, env) {
  const token = cookieValue(request, sessionCookieName(env));
  if (token && /^[0-9a-f]{64}$/i.test(token)) {
    const sessionHash = await sha256Hex(token);
    await requireDatabase(env).prepare(`
      UPDATE mh_auth_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL
    `).bind(nowSeconds(), sessionHash).run();
  }
  return { clearCookie: clearSessionCookie(env) };
}
