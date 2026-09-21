import { COLLECTION, CIDS, NETWORK } from "./contracts.js";
import { PART_LIBRARY } from "./parts.js";
import { readChainSummary, readTokenChainState, readTokenEffect, readTokenBackground, readEquipGrandfatherList, readTokenOwnedParts, syncChainState, backfillSales } from "./chainState.js";
import { routeCustomizationRequest } from "./customization/routes.js";
import { routeShareRequest } from "./share.js";
import { corsHeaders, errorJson, json } from "./responses.js";
import { recordHit, readStats } from "./stats.js";
import { handleCrateSign } from "./crate-signer.js";
import {
  guardRegistryWrite,
  isIndexerDisabled,
  safetySnapshot
} from "./safety.js";
import {
  awakenAgent,
  isEthAddress,
  parseTokenId,
  readAgentProfile,
  readVisualState,
  writeVisualState
} from "./state.js";

const API_VERSION = "2026-06-08";

export default {
  async fetch(request, env = {}, ctx = {}) {
    const customizationResponse = await routeCustomizationRequest(request, env, ctx);
    if (customizationResponse) {
      return customizationResponse;
    }

    const shareResponse = await routeShareRequest(request, env, ctx);
    if (shareResponse) {
      return shareResponse;
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error("Unhandled MotorHeads API error", error);
      return errorJson(500, "internal_error", "The MotorHeads backend hit an unexpected error.", undefined, env);
    }
  },

  async scheduled(event, env = {}, ctx = {}) {
    if (isIndexerDisabled(env)) {
      console.warn("MotorHeads chain indexer skipped by safety switch.");
      return;
    }

    ctx.waitUntil(
      syncChainState(env, { reason: event?.cron || "cron" }).catch((error) => {
        console.error("MotorHeads chain indexer failed", error);
      })
    );
    // Keep the activation cache warm. A marketplace re-indexing the collection asks for all 5555 tokens at
    // once and each one used to trigger its own activation read — the RPC rate-limited, most failed, and
    // those tokens were served with NO Activated/Tier/Weight/Parts trait at all. Served from D1 instead,
    // that whole burst costs nothing. One Multicall3 per run walks 400 ids and remembers where it stopped,
    // so the full collection is refreshed about every hour.
    ctx.waitUntil(
      (async () => {
        try {
          const { warmActivation } = await import("./foundry/economy.js");
          const r = await warmActivation(env);
          if (r && r.error) console.warn("activation warm-up skipped:", r.error);
        } catch (error) {
          console.warn("activation warm-up failed", error);
        }
      })()
    );
    // NOTE: historical sale backfill is NOT run on the cron — with a 5000/day RPC budget, grinding the ~4k
    // transfer backlog would starve the indexer. It's done out-of-band (local script on a free public RPC) +
    // the gated /v1/indexer/backfill-sales endpoint for deliberate, throttled runs. Forward detection is live.
  }
};

async function route(request, env, ctx = {}) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/") {
    return json({ ok: true, service: "motorheads-backend", version: API_VERSION }, {}, env);
  }

  if (request.method === "GET" && pathname === "/health") {
    return json({ ok: true, version: API_VERSION, time: new Date().toISOString(), safety: safetySnapshot(env) }, {}, env);
  }

  if (request.method === "GET" && pathname === "/v1/config") {
    return json(
      {
        ok: true,
        collection: COLLECTION,
        network: NETWORK,
        cids: CIDS,
        registry: {
          visualState: Boolean(env.DB),
          signatureWrites: env.ALLOW_UNVERIFIED_WRITES === "true" ? "dev-only" : "required"
        },
        safety: safetySnapshot(env)
      },
      {},
      env
    );
  }

  if (request.method === "GET" && pathname === "/v1/parts") {
    return json({ ok: true, parts: PART_LIBRARY }, {}, env);
  }

  // IPFS PROXY — serve the 333-Archive animation (+ image, + any relative assets) SAME-ORIGIN so it embeds in the
  // Foundry app. No public gateway embeds cleanly: Filebase adds `default-src 'self'` that kills the animation's 343
  // inline scripts; dweb.link/ipfs.io throw Cloudflare "Just a moment…" challenges in a browser iframe. So we fetch
  // server-side, STRIP the restrictive CSP + X-Frame-Options, and re-serve it.
  //
  // This is how OpenSea serves the same media: read the token's IPFS media ONCE, then cache it on your own CDN and
  // serve every later view from there. IPFS content is IMMUTABLE (addressed by its CID), so we cache it HARD at our
  // own edge (Cache API, 1-year immutable) — after the first view NO visitor touches a public gateway again. The old
  // proxy re-fetched Filebase live on every view (cf-cache-status: DYNAMIC); one slow moment there showed the visitor
  // a "Gateway time-out". We also RACE two independent gateways so a single slow/down gateway can't break the embed.
  if (request.method === "GET" && pathname.startsWith("/v1/ipfs/")) {
    const rest = pathname.slice("/v1/ipfs/".length);
    if (!/^[a-z0-9]+(?:\/[A-Za-z0-9._\-/%]*)?$/i.test(rest)) return new Response("bad ipfs path", { status: 400 });

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const grab = (base) => fetch(base + "/ipfs/" + rest + url.search, {
      headers: { Accept: "*/*" },
      signal: AbortSignal.timeout(12000),
      cf: { cacheTtl: 31536000, cacheEverything: true }
    }).then((r) => (r.ok ? r : Promise.reject(new Error("gateway " + r.status))));

    let upstream;
    try {
      // Promise.any → whichever independent gateway answers first (both proven to serve real content server-side).
      upstream = await Promise.any([
        grab("https://ipfs.filebase.io"),
        grab("https://ipfs.io")
      ]);
    } catch {
      return new Response("ipfs upstream unavailable", { status: 502, headers: { "access-control-allow-origin": "*" } });
    }

    const buf = await upstream.arrayBuffer();
    const h = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) h.set("content-type", ct);
    h.set("access-control-allow-origin", "*");
    h.set("cache-control", "public, max-age=31536000, immutable");   // CID content never changes → cache forever
    const out = new Response(buf, { status: 200, headers: h });
    ctx.waitUntil?.(cache.put(cacheKey, out.clone()));               // populate OUR edge in the background
    return out;
  }

  if (request.method === "GET" && pathname === "/v1/chain/summary") {
    return json({ ok: true, chain: await readChainSummary(env) }, {}, env);
  }

  // One-time equip grandfather snapshot: which tokens currently show an effect/background (first-owned),
  // so the founder can seed equip.grandfather() before flipping EQUIP_READS. Public — all inputs are on-chain.
  if (request.method === "GET" && pathname === "/v1/equip/grandfather-list") {
    try {
      return json({ ok: true, ...(await readEquipGrandfatherList(env)) }, {}, env);
    } catch (error) {
      return errorJson(500, "grandfather_scan_failed", error?.message || "Grandfather scan failed.", undefined, env);
    }
  }

  if (request.method === "POST" && pathname === "/v1/indexer/run") {
    return handleIndexerRun(request, env);
  }

  // One-time repair: reclassify past transfers that were actually Seaport/WETH sales the old detector missed.
  if (request.method === "POST" && pathname === "/v1/indexer/backfill-sales") {
    return handleBackfillSales(request, env);
  }

  // Crate opening: holder commits on-chain (requestId), asks for the signed seed here, then submits resolveOpen.
  if (request.method === "POST" && pathname === "/v1/crate/open") {
    return handleCrateSign(request, env);
  }

  // Lightweight monitoring: record a page view; read the dashboard stats (visitors + on-chain edits).
  if (request.method === "POST" && pathname === "/v1/hit") {
    return recordHit(request, env);
  }
  if (request.method === "GET" && pathname === "/v1/stats") {
    return readStats(request, env);
  }

  const tokenStateMatch = pathname.match(/^\/v1\/tokens\/([^/]+)\/state$/);
  if (tokenStateMatch) {
    return handleTokenState(request, env, tokenStateMatch[1]);
  }

  const tokenChainStateMatch = pathname.match(/^\/v1\/tokens\/([^/]+)\/chain-state$/);
  if (tokenChainStateMatch) {
    return handleTokenChainState(request, env, tokenChainStateMatch[1]);
  }

  // Which effect/background parts a token's garage owns (inventory) — wallet-independent read for the Effects tab.
  const tokenOwnedMatch = pathname.match(/^\/v1\/tokens\/([^/]+)\/owned-parts$/);
  if (tokenOwnedMatch && request.method === "GET") {
    const tokenId = parseTokenId(tokenOwnedMatch[1]);
    if (!tokenId) return errorJson(400, "invalid_token_id", "Token ID must be between 1 and 5555.", undefined, env);
    return json({ ok: true, ...(await readTokenOwnedParts(env, tokenId)) }, {}, env);
  }

  const agentMatch = pathname.match(/^\/v1\/agent\/([^/]+)$/);
  if (agentMatch) {
    return handleAgent(request, env, agentMatch[1]);
  }

  const awakenMatch = pathname.match(/^\/v1\/agent\/([^/]+)\/awaken$/);
  if (awakenMatch) {
    return handleAwaken(request, env, awakenMatch[1]);
  }

  const walletMatch = pathname.match(/^\/v1\/wallet\/([^/]+)\/tokens$/);
  if (walletMatch) {
    return handleWalletTokens(request, env, walletMatch[1]);
  }

  return errorJson(404, "not_found", "No MotorHeads API route matched this request.", { path: pathname }, env);
}

async function handleTokenState(request, env, rawTokenId) {
  const tokenId = parseTokenId(rawTokenId);
  if (!tokenId) {
    return errorJson(400, "invalid_token_id", "Token ID must be between 1 and 5555.", undefined, env);
  }

  if (request.method === "GET") {
    return json({ ok: true, state: await readVisualState(env, tokenId) }, {}, env);
  }

  if (request.method !== "PUT") {
    return errorJson(405, "method_not_allowed", "Use GET or PUT for token visual state.", undefined, env);
  }

  const auth = requireWriteAuth(request, env);
  if (auth.error) {
    return auth.error;
  }

  if (env.ALLOW_UNVERIFIED_WRITES !== "true") {
    return errorJson(
      501,
      "signature_verifier_pending",
      "Permanent writes are locked until the website signature verifier is connected.",
      { next: "Verify the signed message matches the wallet and token ownership before enabling writes." },
      env
    );
  }

  const writeGuard = await guardRegistryWrite(env);
  if (!writeGuard.allowed) {
    return safetyError(writeGuard, env);
  }

  if (!env.DB) {
    return errorJson(503, "registry_not_configured", "Cloudflare D1 is not bound to this Worker yet.", undefined, env);
  }

  const payload = await readJsonBody(request, env);
  if (payload.error) {
    return payload.error;
  }

  const state = await writeVisualState(env, tokenId, auth.walletAddress, payload.data, auth);
  return json({ ok: true, state }, {}, env);
}

async function handleAgent(request, env, rawTokenId) {
  const tokenId = parseTokenId(rawTokenId);
  if (!tokenId) {
    return errorJson(400, "invalid_token_id", "Token ID must be between 1 and 5555.", undefined, env);
  }

  if (request.method !== "GET") {
    return errorJson(405, "method_not_allowed", "Use GET for agent profiles.", undefined, env);
  }

  return json({ ok: true, agent: await readAgentProfile(env, tokenId) }, {}, env);
}

async function handleAwaken(request, env, rawTokenId) {
  const tokenId = parseTokenId(rawTokenId);
  if (!tokenId) {
    return errorJson(400, "invalid_token_id", "Token ID must be between 1 and 5555.", undefined, env);
  }

  if (request.method !== "POST") {
    return errorJson(405, "method_not_allowed", "Use POST to awaken an agent.", undefined, env);
  }

  const auth = requireWriteAuth(request, env);
  if (auth.error) {
    return auth.error;
  }

  if (env.ALLOW_UNVERIFIED_WRITES !== "true") {
    return errorJson(
      501,
      "signature_verifier_pending",
      "Agent awakening is locked until wallet signature verification is connected.",
      undefined,
      env
    );
  }

  const writeGuard = await guardRegistryWrite(env);
  if (!writeGuard.allowed) {
    return safetyError(writeGuard, env);
  }

  if (!env.DB) {
    return errorJson(503, "registry_not_configured", "Cloudflare D1 is not bound to this Worker yet.", undefined, env);
  }

  const payload = await readJsonBody(request, env);
  if (payload.error) {
    return payload.error;
  }

  const agent = await awakenAgent(env, tokenId, auth.walletAddress, payload.data, auth);
  return json({ ok: true, agent }, {}, env);
}

function handleWalletTokens(request, env, rawWallet) {
  if (request.method !== "GET") {
    return errorJson(405, "method_not_allowed", "Use GET for wallet token lookups.", undefined, env);
  }

  if (!isEthAddress(rawWallet)) {
    return errorJson(400, "invalid_wallet", "Wallet address must be a valid Ethereum address.", undefined, env);
  }

  return errorJson(
    501,
    "chain_indexer_pending",
    "Wallet token lookup is intentionally left to the website wallet scan until a chain indexer is configured.",
    {
      wallet: rawWallet,
      currentProductionPath: "The website reads balanceOf/ownerOf directly from Ethereum through the connected wallet."
    },
    env
  );
}

async function handleTokenChainState(request, env, rawTokenId) {
  const tokenId = parseTokenId(rawTokenId);
  if (!tokenId) {
    return errorJson(400, "invalid_token_id", "Token ID must be between 1 and 5555.", undefined, env);
  }

  if (request.method !== "GET") {
    return errorJson(405, "method_not_allowed", "Use GET for token chain state.", undefined, env);
  }

  const chainState = await readTokenChainState(env, tokenId);
  chainState.effect = await readTokenEffect(env, tokenId); // applied whole-machine effect (null if none) — drives the live animation FX
  chainState.background = await readTokenBackground(env, tokenId); // applied animated background (null if none) — drives the anim's behind layer
  return json({ ok: true, chainState }, {}, env);
}

async function handleIndexerRun(request, env) {
  if (isIndexerDisabled(env)) {
    return errorJson(503, "indexer_disabled", "The MotorHeads indexer is disabled by the safety switch.", safetySnapshot(env), env);
  }

  if (!env.INDEXER_ADMIN_TOKEN) {
    return errorJson(
      501,
      "indexer_admin_token_missing",
      "Manual indexer runs are locked until INDEXER_ADMIN_TOKEN is configured.",
      undefined,
      env
    );
  }

  const expectedToken = String(env.INDEXER_ADMIN_TOKEN || "").trim();
  const providedToken = String(request.headers.get("X-Indexer-Token") || "").trim();
  if (providedToken !== expectedToken) {
    return errorJson(401, "indexer_admin_required", "Manual indexer runs require X-Indexer-Token.", undefined, env);
  }

  try {
    const result = await syncChainState(env, { reason: "manual-api" });
    return json({ ok: true, indexer: result }, {}, env);
  } catch (error) {
    return errorJson(500, "indexer_failed", error.message || "The chain indexer failed.", undefined, env);
  }
}

async function handleBackfillSales(request, env) {
  const expectedToken = String(env.INDEXER_ADMIN_TOKEN || "").trim();
  if (!expectedToken) return errorJson(501, "indexer_admin_token_missing", "Backfill is locked until INDEXER_ADMIN_TOKEN is configured.", undefined, env);
  if (String(request.headers.get("X-Indexer-Token") || "").trim() !== expectedToken) {
    return errorJson(401, "indexer_admin_required", "Backfill requires X-Indexer-Token.", undefined, env);
  }
  const limit = Number(new URL(request.url).searchParams.get("limit")) || 30;
  try {
    const result = await backfillSales(env, limit);
    return json({ ok: true, backfill: result }, {}, env);
  } catch (error) {
    return errorJson(500, "backfill_failed", error.message || "The sales backfill failed.", undefined, env);
  }
}

function safetyError(guard, env) {
  const status = guard.code === "daily_budget_exhausted" ? 429 : 503;
  return errorJson(status, guard.code || "safety_blocked", guard.message || "Blocked by MotorHeads safety guard.", guard.details, env);
}

async function readJsonBody(request, env) {
  try {
    return { data: await request.json() };
  } catch {
    return { error: errorJson(400, "invalid_json", "Request body must be valid JSON.", undefined, env) };
  }
}

function requireWriteAuth(request, env) {
  const walletAddress = request.headers.get("X-Wallet-Address");
  const signature = request.headers.get("X-Signature");
  const signedMessage = request.headers.get("X-Signed-Message");

  if (!walletAddress || !signature || !signedMessage) {
    return {
      error: errorJson(
        401,
        "signature_required",
        "Write requests must include X-Wallet-Address, X-Signature, and X-Signed-Message.",
        undefined,
        env
      )
    };
  }

  if (!isEthAddress(walletAddress)) {
    return { error: errorJson(400, "invalid_wallet", "X-Wallet-Address is not a valid Ethereum address.", undefined, env) };
  }

  if (!signature.startsWith("0x") || signature.length < 64) {
    return { error: errorJson(400, "invalid_signature", "X-Signature must be a hex wallet signature.", undefined, env) };
  }

  return { walletAddress, signature, signedMessage };
}
