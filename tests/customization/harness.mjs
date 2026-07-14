import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { createSiweMessage } from "viem/siwe";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const CONTRACT = "0x0a5008550fc1402bb567a3ba38d9433e6199ceb1";
export const LOCAL_ORIGIN = "http://localhost:5173";
export const PRODUCTION_ORIGIN = "https://motorheadsonline.com";
export const SIWE_STATEMENT =
  "Sign in to save your MotorHeads workshop layout. This does not send a transaction or cost gas.";

export const TOKEN_MANIFESTS = Object.freeze({
  1: readJson(path.join(HERE, "fixtures", "token-1.json")),
  3: readJson(path.join(HERE, "fixtures", "token-3.json"))
});

let workerBundlePromise;

async function getWorkerBundle() {
  workerBundlePromise ||= build({
    entryPoints: [path.join(ROOT, "src", "index.js")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent"
  }).then((result) => {
    assert.equal(result.outputFiles.length, 1, "expected one in-memory Worker bundle");
    return result.outputFiles[0].text;
  });
  return workerBundlePromise;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readD1Schema(file) {
  return fs.readFileSync(file, "utf8")
    .replace(/--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonResponse(value, status = 200) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body))
    }
  });
}

function ownerResult(address) {
  return `0x${"0".repeat(24)}${address.toLowerCase().slice(2)}`;
}

function tokenIdFromOwnerCall(data) {
  if (typeof data !== "string" || !/^0x6352211e[0-9a-f]{64}$/i.test(data)) return null;
  const tokenId = Number(BigInt(`0x${data.slice(10)}`));
  return Number.isSafeInteger(tokenId) ? tokenId : null;
}

export async function createRuntime({
  flags = true,
  bindings = {},
  owners = {},
  schemaFile = "schema.sql"
} = {}) {
  const workerBundle = await getWorkerBundle();
  const control = {
    owners: new Map(Object.entries(owners).map(([tokenId, address]) => [Number(tokenId), address.toLowerCase()])),
    contractWallets: new Set(),
    nonexistentTokens: new Set(),
    rpcMode: "ok",
    walletTypeRpcMode: "ok",
    rpcCalls: [],
    manifestMode: "ok",
    manifestModeByToken: new Map(),
    manifestCalls: []
  };

  const defaultBindings = {
    CORS_ORIGIN: "*",
    ALLOW_UNVERIFIED_WRITES: "false",
    CUSTOMIZATION_READS_ENABLED: flags ? "true" : "false",
    CUSTOMIZATION_WRITES_ENABLED: flags ? "true" : "false",
    CUSTOMIZATION_AUTH_ENABLED: flags ? "true" : "false",
    CUSTOMIZATION_ALLOWED_ORIGINS:
      "http://localhost:5173,http://127.0.0.1:5173,https://motorheadsonline.com,https://www.motorheadsonline.com",
    CUSTOMIZATION_SIWE_DOMAIN: "localhost:5173",
    CUSTOMIZATION_SIWE_URI: LOCAL_ORIGIN,
    CUSTOMIZATION_CHAIN_ID: "1",
    CUSTOMIZATION_SUPPORTED_CONTRACT: CONTRACT,
    CUSTOMIZATION_COOKIE_SECURE: "false",
    CUSTOMIZATION_NONCE_TTL_SECONDS: "600",
    CUSTOMIZATION_SESSION_TTL_SECONDS: "86400",
    CUSTOMIZATION_SESSION_TOUCH_SECONDS: "300",
    CUSTOMIZATION_NONCE_RATE_LIMIT: "1000",
    CUSTOMIZATION_NONCE_RATE_WINDOW_SECONDS: "900",
    CUSTOMIZATION_VERIFY_RATE_LIMIT: "1000",
    CUSTOMIZATION_VERIFY_RATE_WINDOW_SECONDS: "900",
    CUSTOMIZATION_WRITE_RATE_LIMIT: "1000",
    CUSTOMIZATION_WRITE_RATE_WINDOW_SECONDS: "3600",
    ETH_RPC_URL: "https://ownership.test",
    HOLDER_PLACEMENT_BASE_URL: "https://placement.test",
    INDEXER_ENABLED: "true"
  };

  const mf = new Miniflare({
    rootPath: ROOT,
    script: workerBundle,
    modules: true,
    compatibilityDate: "2026-06-08",
    bindings: { ...defaultBindings, ...bindings },
    d1Databases: { DB: `phase3a-${crypto.randomUUID()}` },
    d1Persist: false,
    cachePersist: false,
    serviceBindings: {
      async OWNERSHIP_RPC(request) {
        let payload;
        try {
          payload = await request.json();
        } catch {
          return jsonResponse({ error: { message: "invalid JSON-RPC request" } }, 400);
        }
        control.rpcCalls.push(structuredClone(payload));
        if (payload?.method === "eth_getCode") {
          if (control.walletTypeRpcMode === "unavailable") return jsonResponse({ error: "unavailable" }, 503);
          if (control.walletTypeRpcMode === "invalid-json") return new Response("not-json", { status: 200 });
          if (control.walletTypeRpcMode === "invalid-result") {
            return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: "0x1" });
          }
          const address = String(payload?.params?.[0] || "").toLowerCase();
          const result = control.contractWallets.has(address) ? "0x6001600055" : "0x";
          return jsonResponse({ jsonrpc: "2.0", id: payload.id, result });
        }
        if (control.rpcMode === "unavailable") return jsonResponse({ error: "unavailable" }, 503);
        if (control.rpcMode === "invalid-json") return new Response("not-json", { status: 200 });
        if (control.rpcMode === "invalid-result") {
          return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: "0x1234" });
        }
        const tokenId = tokenIdFromOwnerCall(payload?.params?.[0]?.data);
        if (payload?.method !== "eth_call" || tokenId === null) {
          return jsonResponse({ jsonrpc: "2.0", id: payload?.id, error: { message: "unsupported method" } });
        }
        if (control.nonexistentTokens.has(tokenId)) {
          return jsonResponse({
            jsonrpc: "2.0",
            id: payload.id,
            error: { code: 3, message: "execution reverted: ERC721: invalid token ID" }
          });
        }
        const owner = control.owners.get(tokenId);
        if (!owner) {
          return jsonResponse({
            jsonrpc: "2.0",
            id: payload.id,
            error: { code: 3, message: "execution reverted: owner query for nonexistent token" }
          });
        }
        return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: ownerResult(owner) });
      },

      async HOLDER_PLACEMENT_FETCHER(request) {
        const match = new URL(request.url).pathname.match(/\/tokens\/(\d+)\.json$/);
        const tokenId = match ? Number(match[1]) : null;
        control.manifestCalls.push({ method: request.method, tokenId, url: request.url });
        const mode = control.manifestModeByToken.get(tokenId) || control.manifestMode;
        if (mode === "unavailable") return jsonResponse({ error: "unavailable" }, 503);
        if (mode === "invalid-json") return new Response("not-json", { status: 200 });
        if (mode === "invalid-schema") return jsonResponse({ tokenId, source: {} });
        if (mode === "oversized-no-length") {
          return new Response(`{"padding":"${"x".repeat(1024 * 1024)}"}`, {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }
        const manifest = TOKEN_MANIFESTS[tokenId];
        if (!manifest) return jsonResponse({ error: "missing fixture" }, 404);
        return jsonResponse(manifest);
      }
    }
  });

  const db = await mf.getD1Database("DB");
  await db.exec(readD1Schema(path.join(ROOT, schemaFile)));

  return {
    mf,
    db,
    control,
    async close() {
      await mf.dispose();
    }
  };
}

export async function callApi(runtime, pathName, {
  method = "GET",
  origin,
  cookie,
  body,
  headers = {}
} = {}) {
  const requestHeaders = new Headers(headers);
  if (origin !== undefined) requestHeaders.set("Origin", origin);
  if (cookie) requestHeaders.set("Cookie", cookie);
  let requestBody = body;
  if (body !== undefined && typeof body !== "string" && !(body instanceof Uint8Array)) {
    requestHeaders.set("Content-Type", "application/json");
    requestBody = JSON.stringify(body);
  }
  const response = await runtime.mf.dispatchFetch(`http://api.motorheads.local${pathName}`, {
    method,
    headers: requestHeaders,
    body: requestBody
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { response, body: parsed, text };
}

export function errorCode(result) {
  return result?.body?.error?.code || null;
}

export function cookiePair(response) {
  const setCookie = response.headers.get("Set-Cookie");
  assert.ok(setCookie, "expected Set-Cookie response header");
  return setCookie.split(";", 1)[0];
}

export async function issueNonce(runtime, address, options = {}) {
  const result = await callApi(runtime, "/v1/auth/nonce", {
    method: "POST",
    origin: options.origin ?? LOCAL_ORIGIN,
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": options.ip || "127.0.0.10" },
    body: address ? { address } : {}
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

export function buildSiweMessage(account, nonce, overrides = {}) {
  return createSiweMessage({
    address: account.address,
    chainId: overrides.chainId ?? nonce.chainId,
    domain: overrides.domain ?? nonce.domain,
    uri: overrides.uri ?? nonce.uri,
    version: "1",
    statement: overrides.statement ?? nonce.statement,
    nonce: overrides.nonce ?? nonce.nonce,
    issuedAt: overrides.issuedAt ?? new Date(nonce.issuedAt),
    expirationTime: overrides.expirationTime ?? new Date(nonce.expirationTime),
    ...(overrides.notBefore ? { notBefore: overrides.notBefore } : {})
  });
}

export async function authenticate(runtime, account, {
  origin = LOCAL_ORIGIN,
  ip = "127.0.0.10",
  existingCookie,
  messageOverrides,
  signer = account
} = {}) {
  const nonce = await issueNonce(runtime, account.address, { origin, ip });
  const message = buildSiweMessage(account, nonce, messageOverrides);
  const signature = await signer.signMessage({ message });
  const result = await callApi(runtime, "/v1/auth/verify", {
    method: "POST",
    origin,
    cookie: existingCookie,
    headers: { "CF-Connecting-IP": ip },
    body: { message, signature }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return { nonce, message, signature, result, cookie: cookiePair(result.response) };
}

export function validState(tokenId = 3, overrides = {}) {
  const manifest = TOKEN_MANIFESTS[tokenId];
  assert.ok(manifest, `missing token ${tokenId} fixture`);
  const defaultItems = tokenId === 3 ? [{
    itemId: "side-panel-test-sticker",
    mountZone: "rightSidePanel",
    adjustment: { dx: 0, dy: 0, scale: 1, rotation: 0 }
  }] : [];
  return {
    schemaVersion: 1,
    chainId: 1,
    tokenContract: CONTRACT,
    tokenId,
    catalogVersion: 1,
    placementManifestVersion: 1,
    sourceLayoutHash: manifest.source.layoutHash,
    backgroundId: null,
    items: defaultItems,
    ...overrides
  };
}

export function customizationPath(tokenId = 3, contract = CONTRACT) {
  return `/v1/customizations/${contract}/${tokenId}`;
}

export async function clearManifestCache(runtime, tokenId) {
  const cacheStorage = await runtime.mf.getCaches();
  return cacheStorage.default.delete(`https://placement.test/holder-placement/v1/tokens/${tokenId}.json`);
}

export async function tableRows(db, sql, ...bindings) {
  const statement = db.prepare(sql).bind(...bindings);
  const result = await statement.all();
  return result?.results || [];
}
