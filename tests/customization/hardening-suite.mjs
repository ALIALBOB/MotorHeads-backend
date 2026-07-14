import assert from "node:assert/strict";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  CLEANUP_MAX_ROWS,
  cleanupCustomizationData
} from "../../src/customization/cleanup.js";
import { sha256Hex } from "../../src/customization/crypto.js";
import {
  CONTRACT,
  LOCAL_ORIGIN,
  authenticate,
  buildSiweMessage,
  callApi,
  cookiePair,
  createRuntime,
  customizationPath,
  issueNonce,
  tableRows,
  validState
} from "./harness.mjs";
import { assertApi, createSuite, withRuntime } from "./test-support.mjs";

const DAY_SECONDS = 24 * 60 * 60;
const STRICT_ERROR_KEYS = Object.freeze(["code", "message", "retryable"]);

function ephemeralAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

function candidate(itemId, mountZone, adjustment = {}) {
  return {
    itemId,
    mountZone,
    adjustment: { dx: 0, dy: 0, scale: 1, rotation: 0, ...adjustment }
  };
}

function put(runtime, tokenId, cookie, expectedRevision, state, {
  ip = "127.4.0.20",
  headers = {}
} = {}) {
  return callApi(runtime, customizationPath(tokenId), {
    method: "PUT",
    origin: LOCAL_ORIGIN,
    cookie,
    headers: { "CF-Connecting-IP": ip, ...headers },
    body: { expectedRevision, state }
  });
}

async function prepareVerification(runtime, account, {
  signer = account,
  ip = "127.4.0.10",
  existingCookie
} = {}) {
  const nonce = await issueNonce(runtime, account.address, { ip });
  const message = buildSiweMessage(account, nonce);
  const signature = await signer.signMessage({ message });
  const verify = () => callApi(runtime, "/v1/auth/verify", {
    method: "POST",
    origin: LOCAL_ORIGIN,
    cookie: existingCookie,
    headers: { "CF-Connecting-IP": ip },
    body: { message, signature }
  });
  return { nonce, message, signature, verify };
}

async function ownedContext(runtime, tokenId = 3, ip = "127.4.0.10") {
  const account = ephemeralAccount();
  runtime.control.owners.set(tokenId, account.address.toLowerCase());
  const auth = await authenticate(runtime, account, { ip });
  return { account, auth };
}

function strictError(result, status, code) {
  assertApi(result, status, code);
  assert.deepEqual(Object.keys(result.body.error).sort(), [...STRICT_ERROR_KEYS].sort());
  assert.equal(typeof result.body.error.message, "string");
  assert.equal(typeof result.body.error.retryable, "boolean");
  assert.equal(result.response.headers.get("Cache-Control"), "no-store");
  return result;
}

function normalizedKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function collectKeys(value, result = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, nested] of Object.entries(value)) {
    result.push(normalizedKey(key));
    collectKeys(nested, result);
  }
  return result;
}

function assertNoSensitiveContent(result, sensitiveValues = []) {
  const serialized = JSON.stringify(result.body || {}).toLowerCase();
  const forbiddenFragments = [
    "stack",
    "select ",
    "insert ",
    "update ",
    "delete ",
    "mh_auth_",
    "mh_customization_",
    "d:\\",
    "ownership.test",
    "session_hash",
    "nonce_hash",
    "set-cookie"
  ];
  for (const fragment of forbiddenFragments) {
    assert.equal(serialized.includes(fragment), false, `error leaked ${fragment}`);
  }
  for (const value of sensitiveValues.filter(Boolean)) {
    assert.equal(serialized.includes(String(value).toLowerCase()), false, "error leaked request secret");
  }
}

async function installSessionInsertFailure(runtime) {
  await runtime.db.prepare(`
    CREATE TRIGGER fail_mh_auth_session_insert
    BEFORE INSERT ON mh_auth_sessions
    BEGIN
      SELECT RAISE(ABORT, 'forced session insert failure');
    END;
  `).run();
}

async function removeSessionInsertFailure(runtime) {
  await runtime.db.prepare("DROP TRIGGER IF EXISTS fail_mh_auth_session_insert").run();
}

export async function runHardeningSuite() {
  const suite = createSuite("hardening");

  await suite.test("valid EOA succeeds without wallet-type RPC fallback", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const auth = await authenticate(runtime, account, { ip: "127.4.1.10" });
      assert.equal(auth.result.body.address, account.address.toLowerCase());
      assert.equal(runtime.control.rpcCalls.some((call) => call.method === "eth_getCode"), false);
      return { walletType: "EOA", authenticated: true, fallbackRpcCalls: 0 };
    })
  );

  await suite.test("invalid EOA, contract wallet, and wallet-type RPC failure are distinct", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const wrongSigner = ephemeralAccount();

      let prepared = await prepareVerification(runtime, account, {
        signer: wrongSigner,
        ip: "127.4.2.10"
      });
      strictError(await prepared.verify(), 401, "INVALID_WALLET_SIGNATURE");

      runtime.control.contractWallets.add(account.address.toLowerCase());
      prepared = await prepareVerification(runtime, account, {
        signer: wrongSigner,
        ip: "127.4.2.11"
      });
      const contractResult = strictError(
        await prepared.verify(),
        501,
        "CONTRACT_WALLET_AUTH_UNSUPPORTED"
      );
      assert.equal(
        contractResult.body.error.message,
        "Smart-contract wallet authentication is not available in this beta."
      );

      runtime.control.contractWallets.clear();
      runtime.control.walletTypeRpcMode = "unavailable";
      prepared = await prepareVerification(runtime, account, {
        signer: wrongSigner,
        ip: "127.4.2.12"
      });
      strictError(await prepared.verify(), 503, "WALLET_TYPE_CHECK_UNAVAILABLE");
      assert.ok(runtime.control.rpcCalls.filter((call) => call.method === "eth_getCode").length >= 3);
      return {
        invalidEoa: "401 INVALID_WALLET_SIGNATURE",
        contractWallet: "501 CONTRACT_WALLET_AUTH_UNSUPPORTED",
        rpcFailure: "503 WALLET_TYPE_CHECK_UNAVAILABLE"
      };
    })
  );

  await suite.test("session insert failure rolls back nonce consumption and remains retryable", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const prepared = await prepareVerification(runtime, account, { ip: "127.4.3.10" });
      await installSessionInsertFailure(runtime);
      strictError(await prepared.verify(), 503, "AUTH_SESSION_UNAVAILABLE");

      const nonceHash = await sha256Hex(prepared.nonce.nonce);
      const [nonce] = await tableRows(
        runtime.db,
        "SELECT consumed_at, consumed_session_hash FROM mh_auth_nonces WHERE nonce_hash = ?",
        nonceHash
      );
      assert.equal(nonce.consumed_at, null);
      assert.equal(nonce.consumed_session_hash, null);
      assert.equal((await tableRows(runtime.db, "SELECT session_hash FROM mh_auth_sessions")).length, 0);

      await removeSessionInsertFailure(runtime);
      const retry = assertApi(await prepared.verify(), 200);
      assert.ok(cookiePair(retry.response));
      const [consumed] = await tableRows(
        runtime.db,
        "SELECT consumed_at, consumed_session_hash FROM mh_auth_nonces WHERE nonce_hash = ?",
        nonceHash
      );
      assert.ok(Number(consumed.consumed_at) > 0);
      assert.match(consumed.consumed_session_hash, /^[0-9a-f]{64}$/);
      return { rolledBack: ["nonce consumption", "session insert"], safeRetry: true };
    })
  );

  await suite.test("failed replacement session preserves the prior valid session", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const first = await authenticate(runtime, account, { ip: "127.4.4.10" });
      const firstHash = await sha256Hex(first.cookie.split("=", 2)[1]);
      const prepared = await prepareVerification(runtime, account, {
        ip: "127.4.4.11",
        existingCookie: first.cookie
      });

      await installSessionInsertFailure(runtime);
      strictError(await prepared.verify(), 503, "AUTH_SESSION_UNAVAILABLE");
      const [prior] = await tableRows(
        runtime.db,
        "SELECT revoked_at FROM mh_auth_sessions WHERE session_hash = ?",
        firstHash
      );
      assert.equal(prior.revoked_at, null);
      assertApi(await callApi(runtime, "/v1/auth/session", {
        origin: LOCAL_ORIGIN,
        cookie: first.cookie
      }), 200);
      return { priorSessionRevoked: false, priorSessionStillAuthenticates: true };
    })
  );

  await suite.test("only one concurrent nonce verification wins and successful replay fails", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const prepared = await prepareVerification(runtime, account, { ip: "127.4.5.10" });
      const results = await Promise.all([prepared.verify(), prepared.verify()]);
      const statuses = results.map((entry) => entry.response.status).sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 401]);
      const loser = results.find((entry) => entry.response.status === 401);
      strictError(loser, 401, "NONCE_ALREADY_USED");
      assert.equal((await tableRows(runtime.db, "SELECT session_hash FROM mh_auth_sessions")).length, 1);
      strictError(await prepared.verify(), 401, "NONCE_ALREADY_USED");
      return { winners: 1, losers: 1, replayRejected: true, lockType: "D1 transactional batch" };
    })
  );

  await suite.test("cleanup removes only expired auth rows and leaves customization audit data intact", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { account, auth } = await ownedContext(runtime, 3, "127.4.6.10");
      assertApi(await put(runtime, 3, auth.cookie, 0, validState(3), { ip: "127.4.6.11" }), 200);
      const beforeStates = await tableRows(runtime.db, "SELECT * FROM mh_customization_states");
      const beforeHistory = await tableRows(runtime.db, "SELECT * FROM mh_customization_history");
      const now = Math.floor(Date.now() / 1000);

      await runtime.db.batch([
        runtime.db.prepare(`
          INSERT INTO mh_auth_nonces
            (nonce_hash, address_hint, domain, uri, chain_id, issued_at, expires_at, consumed_at)
          VALUES ('cleanup-expired-unused', NULL, 'localhost:5173', ?, 1, ?, ?, NULL)
        `).bind(LOCAL_ORIGIN, now - 9 * DAY_SECONDS, now - 8 * DAY_SECONDS),
        runtime.db.prepare(`
          INSERT INTO mh_auth_nonces
            (nonce_hash, address_hint, domain, uri, chain_id, issued_at, expires_at, consumed_at)
          VALUES ('cleanup-consumed-old', NULL, 'localhost:5173', ?, 1, ?, ?, ?)
        `).bind(LOCAL_ORIGIN, now - 9 * DAY_SECONDS, now + DAY_SECONDS, now - 8 * DAY_SECONDS),
        runtime.db.prepare(`
          INSERT INTO mh_auth_nonces
            (nonce_hash, address_hint, domain, uri, chain_id, issued_at, expires_at, consumed_at)
          VALUES ('cleanup-unexpired', NULL, 'localhost:5173', ?, 1, ?, ?, NULL)
        `).bind(LOCAL_ORIGIN, now, now + DAY_SECONDS),
        runtime.db.prepare(`
          INSERT INTO mh_auth_sessions
            (session_hash, address, created_at, expires_at, last_seen_at, revoked_at)
          VALUES ('cleanup-expired-session', ?, ?, ?, ?, NULL)
        `).bind(account.address.toLowerCase(), now - 40 * DAY_SECONDS, now - 31 * DAY_SECONDS, now - 31 * DAY_SECONDS),
        runtime.db.prepare(`
          INSERT INTO mh_auth_sessions
            (session_hash, address, created_at, expires_at, last_seen_at, revoked_at)
          VALUES ('cleanup-old-revoked', ?, ?, ?, ?, ?)
        `).bind(account.address.toLowerCase(), now - 40 * DAY_SECONDS, now + DAY_SECONDS, now - 31 * DAY_SECONDS, now - 31 * DAY_SECONDS),
        runtime.db.prepare(`
          INSERT INTO mh_auth_sessions
            (session_hash, address, created_at, expires_at, last_seen_at, revoked_at)
          VALUES ('cleanup-active-session', ?, ?, ?, ?, NULL)
        `).bind(account.address.toLowerCase(), now, now + DAY_SECONDS, now),
        runtime.db.prepare(`
          INSERT INTO mh_auth_sessions
            (session_hash, address, created_at, expires_at, last_seen_at, revoked_at)
          VALUES ('cleanup-recent-revoked', ?, ?, ?, ?, ?)
        `).bind(account.address.toLowerCase(), now - DAY_SECONDS, now + DAY_SECONDS, now, now - DAY_SECONDS),
        runtime.db.prepare(`
          INSERT INTO mh_rate_limits (bucket_key, window_started_at, request_count, expires_at)
          VALUES ('cleanup-expired-rate', ?, 1, ?)
        `).bind(now - 4 * DAY_SECONDS, now - 3 * DAY_SECONDS),
        runtime.db.prepare(`
          INSERT INTO mh_rate_limits (bucket_key, window_started_at, request_count, expires_at)
          VALUES ('cleanup-fresh-rate', ?, 1, ?)
        `).bind(now, now + DAY_SECONDS)
      ]);

      const cleaned = await cleanupCustomizationData({ DB: runtime.db }, { nowSeconds: now });
      assert.deepEqual(cleaned.deleted, { nonces: 2, sessions: 2, rateLimitBuckets: 1 });
      const nonceKeys = (await tableRows(runtime.db, "SELECT nonce_hash FROM mh_auth_nonces"))
        .map((row) => row.nonce_hash);
      const sessionKeys = (await tableRows(runtime.db, "SELECT session_hash FROM mh_auth_sessions"))
        .map((row) => row.session_hash);
      const rateKeys = (await tableRows(runtime.db, "SELECT bucket_key FROM mh_rate_limits"))
        .map((row) => row.bucket_key);
      assert.ok(nonceKeys.includes("cleanup-unexpired"));
      assert.ok(sessionKeys.includes("cleanup-active-session"));
      assert.ok(sessionKeys.includes("cleanup-recent-revoked"));
      assert.ok(rateKeys.includes("cleanup-fresh-rate"));

      assert.deepEqual(await tableRows(runtime.db, "SELECT * FROM mh_customization_states"), beforeStates);
      assert.deepEqual(await tableRows(runtime.db, "SELECT * FROM mh_customization_history"), beforeHistory);
      const repeated = await cleanupCustomizationData({ DB: runtime.db }, { nowSeconds: now });
      assert.deepEqual(repeated.deleted, { nonces: 0, sessions: 0, rateLimitBuckets: 0 });
      return {
        deleted: cleaned.deleted,
        activeRowsPreserved: true,
        customizationRowsPreserved: true,
        secondRunDeleted: repeated.deleted
      };
    })
  );

  await suite.test("cleanup enforces a hard 500-row cap even when a caller requests more", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const now = 2_000_000_000;
      await runtime.db.prepare(`
        WITH RECURSIVE rows(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM rows WHERE value < 501
        )
        INSERT INTO mh_rate_limits (bucket_key, window_started_at, request_count, expires_at)
        SELECT 'cleanup-cap-' || printf('%03d', value), 0, 1, ? FROM rows
      `).bind(now - 3 * DAY_SECONDS).run();

      const first = await cleanupCustomizationData(
        { DB: runtime.db },
        { nowSeconds: now, maxRowsPerTable: 50_000 }
      );
      assert.equal(first.maxRowsPerTable, CLEANUP_MAX_ROWS);
      assert.equal(first.deleted.rateLimitBuckets, CLEANUP_MAX_ROWS);
      assert.equal((await tableRows(runtime.db, "SELECT bucket_key FROM mh_rate_limits WHERE bucket_key LIKE 'cleanup-cap-%'")).length, 1);

      const second = await cleanupCustomizationData({ DB: runtime.db }, { nowSeconds: now });
      const third = await cleanupCustomizationData({ DB: runtime.db }, { nowSeconds: now });
      assert.equal(second.deleted.rateLimitBuckets, 1);
      assert.equal(third.deleted.rateLimitBuckets, 0);
      return { requested: 50_000, enforced: CLEANUP_MAX_ROWS, safelyDrainedAcrossRuns: true };
    })
  );

  await suite.test("public reads use short cache windows and stable revision ETags", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const missing = assertApi(await callApi(runtime, customizationPath(3)), 200);
      const missingEtag = missing.response.headers.get("ETag");
      assert.equal(missing.response.headers.get("Cache-Control"), "public, max-age=5");
      assert.match(missingEtag, /^"mh-missing-0"$/);
      const missing304 = await callApi(runtime, customizationPath(3), {
        headers: { "If-None-Match": missingEtag }
      });
      assert.equal(missing304.response.status, 304);
      assert.equal(missing304.text, "");

      const { auth } = await ownedContext(runtime, 3, "127.4.8.10");
      const firstWrite = assertApi(
        await put(runtime, 3, auth.cookie, 0, validState(3), { ip: "127.4.8.11" }),
        200
      );
      assert.equal(firstWrite.response.headers.get("Cache-Control"), "no-store");
      const first = assertApi(await callApi(runtime, customizationPath(3)), 200);
      const firstEtag = first.response.headers.get("ETag");
      assert.equal(first.response.headers.get("Cache-Control"), "public, max-age=15, stale-while-revalidate=30");
      assert.match(firstEtag, /^"mh-1-[0-9a-f]{64}"$/);
      assert.equal((await callApi(runtime, customizationPath(3), {
        headers: { "If-None-Match": firstEtag }
      })).response.status, 304);

      assertApi(await put(runtime, 3, auth.cookie, 1, validState(3, {
        items: [candidate("side-panel-test-sticker", "rightSidePanel", { dx: 1 })]
      }), { ip: "127.4.8.12" }), 200);
      const changed = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.notEqual(changed.response.headers.get("ETag"), firstEtag);

      const nonce = assertApi(await callApi(runtime, "/v1/auth/nonce", {
        method: "POST",
        origin: LOCAL_ORIGIN,
        headers: { "CF-Connecting-IP": "127.4.8.13" },
        body: {}
      }), 200);
      assert.equal(nonce.response.headers.get("Cache-Control"), "no-store");
      assert.equal(auth.result.response.headers.get("Cache-Control"), "no-store");
      assert.equal((await callApi(runtime, "/v1/auth/session", {
        origin: LOCAL_ORIGIN,
        cookie: auth.cookie
      })).response.headers.get("Cache-Control"), "no-store");
      return {
        missingCache: "public, max-age=5",
        existingCache: "public, max-age=15, stale-while-revalidate=30",
        conditional304: true,
        revisionChangesEtag: true,
        authenticatedRoutes: "no-store"
      };
    })
  );

  await suite.test("public state is recursively wallet-private while D1 history retains audit owners", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { account, auth } = await ownedContext(runtime, 3, "127.4.9.10");
      assertApi(await put(runtime, 3, auth.cookie, 0, validState(3), { ip: "127.4.9.11" }), 200);
      const read = assertApi(await callApi(runtime, customizationPath(3)), 200);
      const forbidden = new Set([
        "owneratsave",
        "savedby",
        "session",
        "sessionaddress",
        "sessionhash",
        "noncehash",
        "signature",
        "wallethistory",
        "priorowners",
        "iphash",
        "useragenthash"
      ]);
      for (const key of collectKeys(read.body)) {
        assert.equal(forbidden.has(key), false, `public response leaked ${key}`);
      }
      assert.equal(JSON.stringify(read.body).toLowerCase().includes(account.address.toLowerCase()), false);
      const [history] = await tableRows(
        runtime.db,
        "SELECT owner_at_save, saved_by FROM mh_customization_history WHERE token_id = 3"
      );
      assert.equal(history.owner_at_save, account.address.toLowerCase());
      assert.equal(history.saved_by, account.address.toLowerCase());
      return { publicWalletLinkageFields: 0, internalHistoryOwnersRetained: true };
    })
  );

  await suite.test("legacy wallet headers cannot authenticate customization writes", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { auth } = await ownedContext(runtime, 3, "127.4.10.10");
      const legacyHeaders = {
        "CF-Connecting-IP": "127.4.10.11",
        "X-Wallet-Address": "0x1111111111111111111111111111111111111111",
        "X-Signature": `0x${"11".repeat(65)}`,
        "X-Signed-Message": "legacy header authorization"
      };
      strictError(await put(runtime, 3, null, 0, validState(3), {
        ip: "127.4.10.11",
        headers: legacyHeaders
      }), 401, "AUTHENTICATION_REQUIRED");

      const legacy = await callApi(runtime, "/v1/tokens/3/state", {
        method: "PUT",
        headers: legacyHeaders,
        body: {}
      });
      assertApi(legacy, 501, "signature_verifier_pending");

      assertApi(await put(runtime, 3, auth.cookie, 0, validState(3), {
        ip: "127.4.10.12"
      }), 200);
      strictError(await callApi(runtime, customizationPath(3), {
        method: "DELETE",
        origin: LOCAL_ORIGIN,
        headers: legacyHeaders,
        body: { expectedRevision: 1 }
      }), 401, "AUTHENTICATION_REQUIRED");
      return {
        customizationAcceptsLegacyHeaders: false,
        legacyMutationFlag: "locked",
        sessionCookieRequired: true
      };
    })
  );

  await suite.test("configuration locks fail closed without affecting legacy chain-state", async () => {
    await withRuntime(createRuntime, {
      flags: false,
      bindings: {
        ETH_RPC_URL: "",
        HOLDER_PLACEMENT_BASE_URL: "",
        CUSTOMIZATION_ALLOWED_ORIGINS: "",
        CUSTOMIZATION_SIWE_DOMAIN: "",
        CUSTOMIZATION_SIWE_URI: ""
      }
    }, async (runtime) => {
      strictError(await put(runtime, 3, null, 0, validState(3)), 503, "CUSTOMIZATION_WRITES_DISABLED");
    });

    return withRuntime(createRuntime, {
      bindings: { HOLDER_PLACEMENT_BASE_URL: "" }
    }, async (runtime) => {
      strictError(await put(runtime, 3, null, 0, validState(3)), 503, "CUSTOMIZATION_CONFIGURATION_INVALID");
      assert.equal(runtime.control.rpcCalls.length, 0);
      assert.equal(runtime.control.manifestCalls.length, 0);
      assert.equal((await tableRows(runtime.db, "SELECT * FROM mh_customization_states")).length, 0);

      const chain = assertApi(await callApi(runtime, "/v1/tokens/3/chain-state"), 200);
      assert.equal(chain.body.ok, true);
      assert.equal(chain.body.chainState.tokenId, 3);
      return {
        disabledFlagsWinBeforeConfiguration: true,
        incompleteWriteConfigurationRejected: true,
        queuedWrites: 0,
        legacyChainStateStatus: 200
      };
    });
  });

  await suite.test("representative errors use one redacted production-safe shape", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const wrongSigner = ephemeralAccount();
      const prepared = await prepareVerification(runtime, account, {
        signer: wrongSigner,
        ip: "127.4.12.10"
      });
      const invalidSignature = strictError(await prepared.verify(), 401, "INVALID_WALLET_SIGNATURE");
      assertNoSensitiveContent(invalidSignature, [prepared.signature, prepared.message]);

      const { auth } = await ownedContext(runtime, 3, "127.4.12.11");
      const validation = strictError(await put(runtime, 3, auth.cookie, 0, validState(3, {
        items: [candidate("not-in-catalog", "rightSidePanel")]
      }), { ip: "127.4.12.12" }), 409, "ITEM_UNKNOWN");
      assertNoSensitiveContent(validation, [auth.cookie]);

      runtime.control.rpcMode = "unavailable";
      const ownership = strictError(await put(runtime, 3, auth.cookie, 0, validState(3), {
        ip: "127.4.12.13"
      }), 503, "OWNERSHIP_CHECK_UNAVAILABLE");
      assertNoSensitiveContent(ownership, [auth.cookie]);
      return {
        exactErrorKeys: STRICT_ERROR_KEYS,
        stackSqlPathsRpcUrlsHashesSignaturesCookiesExposed: false
      };
    })
  );

  return suite.result();
}
