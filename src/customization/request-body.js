import { isAddress } from "viem";
import { CUSTOMIZATION_MAX_BODY_BYTES, CUSTOMIZATION_MAX_ITEMS } from "./constants.js";
import { ApiError } from "./http.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STATE_KEYS = new Set([
  "schemaVersion", "chainId", "tokenContract", "tokenId", "catalogVersion",
  "placementManifestVersion", "sourceLayoutHash", "backgroundId", "items"
]);
const ITEM_KEYS = new Set(["itemId", "mountZone", "adjustment"]);
const ADJUSTMENT_KEYS = new Set(["dx", "dy", "scale", "rotation"]);

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ApiError(400, "INVALID_REQUEST_SHAPE", `${label} contains an unsupported field: ${key}.`);
  }
}

function scanStructure(value, { depth = 0, counter = { value: 0 } } = {}) {
  counter.value += 1;
  if (counter.value > 512 || depth > 8) throw new ApiError(400, "INVALID_REQUEST_SHAPE", "Request JSON is too deeply nested or complex.");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ApiError(400, "INVALID_NUMBER", "Request numbers must be finite.");
    return;
  }
  if (typeof value === "string") {
    if (value.length > 4096) throw new ApiError(400, "STRING_TOO_LONG", "A request string exceeds the allowed length.");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new ApiError(400, "ARRAY_TOO_LARGE", "A request array exceeds the allowed length.");
    for (const entry of value) scanStructure(entry, { depth: depth + 1, counter });
    return;
  }
  if (typeof value !== "object") throw new ApiError(400, "INVALID_REQUEST_SHAPE", "Request JSON contains an unsupported value.");
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new ApiError(400, "PROTOTYPE_KEY_REJECTED", "Prototype-related keys are not allowed.");
    scanStructure(value[key], { depth: depth + 1, counter });
  }
}

export async function readJsonBody(request, { optional = false, maxBytes = CUSTOMIZATION_MAX_BODY_BYTES } = {}) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, "REQUEST_TOO_LARGE", "Request body exceeds 32 KB.");
  if (!request.body) {
    if (optional) return {};
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const type = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (!type.startsWith("application/json")) throw new ApiError(415, "JSON_CONTENT_TYPE_REQUIRED", "Content-Type must be application/json.");

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "REQUEST_TOO_LARGE", "Request body exceeds 32 KB.");
    }
    chunks.push(value);
  }
  if (total === 0 && optional) return {};
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new ApiError(400, "INVALID_REQUEST_SHAPE", "Request JSON must be an object.");
  scanStructure(parsed);
  return parsed;
}

export function parseNonceBody(body) {
  exactKeys(body, new Set(["address"]), "Nonce request");
  if (body.address !== undefined && !isAddress(body.address)) throw new ApiError(400, "INVALID_WALLET", "Address must be a valid Ethereum address.");
  return { address: body.address || null };
}

export function parseVerifyBody(body) {
  exactKeys(body, new Set(["message", "signature"]), "Verify request");
  if (typeof body.message !== "string" || body.message.length < 32 || body.message.length > 4096) {
    throw new ApiError(400, "MALFORMED_SIWE_MESSAGE", "SIWE message is missing or malformed.");
  }
  if (
    typeof body.signature !== "string" ||
    body.signature.length > 4098 ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(body.signature)
  ) {
    throw new ApiError(400, "INVALID_WALLET_SIGNATURE", "Signature must be non-empty hexadecimal wallet signature data.");
  }
  return body;
}

function safeIdentifier(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 96 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new ApiError(400, "INVALID_REQUEST_SHAPE", `${label} is invalid.`);
  }
  return value;
}

function finiteAdjustment(value, key) {
  const number = value[key];
  if (number === undefined) return key === "scale" ? 1 : 0;
  if (typeof number !== "number" || !Number.isFinite(number)) throw new ApiError(400, "INVALID_NUMBER", `${key} must be a finite number.`);
  return number;
}

export function parseSaveBody(body) {
  exactKeys(body, new Set(["expectedRevision", "state"]), "Save request");
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new ApiError(400, "INVALID_REVISION", "expectedRevision must be a non-negative integer.");
  const state = body.state;
  if (!state || Array.isArray(state) || typeof state !== "object") throw new ApiError(400, "INVALID_STATE", "state must be an object.");
  exactKeys(state, STATE_KEYS, "Customization state");
  if (state.backgroundId !== null) throw new ApiError(409, "BACKGROUND_NOT_SAVEABLE", "Background customization is not saveable in this beta.");
  if (!Array.isArray(state.items) || state.items.length > CUSTOMIZATION_MAX_ITEMS) throw new ApiError(400, "ITEM_LIMIT_EXCEEDED", `items must contain no more than ${CUSTOMIZATION_MAX_ITEMS} entries.`);
  if (typeof state.tokenContract !== "string" || !isAddress(state.tokenContract)) throw new ApiError(400, "INVALID_TOKEN_CONTRACT", "tokenContract must be a valid Ethereum address.");
  if (typeof state.sourceLayoutHash !== "string" || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(state.sourceLayoutHash)) {
    throw new ApiError(400, "INVALID_SOURCE_LAYOUT_HASH", "sourceLayoutHash must be a 32-byte hex digest.");
  }
  const items = state.items.map((item, index) => {
    if (!item || Array.isArray(item) || typeof item !== "object") throw new ApiError(400, "INVALID_ITEM", `Item ${index} must be an object.`);
    exactKeys(item, ITEM_KEYS, `Item ${index}`);
    const adjustment = item.adjustment ?? {};
    if (!adjustment || Array.isArray(adjustment) || typeof adjustment !== "object") throw new ApiError(400, "INVALID_ADJUSTMENT", `Item ${index} adjustment must be an object.`);
    exactKeys(adjustment, ADJUSTMENT_KEYS, `Item ${index} adjustment`);
    return {
      itemId: safeIdentifier(item.itemId, `Item ${index} itemId`),
      mountZone: safeIdentifier(item.mountZone, `Item ${index} mountZone`),
      adjustment: {
        dx: finiteAdjustment(adjustment, "dx"),
        dy: finiteAdjustment(adjustment, "dy"),
        scale: finiteAdjustment(adjustment, "scale"),
        rotation: finiteAdjustment(adjustment, "rotation")
      }
    };
  });
  return {
    expectedRevision: body.expectedRevision,
    state: {
      ...state,
      sourceLayoutHash: state.sourceLayoutHash.replace(/^0x/, "").toLowerCase(),
      items
    }
  };
}

export function parseResetBody(body) {
  exactKeys(body, new Set(["expectedRevision"]), "Reset request");
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new ApiError(400, "INVALID_REVISION", "expectedRevision must be a non-negative integer.");
  return { expectedRevision: body.expectedRevision };
}
