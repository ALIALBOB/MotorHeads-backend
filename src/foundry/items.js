// The Foundry BENCH record: which accessory items a 3D MotorHead wears, and where.
//   GET  /v1/foundry/items/:tokenId   public, open CORS, edge-cached 60 s  -> { ok, token, items, updatedAt }
//   PUT  /v1/foundry/items/:tokenId   SIWE session; the wallet must OWN the robot (readOwnedRobots) or be the admin
//                                     body { items: [ { glb, anchor?, dx?, dy?, dz?, rx?, ry?, rz?, s? } ] }
// The site worker reads GET on /foundry/anim/:id and injects the array as window.__COMP__.items — the scene's
// loadItems() renders them. This is the first field of the per-token record; head/body/pack overrides come next.
import { ApiError, customizationJson } from "../customization/http.js";
import { requireSession } from "../customization/auth.js";
import { readOwnedRobots } from "./vouchers.js";
import { TREASURY_WALLET } from "../contracts.js";

// The wearable GLBs that exist under /foundry-glb/item_<key>.glb on the site. Keep in sync with the Bench tray.
export const ITEM_KEYS = ["tophat", "aviatorduck", "thugshades", "steamgoggles"];
const ANCHORS = ["top", "face", "neck", "back"];
const MAX_ITEMS = 8;

function num(v, lo, hi, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, "ITEM_INVALID", "Item offsets must be numbers.");
  return Math.min(hi, Math.max(lo, n));
}

export function validateItems(raw) {
  if (!Array.isArray(raw)) throw new ApiError(400, "ITEMS_INVALID", "items must be an array.");
  if (raw.length > MAX_ITEMS) throw new ApiError(400, "ITEMS_TOO_MANY", `At most ${MAX_ITEMS} items.`);
  const out = [];
  for (const it of raw) {
    const glb = String((it && (it.glb || it.item || it.name)) || "").toLowerCase();
    if (!ITEM_KEYS.includes(glb)) throw new ApiError(400, "ITEM_UNKNOWN", `Unknown item "${glb}".`);
    const o = { glb };
    if (it.anchor !== undefined && it.anchor !== null && it.anchor !== "") {
      if (!ANCHORS.includes(String(it.anchor))) throw new ApiError(400, "ITEM_INVALID", "Bad anchor.");
      o.anchor = String(it.anchor);
    }
    for (const k of ["dx", "dy", "dz"]) { const v = num(it[k], -3, 3, 0); if (v) o[k] = +v.toFixed(3); }
    for (const k of ["rx", "ry", "rz"]) { const v = num(it[k], -Math.PI, Math.PI, 0); if (v) o[k] = +v.toFixed(3); }
    const s = num(it.s, 0.15, 3, null); if (s !== null) o.s = +s.toFixed(3);
    out.push(o);
  }
  return out;
}

export async function readTokenItems(env, tokenId) {
  const db = env.DB;
  if (!db || typeof db.prepare !== "function") return null;
  const row = await db.prepare("SELECT items, wallet, updated_at FROM mh_foundry_items WHERE token_id = ?").bind(tokenId).first();
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items); } catch { items = []; }
  return { items: Array.isArray(items) ? items : [], wallet: row.wallet, updatedAt: Number(row.updated_at) };
}

export async function saveTokenItems(env, tokenId, wallet, items) {
  const db = env.DB;
  if (!db || typeof db.prepare !== "function") throw new ApiError(503, "STORAGE_UNAVAILABLE", "Storage is not available.");
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO mh_foundry_items (token_id, items, wallet, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(token_id) DO UPDATE SET items = excluded.items, wallet = excluded.wallet, updated_at = excluded.updated_at"
  ).bind(tokenId, JSON.stringify(items), String(wallet).toLowerCase(), now).run();
  return now;
}

function isAdmin(env, address) {
  const list = String(env.FOUNDRY_ADMIN_WALLETS || TREASURY_WALLET).split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(address).toLowerCase());
}

export async function foundryItemsRoute(request, env, rawId) {
  const tokenId = parseInt(rawId, 10);
  if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > 100000) throw new ApiError(400, "TOKEN_INVALID", "Bad token id.");
  if (request.method === "OPTIONS") {
    const requested = String(request.headers.get("Access-Control-Request-Method") || "GET").toUpperCase();
    const { customizationOptions } = await import("../customization/http.js");
    if (requested === "GET") return customizationOptions(request, env, { cors: "public", methods: "GET,OPTIONS" });
    return customizationOptions(request, env, { methods: "PUT,OPTIONS" });
  }
  if (request.method === "GET") {
    const rec = await readTokenItems(env, tokenId);
    return customizationJson({ ok: true, token: tokenId, items: rec ? rec.items : [], updatedAt: rec ? rec.updatedAt : null },
      { request, env, cors: "public", cacheControl: "public, max-age=60, stale-while-revalidate=120" });
  }
  if (request.method !== "PUT") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or PUT.");
  const session = await requireSession(request, env);
  let body;
  try { body = await request.json(); } catch { throw new ApiError(400, "BODY_INVALID", "Send JSON { items: [...] }."); }
  const items = validateItems(body && body.items);
  if (!isAdmin(env, session.address)) {
    let owned = [];
    try { owned = await readOwnedRobots(env, session.address); } catch { owned = []; }
    if (!owned.some((r) => Number(r.tokenId) === tokenId)) throw new ApiError(403, "NOT_OWNER", `Wallet does not own robot #${tokenId}.`);
  }
  const updatedAt = await saveTokenItems(env, tokenId, session.address, items);
  return customizationJson({ ok: true, token: tokenId, items, updatedAt, address: session.address }, { request, env, methods: "PUT,OPTIONS" });
}
