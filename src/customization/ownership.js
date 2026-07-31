import { getAddress } from "viem";
import { ApiError } from "./http.js";

const OWNER_OF_SELECTOR = "6352211e";
const BALANCE_OF_SELECTOR = "70a08231"; // balanceOf(address) — how many MotorHeads a wallet holds
const RPC_TIMEOUT_MS = 8000;

function ownerOfData(tokenId) {
  return `0x${OWNER_OF_SELECTOR}${BigInt(tokenId).toString(16).padStart(64, "0")}`;
}

function balanceOfData(address) {
  return `0x${BALANCE_OF_SELECTOR}${String(address).toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function rpcFetcher(env) {
  if (env.OWNERSHIP_RPC && typeof env.OWNERSHIP_RPC.fetch === "function") {
    return (request) => env.OWNERSHIP_RPC.fetch(request);
  }
  return (request) => fetch(request);
}

function unavailable(code, message) {
  return new ApiError(503, code, message, { retryable: true });
}

async function jsonRpc(env, { method, params, unavailableCode, unavailableMessage }) {
  const rpcUrl = String(env.ETH_RPC_URL || "").trim();
  if (!rpcUrl) throw unavailable(unavailableCode, unavailableMessage);

  let response;
  try {
    response = await rpcFetcher(env)(new Request(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
    }));
  } catch {
    throw unavailable(unavailableCode, unavailableMessage);
  }
  if (!response.ok) throw unavailable(unavailableCode, unavailableMessage);

  try {
    return await response.json();
  } catch {
    throw unavailable(unavailableCode, unavailableMessage);
  }
}

function tokenNotFound(error) {
  const text = JSON.stringify(error || {}).toLowerCase();
  return text.includes("execution reverted") || text.includes("nonexistent") || text.includes("invalid token") || text.includes("owner query");
}

export async function walletAddressHasCode(env, address) {
  const message = "Wallet type verification is temporarily unavailable.";
  const payload = await jsonRpc(env, {
    method: "eth_getCode",
    params: [address, "latest"],
    unavailableCode: "WALLET_TYPE_CHECK_UNAVAILABLE",
    unavailableMessage: message
  });
  if (payload?.error || typeof payload?.result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(payload.result)) {
    throw unavailable("WALLET_TYPE_CHECK_UNAVAILABLE", message);
  }
  return payload.result.slice(2).replace(/0/g, "").length > 0;
}

export async function readCurrentOwner(env, contractAddress, tokenId) {
  const message = "Ethereum ownership verification is temporarily unavailable.";
  const payload = await jsonRpc(env, {
    method: "eth_call",
    params: [{ to: contractAddress, data: ownerOfData(tokenId) }, "latest"],
    unavailableCode: "OWNERSHIP_CHECK_UNAVAILABLE",
    unavailableMessage: message
  });
  if (payload?.error) {
    if (tokenNotFound(payload.error)) throw new ApiError(404, "TOKEN_NOT_FOUND", "This MotorHead token does not exist.");
    throw unavailable("OWNERSHIP_CHECK_UNAVAILABLE", message);
  }
  if (typeof payload?.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(payload.result)) {
    throw unavailable("OWNERSHIP_CHECK_UNAVAILABLE", "Ethereum ownership verification returned an invalid owner.");
  }
  try {
    return getAddress(`0x${payload.result.slice(-40)}`).toLowerCase();
  } catch {
    throw unavailable("OWNERSHIP_CHECK_UNAVAILABLE", "Ethereum ownership verification returned an invalid owner.");
  }
}

// Live on-chain holder check: how many MotorHeads this wallet currently owns (authoritative for the gate).
export async function readOwnerBalance(env, contractAddress, address) {
  const message = "Ethereum holder verification is temporarily unavailable.";
  const payload = await jsonRpc(env, {
    method: "eth_call",
    params: [{ to: contractAddress, data: balanceOfData(address) }, "latest"],
    unavailableCode: "HOLDER_CHECK_UNAVAILABLE",
    unavailableMessage: message
  });
  if (payload?.error) throw unavailable("HOLDER_CHECK_UNAVAILABLE", message);
  if (typeof payload?.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(payload.result)) {
    throw unavailable("HOLDER_CHECK_UNAVAILABLE", "Ethereum holder verification returned an invalid balance.");
  }
  try {
    const balance = BigInt(payload.result);
    return balance > 1000000n ? 1000000 : Number(balance); // clamp absurd values
  } catch {
    throw unavailable("HOLDER_CHECK_UNAVAILABLE", message);
  }
}
