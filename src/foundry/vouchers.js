// ForgeBridge voucher signer — the AUTOMATED backend half of the cross-chain burn/attach.
//
// The user just logs in (SIWE → session.address) and burns a 2D / holds a 333 on Ethereum. This module WATCHES
// Ethereum for that exact wallet — no one tells us anything — and signs the EIP-712 voucher the website then
// redeems on Robinhood. It also reads the ForgeBridge on Robinhood so it never signs an already-used burn/333.
//
// Config (env): FOUNDRY_SIGNER_KEY (secret, matches the contract's signer), FORGE_BRIDGE_ADDRESS,
//   ETH_RPC_URL (Ethereum, already set for ownership), ROBINHOOD_RPC (defaults to the public mainnet RPC).
import { privateKeyToAccount } from "viem/accounts";

const TWOD = "0x0a5008550fc1402bb567a3ba38d9433e6199ceb1";        // 2D MotorHeads (Ethereum)
const ARCHIVE333 = "0x5eb82c9b5ced4c98982633976941d2cc23f4f9b9";   // 333 Archive (Ethereum)
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const ROBINHOOD_RPC_DEFAULT = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;
// cumulative 2D-burns to REACH each tier (Forge economy: 5 / 15 / 30 / 70 / 100)
const BURN_REQUIRED = [0, 5, 15, 30, 70, 100];

function bridgeDomain(env) {
  const verifyingContract = String(env.FORGE_BRIDGE_ADDRESS || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(verifyingContract)) throw new Error("FORGE_BRIDGE_ADDRESS not configured");
  return { name: "MHForgeBridge", version: "1", chainId: CHAIN_ID, verifyingContract };
}
function account(env) {
  const key = String(env.FOUNDRY_SIGNER_KEY || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("FOUNDRY_SIGNER_KEY not configured");
  return privateKeyToAccount(key);
}
function randNonce() { const b = new Uint8Array(32); crypto.getRandomValues(b); return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
const pad32 = (hexAddrOrNum) => "0x" + BigInt(hexAddrOrNum).toString(16).padStart(64, "0");

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`rpc ${method} ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}
// Retry a read with exponential backoff — the public Robinhood RPC RATE-LIMITS the Worker (HTTP 429), and a
// dropped ownerOf/tierOf would silently hide a robot the wallet really owns. Extra patience on 429. Read-only, safe.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpcRead(url, method, params, tries = 5) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await rpc(url, method, params); }
    catch (e) {
      err = e;
      if (i >= tries - 1) break;
      const is429 = /\b429\b/.test(String(e?.message || ""));
      await sleep(Math.min(1200, (is429 ? 300 : 150) * Math.pow(1.6, i))); // capped so the scan can't hang the request
    }
  }
  throw err;
}
function ethBase(env) { const u = String(env.ETH_RPC_URL || "").trim(); if (!u) throw new Error("ETH_RPC_URL not set"); return u; }
function rhBase(env) { return String(env.ROBINHOOD_RPC || ROBINHOOD_RPC_DEFAULT); }

// which 2D tokenIds did this wallet send to the burn address (Alchemy asset-transfers → tokenIds)
async function burnedTokenIds(env, wallet) {
  const base = ethBase(env);
  const res = await rpc(base, "alchemy_getAssetTransfers", [{
    fromAddress: wallet, toAddress: BURN_ADDRESS, contractAddresses: [TWOD],
    category: ["erc721"], withMetadata: false, excludeZeroValue: false, maxCount: "0x3e8", order: "desc"
  }]);
  const out = [];
  for (const t of (res?.transfers || [])) {
    const id = t?.erc721TokenId || t?.tokenId;
    if (id != null) out.push(BigInt(id));
  }
  return [...new Set(out.map(String))].map(BigInt);
}
// ForgeBridge.burnConsumed(uint256) → bool  (selector 0x…); read on Robinhood so we never sign a spent burn
async function burnConsumed(env, id) {
  const sel = "0x" + (await keccakSel("burnConsumed(uint256)"));
  const data = sel + BigInt(id).toString(16).padStart(64, "0");
  const r = await rpc(rhBase(env), "eth_call", [{ to: env.FORGE_BRIDGE_ADDRESS, data }, "latest"]);
  return BigInt(r || "0x0") !== 0n;
}
async function archiveBoundTo(env, id) {
  const sel = "0x" + (await keccakSel("archiveBoundTo(uint256)"));
  const data = sel + BigInt(id).toString(16).padStart(64, "0");
  const r = await rpc(rhBase(env), "eth_call", [{ to: env.FORGE_BRIDGE_ADDRESS, data }, "latest"]);
  return BigInt(r || "0x0");
}
async function currentTier(env, robotId) {
  // WeightRegistry.tierOf(uint256) via the bridge's reg — but simplest: read tierOf on the registry if configured.
  // Fall back to 0 (fresh) if the registry read isn't wired; the on-chain redeem still enforces toTier > current.
  try {
    if (!env.FOUNDRY_REG_ADDRESS) return 0;
    const sel = "0x" + (await keccakSel("tierOf(uint256)"));
    const data = sel + BigInt(robotId).toString(16).padStart(64, "0");
    const r = await rpc(rhBase(env), "eth_call", [{ to: env.FOUNDRY_REG_ADDRESS, data }, "latest"]);
    return Number(BigInt(r || "0x0"));
  } catch { return 0; }
}

// 4-byte selector via WebCrypto keccak — Workers lack keccak natively, so use the viem util
import { toFunctionSelector } from "viem";
async function keccakSel(sig) { return toFunctionSelector("function " + sig).slice(2); }

// ── D1 cache of a wallet's robots (last KNOWN-GOOD roster) ──────────────────────────────────────────
// The public Robinhood RPC rate-limits the Worker (HTTP 429) and randomly drops reads, so a live scan can come
// back short or empty even when the wallet owns robots. That cache is what makes a transient 429 unable to wipe
// someone's roster: an incomplete scan is merged over the last good result instead of replacing it.
async function loadRobotsCache(env, w) {
  try { const row = await env.DB.prepare("SELECT robots FROM foundry_robots_cache WHERE wallet = ?").bind(w).first();
    if (row && row.robots) { const r = JSON.parse(row.robots); if (Array.isArray(r)) return r; } } catch { /* no DB / bad row */ }
  return null;
}
async function saveRobotsCache(env, w, robots) {
  try { await env.DB.prepare(
      "INSERT INTO foundry_robots_cache (wallet, robots, updated_at) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT(wallet) DO UPDATE SET robots = ?2, updated_at = ?3"
    ).bind(w, JSON.stringify(robots), Date.now()).run();
  } catch { /* best-effort */ }
}
function unionRobots(fresh, cached) {
  const m = new Map();
  for (const r of (cached || [])) m.set(r.tokenId, r);
  for (const r of (fresh || [])) m.set(r.tokenId, r); // fresh tier wins
  return [...m.values()].sort((a, b) => a.tokenId - b.tokenId);
}

// ── the robots this wallet ACTUALLY owns on Robinhood (so the app shows real robots, not demo ones) ──
// Scan ownerOf(1..totalSupply) with retries (NOT eth_getLogs — the public RPC returns it unreliably). Every
// per-token read that fails after retries marks the scan INCOMPLETE, so we know not to trust an empty/short
// result and fall back to the D1 cache instead. The collection is small (forged over time); past the cap we use
// the log scan. NOTE (real launch): at scale replace with an indexer/multicall — see FOUNDRY_LAUNCH_RUNBOOK.
export async function readOwnedRobots(env, wallet) {
  const NFT = env.FOUNDRY_NFT || "0xee14596172332c4f3964540904d9676d650d8de3";
  const REG = env.FOUNDRY_REG_ADDRESS;
  const w = String(wallet).toLowerCase();
  const ownerSel = "0x6352211e"; // ownerOf(uint256)
  const tierSel = "0x" + (await keccakSel("tierOf(uint256)"));
  const id32 = (id) => BigInt(id).toString(16).padStart(64, "0");
  const rh = rhBase(env);
  const SCAN_CAP = 4000;

  let total = 0, complete = true;
  try { total = Number(BigInt(await rpcRead(rh, "eth_call", [{ to: NFT, data: "0x18160ddd" }, "latest"]) || "0x0")); }
  catch { total = 0; complete = false; }

  const out = [];
  // In a 1..totalSupply scan every id exists, so an ownerOf failure is a RATE LIMIT (uncertain), not a revert —
  // treat it as "scan incomplete" rather than "not owned".
  const addOwned = async (id) => {
    let owner = "";
    try { owner = "0x" + String(await rpcRead(rh, "eth_call", [{ to: NFT, data: ownerSel + id32(id) }, "latest"])).slice(-40); }
    catch { complete = false; return; }
    if (owner.toLowerCase() !== w) return;
    let tier = 0;
    try { tier = Number(BigInt(await rpcRead(rh, "eth_call", [{ to: REG, data: tierSel + id32(id) }, "latest"]) || "0x0")); } catch { tier = 0; }
    out.push({ tokenId: Number(id), tier });
  };

  if (total > 0 && total <= SCAN_CAP) {
    for (let id = 1; id <= total; id++) { await addOwned(id); if (id < total) await sleep(60); } // gap avoids burst 429s
  } else {
    complete = false; // couldn't read totalSupply (or too large) → best-effort log scan, don't trust as authoritative
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const toTopic = "0x" + id32(wallet);
    let logs = [];
    try { logs = await rpcRead(rh, "eth_getLogs", [{ address: NFT, topics: [TRANSFER, null, toTopic], fromBlock: "0x0", toBlock: "latest" }]); } catch { logs = []; }
    const ids = [...new Set((logs || []).map((l) => BigInt(l.topics[3]).toString()))];
    for (const id of ids) await addOwned(id);
  }
  out.sort((a, b) => a.tokenId - b.tokenId);

  // A fully-successful scan is authoritative → it becomes the new known-good roster. An incomplete scan is merged
  // over the cache so a 429 can never drop a robot the wallet owns (a real transfer-away is corrected by the next
  // complete scan). Either way we persist the best-known roster.
  const cached = await loadRobotsCache(env, w);
  const result = complete ? out : unionRobots(out, cached);
  await saveRobotsCache(env, w, result);
  return result;
}

// ── sign a BURN voucher: pick enough of the wallet's UNUSED burns to reach toTier ──
export async function signBurnVoucher(env, wallet, robotId, toTier) {
  toTier = Number(toTier);
  if (!(toTier >= 1 && toTier < BURN_REQUIRED.length)) throw new Error("bad tier");
  const cur = await currentTier(env, robotId);
  if (toTier <= cur) throw new Error(`robot already tier ${cur}`);
  const need = BURN_REQUIRED[toTier] - BURN_REQUIRED[cur];

  const all = await burnedTokenIds(env, wallet);
  const fresh = [];
  for (const id of all) { if (!(await burnConsumed(env, id))) fresh.push(id); if (fresh.length >= need) break; }
  if (fresh.length < need) throw new Error(`need ${need} unused burned 2D, found ${fresh.length}. Burn ${need - fresh.length} more.`);
  const burnIds = fresh.slice(0, need);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const nonce = randNonce();
  const message = { owner: wallet, robotId: BigInt(robotId), toTier, burnIds, nonce, deadline };
  const types = { Burn: [
    { name: "owner", type: "address" }, { name: "robotId", type: "uint256" }, { name: "toTier", type: "uint8" },
    { name: "burnIds", type: "uint256[]" }, { name: "nonce", type: "bytes32" }, { name: "deadline", type: "uint256" }] };
  const sig = await account(env).signTypedData({ domain: bridgeDomain(env), types, primaryType: "Burn", message });
  return { fn: "activateWithBurn", owner: wallet, robotId: String(robotId), toTier, burnIds: burnIds.map(String), nonce, deadline: deadline.toString(), signature: sig };
}

// ArchiveVault.depositorOf(uint256) on Ethereum → who has the 333 ESCROWED (locked so it can't be sold while attached)
async function vaultDepositorOf(env, archiveId) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(env.ARCHIVE_VAULT_ADDRESS || ""))) throw new Error("ARCHIVE_VAULT_ADDRESS not configured");
  const sel = "0x" + (await keccakSel("depositorOf(uint256)"));
  const data = sel + BigInt(archiveId).toString(16).padStart(64, "0");
  const r = await rpc(ethBase(env), "eth_call", [{ to: env.ARCHIVE_VAULT_ADDRESS, data }, "latest"]);
  return "0x" + String(r).slice(-40);
}
function vaultDomain(env) {
  return { name: "MHArchiveVault", version: "1", chainId: 1, verifyingContract: env.ARCHIVE_VAULT_ADDRESS }; // Ethereum mainnet
}

// ── sign an ATTACH voucher: the 333 must be ESCROWED by this wallet (locked) + not already attached ──
export async function signAttachVoucher(env, wallet, robotId, archiveId) {
  const depositor = await vaultDepositorOf(env, archiveId);
  if (depositor.toLowerCase() !== String(wallet).toLowerCase()) throw new Error("lock the 333 in the vault first (deposit it) — it can't be sold while attached");
  if ((await archiveBoundTo(env, archiveId)) !== 0n) throw new Error("that 333 is already attached to a robot");

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const nonce = randNonce();
  const message = { owner: wallet, robotId: BigInt(robotId), archiveId: BigInt(archiveId), nonce, deadline };
  const types = { Attach: [
    { name: "owner", type: "address" }, { name: "robotId", type: "uint256" }, { name: "archiveId", type: "uint256" },
    { name: "nonce", type: "bytes32" }, { name: "deadline", type: "uint256" }] };
  const sig = await account(env).signTypedData({ domain: bridgeDomain(env), types, primaryType: "Attach", message });
  return { fn: "attachArchive", owner: wallet, robotId: String(robotId), archiveId: String(archiveId), nonce, deadline: deadline.toString(), signature: sig };
}

// ── sign a vault WITHDRAW voucher: only AFTER the 333 is detached on Robinhood (so a robot never earns for a 333 that left) ──
export async function signWithdrawVoucher(env, wallet, archiveId) {
  const depositor = await vaultDepositorOf(env, archiveId);
  if (depositor.toLowerCase() !== String(wallet).toLowerCase()) throw new Error("you didn't deposit that 333");
  if ((await archiveBoundTo(env, archiveId)) !== 0n) throw new Error("detach it from your robot on Robinhood first, then withdraw");

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const nonce = randNonce();
  const message = { depositor: wallet, archiveId: BigInt(archiveId), nonce, deadline };
  const types = { Withdraw: [
    { name: "depositor", type: "address" }, { name: "archiveId", type: "uint256" },
    { name: "nonce", type: "bytes32" }, { name: "deadline", type: "uint256" }] };
  const sig = await account(env).signTypedData({ domain: vaultDomain(env), types, primaryType: "Withdraw", message });
  return { fn: "withdraw", archiveId: String(archiveId), nonce, deadline: deadline.toString(), signature: sig };
}
