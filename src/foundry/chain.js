// ETHEREUM-MAINNET READS for the Foundry record's gates (founder 2026-09-17: "use the same activation and part
// contract" as the 2D garage):
//   ownerOf2D      who owns the 2D MotorHead — the collection the 3D art replaces in place (0x0a50…ceb1)
//   isActivated    ScrapCrates.activated(tokenId) — the ONE-TIME 0.003 ETH garage activation (2D and 3D share it)
//   garageOf       the token's ERC-6551 garage (holds its ScrapParts)
//   garageHasParts ScrapParts.balanceOf(garage, id) for every part id a save requires
// Read-only eth_call through ETH_RPC_URL — or the OWNERSHIP_RPC service binding the test harness mocks. Never a tx.
import { toFunctionSelector, encodeFunctionData, decodeFunctionResult } from "viem";
import { MOTORHEADS_CONTRACT } from "../contracts.js";

export const SCRAP_CRATES = "0x50Dc22553988de047a00328963faEe8EC5E19b12";   // deployments/mainnet.json (2026-08-13)
export const SCRAP_PARTS = "0x3f6ADfe2fA714c28B2c6ec4762D089069675f2a2";
export const SEL = Object.freeze({
  ownerOf: toFunctionSelector("function ownerOf(uint256)"),
  activated: toFunctionSelector("function activated(uint256)"),
  activationFeeWei: toFunctionSelector("function activationFeeWei()"),
  garageOf: toFunctionSelector("function garageOf(uint256)"),
  lootTable: toFunctionSelector("function lootTable(uint256)"),
  balanceOf1155: toFunctionSelector("function balanceOf(address,uint256)"),
});
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");

// any JSON-RPC method through the same transport (ETH_RPC_URL, or the OWNERSHIP_RPC binding the tests mock)
export async function ethRpc(env, method, params = []) {
  const url = String(env.ETH_RPC_URL || "").trim();
  if (!url) throw new Error("ETH_RPC_URL not configured");
  const doFetch = (env.OWNERSHIP_RPC && typeof env.OWNERSHIP_RPC.fetch === "function") ? (r) => env.OWNERSHIP_RPC.fetch(r) : (r) => fetch(r);
  const res = await doFetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) }));
  if (!res.ok) throw new Error("rpc http " + res.status);
  const j = await res.json();
  if (j && j.error) { const e = new Error(j.error.message || "rpc error"); e.rpc = j.error; throw e; }
  return j ? j.result : null;
}
export async function ethCall(env, to, data) {
  const url = String(env.ETH_RPC_URL || "").trim();
  if (!url) throw new Error("ETH_RPC_URL not configured");
  const doFetch = (env.OWNERSHIP_RPC && typeof env.OWNERSHIP_RPC.fetch === "function") ? (r) => env.OWNERSHIP_RPC.fetch(r) : (r) => fetch(r);
  const res = await doFetch(new Request(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(8000),
  }));
  if (!res.ok) throw new Error("rpc http " + res.status);
  const j = await res.json();
  if (j && j.error) { const e = new Error(j.error.message || "rpc error"); e.rpc = j.error; throw e; }
  return String((j && j.result) || "0x");
}
const reverted = (e) => /revert|nonexistent|invalid token|owner query/i.test(String((e && e.message) || ""));

// lower-case owner address, or null when the token does not exist (revert). Other RPC failures throw.
export async function ownerOf2D(env, tokenId) {
  try { const r = await ethCall(env, MOTORHEADS_CONTRACT, SEL.ownerOf + word(tokenId)); return /^0x[0-9a-f]{64}$/i.test(r) ? "0x" + r.slice(-40).toLowerCase() : null; }
  catch (e) { if (reverted(e)) return null; throw e; }
}
// owner of any ERC-721 token (lower-case) or null when it does not exist — used for the 333 Archive
export async function ownerOf721(env, contract, tokenId) {
  try { const r = await ethCall(env, contract, SEL.ownerOf + word(tokenId)); return /^0x[0-9a-f]{64}$/i.test(r) ? "0x" + r.slice(-40).toLowerCase() : null; }
  catch (e) { if (reverted(e)) return null; throw e; }
}
export async function isActivated(env, tokenId) {
  const r = await ethCall(env, SCRAP_CRATES, SEL.activated + word(tokenId));
  return /^0x[0-9a-f]{64}$/i.test(r) && BigInt(r) !== 0n;
}
export async function garageOf(env, tokenId) {
  const r = await ethCall(env, SCRAP_CRATES, SEL.garageOf + word(tokenId));
  return /^0x[0-9a-f]{64}$/i.test(r) ? "0x" + r.slice(-40).toLowerCase() : null;
}
// { garage, missing: [partId, …] } — every id the garage holds none of
export async function garageHasParts(env, tokenId, partIds) {
  const ids = [...new Set(partIds.map(Number).filter((n) => n > 0))];
  if (!ids.length) return { garage: null, missing: [] };
  const garage = await garageOf(env, tokenId);
  if (!garage || /^0x0{40}$/.test(garage)) return { garage, missing: ids };
  const missing = [];
  for (const id of ids) {
    const r = await ethCall(env, SCRAP_PARTS, SEL.balanceOf1155 + addrWord(garage) + word(id));
    if (!/^0x[0-9a-f]{64}$/i.test(r) || BigInt(r) === 0n) missing.push(id);
  }
  return { garage, missing };
}

// ── MANY READS IN ONE eth_call — Multicall3 (the canonical deployment, same address on every chain). A reward-round
// snapshot asks "activated?" for all 5555 robots: 14 calls of 400 instead of 5555.
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MC_ABI = [{ name: "aggregate3", type: "function", stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] }],
  outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] }];
export const SEL_AGGREGATE3 = toFunctionSelector("function aggregate3((address,bool,bytes)[])");
// calls: [{ target, callData }] -> [{ success, returnData }] in the same order. Any RPC failure throws (never a partial answer).
export async function multicall(env, calls, chunk = 400) {
  const out = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const part = calls.slice(i, i + chunk).map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }));
    const ret = await ethCall(env, MULTICALL3, encodeFunctionData({ abi: MC_ABI, functionName: "aggregate3", args: [part] }));
    const dec = decodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", data: ret });
    if (!Array.isArray(dec) || dec.length !== part.length) throw new Error("multicall answer has the wrong length");
    for (const r of dec) out.push({ success: !!r.success, returnData: String(r.returnData || "0x") });
  }
  return out;
}
// Set of the token ids that are activated on ScrapCrates
export async function activatedMany(env, ids) {
  const res = await multicall(env, ids.map((id) => ({ target: SCRAP_CRATES, callData: SEL.activated + word(id) })));
  const on = new Set();
  res.forEach((r, i) => { if (r.success && /^0x[0-9a-f]{64}$/i.test(r.returnData) && BigInt(r.returnData) !== 0n) on.add(ids[i]); });
  return on;
}
// Map tokenId -> lower-case owner (missing = the token does not exist)
// FoundryForge.tierOf(tokenId) for many robots at once. 0 = not activated, 1 = activated, 2..5 = paid steps.
export async function tiersMany(env, forge, ids) {
  const m = new Map(); if (!forge || !ids.length) return m;
  const res = await multicall(env, ids.map((id) => ({ target: forge, callData: "0x53f96df2" + word(id) })));
  res.forEach((r, i) => { if (r.success && /^0x[0-9a-f]{64}$/i.test(r.returnData)) m.set(ids[i], Number(BigInt(r.returnData))); });
  return m;
}

export async function ownersMany(env, ids, contract = MOTORHEADS_CONTRACT) {
  const res = await multicall(env, ids.map((id) => ({ target: contract, callData: SEL.ownerOf + word(id) })));
  assertAnswered(res, "ownerOf");
  const m = new Map();
  res.forEach((r, i) => { if (r.success && /^0x[0-9a-f]{64}$/i.test(r.returnData)) m.set(ids[i], "0x" + r.returnData.slice(-40).toLowerCase()); });
  return m;
}
// Which of these ScrapParts ids does each robot's GARAGE hold? Map tokenId -> Set(partId). Two multicall rounds
// (garageOf for every robot, then balanceOf for robot x part) whatever the number of robots. Any RPC failure throws.
// aggregate3 reports success for a call to an address with no code, so "every sub-call came back empty" is indistinguishable
// from "nothing is held" unless we say so. Reward rounds pay real ETH off these, so refuse rather than answer zero.
function assertAnswered(res, what) {
  if (!res.length) return;
  if (!res.some((r) => r.success && /^0x[0-9a-f]{64,}$/i.test(r.returnData || ""))) throw new Error(what + ": every call came back empty — the RPC is not answering properly");
}

export async function partsHeldMany(env, tokenIds, partIds) {
  const out = new Map(tokenIds.map((id) => [id, new Set()])); const pids = [...new Set(partIds.map(Number).filter((n) => n > 0))];
  if (!tokenIds.length || !pids.length) return out;
  const g = await multicall(env, tokenIds.map((id) => ({ target: SCRAP_CRATES, callData: SEL.garageOf + word(id) })));
  assertAnswered(g, "garageOf");
  const pairs = [];
  g.forEach((r, i) => { if (!r.success || !/^0x[0-9a-f]{64}$/i.test(r.returnData)) return; const garage = "0x" + r.returnData.slice(-40); if (/^0x0{40}$/.test(garage)) return; for (const pid of pids) pairs.push({ id: tokenIds[i], pid, garage }); });
  if (!pairs.length) return out;
  const b = await multicall(env, pairs.map((p) => ({ target: SCRAP_PARTS, callData: SEL.balanceOf1155 + addrWord(p.garage) + word(p.pid) })));
  assertAnswered(b, "balanceOf");
  b.forEach((r, i) => { if (r.success && /^0x[0-9a-f]{64}$/i.test(r.returnData) && BigInt(r.returnData) > 0n) out.get(pairs[i].id).add(pairs[i].pid); });
  return out;
}
// a wallet's balance of one crate id (crates are ERC-1155 tokens of ScrapCrates itself, held by the WALLET)
export async function crateBalance(env, wallet, crateId) {
  const r = await ethCall(env, SCRAP_CRATES, SEL.balanceOf1155 + addrWord(wallet) + word(crateId));
  return /^0x[0-9a-f]{64}$/i.test(r) ? Number(BigInt(r)) : 0;
}
// ScrapCrates.lootTable(crateId) -> { version, partIds:[…], weights:[…] } (the contract stores cumulative weights)
function decodeLoot(ret) {
  const hex = String(ret || "0x").slice(2), w = (i) => hex.slice(i * 64, (i + 1) * 64), n = (i) => (w(i) ? BigInt("0x" + w(i)) : 0n);
  if (hex.length < 64 * 4) return { version: 0, partIds: [], weights: [] };
  const arr = (o) => { const len = Number(n(o)), a = []; for (let i = 0; i < Math.min(len, 256); i++) a.push(n(o + 1 + i)); return a; };
  const partIds = arr(Number(n(1)) / 32).map(Number), cum = arr(Number(n(2)) / 32);
  return { version: Number(n(0)), partIds, weights: cum.map((c, i) => Number(c - (i ? cum[i - 1] : 0n))) };
}
export async function readLootTable(env, crateId) { return decodeLoot(await ethCall(env, SCRAP_CRATES, SEL.lootTable + word(crateId))); }
// SEVERAL CRATES AT ONCE (one multicall): every crate id's loot table and, for a wallet, how many of each it holds.
// -> [{ crateId, version, partIds, weights, balance }]
export async function readCrates(env, crateIds, wallet) {
  const calls = crateIds.map((id) => ({ target: SCRAP_CRATES, callData: SEL.lootTable + word(id) }));
  if (wallet) for (const id of crateIds) calls.push({ target: SCRAP_CRATES, callData: SEL.balanceOf1155 + addrWord(wallet) + word(id) });
  const res = await multicall(env, calls), n = crateIds.length;
  return crateIds.map((id, i) => { const loot = res[i].success ? decodeLoot(res[i].returnData) : { version: 0, partIds: [], weights: [] }, b = wallet ? res[n + i] : null;
    return { crateId: id, ...loot, balance: b && b.success && /^0x[0-9a-f]{64}$/i.test(b.returnData) ? Number(BigInt(b.returnData)) : 0 }; });
}
