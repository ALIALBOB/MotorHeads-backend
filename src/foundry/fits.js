// THE FITTING BENCH's store: where the FACE sits on each head, and where each BACKPACK sits on each body.
//   GET /v1/foundry/fits            public, open CORS, edge-cached 30 s -> { ok, face:{head:{...}}, pack:{"pack|body":{...}}, count, updatedAt }
//   PUT /v1/foundry/fits            SIWE session, ADMIN wallet only
//       body { kind:"face"|"pack", key, data }            one fit (what Save sends)
//       body { face:{...}, pack:{...} }                   a full sync (what the bench sends on first connect)
//       body { kind, key, remove:true }                   drop one
// These are AUTHORING values, not per-token data: they get baked into FACEPOS / HEADPOS / PACKFIT in the viewer.
// They lived only in the founder's localStorage before, so the work could not be read or reviewed by anyone else
// and a cleared browser would have lost a 221-combination pass.
import { ApiError, customizationJson } from "../customization/http.js";
import { requireSession } from "../customization/auth.js";
import { TREASURY_WALLET } from "../contracts.js";

// "note" is the third kind: not a fit at all, but the founder's verdict on a single MODEL (a head, a body or a
// backpack) while reviewing it — "the crank floats", "this lid opens into the head". Those are the ones that
// cannot be fixed by moving something and have to go back into Blender or the behaviour code.
const KINDS = ["face", "pack", "note"];
const KEY_RE = { face: /^[a-z0-9_]{2,40}$/, pack: /^pack_[a-z0-9_]{2,30}\|body_[a-z0-9_]{2,30}$/, note: /^[a-z0-9_]{2,40}$/ };
const NOTE_STATUS = ["ok", "issue"];
const MAX_SYNC = 400;   // 98 heads + 221 pack/body pairs, with room to spare

function isAdmin(env, address) {
  const list = String(env.FOUNDRY_ADMIN_WALLETS || TREASURY_WALLET).split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(address).toLowerCase());
}

function offs(raw, what) {
  const o = {};
  for (const k of ["dx", "dy", "dz"]) {
    const n = Number(raw && raw[k]);
    if (raw && raw[k] !== undefined && raw[k] !== null && raw[k] !== "" && !Number.isFinite(n)) throw new ApiError(400, "FIT_INVALID", `${what} ${k} must be a number.`);
    o[k] = Number.isFinite(n) ? +Math.min(20, Math.max(-20, n)).toFixed(3) : 0;
  }
  const s = Number(raw && raw.ds);
  o.ds = Number.isFinite(s) ? +Math.min(6, Math.max(0.05, s)).toFixed(3) : 1;
  return o;
}

// One saved fit, normalised. A face fit carries both the face and the head-on-body offsets; a pack fit is one set.
export function validateFit(kind, data) {
  if (!KINDS.includes(kind)) throw new ApiError(400, "FIT_KIND", 'kind must be "face", "pack" or "note".');
  if (kind === "note") {
    const status = NOTE_STATUS.includes(String(data && data.status)) ? String(data.status) : "issue";
    const text = String((data && data.text) || "").slice(0, 2000);
    if (!text && status === "issue") throw new ApiError(400, "NOTE_EMPTY", "An issue needs a description.");
    return { status, text };
  }
  const note = String((data && data.note) || "").slice(0, 300);
  if (kind === "face") {
    const out = { face: offs(data && data.face, "face"), head: offs(data && data.head, "head") };
    if (note) out.note = note;
    return out;
  }
  const out = offs(data, "pack");
  if (note) out.note = note;
  return out;
}

function checkKey(kind, key) {
  const k = String(key || "");
  if (!KEY_RE[kind].test(k)) throw new ApiError(400, "FIT_KEY", `Bad ${kind} key "${k.slice(0, 60)}".`);
  return k;
}

export async function readFits(env) {
  if (!env.DB) return { face: {}, pack: {}, note: {}, count: 0, updatedAt: null };
  const rs = await env.DB.prepare("SELECT kind, fit_key, data, updated_at FROM mh_foundry_fits").all();
  const out = { face: {}, pack: {}, note: {}, count: 0, updatedAt: null };
  for (const row of (rs && rs.results) || []) {
    let d = null; try { d = JSON.parse(row.data); } catch { continue; }
    if (!out[row.kind]) continue;
    out[row.kind][row.fit_key] = d;
    out.count++;
    if (!out.updatedAt || row.updated_at > out.updatedAt) out.updatedAt = row.updated_at;
  }
  return out;
}

async function writeFit(env, kind, key, data, wallet) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO mh_foundry_fits (kind, fit_key, data, wallet, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)" +
    " ON CONFLICT(kind, fit_key) DO UPDATE SET data = excluded.data, wallet = excluded.wallet, updated_at = excluded.updated_at",
  ).bind(kind, key, JSON.stringify(data), String(wallet).toLowerCase(), now).run();
  return now;
}

export async function foundryFitsRoute(request, env) {
  if (request.method === "OPTIONS") {
    const requested = String(request.headers.get("Access-Control-Request-Method") || "GET").toUpperCase();
    const { customizationOptions } = await import("../customization/http.js");
    if (requested === "GET") return customizationOptions(request, env, { cors: "public", methods: "GET,OPTIONS" });
    return customizationOptions(request, env, { methods: "PUT,OPTIONS" });
  }
  if (request.method === "GET") {
    const fits = await readFits(env);
    return customizationJson({ ok: true, ...fits }, { request, env, cors: "public", cacheControl: "public, max-age=30, stale-while-revalidate=60" });
  }
  if (request.method !== "PUT") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or PUT.");
  if (!env.DB) throw new ApiError(503, "NO_DB", "No database bound.");

  const session = await requireSession(request, env);
  if (!isAdmin(env, session.address)) throw new ApiError(403, "NOT_ADMIN", "The fitting bench is admin-only.");
  let body;
  try { body = await request.json(); } catch { throw new ApiError(400, "BODY_INVALID", "Send JSON."); }

  // one fit — what pressing Save sends
  if (body && body.kind) {
    const kind = String(body.kind), key = checkKey(kind, body.key);
    if (body.remove) {
      await env.DB.prepare("DELETE FROM mh_foundry_fits WHERE kind = ?1 AND fit_key = ?2").bind(kind, key).run();
      return customizationJson({ ok: true, removed: 1, kind, key }, { request, env, methods: "PUT,OPTIONS" });
    }
    const data = validateFit(kind, body.data);
    const updatedAt = await writeFit(env, kind, key, data, session.address);
    return customizationJson({ ok: true, saved: 1, kind, key, data, updatedAt }, { request, env, methods: "PUT,OPTIONS" });
  }

  // a full sync — the bench pushing everything it has in the browser
  const pairs = [];
  for (const kind of KINDS) {
    const map = body && body[kind];
    if (!map || typeof map !== "object") continue;
    for (const key of Object.keys(map)) pairs.push([kind, checkKey(kind, key), validateFit(kind, map[key])]);
  }
  if (!pairs.length) throw new ApiError(400, "FIT_EMPTY", "Nothing to save.");
  if (pairs.length > MAX_SYNC) throw new ApiError(400, "FIT_TOO_MANY", `At most ${MAX_SYNC} fits.`);
  let updatedAt = 0;
  for (const [kind, key, data] of pairs) updatedAt = await writeFit(env, kind, key, data, session.address);
  return customizationJson({ ok: true, saved: pairs.length, updatedAt }, { request, env, methods: "PUT,OPTIONS" });
}
