// BENCH PARTS ARE DATA, NOT CODE (founder 2026-09-19: "find a way that lets us add more parts with time and price them … I
// need to see a pic of them"). A part = a row in mh_foundry_catalogue + two files in the R2 bucket FOUNDRY_PARTS:
//   glb/item_<key>.glb   the 3D model the viewer bolts onto the robot     (site: /foundry-glb/item_<key>.glb)
//   img/<partId>         its picture — the admin renders it from the model (site: /parts/<partId>.png)
// and its ERC-1155 metadata (/parts/<partId>.json) is generated here from the row. The site worker serves its own static
// files first and falls back to these routes, so a part published from /admin works everywhere at once: the price list,
// the Bench tray, the saved robot, crates (its partId can go into a loot table) and marketplaces.
//
//   POST /v1/foundry/parts                 admin  { name, priceWei, bonus, glbBase64, imageBase64 } -> the new catalogue row
//   PUT  /v1/foundry/parts/:key/image      admin  { imageBase64 }   replace the picture
//   GET  /v1/foundry/partfile/glb/:key     public the model          GET /v1/foundry/partfile/img/:partId   public the picture
//   GET  /v1/foundry/partfile/meta/:partId public the ERC-1155 metadata JSON
import { ApiError, customizationJson, customizationOptions } from "../customization/http.js";
import { readCatalogue, requireFoundryAdmin, ITEM_BONUS_CAP } from "./economy.js";

const MAX_GLB = 8 * 1024 * 1024, MAX_IMG = 2 * 1024 * 1024, FIRST_PART_ID = 101, SITE = "https://motorheadsonline.com";
function db(env) { if (!env.DB || typeof env.DB.prepare !== "function") throw new ApiError(503, "STORAGE_UNAVAILABLE", "Storage is not available."); return env.DB; }
function bucket(env) { if (!env.FOUNDRY_PARTS || typeof env.FOUNDRY_PARTS.put !== "function") throw new ApiError(503, "PART_STORAGE_UNAVAILABLE", "Part storage is not set up on this server."); return env.FOUNDRY_PARTS; }
function bytesOf(b64, what, max) {
  const m = /^(?:data:[^;,]+;base64,)?([A-Za-z0-9+/=\s]+)$/.exec(String(b64 || "")); if (!m) throw new ApiError(400, "FILE_INVALID", `The ${what} did not arrive as base64.`);
  let bin; try { bin = atob(m[1].replace(/\s+/g, "")); } catch { throw new ApiError(400, "FILE_INVALID", `The ${what} is not valid base64.`); }
  if (bin.length > max) throw new ApiError(413, "FILE_TOO_LARGE", `The ${what} is ${(bin.length / 1048576).toFixed(1)} MB — the limit is ${max / 1048576} MB.`);
  const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
const isGlb = (b) => b.length > 20 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46;                      // "glTF"
const imageType = (b) => (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ? "image/png" : (b[0] === 0xff && b[1] === 0xd8) ? "image/jpeg" : (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) ? "image/webp" : null;
const slug = (name) => String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 24);

async function createPart(env, body) {
  const name = String((body && body.name) || "").trim().replace(/\s+/g, " ").slice(0, 40); if (name.length < 2) throw new ApiError(400, "ITEM_INVALID", "Give the part a name.");
  const priceWei = String((body && body.priceWei) ?? "0"), bonus = Number((body && body.bonus) ?? 0);
  if (!/^\d{1,20}$/.test(priceWei) || BigInt(priceWei) > 10n ** 19n) throw new ApiError(400, "PRICE_INVALID", "priceWei must be a whole number of wei, at most 10 ETH.");
  if (!Number.isFinite(bonus) || bonus < 0 || bonus > ITEM_BONUS_CAP) throw new ApiError(400, "BONUS_INVALID", `bonus must be between 0 and ${ITEM_BONUS_CAP}.`);
  const glb = bytesOf(body && body.glbBase64, "3D model", MAX_GLB); if (!isGlb(glb)) throw new ApiError(400, "MODEL_INVALID", "That file is not a .glb 3D model.");
  const img = bytesOf(body && body.imageBase64, "picture", MAX_IMG), type = imageType(img); if (!type) throw new ApiError(400, "IMAGE_INVALID", "The picture must be a PNG, JPEG or WebP.");
  const cat = await readCatalogue(env, { all: true }); let key = slug(name); if (key.length < 2) throw new ApiError(400, "ITEM_INVALID", "The name needs at least two letters or digits.");
  if (cat.some((c) => c.key === key)) { let n = 2; while (cat.some((c) => c.key === key + n)) n++; key = key + n; }
  const partId = Math.max(FIRST_PART_ID - 1, ...cat.map((c) => c.partId)) + 1, b = bucket(env);
  await b.put("glb/item_" + key + ".glb", glb, { httpMetadata: { contentType: "model/gltf-binary" } });
  await b.put("img/" + partId, img, { httpMetadata: { contentType: type } });
  try { await db(env).prepare("INSERT INTO mh_foundry_catalogue (item_key, name, price_wei, bonus, active, sort, updated_at, part_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?)").bind(key, name, priceWei, bonus, partId, Math.floor(Date.now() / 1000), partId).run(); }
  catch (e) { await b.delete("glb/item_" + key + ".glb").catch(() => {}); await b.delete("img/" + partId).catch(() => {}); throw e; }
  return { ok: true, part: { key, name, priceWei, bonus, partId, active: true }, catalogue: await readCatalogue(env, { all: true }) };
}
async function replaceImage(env, key, body) {
  const part = (await readCatalogue(env, { all: true })).find((c) => c.key === key); if (!part || !part.partId) throw new ApiError(404, "ITEM_UNKNOWN", "No such part.");
  const img = bytesOf(body && body.imageBase64, "picture", MAX_IMG), type = imageType(img); if (!type) throw new ApiError(400, "IMAGE_INVALID", "The picture must be a PNG, JPEG or WebP.");
  await bucket(env).put("img/" + part.partId, img, { httpMetadata: { contentType: type } }); return { ok: true, partId: part.partId };
}
async function serveFile(env, r2key, fallbackType) {
  const obj = await bucket(env).get(r2key); if (!obj) return new Response("not found", { status: 404, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=30" } });
  return new Response(obj.body, { status: 200, headers: { "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || fallbackType, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300, stale-while-revalidate=86400", ETag: obj.httpEtag } });
}

export const PARTS_ROUTE = /^\/v1\/foundry\/(parts|parts\/([a-z0-9_]{2,32})\/image|partfile\/(glb|img|meta)\/([a-z0-9_]{1,40}))$/;
export async function foundryPartsRoute(request, env, match) {
  const M = request.method;
  if (match[3]) {   // public files
    if (M === "OPTIONS") return customizationOptions(request, env, { cors: "public", methods: "GET,OPTIONS" });
    if (M !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET.");
    if (match[3] === "glb") return serveFile(env, "glb/item_" + match[4] + ".glb", "model/gltf-binary");
    if (match[3] === "img") return serveFile(env, "img/" + match[4], "image/png");
    const part = (await readCatalogue(env, { all: true })).find((c) => c.partId > 0 && String(c.partId) === match[4]); if (!part) throw new ApiError(404, "ITEM_UNKNOWN", "No such part.");
    return customizationJson({ name: part.name, description: "A 3D Bench part for MotorHeads: bought with ETH or won from a Foundry parts crate, held by the robot and bolted on at the Foundry Bench.",
      image: SITE + "/parts/" + part.partId + ".png", attributes: [{ trait_type: "Category", value: "3D Part" }, { trait_type: "Part", value: part.name }, { trait_type: "Collection", value: "MotorHeads" }] },
      { request, env, cors: "public", cacheControl: "public, max-age=300" });
  }
  if (M === "OPTIONS") return customizationOptions(request, env, { methods: "POST,PUT,OPTIONS" });
  await requireFoundryAdmin(request, env);
  let body; try { body = await request.json(); } catch { throw new ApiError(400, "BODY_INVALID", "Send JSON."); }
  if (match[2]) { if (M !== "PUT") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use PUT."); return customizationJson(await replaceImage(env, match[2], body), { request, env, methods: "PUT,OPTIONS" }); }
  if (M !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST.");
  return customizationJson(await createPart(env, body), { request, env, methods: "POST,OPTIONS" });
}
