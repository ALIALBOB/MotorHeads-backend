// The Foundry PER-TOKEN RECORD: what the owner changed on a 3D MotorHead. One row per token, two fields:
//   overrides  { head?, body?, pack?, expr? }   the owner's SWITCHES over the frozen DNA (validated against roster.json;
//                                               pack "" = no backpack; the colourway is NEVER switchable)
//   items      [ { glb, anchor?, dx?, dy?, dz?, rx?, ry?, rz?, s?, lift?, free? } ]   Bench parts and where they sit
//   GET  /v1/foundry/items/:tokenId   public, open CORS, edge-cached 60 s  -> { ok, token, items, overrides, updatedAt, poster }
//   PUT  /v1/foundry/items/:tokenId   SIWE session; the wallet must OWN the token or be an admin; body
//                                     { items?, overrides?, poster? } — a field left out keeps what is saved.
// OWNERSHIP (FOUNDRY_OWNERSHIP): "eth" = ownerOf on the 2D collection (Ethereum — the collection the 3D art replaces in
//   place), "rig" = the Robinhood test collection (readOwnedRobots), "both" (default) = either, for the transition.
// GATES — founder 2026-09-17: "the switching and adding parts should be day one, we can use the same activation and
// part contract" — both read on Ethereum mainnet (src/foundry/chain.js), admins bypass both:
//   FOUNDRY_REQUIRE_ACTIVATION=true   a save needs ScrapCrates.activated(tokenId): the one-time 0.003 ETH garage activation
//   FOUNDRY_PART_IDS='{"items":{"tophat":5},"head":{"carousel":12},"body":{},"pack":{}}'   an item or switch mapped to a
//                                     ScrapParts id must be held by the token's garage (ERC-1155 balanceOf); unmapped = free
// The site worker reads GET for /foundry/anim/:id (window.__COMP__) and /foundry/meta/:id (traits), through compFor().
import { ApiError, customizationJson } from "../customization/http.js";
import { requireSession } from "../customization/auth.js";
import { readOwnedRobots } from "./vouchers.js";
import { TREASURY_WALLET } from "../contracts.js";
import { ownerOf2D, isActivated, garageHasParts, SCRAP_CRATES } from "./chain.js";
import { assertItemsOwned, assertSwitchesOwned, readCatalogue, takeSiteFee, publicState } from "./economy.js";
import roster from "./roster.js";

// The wearable GLBs that exist under /foundry-glb/item_<key>.glb on the site. Keep in sync with the Bench tray.
export const ITEM_KEYS = ["tophat", "aviatorduck", "thugshades", "steamgoggles"];
const ANCHORS = ["top", "face", "neck", "back"];
const MAX_ITEMS = 8;
const OVERRIDE_KEYS = ["head", "body", "pack", "expr"];
const LOCKED_KEYS = ["scheme", "colourway", "colorway", "colour", "color", "gold"];

function num(v, lo, hi, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, "ITEM_INVALID", "Item offsets must be numbers.");
  return Math.min(hi, Math.max(lo, n));
}

// `allowed` = the part keys that exist: the four built-in ones + every part in the catalogue (parts are data — src/foundry/parts.js)
export function validateItems(raw, allowed = ITEM_KEYS) {
  if (!Array.isArray(raw)) throw new ApiError(400, "ITEMS_INVALID", "items must be an array.");
  if (raw.length > MAX_ITEMS) throw new ApiError(400, "ITEMS_TOO_MANY", `At most ${MAX_ITEMS} items.`);
  const out = [];
  for (const it of raw) {
    const glb = String((it && (it.glb || it.item || it.name)) || "").toLowerCase();
    if (!allowed.includes(glb)) throw new ApiError(400, "ITEM_UNKNOWN", `Unknown item "${glb}".`);
    const o = { glb };
    if (it.anchor !== undefined && it.anchor !== null && it.anchor !== "") {
      if (!ANCHORS.includes(String(it.anchor))) throw new ApiError(400, "ITEM_INVALID", "Bad anchor.");
      o.anchor = String(it.anchor);
    }
    for (const k of ["dx", "dy", "dz"]) { const v = num(it[k], -3, 3, 0); if (v) o[k] = +v.toFixed(3); }
    for (const k of ["rx", "ry", "rz"]) { const v = num(it[k], -Math.PI, Math.PI, 0); if (v) o[k] = +v.toFixed(3); }
    const s = num(it.s, 0.15, 3, null); if (s !== null) o.s = +s.toFixed(3);
    // COLOUR: an index into the site's basic-colour table, never a hex. The server validates the range and
    // nothing else, so the palette can be retuned in the art without a backend deploy.
    if (it.tint !== undefined && it.tint !== null && it.tint !== "") {
      const t = Math.trunc(Number(it.tint));
      if (!Number.isFinite(t) || t < 0 || t > 31) throw new ApiError(400, "ITEM_INVALID", "Bad item colour.");
      if (t > 0) o.tint = t;      // 0 = the part's own colours, which is the default and is never stored
    }
    const lift = num(it.lift, -2, 2, 0); if (lift) o.lift = +lift.toFixed(3);
    // FREE placement (dragged onto the robot in the Bench): the surface point relative to the head centre, in head
    // widths, and the surface normal the item stands on
    if (it.free && typeof it.free === "object" && Array.isArray(it.free.n) && it.free.n.length === 3) {
      const nn = it.free.n.map((v) => num(v, -1, 1, 0)); const len = Math.hypot(nn[0], nn[1], nn[2]);
      if (len > 0.5) o.free = { x: +num(it.free.x, -8, 8, 0).toFixed(3), y: +num(it.free.y, -8, 8, 0).toFixed(3), z: +num(it.free.z, -8, 8, 0).toFixed(3), n: nn.map((v) => +(v / len).toFixed(3)) };
    }
    out.push(o);
  }
  return out;
}

// The owner's switches: { head?, body?, pack?, expr? } with only the keys that are set. `undefined` in = "keep what is
// saved"; null in = reset to the DNA; pack "" / null / "none" = no backpack. Anything outside the roster is refused,
// and any attempt at the colourway is refused by name so the client gets a clear answer, not a silent drop.
export function validateOverrides(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "OVERRIDES_INVALID", "overrides must be an object.");
  const out = {};
  for (const k of Object.keys(raw)) {
    if (LOCKED_KEYS.includes(k)) throw new ApiError(400, "COLOURWAY_LOCKED", "The colourway is fixed at mint and cannot be switched.");
    if (!OVERRIDE_KEYS.includes(k)) throw new ApiError(400, "OVERRIDES_INVALID", `Unknown override "${k}".`);
    const v = raw[k];
    if (v === undefined) continue;
    if (v === null || v === "") { if (k === "pack") out.pack = ""; continue; }
    const s = String(v).toLowerCase().replace(/\.glb$/, "");
    if (k === "head" && !roster.heads.includes(s)) throw new ApiError(400, "OVERRIDE_UNKNOWN", `Unknown head "${s}".`);
    if (k === "body" && !roster.bodies.includes(s)) throw new ApiError(400, "OVERRIDE_UNKNOWN", `Unknown body "${s}".`);
    if (k === "pack") { if (s === "none") { out.pack = ""; continue; } if (!roster.packs.includes(s)) throw new ApiError(400, "OVERRIDE_UNKNOWN", `Unknown backpack "${s}".`); }
    if (k === "expr" && !roster.exprs.includes(s)) throw new ApiError(400, "OVERRIDE_UNKNOWN", `Unknown expression "${s}".`);
    out[k] = s;
  }
  return out;
}

const noColumn = (e) => /no such column|has no column named/i.test(String((e && e.message) || ""));   // SELECT vs INSERT wording of SQLite

export async function readTokenItems(env, tokenId) {
  const db = env.DB;
  if (!db || typeof db.prepare !== "function") return null;
  let row, hasOverrides = true;
  try { row = await db.prepare("SELECT items, overrides, wallet, updated_at FROM mh_foundry_items WHERE token_id = ?").bind(tokenId).first(); }
  catch (e) {   // migration 0006 not applied yet: the record still answers, without switches
    if (!noColumn(e)) throw e;
    hasOverrides = false;
    row = await db.prepare("SELECT items, wallet, updated_at FROM mh_foundry_items WHERE token_id = ?").bind(tokenId).first();
  }
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items); } catch { items = []; }
  let overrides = {};
  if (hasOverrides && row.overrides) { try { overrides = JSON.parse(row.overrides); } catch { overrides = {}; } }
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) overrides = {};
  return { items: Array.isArray(items) ? items : [], overrides, wallet: row.wallet, updatedAt: Number(row.updated_at) };
}

// POSTER: a base64 JPEG the Bench renders at save time (the OpenSea image). Stored in D1 next to the items.
const POSTER_MAX_B64 = 950000;   // ~700 KB of JPEG
export function parsePoster(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(raw));
  if (!m) throw new ApiError(400, "POSTER_INVALID", "poster must be a JPEG data URL.");
  if (m[1].length > POSTER_MAX_B64) throw new ApiError(413, "POSTER_TOO_LARGE", "poster is too large.");
  return m[1];
}
export async function savePoster(env, tokenId, wallet, b64) {
  const db = env.DB; if (!db || typeof db.prepare !== "function") return;
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO mh_foundry_posters (token_id, jpeg_b64, bytes, wallet, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(token_id) DO UPDATE SET jpeg_b64 = excluded.jpeg_b64, bytes = excluded.bytes, wallet = excluded.wallet, updated_at = excluded.updated_at")
    .bind(tokenId, b64, Math.floor(b64.length * 3 / 4), String(wallet).toLowerCase(), now).run();
}
export async function readPosterMeta(env, tokenId) { const db = env.DB; if (!db || typeof db.prepare !== "function") return null; return await db.prepare("SELECT updated_at FROM mh_foundry_posters WHERE token_id = ?").bind(tokenId).first(); }
export async function readPoster(env, tokenId) {
  const db = env.DB; if (!db || typeof db.prepare !== "function") return null;
  const row = await db.prepare("SELECT jpeg_b64, updated_at FROM mh_foundry_posters WHERE token_id = ?").bind(tokenId).first();
  if (!row) return null;
  const bin = atob(row.jpeg_b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, updatedAt: Number(row.updated_at) };
}
export async function foundryPosterRoute(request, env, rawId) {
  const tokenId = parseInt(rawId, 10);
  if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > 100000) throw new ApiError(400, "TOKEN_INVALID", "Bad token id.");
  if (request.method === "OPTIONS") { const { customizationOptions } = await import("../customization/http.js"); return customizationOptions(request, env, { cors: "public", methods: "GET,OPTIONS" }); }
  if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET.");
  const rec = await readPoster(env, tokenId);
  if (!rec) return new Response("no poster", { status: 404, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=30" } });
  return new Response(rec.bytes, { status: 200, headers: { "Content-Type": "image/jpeg", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60, stale-while-revalidate=120", "X-Poster-Updated": String(rec.updatedAt) } });
}

export async function saveTokenItems(env, tokenId, wallet, items, overrides) {
  const db = env.DB;
  if (!db || typeof db.prepare !== "function") throw new ApiError(503, "STORAGE_UNAVAILABLE", "Storage is not available.");
  const now = Math.floor(Date.now() / 1000);
  const w = String(wallet).toLowerCase(), itemsJson = JSON.stringify(items);
  const ovJson = (overrides && Object.keys(overrides).length) ? JSON.stringify(overrides) : null;   // null = exactly the DNA
  try {
    await db.prepare(
      "INSERT INTO mh_foundry_items (token_id, items, overrides, wallet, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(token_id) DO UPDATE SET items = excluded.items, overrides = excluded.overrides, wallet = excluded.wallet, updated_at = excluded.updated_at"
    ).bind(tokenId, itemsJson, ovJson, w, now).run();
  } catch (e) {
    if (!noColumn(e)) throw e;
    // migration 0006 not applied on this database: items still save as before; a switch cannot be stored yet
    if (ovJson) throw new ApiError(503, "OVERRIDES_UNAVAILABLE", "Switching is not enabled on this server yet.", { retryable: false });
    await db.prepare(
      "INSERT INTO mh_foundry_items (token_id, items, wallet, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(token_id) DO UPDATE SET items = excluded.items, wallet = excluded.wallet, updated_at = excluded.updated_at"
    ).bind(tokenId, itemsJson, w, now).run();
  }
  return now;
}

function isAdmin(env, address) {
  const list = String(env.FOUNDRY_ADMIN_WALLETS || TREASURY_WALLET).split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(address).toLowerCase());
}

// Does this wallet own the token? Ethereum first (the real collection), the Robinhood test rig as the transition fallback.
async function ownsToken(env, address, tokenId) {
  const w = String(address).toLowerCase(), mode = String(env.FOUNDRY_OWNERSHIP || "both").toLowerCase();
  if (mode !== "rig") {
    try { if ((await ownerOf2D(env, tokenId)) === w) return true; }
    catch (e) { if (mode === "eth") throw new ApiError(503, "OWNERSHIP_CHECK_UNAVAILABLE", "Ethereum ownership verification is temporarily unavailable.", { retryable: true }); }
  }
  if (mode !== "eth") {
    let owned = [];
    try { owned = await readOwnedRobots(env, w); } catch { owned = []; }
    if (owned.some((r) => Number(r.tokenId) === tokenId)) return true;
  }
  return false;
}

async function assertActivated(env, tokenId) {
  if (String(env.FOUNDRY_REQUIRE_ACTIVATION || "").toLowerCase() !== "true") return;
  let on = false;
  try { on = await isActivated(env, tokenId); }
  catch { throw new ApiError(503, "ACTIVATION_CHECK_UNAVAILABLE", "The activation check is temporarily unavailable.", { retryable: true }); }
  if (!on) throw new ApiError(403, "NOT_ACTIVATED", `MotorHead #${tokenId} is not activated yet. Activate it in the garage first (one-time fee), then save.`, { details: { crates: SCRAP_CRATES } });
}

function partIdMap(env) {
  let m = {};
  try { m = JSON.parse(String(env.FOUNDRY_PART_IDS || "{}")); } catch { m = {}; }
  return (m && typeof m === "object") ? m : {};
}
// every ScrapParts id this save needs the garage to hold (items and switches that are mapped to a part; unmapped = free)
export function requiredPartIds(env, items, overrides) {
  const m = partIdMap(env), ids = [];
  for (const it of items || []) { const id = Number((m.items || {})[it.glb] || 0); if (id > 0) ids.push(id); }
  for (const k of ["head", "body", "pack"]) { const v = overrides && overrides[k]; if (v) { const id = Number((m[k] || {})[v] || 0); if (id > 0) ids.push(id); } }
  return [...new Set(ids)];
}
async function assertPartsHeld(env, tokenId, items, overrides) {
  const ids = requiredPartIds(env, items, overrides);
  if (!ids.length) return;
  let res;
  try { res = await garageHasParts(env, tokenId, ids); }
  catch { throw new ApiError(503, "PARTS_CHECK_UNAVAILABLE", "The parts check is temporarily unavailable.", { retryable: true }); }
  if (res.missing.length) throw new ApiError(403, "PART_NOT_OWNED", `MotorHead #${tokenId}'s garage does not hold part${res.missing.length > 1 ? "s" : ""} ${res.missing.join(", ")}.`, { details: { missing: res.missing, garage: res.garage } });
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
    // `state` is what a marketplace shows a buyer (activated, tier, weight) — D1 plus the activation cache, cheap enough for tokenURI
    let state = null; try { state = await publicState(env, tokenId); } catch { state = null; }
    let items = rec ? rec.items : [], names = {};
    if (items.length) { try {
      const cat = await readCatalogue(env, { all: true });
      // A PAID part that this robot no longer holds has been moved to another robot — stop wearing it here. The saved
      // placement is kept, so moving it back brings the look back. Only ever filtered when the chain actually answered.
      if (state && state.heldOk && Array.isArray(state.owned)) {
        items = items.filter((it) => { const c = cat.find((x) => x.key === it.glb);
          if (!c || (!c.partId && BigInt(c.priceWei || 0) === 0n)) return true;   // a free part is nobody's to take away
          return state.owned.includes(it.glb); });
      }
      for (const it of items) { const c = cat.find((x) => x.key === it.glb); if (c) names[it.glb] = c.name; }
    } catch { names = {}; } }
    return customizationJson({ ok: true, token: tokenId, names, state, items, overrides: rec ? rec.overrides : {}, updatedAt: rec ? rec.updatedAt : null, poster: !!(await readPosterMeta(env, tokenId)) },
      { request, env, cors: "public", cacheControl: "public, max-age=60, stale-while-revalidate=120" });
  }
  if (request.method !== "PUT") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or PUT.");
  const session = await requireSession(request, env);
  let body;
  try { body = await request.json(); } catch { throw new ApiError(400, "BODY_INVALID", "Send JSON { items: [...], overrides: {...} }."); }
  const existing = await readTokenItems(env, tokenId);
  let allowed = ITEM_KEYS; if (body && body.items !== undefined) { try { allowed = [...new Set([...ITEM_KEYS, ...(await readCatalogue(env, { all: true })).filter((c) => c.kind === "item").map((c) => c.key)])]; } catch { allowed = ITEM_KEYS; } }
  const items = (body && body.items === undefined) ? (existing ? existing.items : []) : validateItems(body && body.items, allowed);
  const ov = validateOverrides(body ? body.overrides : undefined);
  const overrides = ov === undefined ? (existing ? existing.overrides : {}) : ov;
  const poster = parsePoster(body && body.poster);
  if (!isAdmin(env, session.address)) {
    if (!(await ownsToken(env, session.address, tokenId))) throw new ApiError(403, "NOT_OWNER", `Wallet does not own MotorHead #${tokenId}.`);
    await assertActivated(env, tokenId);
    await assertPartsHeld(env, tokenId, items, overrides);
    await assertItemsOwned(env, tokenId, items);   // a part on sale in the shop (migration 0008) must belong to the robot
    await assertSwitchesOwned(env, tokenId, overrides, existing ? existing.overrides : {});   // no free switch: only a custom build the robot owns (migration 0012)
  }
  await takeSiteFee(env, session, { txHash: body && body.feeTx, kind: "feesave", tokenId, ref: "save" });   // every Bench save carries the site fee — taken LAST, after every check, so a refused save never costs a fee
  const updatedAt = await saveTokenItems(env, tokenId, session.address, items, overrides);
  let posterSaved = false; if (poster) { try { await savePoster(env, tokenId, session.address, poster); posterSaved = true; } catch (e) { console.warn("poster save failed", e && e.message); } }
  return customizationJson({ ok: true, token: tokenId, items, overrides, updatedAt, posterSaved, address: session.address }, { request, env, methods: "PUT,OPTIONS" });
}
