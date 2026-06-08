import { COLLECTION } from "./contracts.js";

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function parseTokenId(value) {
  const tokenId = Number(value);
  if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > COLLECTION.maxSupply) {
    return null;
  }
  return tokenId;
}

export function isEthAddress(value) {
  return ETH_ADDRESS_RE.test(value || "");
}

export function buildDefaultVisualState(tokenId) {
  return {
    tokenId,
    version: 1,
    mode: "base",
    overlays: [],
    colors: {},
    updatedAt: null,
    source: "default"
  };
}

export function buildDefaultAgentProfile(tokenId) {
  return {
    tokenId,
    awakened: false,
    name: `MotorHead #${tokenId}`,
    mood: "asleep",
    memory: [],
    awakenedAt: null,
    updatedAt: null,
    source: "default"
  };
}

export async function readVisualState(env, tokenId) {
  if (!env.DB) {
    return buildDefaultVisualState(tokenId);
  }

  const row = await env.DB
    .prepare("SELECT token_id, version, overlay_json, color_json, updated_at FROM token_visual_state WHERE token_id = ?")
    .bind(tokenId)
    .first();

  if (!row) {
    return buildDefaultVisualState(tokenId);
  }

  return {
    tokenId: row.token_id,
    version: row.version,
    mode: "custom",
    overlays: safeJson(row.overlay_json, []),
    colors: safeJson(row.color_json, {}),
    updatedAt: row.updated_at,
    source: "registry"
  };
}

export async function writeVisualState(env, tokenId, ownerAddress, payload, auth) {
  const normalized = normalizeVisualPayload(payload);
  const now = new Date().toISOString();

  await env.DB
    .prepare(
      `INSERT INTO token_visual_state
        (token_id, owner_address, version, overlay_json, color_json, updated_at, signature, signed_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(token_id) DO UPDATE SET
        owner_address = excluded.owner_address,
        version = excluded.version,
        overlay_json = excluded.overlay_json,
        color_json = excluded.color_json,
        updated_at = excluded.updated_at,
        signature = excluded.signature,
        signed_message = excluded.signed_message`
    )
    .bind(
      tokenId,
      ownerAddress.toLowerCase(),
      normalized.version,
      JSON.stringify(normalized.overlays),
      JSON.stringify(normalized.colors),
      now,
      auth.signature,
      auth.signedMessage
    )
    .run();

  return {
    tokenId,
    version: normalized.version,
    mode: "custom",
    overlays: normalized.overlays,
    colors: normalized.colors,
    updatedAt: now,
    source: "registry"
  };
}

export async function readAgentProfile(env, tokenId) {
  if (!env.DB) {
    return buildDefaultAgentProfile(tokenId);
  }

  const row = await env.DB
    .prepare("SELECT token_id, agent_name, mood, awakened_at, memory_json, updated_at FROM agent_profile WHERE token_id = ?")
    .bind(tokenId)
    .first();

  if (!row) {
    return buildDefaultAgentProfile(tokenId);
  }

  return {
    tokenId: row.token_id,
    awakened: true,
    name: row.agent_name,
    mood: row.mood,
    memory: safeJson(row.memory_json, []),
    awakenedAt: row.awakened_at,
    updatedAt: row.updated_at,
    source: "registry"
  };
}

export async function awakenAgent(env, tokenId, ownerAddress, payload, auth) {
  const now = new Date().toISOString();
  const agentName = cleanShortText(payload?.name, `MotorHead #${tokenId}`, 48);
  const mood = cleanShortText(payload?.mood, "awake", 32);
  const memory = Array.isArray(payload?.memory) ? payload.memory.slice(0, 12).map((item) => cleanShortText(item, "", 160)) : [];

  await env.DB
    .prepare(
      `INSERT INTO agent_profile
        (token_id, owner_address, agent_name, mood, awakened_at, memory_json, updated_at, signature, signed_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(token_id) DO UPDATE SET
        owner_address = excluded.owner_address,
        agent_name = excluded.agent_name,
        mood = excluded.mood,
        memory_json = excluded.memory_json,
        updated_at = excluded.updated_at,
        signature = excluded.signature,
        signed_message = excluded.signed_message`
    )
    .bind(
      tokenId,
      ownerAddress.toLowerCase(),
      agentName,
      mood,
      now,
      JSON.stringify(memory),
      now,
      auth.signature,
      auth.signedMessage
    )
    .run();

  return {
    tokenId,
    awakened: true,
    name: agentName,
    mood,
    memory,
    awakenedAt: now,
    updatedAt: now,
    source: "registry"
  };
}

function normalizeVisualPayload(payload = {}) {
  const overlays = Array.isArray(payload.overlays)
    ? payload.overlays.slice(0, 64).map((item) => ({
        partId: cleanShortText(item?.partId, "unknown", 80),
        x: cleanNumber(item?.x, 0),
        y: cleanNumber(item?.y, 0),
        scale: cleanNumber(item?.scale, 1, 0.1, 4),
        rotation: cleanNumber(item?.rotation, 0, -360, 360),
        color: cleanShortText(item?.color, "default", 32)
      }))
    : [];

  return {
    version: Number.isInteger(payload.version) ? payload.version : 1,
    overlays,
    colors: typeof payload.colors === "object" && payload.colors ? payload.colors : {}
  };
}

function cleanNumber(value, fallback, min = -4096, max = 4096) {
  const next = Number(value);
  if (!Number.isFinite(next)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, next));
}

function cleanShortText(value, fallback, maxLength) {
  if (typeof value !== "string") {
    return fallback;
  }
  const clean = value.trim().slice(0, maxLength);
  return clean || fallback;
}

function safeJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

