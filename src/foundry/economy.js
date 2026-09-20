// THE FOUNDRY ECONOMY — ETH only, always quoted in ETH (founder 2026-09-18). No token, no burn, nothing on Robinhood.
//   Tier 1 = ACTIVATE, on-chain: ScrapCrates.activate(tokenId), fee read from the contract (0.0067 ETH).
//   Tiers 2..5 = UPGRADE, one step at a time, each step DOUBLE the last: 0.0134 / 0.0268 / 0.0536 / 0.1072 ETH, paid as a
//     plain ETH transfer to the treasury and recorded here once the transaction is VERIFIED on Ethereum (hybrid model:
//     crates + item ownership stay on the existing contracts; tiers / attachments live here so no unaudited contract ever
//     holds pooled money). Reward weight per tier: 1x / 2.5x / 6x / 12x / 22x.
//   333 Archive attach: +5% each, at most 5 per robot (+25%). Item bonus: capped at +5%.
//   weight = tierWeight x (1 + min(0.25, 0.05 x attached) + min(0.05, itemBonus))
//
//   GET  /v1/foundry/economy           public  -> the price list + rules (the app never hard-codes a number)
//   GET  /v1/foundry/state/:tokenId    public  -> { activated, tier, attached333, weight, next:{tier, priceWei} }
//   GET  /v1/foundry/states?tokens=1,7 public  -> the same for up to 200 robots in ONE request (3 eth_calls via Multicall3, whatever the count)
//   POST /v1/foundry/upgrade           SIWE    { tokenId, txHash }        the payment for the NEXT tier, verified on chain
//   POST /v1/foundry/attach333         SIWE    { tokenId, archiveId }     wallet must own both, right now, on Ethereum
//   POST /v1/foundry/detach333         SIWE    { archiveId }
//   PARTS SHOP (migration 0008) — Bench parts are bought with ETH, belong to the ROBOT, and each adds its bonus (capped):
//   GET  /v1/foundry/catalogue         public  -> the parts: { key, name, priceWei, bonus, partId }
//   3D CRATES (migration 0010): a part can also be WON — ScrapCrates crate id 5 drops ScrapParts ids (catalogue.part_id) into
//   the robot's garage, on Ethereum, with the existing contracts. A robot owns a part if it BOUGHT it or its garage HOLDS it.
//   GET  /v1/foundry/crates?wallet=0x… public  -> { crateId, balance, loot:[{ partId, key, name, pct }] } read from the chain
//   POST /v1/foundry/buy               SIWE    { tokenId, itemKey, txHash }   same verified-payment rule as an upgrade
//   PUT  /v1/foundry/catalogue/:key    admin   { name?, priceWei?, bonus?, active?, sort? }   re-price / add / retire a part
//   GET  /v1/foundry/catalogue?all=1   admin   -> also the retired parts        GET /v1/foundry/payments   admin -> the last 100 verified payments
//   admin = a SIWE session of an admin wallet, OR the /admin panel's fresh signed message (x-wallet-address / x-signature / x-signed-message)
// A transaction hash can pay for exactly one thing, ever (primary key on mh_eth_payments).
import roster from "./roster.js";
import { recoverMessageAddress } from "viem";
import { ApiError, customizationJson, customizationOptions } from "../customization/http.js";
import { requireSession } from "../customization/auth.js";
import { TREASURY_WALLET, ARCHIVE_333_CONTRACT } from "../contracts.js";
import { ownerOf2D, isActivated, ethRpc, ethCall, ownerOf721, partsHeldMany, readCrates, activatedMany, ownersMany, multicall, tiersMany, SCRAP_PARTS } from "./chain.js";

export const TIER_WEIGHT = [0, 1, 2.5, 6, 12, 22];                 // index = tier; 0 = not activated = earns nothing
// price of the STEP INTO each tier, in wei. Tier 1 is charged by the contract itself (activationFeeWei), listed for display.
export const TIER_STEP_WEI = [0n, 6700000000000000n, 13400000000000000n, 26800000000000000n, 53600000000000000n, 107200000000000000n];
export const MAX_TIER = 5, MAX_333 = 5, BONUS_PER_333 = 0.05, ITEM_BONUS_CAP = 0.05, MIN_CONFIRMATIONS = 2;

const lc = (a) => String(a || "").toLowerCase();
const isHash = (h) => /^0x[0-9a-fA-F]{64}$/.test(String(h || ""));
export function isAdmin(env, address) { return String(env.FOUNDRY_ADMIN_WALLETS || TREASURY_WALLET).split(",").map((a) => a.trim().toLowerCase()).filter(Boolean).includes(lc(address)); }
function db(env) { if (!env.DB || typeof env.DB.prepare !== "function") throw new ApiError(503, "STORAGE_UNAVAILABLE", "Storage is not available."); return env.DB; }
function tokenIdOf(v) { const n = parseInt(v, 10); if (!Number.isInteger(n) || n < 1 || n > 5555) throw new ApiError(400, "TOKEN_INVALID", "Bad token id."); return n; }

export function weightOf(tier, attached, itemBonus = 0) {
  const base = TIER_WEIGHT[tier] || 0;
  return +(base * (1 + Math.min(MAX_333 * BONUS_PER_333, BONUS_PER_333 * attached) + Math.min(ITEM_BONUS_CAP, Math.max(0, itemBonus)))).toFixed(4);
}

// tier as recorded (2..5) or null; activation (tier 1) is read from the chain, never stored
// THE TIER. Once the forge contract is registered the CHAIN is the truth and D1 is only history; before that (and if the
// chain will not answer) the D1 record still runs the site, so nothing breaks between the deploy and the switch-over.
async function storedTier(env, tokenId) {
  const forge = await forgeAddress(env);
  if (forge) { try { const t = (await tiersMany(env, forge, [tokenId])).get(tokenId); if (t !== undefined) return t; } catch { /* fall back to the record */ } }
  const row = await db(env).prepare("SELECT tier FROM mh_foundry_tiers WHERE token_id = ?").bind(tokenId).first();
  return row ? Number(row.tier) : null;
}
async function attachedTo(env, tokenId) {
  const r = await db(env).prepare("SELECT archive_id FROM mh_foundry_attachments WHERE token_id = ? ORDER BY attached_at").bind(tokenId).all();
  return (r.results || []).map((x) => Number(x.archive_id));
}
// ── the parts shop ──
const noTable = (e) => /no such table/i.test(String((e && e.message) || ""));   // migration 0008 not applied: the shop is empty, parts stay free
export const FOUNDRY_CRATE_ID = 5;   // ScrapCrates crate id of the first 3D parts crate (1-4 = the 2D effect / background crates)
// Crate ids 5..20 belong to the 3D collection: the founder makes a new kind of crate (a rare one, a single-part one…) just by
// setting a loot table on the next free id — the app shows every id in this range that has one, no deploy needed.
const FOUNDRY_CRATE_IDS = Array.from({ length: 16 }, (_, i) => 5 + i);
const noColumn = (e) => /no such column|has no column named/i.test(String((e && e.message) || ""));   // migration 0010 not applied: nothing drops from crates yet
// THE FORGE CONTRACT (FoundryForge) — tiers and bought parts on chain, deployed and registered from /admin. Until it is
// registered the site keeps using the D1 records, so nothing breaks between the deploy and the switch-over.
export async function forgeAddress(env) {
  try { const r = await db(env).prepare("SELECT value FROM mh_foundry_settings WHERE key = 'forge'").first();
    return r && /^0x[0-9a-fA-F]{40}$/.test(String(r.value)) ? String(r.value) : null; }
  catch (e) { if (noTable(e)) return null; throw e; }
}
// What /admin needs to finish the setup, all read from chain so the checklist never lies about what is already done.
export async function forgeSetup(env) {
  const address = await forgeAddress(env);
  const out = { address, deployed: !!address, canMint: false, hasMove: false, accountImpl: null, legacy: [], tierPrices: {}, fee: null, owner: null, treasury: null, seedable: [] };
  const rows = await (async () => { try { return ((await db(env).prepare("SELECT token_id, tier FROM mh_foundry_tiers ORDER BY token_id").all()).results) || []; } catch { return []; } })();
  out.seedable = rows.map((r) => ({ token: Number(r.token_id), tier: Number(r.tier) })).filter((r) => r.tier > 1);
  // parts bought BEFORE the forge existed are a row in D1, not a token in the garage: they cannot be moved or read from
  // the chain until they are minted. Listed here so /admin can put them on chain, and dropped once the garage holds them.
  try { const cat = await readCatalogue(env, { all: true });
    const rows = ((await db(env).prepare("SELECT token_id, item_key FROM mh_foundry_owned").all()).results) || [];
    const want = rows.map((r) => ({ token: Number(r.token_id), key: String(r.item_key), partId: (cat.find((c) => c.key === String(r.item_key)) || {}).partId || 0 })).filter((r) => r.partId > 0);
    if (want.length) { const held = await partsHeldMany(env, [...new Set(want.map((r) => r.token))], [...new Set(want.map((r) => r.partId))]);
      out.legacy = want.filter((r) => !(held.get(r.token) || new Set()).has(r.partId)); } }
  catch { out.legacy = []; }
  if (!address) return out;
  const SEL_HAS_ROLE = "0x91d14854", SEL_TIER_PRICE = "0x1d7737f5", SEL_FEE = "0xb7dc68e0", SEL_OWNER = "0x8da5cb5b", SEL_TREASURY = "0x61d027b3", SEL_TIER_OF = "0x53f96df2", SEL_CAN_MOVE = "0x5f8cd4ee", SEL_ACCT_IMPL = "0x8804eb9f";
  const w = (v) => BigInt(v).toString(16).padStart(64, "0"), aw = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const calls = [
    { target: SCRAP_PARTS, callData: SEL_HAS_ROLE + "9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6" + aw(address) },
    { target: address, callData: SEL_OWNER }, { target: address, callData: SEL_TREASURY }, { target: address, callData: SEL_FEE },
    { target: address, callData: SEL_CAN_MOVE + w(1) },   // only a build that can MOVE parts answers this
    { target: address, callData: SEL_ACCT_IMPL },          // and only the newest knows the garage build
    ...[2, 3, 4, 5].map((t) => ({ target: address, callData: SEL_TIER_PRICE + w(t) })),
    ...out.seedable.map((r) => ({ target: address, callData: SEL_TIER_OF + w(r.token) })),   // what the CHAIN already says
  ];
  let res; try { res = await multicall(env, calls); } catch { return out; }
  const num = (r) => (r && r.success && r.returnData && r.returnData.length >= 66 ? BigInt(r.returnData.slice(0, 66)) : null);
  out.canMint = num(res[0]) === 1n;
  out.owner = res[1] && res[1].success ? "0x" + res[1].returnData.slice(26, 66) : null;
  out.treasury = res[2] && res[2].success ? "0x" + res[2].returnData.slice(26, 66) : null;
  const fee = num(res[3]); out.fee = fee === null ? null : fee.toString();
  out.hasMove = !!(res[4] && res[4].success) && !!(res[5] && res[5].success);   // an older deploy answers neither, so the panel can offer a fresh one
  const ai = res[5] && res[5].success ? "0x" + res[5].returnData.slice(26, 66) : null;
  out.accountImpl = ai && !/^0x0+$/.test(ai) ? ai : null;   // the garage build, needed before a part can be moved
  [2, 3, 4, 5].forEach((t, i) => { const v = num(res[6 + i]); out.tierPrices[t] = v === null ? null : v.toString(); });
  // a robot only needs carrying over while the chain is BEHIND the record. Comparing against the record alone made the
  // step impossible to finish: it listed the same robot for ever, however many times it was seeded (founder 2026-09-19).
  const chainTiers = out.seedable.map((r, i) => num(res[10 + i]));
  out.seedable = out.seedable.filter((r, i) => chainTiers[i] === null || Number(chainTiers[i]) < r.tier);
  return out;
}
async function setForge(env, body) {
  const address = String((body && body.address) || ""); if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new ApiError(400, "FORGE_INVALID", "Send the forge contract address.");
  let owner = null, treasury = null;
  try { const r = await multicall(env, [{ target: address, callData: "0x8da5cb5b" }, { target: address, callData: "0x61d027b3" }]);
    if (!r[0].success || !r[1].success) throw new Error("no");
    owner = lc("0x" + r[0].returnData.slice(26, 66)); treasury = lc("0x" + r[1].returnData.slice(26, 66)); }
  catch { throw new ApiError(400, "FORGE_INVALID", "That address does not answer like a FoundryForge on Ethereum."); }
  if (!isAdmin(env, owner)) throw new ApiError(400, "FORGE_WRONG_OWNER", "That forge is not owned by the treasury wallet.");
  if (lc(treasury) !== lc(TREASURY_WALLET)) throw new ApiError(400, "FORGE_WRONG_TREASURY", "That forge pays a different treasury.");
  await db(env).prepare("INSERT INTO mh_foundry_settings (key, value, updated_at) VALUES ('forge', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(address, Math.floor(Date.now() / 1000)).run();
  return { ok: true, forge: await forgeSetup(env) };
}

export const BUILD_KINDS = ["head", "body", "pack", "expr"];   // a custom BUILD: its catalogue key is the roster key the robot is switched to
const ROSTER_OF = { head: roster.heads, body: roster.bodies, pack: roster.packs, expr: roster.exprs };
export async function readCatalogue(env, { all = false } = {}) {
  let r;
  try { r = await db(env).prepare("SELECT item_key, name, price_wei, bonus, active, sort, part_id, kind FROM mh_foundry_catalogue ORDER BY sort, item_key").all(); }
  catch (e) { if (noTable(e)) return []; if (!noColumn(e)) throw e;
    try { r = await db(env).prepare("SELECT item_key, name, price_wei, bonus, active, sort, part_id FROM mh_foundry_catalogue ORDER BY sort, item_key").all(); }   // 0012 not applied: every row is a wearable part
    catch (e2) { if (!noColumn(e2)) throw e2; r = await db(env).prepare("SELECT item_key, name, price_wei, bonus, active, sort FROM mh_foundry_catalogue ORDER BY sort, item_key").all(); } }
  return (r.results || []).map((x) => ({ key: String(x.item_key), name: String(x.name), priceWei: String(x.price_wei), bonus: Number(x.bonus) || 0, active: Number(x.active) === 1, sort: Number(x.sort) || 0, partId: Number(x.part_id) || 0, kind: BUILD_KINDS.includes(String(x.kind)) ? String(x.kind) : "item" }))
    .filter((x) => all || x.active);
}
// Once the forge is live the GARAGE is the truth for any part that has a part number: the old purchase rows are history,
// and a part that has been moved to another robot must stop counting for the one it left (founder 2026-09-20: it showed on
// both). A part with no part number can only ever be a record, so those rows still count.
export async function stillCounts(env, keys, cat) {
  if (!keys.length) return keys;
  if (!(await forgeAddress(env))) return keys;
  return keys.filter((k) => { const c = cat.find((x) => x.key === k); return !c || !c.partId; });
}
export async function ownedItems(env, tokenId) {
  try { const r = await db(env).prepare("SELECT item_key FROM mh_foundry_owned WHERE token_id = ? ORDER BY bought_at").bind(tokenId).all(); return (r.results || []).map((x) => String(x.item_key)); }
  catch (e) { if (noTable(e)) return []; throw e; }
}
// the bonus of the parts a robot OWNS (a retired part keeps the bonus it was sold with); weightOf() applies the cap
export function itemBonusOf(catalogue, owned) { let b = 0; for (const c of catalogue) if (owned.includes(c.key)) b += c.bonus; return +b.toFixed(4); }
// parts the robot's GARAGE holds on Ethereum (won from a crate), as catalogue keys. Throws when the chain cannot be read.
export async function wonItems(env, tokenId, catalogue) {
  const mapped = catalogue.filter((c) => c.partId > 0); if (!mapped.length) return [];
  const held = (await partsHeldMany(env, [tokenId], mapped.map((c) => c.partId))).get(tokenId) || new Set();
  return mapped.filter((c) => held.has(c.partId)).map((c) => c.key);
}
// the Bench save gate: a part that is sold or drops from a crate must be owned by the robot (bought OR won) before it can be saved onto it
export async function assertItemsOwned(env, tokenId, items) {
  const worn = [...new Set((items || []).map((i) => i.glb))]; if (!worn.length) return;
  const cat = await readCatalogue(env, { all: true }); const paid = cat.filter((c) => worn.includes(c.key) && (BigInt(c.priceWei) > 0n || c.partId > 0)); if (!paid.length) return;
  const bought = await stillCounts(env, await ownedItems(env, tokenId), cat); let missing = paid.filter((c) => !bought.includes(c.key));
  if (missing.length && missing.some((c) => c.partId > 0)) {
    let won; try { won = await wonItems(env, tokenId, missing); } catch { throw new ApiError(503, "PARTS_CHECK_UNAVAILABLE", "The parts check is temporarily unavailable.", { retryable: true }); }
    missing = missing.filter((c) => !won.includes(c.key)); }
  if (missing.length) throw new ApiError(403, "ITEM_NOT_OWNED", `MotorHead #${tokenId} does not own ${missing.map((c) => c.name).join(", ")} yet — buy ${missing.length > 1 ? "them" : "it"} or win ${missing.length > 1 ? "them" : "it"} from a crate, or take ${missing.length > 1 ? "them" : "it"} off before saving.`);
}

// THE SWITCH GATE (founder 2026-09-19): a head / body / backpack / expression can only be switched to a CUSTOM BUILD the robot
// owns — a catalogue row of that kind, bought or won. `before` = the switches already saved: an unchanged one is not judged
// again (robots switched while it was free keep their look until they change it).
export async function assertSwitchesOwned(env, tokenId, overrides, before = {}) {
  if (String(env.FOUNDRY_FREE_SWITCHES || "").toLowerCase() === "true") return;   // escape hatch (tests of the record itself, a rehearsal): OFF in production = switches are sold
  const want = BUILD_KINDS.filter((k) => overrides && overrides[k] !== undefined && overrides[k] !== (before || {})[k]); if (!want.length) return;
  const cat = await readCatalogue(env, { all: true }), bought = await stillCounts(env, await ownedItems(env, tokenId), cat); let missing = [];
  for (const k of want) { const v = overrides[k], c = cat.find((x) => x.kind === k && x.key === v);
    if (!c) throw new ApiError(403, "SWITCH_NOT_FOR_SALE", v === "" ? "A backpack can only be swapped for a custom one, not taken off." : `"${v}" is not a custom ${k === "pack" ? "backpack" : (k === "expr" ? "expression" : k)} — only custom builds can be switched to.`);
    if (!bought.includes(c.key)) missing.push(c); }
  if (missing.length && missing.some((c) => c.partId > 0)) {
    let won; try { won = await wonItems(env, tokenId, missing); } catch { throw new ApiError(503, "PARTS_CHECK_UNAVAILABLE", "The parts check is temporarily unavailable.", { retryable: true }); }
    missing = missing.filter((c) => !won.includes(c.key)); }
  if (missing.length) throw new ApiError(403, "SWITCH_NOT_OWNED", `MotorHead #${tokenId} does not own ${missing.map((c) => c.name).join(", ")} yet — buy ${missing.length > 1 ? "them" : "it"} first, or go back to base before saving.`);
}

// ACTIVATION, CHEAP ENOUGH FOR tokenURI (migration 0013). Activation is one-way on ScrapCrates, so a true is remembered for
// ever and never costs another Ethereum call; a false is re-checked at most every 15 minutes. Every live read of a robot's
// state feeds this cache, so a robot activated through the Forge is remembered the moment the Forge reads it back.
const ACT_RECHECK = 21600;   // a 'not activated yet' is trusted for 6 h; a 'yes' for ever. The owner's own app read updates it the moment they activate, so they never wait.
async function rememberActivated(env, tokenId, active) {
  try { await db(env).prepare("INSERT INTO mh_foundry_activated (token_id, active, checked_at) VALUES (?, ?, ?) ON CONFLICT(token_id) DO UPDATE SET active = excluded.active, checked_at = excluded.checked_at")
    .bind(tokenId, active ? 1 : 0, Math.floor(Date.now() / 1000)).run(); } catch { /* migration 0013 not applied: the cache is simply not used */ }
}
// cacheOnly = never touch Ethereum (the metadata path). Returns true / false, or null when it is genuinely unknown.
export async function activatedCached(env, tokenId, { cacheOnly = false } = {}) {
  let row = null;
  try { row = await db(env).prepare("SELECT active, checked_at FROM mh_foundry_activated WHERE token_id = ?").bind(tokenId).first(); } catch { row = null; }
  if (row && Number(row.active) === 1) return true;
  if (cacheOnly) return row ? false : null;
  if (row && Math.floor(Date.now() / 1000) - Number(row.checked_at) < ACT_RECHECK) return false;
  let active; try { active = await isActivated(env, tokenId); } catch { return row ? false : null; }
  await rememberActivated(env, tokenId, active); return active;
}

// A 333 ONLY COUNTS WHILE ITS HOLDER ALSO OWNS THE ROBOT (2026-09-19). The attachment itself is a row in D1 — the archive's
// ownership is checked on Ethereum when it is attached and, before this, never again. So attaching five archives, selling
// them, and keeping +25% for ever was possible, and a reward round would have paid real ETH on it. Every place that turns
// attachments into WEIGHT now verifies both sides on Ethereum instead of trusting the row. There are only 333 archives, so
// this is two multicalls for the whole collection, cached for a minute.
// Returns Map<tokenId, live count>; throws when Ethereum will not answer (a round must never be snapshotted on a guess).
// cached by the ROWS it was computed from, not by time alone: an attach or a detach invalidates it at once, and one test
// run's answer can never be served to another environment's request.
let attCache = { at: 0, sig: null, map: null };
export async function liveAttachments(env, { fresh = false } = {}) {
  let rows = [];
  try { rows = ((await db(env).prepare("SELECT archive_id, token_id FROM mh_foundry_attachments").all()).results) || []; }
  catch (e) { if (noTable(e)) return new Map(); throw e; }
  const sig = rows.map((r) => r.archive_id + ":" + r.token_id).sort().join(",");
  if (!fresh && attCache.map && attCache.sig === sig && Date.now() - attCache.at < 60000) return attCache.map;
  const map = new Map();
  if (!rows.length) { attCache = { at: Date.now(), sig, map }; return map; }
  const archiveIds = rows.map((r) => Number(r.archive_id)), tokenIds = [...new Set(rows.map((r) => Number(r.token_id)))];
  const [aOwn, rOwn] = await Promise.all([ownersMany(env, archiveIds, ARCHIVE_333_CONTRACT), ownersMany(env, tokenIds)]);
  for (const r of rows) { const a = aOwn.get(Number(r.archive_id)), t = rOwn.get(Number(r.token_id));
    if (a && t && a === t) map.set(Number(r.token_id), (map.get(Number(r.token_id)) || 0) + 1); }
  attCache = { at: Date.now(), sig, map }; return map;
}
// display paths would rather show a slightly generous number than fail: fall back to the raw rows when the chain is down
async function liveAttachCount(env, tokenId, rawIds) {
  try { return (await liveAttachments(env)).get(tokenId) || 0; } catch { return rawIds.length; }
}

export async function readState(env, tokenId) {
  let activated = false, chainOk = true;
  try { activated = await isActivated(env, tokenId); await rememberActivated(env, tokenId, activated); } catch { chainOk = false; }
  const stored = await storedTier(env, tokenId), attached = await attachedTo(env, tokenId);
  const cat = await readCatalogue(env, { all: true });
  const bought = await stillCounts(env, await ownedItems(env, tokenId), cat);
  let won = [], wonOk = true; try { won = await wonItems(env, tokenId, cat); } catch { wonOk = false; }
  const owned = [...new Set([...bought, ...won])], itemBonus = owned.length ? itemBonusOf(cat, owned) : 0;
  const tier = activated ? Math.max(1, stored || 1) : 0;          // an upgrade row means nothing on a robot that is not activated
  const nextTier = tier < MAX_TIER ? tier + 1 : null;
  const liveAtt = await liveAttachCount(env, tokenId, attached);   // only archives still held by this robot's owner add weight
  return { token: tokenId, activated, chainOk, tier, tierWeight: TIER_WEIGHT[tier], attached333: attached, attachedLive: liveAtt, items: owned, bought, won, wonOk, itemBonus: Math.min(ITEM_BONUS_CAP, itemBonus), weight: weightOf(tier, liveAtt, itemBonus),
    next: nextTier ? { tier: nextTier, priceWei: TIER_STEP_WEI[nextTier].toString(), onChain: nextTier === 1 } : null };
}

// MANY ROBOTS AT ONCE (a wallet with 159 of them must not cost 159 x 3 RPC calls): activation and garages through Multicall3,
// the rest from D1 in chunks (D1 binds at most 100 parameters per statement). Same fields as readState, minus `next`.
const MAX_STATES = 200;
async function inChunks(env, sql, ids) { const out = []; for (let i = 0; i < ids.length; i += 90) { const part = ids.slice(i, i + 90);
    try { out.push(...(((await db(env).prepare(sql.replace("(?)", "(" + part.map(() => "?").join(",") + ")")).bind(...part).all()).results) || [])); } catch (e) { if (!noTable(e)) throw e; } } return out; }
// What a BUYER needs to see on a marketplace, built from D1 alone (plus the activation cache) so tokenURI stays cheap.
export async function publicState(env, tokenId) {
  // cache first; Ethereum only when this token has never been looked at, or the 'no' is 6 h old. null = genuinely unknown
  // (the chain would not answer), and the metadata then says nothing rather than claiming a robot is not activated.
  const activated = await activatedCached(env, tokenId);
  const [stored, attached, rawBought] = await Promise.all([storedTier(env, tokenId), attachedTo(env, tokenId), ownedItems(env, tokenId)]);
  const tier = activated ? Math.max(1, stored || 1) : 0;
  const cat = await readCatalogue(env, { all: true });
  // a part the GARAGE holds counts too — that is where every part bought through the forge, and every crate part, lives
  let won = [], heldOk = true; try { won = await wonItems(env, tokenId, cat); } catch { won = []; heldOk = false; }
  const owned = [...new Set([...(await stillCounts(env, rawBought, cat)), ...won])];
  const itemBonus = owned.length ? itemBonusOf(cat, owned) : 0, bought = owned;
  // `weight` here counts the TIER and the robot's own PARTS only. A 333 Archive is a separate NFT that stays in its holder's
  // wallet and can be detached at any time, so it is not the robot's to advertise to a buyer — the app shows the live figure.
  // `owned` + `heldOk` let the public record drop a part that has MOVED to another robot (heldOk false = the chain did not
  // answer, and nothing is dropped — a look must never blank out over an RPC blip).
  return { activated, tier, archives: attached.length, parts: bought.length, weight: activated ? weightOf(tier, 0, Math.min(ITEM_BONUS_CAP, itemBonus)) : 0, owned, heldOk };
}

export async function readStates(env, ids) {
  let active = new Set(), chainOk = true, held = new Map(); const cat = await readCatalogue(env, { all: true }), mapped = cat.filter((c) => c.partId > 0);
  try { active = await activatedMany(env, ids); if (mapped.length) held = await partsHeldMany(env, ids, mapped.map((c) => c.partId)); } catch { chainOk = false; }
  if (chainOk) { try { const now = Math.floor(Date.now() / 1000), d = db(env);   /* feed the metadata's activation cache */
    await d.batch(ids.map((id) => d.prepare("INSERT INTO mh_foundry_activated (token_id, active, checked_at) VALUES (?, ?, ?) ON CONFLICT(token_id) DO UPDATE SET active = excluded.active, checked_at = excluded.checked_at").bind(id, active.has(id) ? 1 : 0, now))); } catch { /* 0013 not applied */ } }
  const tiers = new Map((await inChunks(env, "SELECT token_id, tier FROM mh_foundry_tiers WHERE token_id IN (?)", ids)).map((r) => [Number(r.token_id), Number(r.tier)]));
  { const forge = await forgeAddress(env);   // the chain wins wherever it answers
    if (forge) { try { for (const [id, t] of await tiersMany(env, forge, ids)) tiers.set(id, t); } catch { /* keep the record */ } } }
  let liveAttMap = null; try { liveAttMap = await liveAttachments(env); } catch { liveAttMap = null; }   // null = the chain would not answer; fall back to the rows
  const att = new Map(); for (const r of await inChunks(env, "SELECT token_id, archive_id FROM mh_foundry_attachments WHERE token_id IN (?) ORDER BY attached_at", ids)) { const k = Number(r.token_id); if (!att.has(k)) att.set(k, []); att.get(k).push(Number(r.archive_id)); }
  const bought = new Map(); for (const r of await inChunks(env, "SELECT token_id, item_key FROM mh_foundry_owned WHERE token_id IN (?) ORDER BY bought_at", ids)) { const k = Number(r.token_id); if (!bought.has(k)) bought.set(k, []); bought.get(k).push(String(r.item_key)); }
  { const live = await forgeAddress(env);   // the garage is the truth for anything with a part number
    if (live) for (const [k, ks] of bought) bought.set(k, ks.filter((x) => { const c = cat.find((y) => y.key === x); return !c || !c.partId; })); }
  return ids.map((id) => { const activated = active.has(id), tier = activated ? Math.max(1, tiers.get(id) || 1) : 0, attached = att.get(id) || [], b = bought.get(id) || [], hs = held.get(id) || new Set();
    const won = mapped.filter((c) => hs.has(c.partId)).map((c) => c.key), items = [...new Set([...b, ...won])], itemBonus = items.length ? itemBonusOf(cat, items) : 0;
    const liveAtt = liveAttMap ? (liveAttMap.get(id) || 0) : attached.length;   // the SAME rule as readState and the payout
    return { token: id, activated, chainOk, tier, tierWeight: TIER_WEIGHT[tier], attached333: attached, attachedLive: liveAtt, items, bought: b, won, itemBonus: Math.min(ITEM_BONUS_CAP, itemBonus), weight: weightOf(tier, liveAtt, itemBonus) }; });
}

// THE PAYMENT CHECK. A plain ETH transfer, from the signed-in wallet, to the treasury, for at least the price, mined,
// successful and MIN_CONFIRMATIONS deep. Anything else is refused with a code the app can explain.
// THE SITE FEE (founder 2026-09-19): "1$ worth of ETH on every and any transaction on the website … all goes to my wallet".
// It rides on the payment the holder already sends to the treasury (an upgrade, a part, a custom build) and is a payment of its
// own for the actions that had none (a Bench save, a 333 attach / detach). FOUNDRY_SITE_FEE_USD (wrangler.toml) sets it; "0" = off.
// ETH/USD = the Chainlink feed on Ethereum, read through the same RPC as everything else; when it cannot be read the quote falls
// back to a fixed amount. A payment is ACCEPTED at 70% of the current quote, so a price move between quote and block never
// strands a holder who paid what the site showed. Everything is quoted and shown in ETH.
const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", FEE_FALLBACK_WEI = 300000000000000n, FEE_FLOOR_WEI = 80000000000000n;
let feeCache = { at: 0, price8: 0n };
async function ethUsd8(env) {
  if (Date.now() - feeCache.at < 120000 && feeCache.price8 > 0n) return feeCache.price8;
  const hex = String(await ethCall(env, CHAINLINK_ETH_USD, "0xfeaf968c")).replace(/^0x/, "");   // latestRoundData()
  if (hex.length < 64 * 5) throw new Error("feed");
  const price8 = BigInt("0x" + hex.slice(64, 128)), updatedAt = Number(BigInt("0x" + hex.slice(192, 256)));
  if (price8 < 10000000000n || price8 > 10000000000000n || Date.now() / 1000 - updatedAt > 6 * 3600) throw new Error("feed");   // $100 .. $100,000, fresh
  feeCache = { at: Date.now(), price8 }; return price8;
}
// the fee an ADDRESS actually owes: the treasury/admin never charges itself, and the page knows that too, so the amount the
// wallet sends and the amount the server expects always agree (they did not, and an admin's own upgrade failed TX_UNDERPAID).
export async function siteFeeFor(env, address) {
  if (isAdmin(env, address)) return { usd: 0, wei: 0n, minWei: 0n, ethUsd: null, source: "exempt" };
  return siteFee(env);
}
export async function siteFee(env) {
  const usd = Number(env.FOUNDRY_SITE_FEE_USD || "0"); if (!(usd > 0) || usd > 50) return { usd: 0, wei: 0n, minWei: 0n, ethUsd: null, source: "off" };
  try { const p8 = await ethUsd8(env); let wei = BigInt(Math.round(usd * 100)) * 10n ** 24n / p8; wei = (wei + 5n * 10n ** 12n) / 10n ** 13n * 10n ** 13n;   // to 0.00001 ETH
    return { usd, wei, minWei: wei * 70n / 100n, ethUsd: Number(p8) / 1e8, source: "chainlink" }; }
  catch { return { usd, wei: FEE_FALLBACK_WEI * BigInt(Math.round(usd * 100)) / 100n, minWei: FEE_FLOOR_WEI, ethUsd: null, source: "fallback" }; }
}
// a fee paid on its own (no price attached): verified like any payment, and its hash can never be used twice
export async function takeSiteFee(env, session, { txHash, kind, tokenId, ref }) {
  const fee = await siteFee(env); if (fee.wei === 0n || isAdmin(env, session.address)) return null;
  if (!isHash(String(txHash || ""))) throw new ApiError(402, "FEE_REQUIRED", `This action carries the site fee of ${Number(fee.wei) / 1e18} ETH — send it to the MotorHeads treasury and pass its transaction hash.`);
  const paid = await verifyTreasuryPayment(env, { txHash, from: session.address, minWei: fee.minWei });
  try { await db(env).prepare("INSERT INTO mh_eth_payments (tx_hash, wallet, kind, token_id, ref, value_wei, block_number, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(lc(txHash), lc(session.address), kind, tokenId, String(ref || ""), paid.valueWei.toString(), paid.blockNumber, Math.floor(Date.now() / 1000)).run(); }
  catch (e) { if (/UNIQUE|constraint/i.test(String(e && e.message))) throw new ApiError(409, "TX_ALREADY_USED", "That fee payment has already been used."); throw e; }
  return paid;
}

export async function verifyTreasuryPayment(env, { txHash, from, minWei }) {
  let tx, rc, head;
  try { [tx, rc, head] = await Promise.all([ethRpc(env, "eth_getTransactionByHash", [txHash]), ethRpc(env, "eth_getTransactionReceipt", [txHash]), ethRpc(env, "eth_blockNumber", [])]); }
  catch { throw new ApiError(503, "PAYMENT_CHECK_UNAVAILABLE", "Ethereum is not answering right now — try again in a moment.", { retryable: true }); }
  if (!tx) throw new ApiError(404, "TX_NOT_FOUND", "That transaction is not on Ethereum yet. Wait for it to be mined, then try again.", { retryable: true });
  if (!rc || !rc.blockNumber) throw new ApiError(409, "TX_PENDING", "The transaction is still pending.", { retryable: true });
  if (rc.status !== "0x1") throw new ApiError(400, "TX_FAILED", "That transaction failed on chain — nothing was paid.");
  if (lc(tx.from) !== lc(from)) throw new ApiError(403, "TX_WRONG_SENDER", "That payment was sent from a different wallet.");
  if (lc(tx.to) !== lc(TREASURY_WALLET)) throw new ApiError(400, "TX_WRONG_RECIPIENT", "That payment did not go to the MotorHeads treasury.");
  const value = BigInt(tx.value || "0x0");
  if (value < minWei) throw new ApiError(400, "TX_UNDERPAID", "That payment is below the price (and site fee) of this action.");
  const conf = Number(BigInt(head || "0x0") - BigInt(rc.blockNumber)) + 1;
  if (conf < MIN_CONFIRMATIONS) throw new ApiError(409, "TX_UNCONFIRMED", `Waiting for confirmations (${Math.max(0, conf)}/${MIN_CONFIRMATIONS}).`, { retryable: true });
  return { valueWei: value, blockNumber: Number(BigInt(rc.blockNumber)) };
}

async function requireOwner(env, address, tokenId) {
  if (isAdmin(env, address)) return;
  let owner = null;
  try { owner = await ownerOf2D(env, tokenId); } catch { throw new ApiError(503, "OWNERSHIP_CHECK_UNAVAILABLE", "Ethereum ownership verification is temporarily unavailable.", { retryable: true }); }
  if (owner !== lc(address)) throw new ApiError(403, "NOT_OWNER", `Wallet does not own MotorHead #${tokenId}.`);
}

async function upgrade(env, session, body) {
  if (await forgeAddress(env)) throw new ApiError(409, "USE_THE_FORGE", "Upgrades go through the forge contract now — reload the page.", { details: { forge: await forgeAddress(env) } });
  const tokenId = tokenIdOf(body && body.tokenId), txHash = String((body && body.txHash) || "");
  if (!isHash(txHash)) throw new ApiError(400, "TX_INVALID", "Send the transaction hash of your payment.");
  await requireOwner(env, session.address, tokenId);
  const state = await readState(env, tokenId);
  if (!state.chainOk) throw new ApiError(503, "ACTIVATION_CHECK_UNAVAILABLE", "The activation check is temporarily unavailable.", { retryable: true });
  if (!state.activated) throw new ApiError(409, "NOT_ACTIVATED", `Activate MotorHead #${tokenId} first — upgrades start from an activated robot.`);
  if (state.tier >= MAX_TIER) throw new ApiError(409, "MAX_TIER", `MotorHead #${tokenId} is already at the top tier.`);
  const toTier = state.tier + 1, price = TIER_STEP_WEI[toTier];
  const paid = await verifyTreasuryPayment(env, { txHash, from: session.address, minWei: price + (await siteFeeFor(env, session.address)).minWei });   // + the site fee, on the same payment
  const now = Math.floor(Date.now() / 1000), d = db(env);
  // the hash is the primary key: a payment that was already used can never be used again, even under a race
  try { await d.prepare("INSERT INTO mh_eth_payments (tx_hash, wallet, kind, token_id, ref, value_wei, block_number, created_at) VALUES (?, ?, 'tier', ?, ?, ?, ?, ?)")
    .bind(lc(txHash), lc(session.address), tokenId, String(toTier), paid.valueWei.toString(), paid.blockNumber, now).run(); }
  catch (e) { if (/UNIQUE|constraint/i.test(String(e && e.message))) throw new ApiError(409, "TX_ALREADY_USED", "That payment has already been used for an upgrade."); throw e; }
  // …and the tier only ever moves one step, from the tier this payment was checked against
  const res = await d.prepare("INSERT INTO mh_foundry_tiers (token_id, tier, wallet, tx_hash, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(token_id) DO UPDATE SET tier = excluded.tier, wallet = excluded.wallet, tx_hash = excluded.tx_hash, updated_at = excluded.updated_at WHERE mh_foundry_tiers.tier = ?")
    .bind(tokenId, toTier, lc(session.address), lc(txHash), now, toTier - 1).run();
  if (res.meta && res.meta.changes === 0) throw new ApiError(409, "TIER_CHANGED", "This robot's tier changed while you were paying — reload and try again. Your payment is recorded; contact us.");
  return { ok: true, upgraded: true, ...(await readState(env, tokenId)) };
}

async function attach(env, session, body) {
  const tokenId = tokenIdOf(body && body.tokenId), archiveId = parseInt(body && body.archiveId, 10);
  if (!Number.isInteger(archiveId) || archiveId < 0 || archiveId > 100000) throw new ApiError(400, "ARCHIVE_INVALID", "Bad 333 Archive id.");
  await requireOwner(env, session.address, tokenId);
  let holder = null;
  try { holder = await ownerOf721(env, ARCHIVE_333_CONTRACT, archiveId); } catch { throw new ApiError(503, "OWNERSHIP_CHECK_UNAVAILABLE", "Ethereum ownership verification is temporarily unavailable.", { retryable: true }); }
  if (holder !== lc(session.address) && !isAdmin(env, session.address)) throw new ApiError(403, "ARCHIVE_NOT_OWNED", `Wallet does not hold 333 Archive #${archiveId}.`);
  if (!(await isActivated(env, tokenId).catch(() => false))) throw new ApiError(409, "NOT_ACTIVATED", `Activate MotorHead #${tokenId} first — only activated robots carry a 333.`);
  const d = db(env), now = Math.floor(Date.now() / 1000);
  const bound = await d.prepare("SELECT token_id FROM mh_foundry_attachments WHERE archive_id = ?").bind(archiveId).first();
  if (bound && Number(bound.token_id) === tokenId) return { ok: true, attached: false, ...(await readState(env, tokenId)) };
  if (bound) throw new ApiError(409, "ARCHIVE_BOUND", `333 Archive #${archiveId} is already powering MotorHead #${bound.token_id}. Detach it there first.`);
  if ((await attachedTo(env, tokenId)).length >= MAX_333) throw new ApiError(409, "ARCHIVE_LIMIT", `A robot carries at most ${MAX_333} archives.`);
  await takeSiteFee(env, session, { txHash: body && body.feeTx, kind: "fee333", tokenId, ref: String(archiveId) });   // attaching carries the site fee; DETACHING stays free (a buyer must always be able to free an archive)
  try { await d.prepare("INSERT INTO mh_foundry_attachments (archive_id, token_id, wallet, attached_at) VALUES (?, ?, ?, ?)").bind(archiveId, tokenId, lc(session.address), now).run(); }
  catch (e) { if (/UNIQUE|constraint/i.test(String(e && e.message))) throw new ApiError(409, "ARCHIVE_BOUND", `333 Archive #${archiveId} is already attached.`); throw e; }
  return { ok: true, attached: true, ...(await readState(env, tokenId)) };
}

async function detach(env, session, body) {
  const archiveId = parseInt(body && body.archiveId, 10);
  if (!Number.isInteger(archiveId)) throw new ApiError(400, "ARCHIVE_INVALID", "Bad 333 Archive id.");
  const d = db(env), row = await d.prepare("SELECT token_id, wallet FROM mh_foundry_attachments WHERE archive_id = ?").bind(archiveId).first();
  if (!row) return { ok: true, detached: false };
  // whoever holds the archive NOW may free it (so a buyer is never stuck with a seller's binding), as may the robot's owner
  let holder = null; try { holder = await ownerOf721(env, ARCHIVE_333_CONTRACT, archiveId); } catch { /* fall through to the robot-owner check */ }
  if (holder !== lc(session.address) && !isAdmin(env, session.address)) await requireOwner(env, session.address, Number(row.token_id));
  await d.prepare("DELETE FROM mh_foundry_attachments WHERE archive_id = ?").bind(archiveId).run();
  return { ok: true, detached: true, ...(await readState(env, Number(row.token_id))) };
}

// BUY A PART for a robot: the same verified-payment rule as an upgrade. The part belongs to the robot from then on.
async function buy(env, session, body) {
  if (await forgeAddress(env)) throw new ApiError(409, "USE_THE_FORGE", "Parts are bought from the forge contract now — reload the page.", { details: { forge: await forgeAddress(env) } });
  const tokenId = tokenIdOf(body && body.tokenId), itemKey = String((body && body.itemKey) || "").toLowerCase(), txHash = String((body && body.txHash) || "");
  if (!isHash(txHash)) throw new ApiError(400, "TX_INVALID", "Send the transaction hash of your payment.");
  const item = (await readCatalogue(env)).find((c) => c.key === itemKey);
  if (!item) throw new ApiError(404, "ITEM_UNKNOWN", "That part is not on sale.");
  const price = BigInt(item.priceWei);
  if (price <= 0n) throw new ApiError(400, "ITEM_FREE", item.partId > 0 ? `${item.name} is not for sale — it only drops from crates.` : `${item.name} is free — just put it on the robot.`);
  await requireOwner(env, session.address, tokenId);
  if ((await ownedItems(env, tokenId)).includes(itemKey)) throw new ApiError(409, "ITEM_OWNED", `MotorHead #${tokenId} already owns ${item.name}.`);
  if (item.partId > 0 && (await wonItems(env, tokenId, [item]).catch(() => [])).includes(itemKey)) throw new ApiError(409, "ITEM_OWNED", `MotorHead #${tokenId} already won ${item.name} from a crate.`);
  let activated = false;
  try { activated = await isActivated(env, tokenId); } catch { throw new ApiError(503, "ACTIVATION_CHECK_UNAVAILABLE", "The activation check is temporarily unavailable.", { retryable: true }); }
  if (!activated) throw new ApiError(409, "NOT_ACTIVATED", `Activate MotorHead #${tokenId} first — parts are bought for an activated robot.`);
  const paid = await verifyTreasuryPayment(env, { txHash, from: session.address, minWei: price + (await siteFeeFor(env, session.address)).minWei });   // + the site fee, on the same payment
  const now = Math.floor(Date.now() / 1000), d = db(env);
  try { await d.prepare("INSERT INTO mh_eth_payments (tx_hash, wallet, kind, token_id, ref, value_wei, block_number, created_at) VALUES (?, ?, 'item', ?, ?, ?, ?, ?)")
    .bind(lc(txHash), lc(session.address), tokenId, itemKey, paid.valueWei.toString(), paid.blockNumber, now).run(); }
  catch (e) { if (/UNIQUE|constraint/i.test(String(e && e.message))) throw new ApiError(409, "TX_ALREADY_USED", "That payment has already been used."); throw e; }
  const res = await d.prepare("INSERT INTO mh_foundry_owned (token_id, item_key, wallet, tx_hash, bought_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(token_id, item_key) DO NOTHING")
    .bind(tokenId, itemKey, lc(session.address), lc(txHash), now).run();
  if (res.meta && res.meta.changes === 0) throw new ApiError(409, "ITEM_OWNED", `MotorHead #${tokenId} already owns ${item.name}. Your payment is recorded; contact us.`);
  return { ok: true, bought: true, item: itemKey, ...(await readState(env, tokenId)) };
}

// the /admin panel signs "MotorHeads Admin Access … Time: <iso>" with the treasury wallet (same scheme as /v1/stats and
// share-to-earn); a SIWE session of an admin wallet works too. Returns the admin address, or throws 403.
export async function requireFoundryAdmin(request, env) {
  const wallet = request.headers.get("x-wallet-address"), signature = request.headers.get("x-signature"), b64 = request.headers.get("x-signed-message");
  if (wallet && signature && b64) {
    let message = ""; try { message = atob(b64); } catch { message = ""; }
    const t = Date.parse((/Time:\s*(\S+)/.exec(message) || [])[1] || "");
    if (Number.isFinite(t) && Math.abs(Date.now() - t) <= 10 * 60 * 1000) {
      let who = ""; try { who = lc(await recoverMessageAddress({ message, signature })); } catch { who = ""; }
      if (who && who === lc(wallet) && isAdmin(env, who)) return who;
    }
    throw new ApiError(403, "ADMIN_ONLY", "Only the treasury wallet can do that.");
  }
  const session = await requireSession(request, env);
  if (!isAdmin(env, session.address)) throw new ApiError(403, "ADMIN_ONLY", "Only the treasury wallet can do that.");
  return lc(session.address);
}
async function optionalFoundryAdmin(request, env) { try { return await requireFoundryAdmin(request, env); } catch { return null; } }
async function recentPayments(env) {
  try { const r = await db(env).prepare("SELECT tx_hash, wallet, kind, token_id, ref, value_wei, block_number, created_at FROM mh_eth_payments ORDER BY created_at DESC LIMIT 100").all();
    return (r.results || []).map((x) => ({ txHash: x.tx_hash, wallet: x.wallet, kind: x.kind, token: Number(x.token_id), ref: String(x.ref), valueWei: String(x.value_wei), block: Number(x.block_number), at: Number(x.created_at) })); }
  catch (e) { if (noTable(e)) return []; throw e; }
}

// ADMIN: add / re-price / retire a part. The key is the GLB key of the part (item_<key>.glb on the site).
async function setCatalogue(env, key, body) {
  if (!/^[a-z0-9_]{2,32}$/.test(key)) throw new ApiError(400, "ITEM_INVALID", "Bad part key.");
  const found = (await readCatalogue(env, { all: true })).find((c) => c.key === key), cur = found || { name: key, priceWei: "0", bonus: 0, active: true, sort: 0, partId: 0, kind: "item" };
  const kind = body.kind === undefined ? cur.kind : String(body.kind);
  if (kind !== "item" && !BUILD_KINDS.includes(kind)) throw new ApiError(400, "KIND_INVALID", "kind must be item, head, body, pack or expr.");
  if (found && kind !== cur.kind) throw new ApiError(400, "KIND_LOCKED", "A part's kind cannot change once it exists.");
  if (kind !== "item" && !ROSTER_OF[kind].includes(key)) throw new ApiError(400, "BUILD_UNKNOWN", `"${key}" is not a ${kind} in the roster.`);
  // A CUSTOM BUILD NEEDS A PART NUMBER TOO (founder 2026-09-20: "i want to be able to add custom parts"). Once the forge is
  // live a robot only owns what its garage holds, and the garage holds ScrapParts ids — so a build with no id could be
  // tried on but never bought. A new build is given the next free id automatically.
  const all = await readCatalogue(env, { all: true });
  let partId = body.partId === undefined ? cur.partId : Math.trunc(Number(body.partId));
  if (!found && kind !== "item" && !partId) partId = Math.max(100, ...all.map((c) => c.partId || 0)) + 1;
  if (!Number.isInteger(partId) || partId < 0 || partId > 1000000 || (partId > 0 && partId <= 36)) throw new ApiError(400, "PART_ID_INVALID", "partId must be 0 (not in crates) or a ScrapParts id above 36 (1-36 are the 2D effects and backgrounds).");
  const name = body.name === undefined ? cur.name : String(body.name).trim().slice(0, 40);
  const priceWei = body.priceWei === undefined ? cur.priceWei : String(body.priceWei);
  const bonus = body.bonus === undefined ? cur.bonus : Number(body.bonus), sort = body.sort === undefined ? cur.sort : Math.trunc(Number(body.sort)) || 0;
  const active = body.active === undefined ? cur.active : !!body.active;
  if (!name) throw new ApiError(400, "ITEM_INVALID", "A part needs a name.");
  if (!/^\d{1,20}$/.test(priceWei) || BigInt(priceWei) > 10n ** 19n) throw new ApiError(400, "PRICE_INVALID", "priceWei must be a whole number of wei, at most 10 ETH.");
  if (!Number.isFinite(bonus) || bonus < 0 || bonus > ITEM_BONUS_CAP) throw new ApiError(400, "BONUS_INVALID", `bonus must be between 0 and ${ITEM_BONUS_CAP}.`);
  await db(env).prepare("INSERT INTO mh_foundry_catalogue (item_key, name, price_wei, bonus, active, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(item_key) DO UPDATE SET name = excluded.name, price_wei = excluded.price_wei, bonus = excluded.bonus, active = excluded.active, sort = excluded.sort, updated_at = excluded.updated_at")
    .bind(key, name, priceWei, bonus, active ? 1 : 0, sort, Math.floor(Date.now() / 1000)).run();
  if (kind !== "item" && !found) {
    try { await db(env).prepare("UPDATE mh_foundry_catalogue SET kind = ? WHERE item_key = ?").bind(kind, key).run(); }
    catch (e) { if (noColumn(e)) { await db(env).prepare("DELETE FROM mh_foundry_catalogue WHERE item_key = ?").bind(key).run(); throw new ApiError(503, "BUILDS_UNAVAILABLE", "Custom builds are not enabled on this server yet (migration 0012)."); } throw e; } }
  if (partId !== cur.partId) {
    try { await db(env).prepare("UPDATE mh_foundry_catalogue SET part_id = ? WHERE item_key = ?").bind(partId, key).run(); }
    catch (e) { if (noColumn(e)) throw new ApiError(503, "CRATES_UNAVAILABLE", "Crate part ids are not enabled on this server yet (migration 0010)."); throw e; } }
  return { ok: true, catalogue: await readCatalogue(env, { all: true }) };
}

export const ECONOMY_ROUTE = /^\/v1\/foundry\/(economy|payments|crates|states|catalogue|catalogue\/([a-z0-9_]{1,40})|forge|upgrade|buy|attach333|detach333|state\/(\d+))$/;
export async function foundryEconomyRoute(request, env, match) {
  if (match[2] !== undefined) {   // /catalogue/:key — admin edit
    if (request.method === "OPTIONS") return customizationOptions(request, env, { methods: "PUT,OPTIONS" });
    if (request.method !== "PUT") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use PUT.");
    await requireFoundryAdmin(request, env); let b; try { b = await request.json(); } catch { throw new ApiError(400, "BODY_INVALID", "Send JSON."); }
    return customizationJson(await setCatalogue(env, match[2], b || {}), { request, env, methods: "PUT,OPTIONS" });
  }
  const action = match[1].startsWith("state/") ? "state" : match[1], isRead = action === "economy" || action === "state" || action === "states" || action === "catalogue" || action === "crates";
  if (action === "forge") {
    if (request.method === "OPTIONS") return customizationOptions(request, env, { methods: "GET,PUT,OPTIONS" });
    await requireFoundryAdmin(request, env);
    if (request.method === "PUT") { let b; try { b = await request.json(); } catch { throw new ApiError(400, "BODY_INVALID", "Send JSON."); }
      return customizationJson(await setForge(env, b || {}), { request, env, methods: "GET,PUT,OPTIONS" }); }
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or PUT.");
    return customizationJson({ ok: true, forge: await forgeSetup(env) }, { request, env, methods: "GET,PUT,OPTIONS" });
  }
  if (action === "payments") {
    if (request.method === "OPTIONS") return customizationOptions(request, env, { methods: "GET,OPTIONS" });
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET.");
    await requireFoundryAdmin(request, env);
    return customizationJson({ ok: true, payments: await recentPayments(env) }, { request, env, methods: "GET,OPTIONS" });
  }
  if (request.method === "OPTIONS") return customizationOptions(request, env, isRead ? { cors: "public", methods: "GET,OPTIONS" } : { methods: "POST,OPTIONS" });
  if (isRead) {
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET.");
    if (action === "economy") return customizationJson({ ok: true, currency: "ETH", treasury: TREASURY_WALLET, maxTier: MAX_TIER, minConfirmations: MIN_CONFIRMATIONS,
      tiers: TIER_WEIGHT.map((w, t) => ({ tier: t, weight: w, stepWei: TIER_STEP_WEI[t].toString(), onChain: t === 1 })).slice(1),
      archive333: { contract: ARCHIVE_333_CONTRACT, bonusEach: BONUS_PER_333, max: MAX_333 }, itemBonusCap: ITEM_BONUS_CAP, forge: await forgeAddress(env), siteFee: await (async () => { const f = await siteFee(env); return { usd: f.usd, wei: f.wei.toString(), source: f.source }; })() },
      { request, env, cors: "public", cacheControl: "public, max-age=300" });
    if (action === "states") { const ids = [...new Set(String(new URL(request.url).searchParams.get("tokens") || "").split(",").map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5555))];
      if (!ids.length) throw new ApiError(400, "TOKEN_INVALID", "Send ?tokens=1,2,3."); if (ids.length > MAX_STATES) throw new ApiError(400, "TOO_MANY_TOKENS", `At most ${MAX_STATES} robots per request.`);
      return customizationJson({ ok: true, states: await readStates(env, ids) }, { request, env, cors: "public", cacheControl: "public, max-age=20" }); }
    if (action === "crates") {   // the 3D parts crate, straight from the chain: what it drops (with odds) and how many this wallet holds
      const wallet = String(new URL(request.url).searchParams.get("wallet") || ""), cat = await readCatalogue(env, { all: true });
      let raw = [], chainOk = true;
      try { raw = await readCrates(env, FOUNDRY_CRATE_IDS, /^0x[0-9a-fA-F]{40}$/.test(wallet) ? wallet : null); } catch { chainOk = false; }
      const crates = raw.filter((c) => c.version > 0 && c.partIds.length > 0).map((c) => { const total = c.weights.reduce((s2, w2) => s2 + w2, 0) || 1;
        const loot = c.partIds.map((pid, i) => { const p = cat.find((x) => x.partId === pid); return { partId: pid, key: p ? p.key : null, name: p ? p.name : "Part #" + pid, pct: Math.round((c.weights[i] / total) * 1000) / 10 }; });
        return { crateId: c.crateId, name: loot.length === 1 ? loot[0].name + " crate" : (c.crateId === FOUNDRY_CRATE_ID ? "Parts crate" : "Parts crate #" + c.crateId), balance: c.balance, loot }; });
      const first = crates.find((c) => c.crateId === FOUNDRY_CRATE_ID);   // the fields of the first version of this route, kept for older pages
      return customizationJson({ ok: true, chainOk, crates, crateId: FOUNDRY_CRATE_ID, configured: !!first, balance: first ? first.balance : 0, loot: first ? first.loot : [] },
        { request, env, cors: "public", cacheControl: "public, max-age=15" });
    }
    if (action === "catalogue" && new URL(request.url).searchParams.get("all") === "1" && (await optionalFoundryAdmin(request, env)))
    { const sold = new Map(); try { for (const r of ((await db(env).prepare("SELECT item_key, COUNT(*) AS n FROM mh_foundry_owned GROUP BY item_key").all()).results || [])) sold.set(String(r.item_key), Number(r.n)); } catch (e) { if (!noTable(e)) throw e; }
      return customizationJson({ ok: true, currency: "ETH", bonusCap: ITEM_BONUS_CAP, items: (await readCatalogue(env, { all: true })).map((c) => ({ ...c, sold: sold.get(c.key) || 0 })) }, { request, env, methods: "GET,OPTIONS" }); }
    if (action === "catalogue") return customizationJson({ ok: true, currency: "ETH", treasury: TREASURY_WALLET, bonusCap: ITEM_BONUS_CAP,
      crateId: FOUNDRY_CRATE_ID, items: (await readCatalogue(env)).map((c) => ({ key: c.key, name: c.name, priceWei: c.priceWei, bonus: c.bonus, partId: c.partId, kind: c.kind })) }, { request, env, cors: "public", cacheControl: "public, max-age=60" });
    return customizationJson({ ok: true, ...(await readState(env, tokenIdOf(match[3]))) }, { request, env, cors: "public", cacheControl: "public, max-age=20" });
  }
  if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST.");
  const session = await requireSession(request, env);
  let body; try { body = await request.json(); } catch { throw new ApiError(400, "BODY_INVALID", "Send JSON."); }
  const out = action === "upgrade" ? await upgrade(env, session, body) : action === "buy" ? await buy(env, session, body) : action === "attach333" ? await attach(env, session, body) : await detach(env, session, body);
  return customizationJson(out, { request, env, methods: "POST,OPTIONS" });
}
