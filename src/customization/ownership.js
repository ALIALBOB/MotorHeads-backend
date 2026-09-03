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

// A single transient RPC blip on a live balanceOf must NOT read as "not a holder" — that silently LOCKS a
// real holder's gate / partner collab and, since the client re-reads on every page load, makes access FLAP
// (works, refresh, locked). Retry a few times with small backoff before surfacing the failure.
export async function readOwnerBalanceResilient(env, contractAddress, address, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await readOwnerBalance(env, contractAddress, address); }
    catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}

// Enumerate the token IDs a wallet owns via Alchemy's NFT API (real-time, works in dev + prod).
// Returns an ascending unique id list, or null when the RPC isn't Alchemy (caller falls back to D1).
export async function readOwnedTokenIds(env, contractAddress, address, { max = 500 } = {}) {
  const rpcUrl = String(env.ETH_RPC_URL || "").trim();
  if (!/alchemy\.com\/v2\//i.test(rpcUrl)) return null;
  const nftBase = rpcUrl.replace(/\/v2\//i, "/nft/v3/").split("?")[0].replace(/\/$/, "");
  const ids = [];
  let pageKey = "";
  try {
    for (let page = 0; page < 6 && ids.length < max; page += 1) {
      const url = `${nftBase}/getNFTsForOwner?owner=${encodeURIComponent(address)}` +
        `&contractAddresses[]=${encodeURIComponent(contractAddress)}&withMetadata=false&pageSize=100` +
        (pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : "");
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      if (!res.ok) return ids.length ? sortedUnique(ids) : null;
      const data = await res.json();
      for (const nft of (Array.isArray(data?.ownedNfts) ? data.ownedNfts : [])) {
        const id = Number(nft?.tokenId);
        if (Number.isInteger(id) && id >= 1) ids.push(id);
      }
      pageKey = data?.pageKey || "";
      if (!pageKey) break;
    }
    return sortedUnique(ids);
  } catch {
    return ids.length ? sortedUnique(ids) : null;
  }
}

function sortedUnique(ids) {
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

// Route 333-Archive IPFS content through OUR same-origin proxy (/api/v1/ipfs/...). No public gateway embeds cleanly
// (Filebase's CSP kills the animation's inline scripts; dweb.link/ipfs.io throw Cloudflare challenges), so the proxy
// fetches from Filebase server-side + strips the CSP. Returns a same-origin path the Foundry app can iframe directly.
function ipfsToHttp(u) {
  u = String(u || "");
  let rest = "";
  if (u.startsWith("ipfs://")) rest = u.slice(7);
  else { const m = u.match(/\/ipfs\/(.+)$/i); if (m) rest = m[1]; else return u; }
  return "/api/v1/ipfs/" + rest;
}

// The owner's NFTs of a contract WITH media (image + animation_url), via Alchemy's NFT API (withMetadata=true).
// Powers the Foundry app showing real 333-Archive art + animations. Returns [] on a non-Alchemy RPC.
export async function readOwnedNftMedia(env, contractAddress, address, { max = 60 } = {}) {
  const rpcUrl = String(env.ETH_RPC_URL || "").trim();
  if (!/alchemy\.com\/v2\//i.test(rpcUrl)) return [];
  const nftBase = rpcUrl.replace(/\/v2\//i, "/nft/v3/").split("?")[0].replace(/\/$/, "");
  const out = [];
  let pageKey = "";
  try {
    for (let page = 0; page < 3 && out.length < max; page += 1) {
      const url = `${nftBase}/getNFTsForOwner?owner=${encodeURIComponent(address)}` +
        `&contractAddresses[]=${encodeURIComponent(contractAddress)}&withMetadata=true&pageSize=50` +
        (pageKey ? `&pageKey=${encodeURIComponent(pageKey)}` : "");
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      if (!res.ok) break;
      const data = await res.json();
      for (const nft of (Array.isArray(data?.ownedNfts) ? data.ownedNfts : [])) {
        const id = Number(nft?.tokenId);
        if (!Number.isInteger(id) || id < 1) continue;
        // Prefer the canonical metadata image through OUR edge-cached IPFS proxy (reliable) over Alchemy's cache,
        // which frequently has no thumbnail for niche collections like the 333 Archive → the app showed placeholders.
        const image = ipfsToHttp(nft?.raw?.metadata?.image) || nft?.image?.cachedUrl || nft?.image?.pngUrl || ipfsToHttp(nft?.image?.originalUrl) || "";
        const animation = ipfsToHttp(nft?.raw?.metadata?.animation_url || nft?.animation?.cachedUrl || "");
        out.push({ tokenId: id, name: nft?.name || nft?.raw?.metadata?.name || `#${id}`, image, animation });
      }
      pageKey = data?.pageKey || "";
      if (!pageKey) break;
    }
  } catch { /* return what we have */ }
  return out.sort((a, b) => a.tokenId - b.tokenId).slice(0, max);
}
