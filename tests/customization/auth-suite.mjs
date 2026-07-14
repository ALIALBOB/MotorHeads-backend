import assert from "node:assert/strict";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { sha256Hex } from "../../src/customization/crypto.js";
import {
  CONTRACT,
  LOCAL_ORIGIN,
  PRODUCTION_ORIGIN,
  authenticate,
  buildSiweMessage,
  callApi,
  cookiePair,
  createRuntime,
  customizationPath,
  issueNonce,
  tableRows
} from "./harness.mjs";
import { assertApi, createSuite, withRuntime } from "./test-support.mjs";

function ephemeralAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

async function signedVerify(runtime, account, nonce, overrides = {}, signer = account, options = {}) {
  const message = buildSiweMessage(account, nonce, overrides);
  const signature = await signer.signMessage({ message });
  return callApi(runtime, "/v1/auth/verify", {
    method: "POST",
    origin: options.origin ?? LOCAL_ORIGIN,
    headers: { "CF-Connecting-IP": options.ip || "127.0.0.20" },
    body: { message, signature }
  });
}

export async function runAuthSuite() {
  const suite = createSuite("auth");

  await suite.test("nonce uses at least 128 bits, is unique, and only its hash is stored", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const first = await issueNonce(runtime, account.address, { ip: "127.0.1.10" });
      const second = await issueNonce(runtime, account.address, { ip: "127.0.1.11" });
      assert.match(first.nonce, /^[0-9a-f]{32}$/);
      assert.match(second.nonce, /^[0-9a-f]{32}$/);
      assert.notEqual(first.nonce, second.nonce);
      const rows = await tableRows(runtime.db, "SELECT nonce_hash, address_hint FROM mh_auth_nonces ORDER BY issued_at");
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.nonce_hash)));
      assert.ok(rows.every((row) => row.nonce_hash !== first.nonce && row.nonce_hash !== second.nonce));
      const expectedFirstHash = await sha256Hex(first.nonce);
      const expectedSecondHash = await sha256Hex(second.nonce);
      assert.ok(rows.some((row) => row.nonce_hash === expectedFirstHash));
      assert.ok(rows.some((row) => row.nonce_hash === expectedSecondHash));
      return { entropyBits: 128, stored: "SHA-256 only", unique: true };
    })
  );

  await suite.test("valid SIWE verification creates a hashed local session and exact local cookie", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const auth = await authenticate(runtime, account, { ip: "127.0.2.10" });
      const setCookie = auth.result.response.headers.get("Set-Cookie");
      assert.match(setCookie, /^mh_session_dev=[0-9a-f]{64};/i);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
      assert.match(setCookie, /Path=\//i);
      assert.doesNotMatch(setCookie, /; Secure/i);
      assert.doesNotMatch(setCookie, /Domain=/i);

      const session = assertApi(await callApi(runtime, "/v1/auth/session", {
        origin: LOCAL_ORIGIN,
        cookie: auth.cookie
      }), 200);
      assert.equal(session.body.authenticated, true);
      assert.equal(session.body.address, account.address.toLowerCase());

      const rows = await tableRows(runtime.db, "SELECT session_hash, address FROM mh_auth_sessions");
      assert.equal(rows.length, 1);
      const rawToken = auth.cookie.split("=", 2)[1];
      assert.equal(rows[0].session_hash, await sha256Hex(rawToken));
      assert.notEqual(rows[0].session_hash, rawToken);
      return { cryptographicVerification: true, sessionStored: "SHA-256 only", cookie: "local host-only HttpOnly" };
    })
  );

  await suite.test("nonce replay is rejected after successful verification", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const auth = await authenticate(runtime, account, { ip: "127.0.3.10" });
      assertApi(await callApi(runtime, "/v1/auth/verify", {
        method: "POST",
        origin: LOCAL_ORIGIN,
        headers: { "CF-Connecting-IP": "127.0.3.10" },
        body: { message: auth.message, signature: auth.signature }
      }), 401, "NONCE_ALREADY_USED");
      return { oneTimeNonce: true };
    })
  );

  await suite.test("SIWE domain, URI, chain, statement, issued-at, and expiration are enforced", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const cases = [
        [{ domain: "evil.example" }, "SIWE_DOMAIN_MISMATCH"],
        [{ uri: "https://evil.example" }, "SIWE_URI_MISMATCH"],
        [{ chainId: 8453 }, "SIWE_CHAIN_MISMATCH"],
        [{ statement: "Authorize something else." }, "SIWE_STATEMENT_MISMATCH"],
        [{ issuedAt: new Date(Date.now() + 120_000) }, "SIWE_ISSUED_AT_INVALID"],
        [{ expirationTime: new Date(Date.now() - 1_000) }, "SIWE_EXPIRED"],
        [{ notBefore: new Date(Date.now() + 60_000) }, "SIWE_NOT_BEFORE_INVALID"]
      ];
      for (let index = 0; index < cases.length; index += 1) {
        const [overrides, code] = cases[index];
        const nonce = await issueNonce(runtime, account.address, { ip: `127.0.4.${10 + index}` });
        assertApi(await signedVerify(runtime, account, nonce, overrides, account, {
          ip: `127.0.5.${10 + index}`
        }), 401, code);
      }
      return { contextsRejected: cases.map(([, code]) => code) };
    })
  );

  await suite.test("malformed, mismatched, invalid, expired, and hinted-address signatures are rejected", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const accountA = ephemeralAccount();
      const accountB = ephemeralAccount();
      assertApi(await callApi(runtime, "/v1/auth/verify", {
        method: "POST",
        origin: LOCAL_ORIGIN,
        body: { message: "bad", signature: "0x00" }
      }), 400, "MALFORMED_SIWE_MESSAGE");

      const mismatchNonce = await issueNonce(runtime, accountA.address, { ip: "127.0.6.10" });
      assertApi(await signedVerify(runtime, accountA, mismatchNonce, {}, accountB, { ip: "127.0.6.11" }), 401, "INVALID_WALLET_SIGNATURE");

      const invalidNonce = await issueNonce(runtime, accountA.address, { ip: "127.0.6.12" });
      const invalidMessage = buildSiweMessage(accountA, invalidNonce);
      assertApi(await callApi(runtime, "/v1/auth/verify", {
        method: "POST",
        origin: LOCAL_ORIGIN,
        headers: { "CF-Connecting-IP": "127.0.6.13" },
        body: { message: invalidMessage, signature: `0x${"00".repeat(65)}` }
      }), 401, "INVALID_WALLET_SIGNATURE");

      const hintNonce = await issueNonce(runtime, accountA.address, { ip: "127.0.6.14" });
      const hintMessage = buildSiweMessage(accountB, hintNonce);
      const hintSignature = await accountB.signMessage({ message: hintMessage });
      assertApi(await callApi(runtime, "/v1/auth/verify", {
        method: "POST",
        origin: LOCAL_ORIGIN,
        headers: { "CF-Connecting-IP": "127.0.6.15" },
        body: { message: hintMessage, signature: hintSignature }
      }), 401, "SIWE_ADDRESS_MISMATCH");

      const expiredNonce = await issueNonce(runtime, accountA.address, { ip: "127.0.6.16" });
      await runtime.db.prepare("UPDATE mh_auth_nonces SET expires_at = 0 WHERE consumed_at IS NULL").run();
      assertApi(await signedVerify(runtime, accountA, expiredNonce, {}, accountA, { ip: "127.0.6.17" }), 401, "NONCE_EXPIRED");
      return { rejected: ["malformed", "recovered-address mismatch", "invalid signature", "address hint mismatch", "expired nonce"] };
    })
  );

  await suite.test("session expiration, logout revocation, and cookie clearing are enforced", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const expired = await authenticate(runtime, account, { ip: "127.0.7.10" });
      await runtime.db.prepare("UPDATE mh_auth_sessions SET expires_at = 0 WHERE revoked_at IS NULL").run();
      assertApi(await callApi(runtime, "/v1/auth/session", {
        origin: LOCAL_ORIGIN,
        cookie: expired.cookie
      }), 401, "SESSION_INVALID");

      const active = await authenticate(runtime, account, { ip: "127.0.7.11" });
      const logout = assertApi(await callApi(runtime, "/v1/auth/logout", {
        method: "POST",
        origin: LOCAL_ORIGIN,
        cookie: active.cookie,
        body: {}
      }), 200);
      assert.match(logout.response.headers.get("Set-Cookie"), /Max-Age=0/);
      assertApi(await callApi(runtime, "/v1/auth/session", {
        origin: LOCAL_ORIGIN,
        cookie: active.cookie
      }), 401, "SESSION_INVALID");
      return { expirationRejected: true, logoutRevoked: true, cookieCleared: true };
    })
  );

  await suite.test("reauthentication rotates the session and revokes the prior request session", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const account = ephemeralAccount();
      const first = await authenticate(runtime, account, { ip: "127.0.8.10" });
      const second = await authenticate(runtime, account, {
        ip: "127.0.8.10",
        existingCookie: first.cookie
      });
      assert.notEqual(first.cookie, second.cookie);
      const rows = await tableRows(runtime.db, "SELECT revoked_at FROM mh_auth_sessions ORDER BY created_at, session_hash");
      assert.equal(rows.length, 2);
      assert.equal(rows.filter((row) => row.revoked_at !== null).length, 1);
      assert.equal(rows.filter((row) => row.revoked_at === null).length, 1);
      return { activeSessions: 1, revokedSessions: 1 };
    })
  );

  await suite.test("future production cookie is __Host-, Secure, HttpOnly, Lax, and host-only", () =>
    withRuntime(createRuntime, {
      bindings: {
        CUSTOMIZATION_SIWE_DOMAIN: "motorheadsonline.com",
        CUSTOMIZATION_SIWE_URI: PRODUCTION_ORIGIN,
        CUSTOMIZATION_COOKIE_SECURE: "true"
      }
    }, async (runtime) => {
      const account = ephemeralAccount();
      const auth = await authenticate(runtime, account, {
        origin: PRODUCTION_ORIGIN,
        ip: "127.0.9.10"
      });
      const value = auth.result.response.headers.get("Set-Cookie");
      assert.match(value, /^__Host-mh_session=[0-9a-f]{64};/i);
      assert.match(value, /; Secure/i);
      assert.match(value, /; HttpOnly/i);
      assert.match(value, /; SameSite=Lax/i);
      assert.match(value, /; Path=\//i);
      assert.doesNotMatch(value, /Domain=/i);
      return { name: "__Host-mh_session", secure: true, httpOnly: true, sameSite: "Lax", domainAttribute: false };
    })
  );

  await suite.test("authenticated CORS is exact while public reads retain wildcard non-credentialed CORS", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const valid = assertApi(await callApi(runtime, "/v1/auth/nonce", {
        method: "POST",
        origin: LOCAL_ORIGIN,
        headers: { "CF-Connecting-IP": "127.0.10.10" },
        body: {}
      }), 200);
      assert.equal(valid.response.headers.get("Access-Control-Allow-Origin"), LOCAL_ORIGIN);
      assert.equal(valid.response.headers.get("Access-Control-Allow-Credentials"), "true");
      assert.equal(valid.response.headers.get("Vary"), "Origin");

      const invalid = assertApi(await callApi(runtime, "/v1/auth/nonce", {
        method: "POST",
        origin: "https://evil.example",
        body: {}
      }), 403, "ORIGIN_NOT_ALLOWED");
      assert.equal(invalid.response.headers.get("Access-Control-Allow-Origin"), null);

      const preflight = assertApi(await callApi(runtime, "/v1/auth/nonce", {
        method: "OPTIONS",
        origin: LOCAL_ORIGIN,
        headers: { "Access-Control-Request-Method": "POST" }
      }), 204);
      assert.equal(preflight.response.headers.get("Access-Control-Allow-Origin"), LOCAL_ORIGIN);

      const badPreflight = assertApi(await callApi(runtime, "/v1/auth/nonce", {
        method: "OPTIONS",
        origin: "https://evil.example",
        headers: { "Access-Control-Request-Method": "POST" }
      }), 403, "ORIGIN_NOT_ALLOWED");
      assert.equal(badPreflight.response.headers.get("Access-Control-Allow-Origin"), null);

      const publicRead = assertApi(await callApi(runtime, customizationPath(3), {
        origin: "https://any-reader.example"
      }), 200);
      assert.equal(publicRead.response.headers.get("Access-Control-Allow-Origin"), "*");
      assert.equal(publicRead.response.headers.get("Access-Control-Allow-Credentials"), null);
      return { authOrigin: "exact", credentials: true, publicOrigin: "*", publicCredentials: false };
    })
  );

  await suite.test("nonce and verify application limits are enforced and expired windows reset", async () => {
    await withRuntime(createRuntime, {
      bindings: {
        CUSTOMIZATION_NONCE_RATE_LIMIT: "1",
        CUSTOMIZATION_NONCE_RATE_WINDOW_SECONDS: "60"
      }
    }, async (runtime) => {
      const account = ephemeralAccount();
      await issueNonce(runtime, account.address, { ip: "127.0.11.10" });
      assertApi(await callApi(runtime, "/v1/auth/nonce", {
        method: "POST",
        origin: LOCAL_ORIGIN,
        headers: { "CF-Connecting-IP": "127.0.11.10" },
        body: { address: account.address }
      }), 429, "RATE_LIMITED");
      await runtime.db.prepare("UPDATE mh_rate_limits SET expires_at = 0").run();
      await issueNonce(runtime, account.address, { ip: "127.0.11.10" });
    });

    await withRuntime(createRuntime, {
      bindings: {
        CUSTOMIZATION_VERIFY_RATE_LIMIT: "1",
        CUSTOMIZATION_VERIFY_RATE_WINDOW_SECONDS: "60"
      }
    }, async (runtime) => {
      const account = ephemeralAccount();
      await authenticate(runtime, account, { ip: "127.0.12.10" });
      const nonce = await issueNonce(runtime, account.address, { ip: "127.0.12.11" });
      assertApi(await signedVerify(runtime, account, nonce, {}, account, { ip: "127.0.12.10" }), 429, "RATE_LIMITED");
    });
    return { nonceLimit: true, verifyLimit: true, windowReset: true };
  });

  await suite.test("all production-default customization feature flags fail closed", () =>
    withRuntime(createRuntime, { flags: false }, async (runtime) => {
      assertApi(await callApi(runtime, "/v1/auth/nonce", {
        method: "POST",
        origin: LOCAL_ORIGIN,
        body: {}
      }), 503, "CUSTOMIZATION_AUTH_DISABLED");
      const disabledRead = assertApi(await callApi(runtime, customizationPath(3)), 503, "CUSTOMIZATION_READS_DISABLED");
      assert.equal(disabledRead.response.headers.get("Cache-Control"), "no-store");
      assertApi(await callApi(runtime, customizationPath(3), {
        method: "PUT",
        origin: LOCAL_ORIGIN,
        body: { expectedRevision: 0, state: {} }
      }), 503, "CUSTOMIZATION_WRITES_DISABLED");
      return { reads: "locked", auth: "locked", writes: "locked" };
    })
  );

  return suite.result();
}
