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

// ── sign an ATTACH voucher: verify the wallet owns the 333 + it isn't already bound ──
export async function signAttachVoucher(env, wallet, robotId, archiveId) {
  const sel = "0x" + (await keccakSel("ownerOf(uint256)"));
  const data = sel + BigInt(archiveId).toString(16).padStart(64, "0");
  const owner = "0x" + String(await rpc(ethBase(env), "eth_call", [{ to: ARCHIVE333, data }, "latest"])).slice(-40);
  if (owner.toLowerCase() !== String(wallet).toLowerCase()) throw new Error("you don't own that 333");
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
