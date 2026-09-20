// REWARD ROUNDS — ETH, split by weight, paid by the ON-CHAIN POOL (founder 2026-09-19: "a pool where I can manually transfer
// eth there but also I can withdraw back to my wallet, and people can depending on their tier claim rewards").
// The pool is the FoundryRewardPool contract (contracts repo): the founder funds it with a plain transfer, may withdraw
// whatever no open round has reserved, and closes a round to free what was not claimed. A ROUND = a snapshot of every
// activated robot's weight + a pot, committed on chain as a Merkle root over (roundId, tokenId, amount). This backend
// takes the snapshot, computes the amounts, builds the tree and hands out the proofs; the MONEY and the claimed flags
// are the contract's. Whoever owns a robot when it is claimed receives its share (an unclaimed share travels with the NFT).
//
//   GET  /v1/foundry/pool                          public -> the pool: address, balance, reserved, available, round count
//   PUT  /v1/foundry/pool                          admin  { address }  checked on chain: a pool for THIS collection, owned by the treasury
//   GET  /v1/foundry/rounds                        public -> the rounds (pot, robots, total weight, claimed so far, open?)
//   GET  /v1/foundry/rewards?tokens=1,7,20         public -> those robots' shares: amount + state READ FROM THE CONTRACT
//   GET  /v1/foundry/claimcall?round=1&tokens=7,8  public -> { to, data, amountWei }: the claim transaction, ready to send
//   POST /v1/foundry/rounds/preview                admin  -> what a snapshot taken now would be
//   POST /v1/foundry/rounds                        admin  { potWei, note? } -> a DRAFT round + the openRound transaction to send
//   POST /v1/foundry/rounds/:id/confirm            admin  -> the contract really holds that root and total: draft -> open
//   POST /v1/foundry/rounds/:id/discard            admin  -> forget a draft that was never opened on chain
import { ApiError, customizationJson, customizationOptions } from "../customization/http.js";
import { MOTORHEADS_CONTRACT } from "../contracts.js";
import { keccak256, encodeAbiParameters, encodeFunctionData, decodeFunctionResult, concat } from "viem";
import { activatedMany, partsHeldMany, ethRpc, multicall, tiersMany } from "./chain.js";
import { weightOf, readCatalogue, itemBonusOf, requireFoundryAdmin, isAdmin, liveAttachments, forgeAddress, forgeSetup } from "./economy.js";

const SUPPLY = 5555, WX = 10000, MAX_POT_WEI = 10n ** 20n, MAX_CLAIM_IDS = 600;   // a whale claims in one go; D1 binds <= 100 parameters, so reads are chunked   // weights are stored x10000; a pot is at most 100 ETH
const lc = (a) => String(a || "").toLowerCase();
const noTable = (e) => /no such table/i.test(String((e && e.message) || ""));
function db(env) { if (!env.DB || typeof env.DB.prepare !== "function") throw new ApiError(503, "STORAGE_UNAVAILABLE", "Storage is not available."); return env.DB; }
const all = async (env, sql, ...bind) => ((await db(env).prepare(sql).bind(...bind).all()).results || []);
const optional = async (p) => { try { return await p; } catch (e) { if (noTable(e)) return []; throw e; } };

// every activated robot and its weight, right now: [{ tokenId, tier, attached, itemBonus, weightX }]
export async function takeSnapshot(env) {
  const ids = Array.from({ length: SUPPLY }, (_, i) => i + 1);
  let active;
  try { active = await activatedMany(env, ids); }
  catch { throw new ApiError(503, "ACTIVATION_CHECK_UNAVAILABLE", "Ethereum is not answering right now — no snapshot was taken.", { retryable: true }); }
  const tiers = new Map((await optional(all(env, "SELECT token_id, tier FROM mh_foundry_tiers"))).map((r) => [Number(r.token_id), Number(r.tier)]));
  { const forge = await forgeAddress(env);   // a round pays on the CHAIN's tiers once the forge is live
    if (forge) { let m; try { m = await tiersMany(env, forge, ids.filter((id) => active.has(id))); }
      catch { throw new ApiError(503, "TIER_CHECK_UNAVAILABLE", "Ethereum is not answering right now — no snapshot was taken.", { retryable: true }); }
      for (const [id, t] of m) tiers.set(id, t); } }
  // a 333 counts only while its holder also owns the robot — verified on Ethereum, never taken from the row (see economy.js)
  let att; try { att = await liveAttachments(env, { fresh: true }); }
  catch { throw new ApiError(503, "ARCHIVE_CHECK_UNAVAILABLE", "Ethereum is not answering right now — no snapshot was taken.", { retryable: true }); }
  const owned = new Map(); for (const r of await optional(all(env, "SELECT token_id, item_key FROM mh_foundry_owned"))) { const k = Number(r.token_id); if (!owned.has(k)) owned.set(k, []); owned.get(k).push(String(r.item_key)); }
  { const live = await forgeAddress(env), cat0 = await readCatalogue(env, { all: true });   // a moved part must not pay twice
    if (live) for (const [k, ks] of owned) owned.set(k, ks.filter((x) => { const c = cat0.find((y) => y.key === x); return !c || !c.partId; })); }
  const cat = await readCatalogue(env, { all: true }), mapped = cat.filter((c) => c.partId > 0), activeIds = ids.filter((id) => active.has(id));
  // parts WON from crates live in the robot's garage on Ethereum: they count exactly like bought ones
  if (mapped.length && activeIds.length) { let held;
    try { held = await partsHeldMany(env, activeIds, mapped.map((c) => c.partId)); }
    catch { throw new ApiError(503, "PARTS_CHECK_UNAVAILABLE", "Ethereum is not answering right now — no snapshot was taken.", { retryable: true }); }
    for (const [id, set] of held) { if (!set.size) continue; const keys = mapped.filter((c) => set.has(c.partId)).map((c) => c.key); owned.set(id, [...new Set([...(owned.get(id) || []), ...keys])]); } }
  const rows = [];
  for (const id of ids) { if (!active.has(id)) continue;
    const tier = Math.max(1, tiers.get(id) || 1), attached = att.get(id) || 0, itemBonus = owned.has(id) ? itemBonusOf(cat, owned.get(id)) : 0;
    rows.push({ tokenId: id, tier, attached, itemBonus, weightX: Math.round(weightOf(tier, attached, itemBonus) * WX) }); }
  return { rows, totalX: rows.reduce((s, r) => s + r.weightX, 0) };
}

// ── MERKLE TREE, byte-compatible with OpenZeppelin's StandardMerkleTree over ["uint256","uint256","uint256"] ──
// leaf = keccak256(keccak256(abi.encode(roundId, tokenId, amount))); leaves sorted by hash; node = keccak256(sorted pair).
const LEAF_TYPES = [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }];
const leafHash = (row) => keccak256(keccak256(encodeAbiParameters(LEAF_TYPES, row.map((v) => BigInt(v)))));
const pairHash = (a, b) => keccak256(BigInt(a) < BigInt(b) ? concat([a, b]) : concat([b, a]));
export function buildTree(rows) {
  if (!rows.length) throw new Error("empty tree");
  const leaves = rows.map((row, i) => ({ i, h: leafHash(row) })).sort((x, y) => (BigInt(x.h) < BigInt(y.h) ? -1 : 1));
  const n = leaves.length, tree = new Array(2 * n - 1), at = new Array(n);
  leaves.forEach((l, k) => { const t = tree.length - 1 - k; tree[t] = l.h; at[l.i] = t; });
  for (let t = tree.length - 1 - n; t >= 0; t--) tree[t] = pairHash(tree[2 * t + 1], tree[2 * t + 2]);
  return { root: tree[0], proof: (i) => { const p = []; for (let t = at[i]; t > 0; t = Math.floor((t - 1) / 2)) p.push(tree[t % 2 ? t + 1 : t - 1]); return p; } };
}

// ── THE POOL CONTRACT ──
const POOL_ABI = [
  { name: "openRound", type: "function", stateMutability: "nonpayable", inputs: [{ name: "root", type: "bytes32" }, { name: "total", type: "uint256" }, { name: "expectedRoundId", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { name: "claim", type: "function", stateMutability: "nonpayable", inputs: [{ name: "roundId", type: "uint256" }, { name: "tokenIds", type: "uint256[]" }, { name: "amounts", type: "uint256[]" }, { name: "proofs", type: "bytes32[][]" }], outputs: [] },
  { name: "roundInfo", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ name: "root", type: "bytes32" }, { name: "total", type: "uint256" }, { name: "claimed", type: "uint256" }, { name: "open", type: "bool" }] },
  { name: "isClaimed", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "roundCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "reserved", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "robots", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
export const poolCall = (functionName, args = []) => encodeFunctionData({ abi: POOL_ABI, functionName, args });
const enc = poolCall;
const dec = (functionName, data) => decodeFunctionResult({ abi: POOL_ABI, functionName, data });
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));

export async function poolAddress(env) {
  try { const r = await db(env).prepare("SELECT value FROM mh_foundry_settings WHERE key = 'reward_pool'").first(); return r && isAddr(r.value) ? String(r.value) : null; }
  catch (e) { if (noTable(e)) return null; throw e; }
}
// everything the page shows about the pool, in one multicall + the ETH balance
async function poolState(env, pool) {
  const [res, bal] = await Promise.all([multicall(env, ["roundCount", "reserved", "owner", "robots"].map((f) => ({ target: pool, callData: enc(f) }))), ethRpc(env, "eth_getBalance", [pool, "latest"])]);
  if (!res.every((r) => r.success && r.returnData.length >= 66)) throw new Error("not a reward pool");
  const balance = BigInt(bal || "0x0"), reserved = BigInt(dec("reserved", res[1].returnData));
  return { address: pool, balanceWei: balance.toString(), reservedWei: reserved.toString(), availableWei: (balance - reserved).toString(), roundCount: Number(dec("roundCount", res[0].returnData)), owner: lc(dec("owner", res[2].returnData)), robots: lc(dec("robots", res[3].returnData)) };
}
async function setPool(env, body) {
  const address = String((body && body.address) || ""); if (!isAddr(address)) throw new ApiError(400, "POOL_INVALID", "Send the pool contract address.");
  let st; try { st = await poolState(env, address); } catch { throw new ApiError(400, "POOL_INVALID", "That address does not answer like a FoundryRewardPool on Ethereum."); }
  if (st.robots !== lc(MOTORHEADS_CONTRACT)) throw new ApiError(400, "POOL_WRONG_COLLECTION", "That pool pays the owners of a different collection.");
  if (!isAdmin(env, st.owner)) throw new ApiError(400, "POOL_WRONG_OWNER", "That pool is not owned by the treasury wallet.");
  await db(env).prepare("INSERT INTO mh_foundry_settings (key, value, updated_at) VALUES ('reward_pool', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(address, Math.floor(Date.now() / 1000)).run();
  return { ok: true, pool: st };
}
// on-chain facts of several rounds: Map onchainId -> { root, total, claimed, open }
async function chainRounds(env, pool, ids) { const m = new Map(); if (!pool || !ids.length) return m;
  const res = await multicall(env, ids.map((id) => ({ target: pool, callData: enc("roundInfo", [BigInt(id)]) })));
  res.forEach((r, i) => { if (!r.success) return; const d = dec("roundInfo", r.returnData); m.set(ids[i], { root: String(d[0]).toLowerCase(), total: BigInt(d[1]), claimed: BigInt(d[2]), open: !!d[3] }); }); return m; }

const roundRow = (r, c) => ({ id: Number(r.id), onchainId: Number(r.onchain_id), pool: r.pool || null, root: r.root || null, potWei: String(r.pot_wei), totalWeight: Number(r.total_weight_x) / WX, robots: Number(r.robots), note: String(r.note || ""), createdAt: Number(r.created_at),
  status: r.status === "draft" ? "draft" : (c ? (c.open ? "open" : "closed") : String(r.status)), claimedWei: c ? c.claimed.toString() : "0", chainOk: r.status === "draft" || !!c });
async function listRounds(env, { drafts = false } = {}) {
  const rows = (await optional(all(env, "SELECT * FROM mh_reward_rounds ORDER BY id DESC LIMIT 50"))).filter((r) => Number(r.onchain_id) > 0 && (drafts || r.status !== "draft")); if (!rows.length) return [];
  const withPool = rows.find((r) => r.pool), pool = withPool ? withPool.pool : null; let chain = new Map();
  try { chain = await chainRounds(env, pool, rows.filter((r) => r.status !== "draft" && r.pool === pool).map((r) => Number(r.onchain_id))); } catch { /* rows come back with chainOk:false */ }
  return rows.map((r) => roundRow(r, r.status === "draft" ? null : chain.get(Number(r.onchain_id))));
}
function parseIds(raw, max) { const ids = [...new Set((Array.isArray(raw) ? raw : String(raw || "").split(",")).map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= SUPPLY))]; if (ids.length > max) throw new ApiError(400, "TOO_MANY_TOKENS", `At most ${max} robots per request.`); return ids; }
async function shareRows(env, ids, onchainRound = 0) { const out = [];
  for (let i = 0; i < ids.length; i += 90) { const part = ids.slice(i, i + 90);
    out.push(...(await optional(all(env, `SELECT s.round_id, s.token_id, s.weight_x, s.amount_wei, s.proof, r.onchain_id, r.pool, r.status AS round_status FROM mh_reward_shares s JOIN mh_reward_rounds r ON r.id = s.round_id WHERE r.status != 'draft' AND r.onchain_id > 0 ${onchainRound ? "AND r.onchain_id = " + Number(onchainRound) : ""} AND s.token_id IN (${part.map(() => "?").join(",")})`, ...part)))); }
  return out.sort((a, b) => Number(b.onchain_id) - Number(a.onchain_id) || Number(a.token_id) - Number(b.token_id)); }
// the wallet's view: every share of those robots, with its state READ FROM THE CONTRACT (claimed flag + whether the round is still open)
async function rewardsOf(env, ids) {
  const rows = await shareRows(env, ids); if (!rows.length) return { shares: [], pool: await poolAddress(env), chainOk: true };
  const pool = rows[0].pool, mine = rows.filter((x) => x.pool === pool), rounds = [...new Set(mine.map((x) => Number(x.onchain_id)))]; let info = new Map(), flags = [], chainOk = true;
  try { info = await chainRounds(env, pool, rounds); flags = await multicall(env, mine.map((x) => ({ target: pool, callData: enc("isClaimed", [BigInt(x.onchain_id), BigInt(x.token_id)]) }))); } catch { chainOk = false; }
  return { pool, chainOk, shares: mine.map((x, i) => { const c = info.get(Number(x.onchain_id)), claimed = !!(flags[i] && flags[i].success && dec("isClaimed", flags[i].returnData));
    return { round: Number(x.onchain_id), token: Number(x.token_id), weight: Number(x.weight_x) / WX, amountWei: String(x.amount_wei), status: !chainOk ? "unknown" : claimed ? "paid" : (c && c.open ? "claimable" : "expired") }; }) };
}
// the claim transaction for some robots of ONE round. Public: the contract itself refuses anyone who does not own the robots.
async function claimCall(env, url) {
  const round = parseInt(url.searchParams.get("round"), 10), ids = parseIds(url.searchParams.get("tokens"), 200);
  if (!(round > 0) || !ids.length) throw new ApiError(400, "CLAIM_INVALID", "Send ?round=<id>&tokens=1,2,3.");
  const rows = (await shareRows(env, ids, round)).filter((x) => x.proof); if (!rows.length) throw new ApiError(404, "NOTHING_TO_CLAIM", "Those robots have no share in that round.");
  const data = enc("claim", [BigInt(round), rows.map((x) => BigInt(x.token_id)), rows.map((x) => BigInt(x.amount_wei)), rows.map((x) => JSON.parse(x.proof))]);
  return { ok: true, to: rows[0].pool, data, round, tokens: rows.map((x) => Number(x.token_id)), amountWei: rows.reduce((s2, x) => s2 + BigInt(x.amount_wei), 0n).toString() };
}

// A DRAFT ROUND: snapshot -> amounts -> tree. Nothing is on chain yet: the answer carries the openRound transaction for the
// founder's wallet; `confirm` turns the draft into a round only once the contract really holds that root and that total.
async function draftRound(env, admin, body) {
  const potWei = String((body && body.potWei) || ""), note = String((body && body.note) || "").trim().slice(0, 140);
  if (!/^\d{1,21}$/.test(potWei) || BigInt(potWei) <= 0n || BigInt(potWei) > MAX_POT_WEI) throw new ApiError(400, "POT_INVALID", "potWei must be a whole number of wei, more than 0 and at most 100 ETH.");
  const pool = await poolAddress(env); if (!pool) throw new ApiError(409, "POOL_NOT_SET", "Deploy the reward pool and save its address first.");
  let st; try { st = await poolState(env, pool); } catch { throw new ApiError(503, "POOL_UNAVAILABLE", "The pool contract is not answering right now.", { retryable: true }); }
  if (BigInt(st.availableWei) < BigInt(potWei)) throw new ApiError(409, "POOL_NOT_FUNDED", `The pool has ${st.availableWei} wei free — send it the ETH for this round first.`);
  // A round must never be drafted while the chain is still behind the records: between registering a forge and finishing
  // the carry-over, tierOf() answers 1 for every unseeded robot, so a tier-5 holder would be paid as 1x (founder's audit).
  { let fs = null; try { fs = await forgeSetup(env); } catch { fs = null; }
    if (fs && fs.deployed && ((fs.seedable || []).length || (fs.legacy || []).length))
      throw new ApiError(409, "FORGE_NOT_SEEDED", `The forge is missing ${(fs.seedable || []).length} tier${(fs.seedable || []).length === 1 ? "" : "s"} and ${(fs.legacy || []).length} part${(fs.legacy || []).length === 1 ? "" : "s"} that holders already paid for. Finish the checklist in Prices before opening a round, or they would be paid short.`); }
  const snap = await takeSnapshot(env);
  if (!snap.rows.length || snap.totalX <= 0) throw new ApiError(409, "NO_ACTIVE_ROBOTS", "No activated robot — there is nobody to split a pot between.");
  const pot = BigInt(potWei), totalX = BigInt(snap.totalX), onchainId = st.roundCount + 1, now = Math.floor(Date.now() / 1000), d = db(env);
  const shares = snap.rows.map((r) => ({ ...r, amount: (pot * BigInt(r.weightX)) / totalX })).filter((r) => r.amount > 0n);   // floored: the dust never enters the round
  const total = shares.reduce((s2, r) => s2 + r.amount, 0n), tree = buildTree(shares.map((r) => [onchainId, r.tokenId, r.amount]));
  for (const old of await all(env, "SELECT id FROM mh_reward_rounds WHERE status = 'draft'")) { await d.prepare("DELETE FROM mh_reward_shares WHERE round_id = ?").bind(old.id).run(); await d.prepare("DELETE FROM mh_reward_rounds WHERE id = ?").bind(old.id).run(); }
  const ins = await d.prepare("INSERT INTO mh_reward_rounds (pot_wei, total_weight_x, robots, note, status, created_by, created_at, onchain_id, root, pool) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)")
    .bind(total.toString(), snap.totalX, shares.length, note, admin, now, onchainId, tree.root, pool).run();
  const id = Number(ins.meta && ins.meta.last_row_id); if (!id) throw new ApiError(500, "ROUND_FAILED", "The round could not be created.");
  try { for (let i = 0; i < shares.length; i += 40) await d.batch(shares.slice(i, i + 40).map((r, k) =>
      d.prepare("INSERT INTO mh_reward_shares (round_id, token_id, weight_x, amount_wei, proof) VALUES (?, ?, ?, ?, ?)").bind(id, r.tokenId, r.weightX, r.amount.toString(), JSON.stringify(tree.proof(i + k))))); }
  catch (e) { await d.prepare("DELETE FROM mh_reward_shares WHERE round_id = ?").bind(id).run(); await d.prepare("DELETE FROM mh_reward_rounds WHERE id = ?").bind(id).run(); throw e; }
  return { ok: true, round: { id, onchainId, status: "draft", root: tree.root, potWei: total.toString(), robots: shares.length, totalWeight: snap.totalX / WX, note }, call: { to: pool, data: enc("openRound", [tree.root, total, BigInt(onchainId)]) } };
}
async function confirmRound(env, id) {
  const r = await db(env).prepare("SELECT * FROM mh_reward_rounds WHERE id = ?").bind(id).first(); if (!r) throw new ApiError(404, "ROUND_UNKNOWN", "No such round.");
  if (r.status !== "draft") return { ok: true, confirmed: false, rounds: await listRounds(env, { drafts: true }) };
  let c; try { c = (await chainRounds(env, r.pool, [Number(r.onchain_id)])).get(Number(r.onchain_id)); } catch { throw new ApiError(503, "POOL_UNAVAILABLE", "The pool contract is not answering right now.", { retryable: true }); }
  if (!c) throw new ApiError(409, "ROUND_NOT_ON_CHAIN", "The pool has no round with that id yet — send the openRound transaction, wait for it to be mined, then confirm.", { retryable: true });
  if (c.root !== lc(r.root) || c.total !== BigInt(r.pot_wei)) throw new ApiError(409, "ROUND_MISMATCH", "The round on chain has a different root or total than this draft. Discard the draft.");
  await db(env).prepare("UPDATE mh_reward_rounds SET status = 'open' WHERE id = ? AND status = 'draft'").bind(id).run();
  return { ok: true, confirmed: true, rounds: await listRounds(env, { drafts: true }) };
}

export const ROUNDS_ROUTE = /^\/v1\/foundry\/(pool|rounds|rounds\/preview|rounds\/(\d+)\/(confirm|discard)|rewards|claimcall)$/;
export async function foundryRoundsRoute(request, env, match) {
  const action = match[3] || match[1], url = new URL(request.url), M = request.method;
  const publicGet = M === "GET" && (action === "rounds" || action === "rewards" || action === "claimcall" || action === "pool");
  if (M === "OPTIONS") return customizationOptions(request, env, action === "rewards" || action === "claimcall" ? { cors: "public", methods: "GET,OPTIONS" } : { methods: "GET,POST,PUT,OPTIONS" });
  if (publicGet) {
    if (action === "pool") { const pool = await poolAddress(env); let st = null, chainOk = true; if (pool) { try { st = await poolState(env, pool); } catch { chainOk = false; } }
      return customizationJson({ ok: true, currency: "ETH", pool: st || (pool ? { address: pool } : null), chainOk }, { request, env, cors: "public", cacheControl: "public, max-age=15" }); }
    if (action === "rounds") { const drafts = url.searchParams.get("drafts") === "1" && !!(await requireFoundryAdmin(request, env).catch(() => null));
      return customizationJson({ ok: true, currency: "ETH", pool: await poolAddress(env), rounds: await listRounds(env, { drafts }) }, drafts ? { request, env, methods: "GET,OPTIONS" } : { request, env, cors: "public", cacheControl: "public, max-age=20" }); }
    if (action === "rewards") return customizationJson({ ok: true, ...(await rewardsOf(env, parseIds(url.searchParams.get("tokens"), MAX_CLAIM_IDS))) }, { request, env, cors: "public", cacheControl: "public, max-age=10" });
    return customizationJson(await claimCall(env, url), { request, env, cors: "public", cacheControl: "no-store" });
  }
  // everything below is the treasury's
  const admin = await requireFoundryAdmin(request, env), roundId = match[2] ? parseInt(match[2], 10) : 0;
  let body = {}; try { body = (await request.json()) || {}; } catch { body = {}; }
  let out;
  if (action === "pool" && M === "PUT") out = await setPool(env, body);
  else if (M !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST.");
  else if (action === "rounds/preview") { const s = await takeSnapshot(env); out = { ok: true, robots: s.rows.length, totalWeight: s.totalX / WX, top: s.rows.slice().sort((a, b) => b.weightX - a.weightX).slice(0, 10).map((r) => ({ token: r.tokenId, tier: r.tier, attached333: r.attached, itemBonus: r.itemBonus, weight: r.weightX / WX })) }; }
  else if (action === "rounds") out = await draftRound(env, admin, body);
  else if (action === "confirm") out = await confirmRound(env, roundId);
  else if (action === "discard") { const d = db(env), r = await d.prepare("SELECT status FROM mh_reward_rounds WHERE id = ?").bind(roundId).first(); if (!r || r.status !== "draft") throw new ApiError(404, "NOT_A_DRAFT", "Only a draft can be discarded.");
    await d.prepare("DELETE FROM mh_reward_shares WHERE round_id = ?").bind(roundId).run(); await d.prepare("DELETE FROM mh_reward_rounds WHERE id = ?").bind(roundId).run(); out = { ok: true, discarded: true }; }
  else throw new ApiError(404, "NOT_FOUND", "Unknown rounds action.");
  return customizationJson(out, { request, env, methods: "GET,POST,PUT,OPTIONS" });
}
