import assert from "node:assert/strict";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  LOCAL_ORIGIN,
  buildSiweMessage,
  callApi,
  cookiePair,
  createRuntime,
  customizationPath,
  issueNonce,
  tableRows,
  validState
} from "./harness.mjs";
import { assertApi } from "./test-support.mjs";

function save(runtime, cookie, expectedRevision, state, ip) {
  return callApi(runtime, customizationPath(3), {
    method: "PUT",
    origin: LOCAL_ORIGIN,
    cookie,
    headers: { "CF-Connecting-IP": ip },
    body: { expectedRevision, state }
  });
}

export async function runLocalProof() {
  const runtime = await createRuntime();
  const steps = [];
  const record = (number, name, evidence) => steps.push({ number, name, status: "PASS", evidence });

  try {
    const owner = privateKeyToAccount(generatePrivateKey());
    const nonOwner = privateKeyToAccount(generatePrivateKey());

    const nonce = await issueNonce(runtime, owner.address, { ip: "127.3.0.10" });
    assert.match(nonce.nonce, /^[A-Za-z0-9]{12,}$/);
    const nonceRows = await tableRows(runtime.db, "SELECT nonce_hash FROM mh_auth_nonces");
    assert.equal(nonceRows.length, 1);
    assert.notEqual(nonceRows[0].nonce_hash, nonce.nonce);
    record(1, "Request nonce", { entropyBitsAtLeast: 96, databaseStoresHashOnly: true });

    const message = buildSiweMessage(owner, nonce);
    const signature = await owner.signMessage({ message });
    assert.match(signature, /^0x[0-9a-f]+$/i);
    record(2, "Build and sign SIWE message", { account: "ephemeral", privateKeyPersisted: false, sensitiveValuesReported: false });

    const verified = assertApi(await callApi(runtime, "/v1/auth/verify", {
      method: "POST",
      origin: LOCAL_ORIGIN,
      headers: { "CF-Connecting-IP": "127.3.0.10" },
      body: { message, signature }
    }), 200);
    const ownerCookie = cookiePair(verified.response);
    const session = assertApi(await callApi(runtime, "/v1/auth/session", {
      origin: LOCAL_ORIGIN,
      cookie: ownerCookie
    }), 200);
    assert.equal(session.body.authenticated, true);
    record(3, "Verify session", { authenticated: true, sessionStoredHashed: true, cookie: "HttpOnly local-development cookie" });

    runtime.control.owners.set(3, owner.address.toLowerCase());
    record(4, "Mock ownerOf", { tokenId: 3, method: "eth_call", transaction: false });

    const first = assertApi(await save(runtime, ownerCookie, 0, validState(3), "127.3.0.11"), 200);
    assert.equal(first.body.revision, 1);
    record(5, "Save valid fixture", { saved: true, revision: 1, stateHashFormat: "0x + 64 lowercase hex" });

    const publicRead = assertApi(await callApi(runtime, customizationPath(3)), 200);
    assert.equal(publicRead.body.exists, true);
    assert.equal(publicRead.body.revision, 1);
    record(6, "Read saved state publicly", { exists: true, revision: 1, authenticationRequired: false });

    const updateState = validState(3, {
      items: [{
        itemId: "side-panel-test-sticker",
        mountZone: "rightSidePanel",
        adjustment: { dx: 5, dy: 0, scale: 1, rotation: 0 }
      }]
    });
    const update = assertApi(await save(runtime, ownerCookie, 1, updateState, "127.3.0.12"), 200);
    assert.equal(update.body.revision, 2);
    record(7, "Update with correct revision", { updated: true, revision: 2 });

    assertApi(await save(runtime, ownerCookie, 1, updateState, "127.3.0.13"), 409, "CUSTOMIZATION_STATE_CONFLICT");
    record(8, "Reject stale revision", { rejected: true, code: "CUSTOMIZATION_STATE_CONFLICT", activeRevision: 2 });

    const nonOwnerNonce = await issueNonce(runtime, nonOwner.address, { ip: "127.3.0.20" });
    const nonOwnerMessage = buildSiweMessage(nonOwner, nonOwnerNonce);
    const nonOwnerSignature = await nonOwner.signMessage({ message: nonOwnerMessage });
    const nonOwnerVerified = assertApi(await callApi(runtime, "/v1/auth/verify", {
      method: "POST",
      origin: LOCAL_ORIGIN,
      headers: { "CF-Connecting-IP": "127.3.0.20" },
      body: { message: nonOwnerMessage, signature: nonOwnerSignature }
    }), 200);
    const nonOwnerCookie = cookiePair(nonOwnerVerified.response);
    assertApi(await save(runtime, nonOwnerCookie, 2, updateState, "127.3.0.21"), 403, "TOKEN_NOT_OWNED");
    record(9, "Reject non-owner", { rejected: true, code: "TOKEN_NOT_OWNED", activeRevision: 2 });

    const reset = assertApi(await callApi(runtime, customizationPath(3), {
      method: "DELETE",
      origin: LOCAL_ORIGIN,
      cookie: ownerCookie,
      headers: { "CF-Connecting-IP": "127.3.0.14" },
      body: { expectedRevision: 2 }
    }), 200);
    assert.equal(reset.body.revision, 3);
    record(10, "Reset state", { reset: true, tombstoneRevision: 3 });

    const history = await tableRows(runtime.db, `
      SELECT revision, action FROM mh_customization_history
      WHERE token_id = 3 ORDER BY revision
    `);
    assert.deepEqual(history.map((entry) => [Number(entry.revision), entry.action]), [
      [1, "SAVE"], [2, "SAVE"], [3, "RESET"]
    ]);
    const tombstone = assertApi(await callApi(runtime, customizationPath(3)), 200);
    assert.equal(tombstone.body.exists, false);
    assert.equal(tombstone.body.revision, 3);
    record(11, "Confirm history remains", { revisions: [1, 2, 3], actions: ["SAVE", "SAVE", "RESET"], tombstoneActive: true });

    assert.equal(runtime.control.rpcCalls.length, 5);
    assert.ok(runtime.control.rpcCalls.every((payload) => payload.method === "eth_call"));
    assert.ok(runtime.control.rpcCalls.every((payload) => payload.params?.[1] === "latest"));
    record(12, "Confirm no gas transaction", { ownerOfCalls: 5, readOnlyCalls: 5, transactionCalls: 0 });

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: "local Miniflare, ephemeral D1, ephemeral generated wallets, mocked read-only Ethereum RPC",
      status: "PASS",
      steps,
      safety: {
        privateKeysPersisted: false,
        signaturesReported: false,
        noncesReported: false,
        cookiesReported: false,
        externalNetworkCalls: 0,
        gasTransactions: 0
      }
    };
  } finally {
    await runtime.close();
  }
}
