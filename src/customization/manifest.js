import { HOLDER_VALIDATION_ARTIFACT } from "../vendor/holder-validation/v1/artifact-info.js";
import { ApiError } from "./http.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;

function manifestUrl(env, tokenId) {
  const root = String(env.HOLDER_PLACEMENT_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!root) throw new ApiError(503, "PLACEMENT_DATA_UNAVAILABLE", "Authoritative placement data is not configured.", { retryable: true });
  return `${root}/holder-placement/v1/tokens/${tokenId}.json`;
}

function remoteFetcher(env) {
  if (env.HOLDER_PLACEMENT_FETCHER && typeof env.HOLDER_PLACEMENT_FETCHER.fetch === "function") {
    return (request) => env.HOLDER_PLACEMENT_FETCHER.fetch(request);
  }
  return (request) => fetch(request);
}

function object(value) {
  return value && !Array.isArray(value) && typeof value === "object";
}

export function validateTokenManifest(manifest, tokenId) {
  const source = manifest?.source;
  if (!object(manifest) || Number(manifest.tokenId) !== tokenId || !object(source)) {
    throw new ApiError(503, "PLACEMENT_DATA_INVALID", "Authoritative placement data failed schema validation.", { retryable: false });
  }
  if (typeof source.layoutHash !== "string" || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(source.layoutHash)) {
    throw new ApiError(503, "PLACEMENT_DATA_INVALID", "Placement data has an invalid source layout hash.");
  }
  if (!object(manifest.canvas) || Number(manifest.canvas.width) !== 1024 || Number(manifest.canvas.height) !== 1024 ||
      !object(manifest.anchors) || !object(manifest.surfaces) || !object(manifest.protectedRegions) ||
      !Array.isArray(manifest.supportedMountZones)) {
    throw new ApiError(503, "PLACEMENT_DATA_INVALID", "Placement data is incomplete.");
  }
  if (!Number.isInteger(Number(source.catalogVersion)) ||
      !Number.isInteger(Number(source.placementManifestVersion))) {
    throw new ApiError(503, "PLACEMENT_DATA_INVALID", "Placement data has invalid version fields.");
  }
  if (Number(source.catalogVersion) !== HOLDER_VALIDATION_ARTIFACT.catalogVersion ||
      Number(source.placementManifestVersion) !== HOLDER_VALIDATION_ARTIFACT.placementManifestVersion) {
    throw new ApiError(409, "PLACEMENT_VERSION_MISMATCH", "Placement data version does not match the server validator.");
  }
  return manifest;
}

async function parseResponse(response, tokenId) {
  if (!response || typeof response.ok !== "boolean") {
    throw new ApiError(503, "PLACEMENT_DATA_UNAVAILABLE", "Authoritative placement data is temporarily unavailable.", { retryable: true });
  }
  if (!response.ok) {
    throw new ApiError(503, "PLACEMENT_DATA_UNAVAILABLE", "Authoritative placement data is temporarily unavailable.", { retryable: response.status >= 500 });
  }
  const length = Number(response.headers.get("Content-Length") || 0);
  if (length > MAX_MANIFEST_BYTES) throw new ApiError(503, "PLACEMENT_DATA_INVALID", "Placement data exceeds the allowed size.");
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(503, "PLACEMENT_DATA_INVALID", "Placement data response has no readable body.");
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MANIFEST_BYTES) {
        await reader.cancel();
        throw new ApiError(503, "PLACEMENT_DATA_INVALID", "Placement data exceeds the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(503, "PLACEMENT_DATA_INVALID", "Placement data is not valid JSON.");
  }
  return validateTokenManifest(manifest, tokenId);
}

export async function loadTokenManifest(env, tokenId, ctx = {}) {
  const url = manifestUrl(env, tokenId);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url, { method: "GET" });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return parseResponse(cached, tokenId);
  }

  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await remoteFetcher(env)(new Request(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000)
      }));
      if (response.ok || response.status < 500 || attempt === 1) break;
    } catch {
      if (attempt === 1) throw new ApiError(503, "PLACEMENT_DATA_UNAVAILABLE", "Authoritative placement data is temporarily unavailable.", { retryable: true });
    }
  }
  const cacheCopy = response?.ok ? response.clone() : null;
  const manifest = await parseResponse(response, tokenId);
  if (cache && cacheCopy) {
    const headers = new Headers(cacheCopy.headers);
    headers.set("Cache-Control", "public, max-age=3600");
    const storable = new Response(cacheCopy.body, { status: cacheCopy.status, headers });
    const put = cache.put(cacheKey, storable);
    if (typeof ctx.waitUntil === "function") ctx.waitUntil(put);
    else await put;
  }
  return manifest;
}
