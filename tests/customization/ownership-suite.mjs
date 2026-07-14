import assert from "node:assert/strict";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  CONTRACT,
  LOCAL_ORIGIN,
  authenticate,
  callApi,
  createRuntime,
  customizationPath,
  tableRows,
  validState
} from "./harness.mjs";
import { assertApi, createSuite, withRuntime } from "./test-support.mjs";

function ephemeralAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

function save(runtime, cookie, expectedRevision, state, ip) {
  return callApi(runtime, customizationPath(3), {
    method: "PUT",
    origin: LOCAL_ORIGIN,
    cookie,
    headers: { "CF-Connecting-IP": ip },
    body: { expectedRevision, state }
  });
}

function reset(runtime, cookie, expectedRevision, ip) {
  return callApi(runtime, customizationPath(3), {
    method: "DELETE",
    origin: LOCAL_ORIGIN,
    cookie,
    headers: { "CF-Connecting-IP": ip },
    body: { expectedRevision }
  });
}

export async function runOwnershipSuite() {
  const suite = createSuite("ownership");

  await suite.test("token-bound state survives transfer and current owner alone can mutate it", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const ownerA = ephemeralAccount();
      const ownerB = ephemeralAccount();
      runtime.control.owners.set(3, ownerA.address.toLowerCase());
      const authA = await authenticate(runtime, ownerA, { ip: "127.1.1.10" });
      const authB = await authenticate(runtime, ownerB, { ip: "127.1.1.20" });

      assertApi(await save(runtime, authB.cookie, 0, validState(3), "127.1.1.21"), 403, "TOKEN_NOT_OWNED");

      const first = assertApi(await save(runtime, authA.cookie, 0, validState(3), "127.1.1.11"), 200);
      assert.equal(first.body.saved, true);
      assert.equal(first.body.revision, 1);
      assert.match(first.body.stateHash, /^0x[0-9a-f]{64}$/);

      const beforeTransfer = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.equal(beforeTransfer.body.exists, true);
      assert.equal("ownerAtSave" in beforeTransfer.body, false);

      runtime.control.owners.set(3, ownerB.address.toLowerCase());
      const ownerAUpdate = validState(3, {
        items: [{
          itemId: "side-panel-test-sticker",
          mountZone: "rightSidePanel",
          adjustment: { dx: 4, dy: 2, scale: 1.05, rotation: 0.1 }
        }]
      });
      assertApi(await save(runtime, authA.cookie, 1, ownerAUpdate, "127.1.1.12"), 403, "TOKEN_NOT_OWNED");

      const inherited = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.equal(inherited.body.exists, true);
      assert.equal(inherited.body.revision, 1);
      assert.equal("ownerAtSave" in inherited.body, false);

      const ownerBUpdate = validState(3, {
        items: [{
          itemId: "side-panel-test-sticker",
          mountZone: "rightSidePanel",
          adjustment: { dx: 12, dy: -3, scale: 1.1, rotation: 0.2 }
        }]
      });
      const second = assertApi(await save(runtime, authB.cookie, 1, ownerBUpdate, "127.1.1.22"), 200);
      assert.equal(second.body.revision, 2);

      const afterTransfer = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.equal("ownerAtSave" in afterTransfer.body, false);
      assert.equal(afterTransfer.body.revision, 2);

      return {
        initialOwnerRejectedForNonOwner: true,
        priorOwnerRejectedAfterTransfer: true,
        stateSurvivedTransfer: true,
        newOwnerUpdatedInheritedState: true
      };
    })
  );

  await suite.test("ownership RPC failure and nonexistent-token responses preserve active state and history", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const owner = ephemeralAccount();
      runtime.control.owners.set(3, owner.address.toLowerCase());
      const auth = await authenticate(runtime, owner, { ip: "127.1.2.10" });
      assertApi(await save(runtime, auth.cookie, 0, validState(3), "127.1.2.11"), 200);

      runtime.control.rpcMode = "unavailable";
      assertApi(await reset(runtime, auth.cookie, 1, "127.1.2.12"), 503, "OWNERSHIP_CHECK_UNAVAILABLE");
      let current = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.equal(current.body.exists, true);
      assert.equal(current.body.revision, 1);
      assert.equal((await tableRows(runtime.db, "SELECT * FROM mh_customization_history")).length, 1);

      runtime.control.rpcMode = "ok";
      runtime.control.nonexistentTokens.add(3);
      assertApi(await reset(runtime, auth.cookie, 1, "127.1.2.13"), 404, "TOKEN_NOT_FOUND");
      current = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.equal(current.body.exists, true);
      assert.equal(current.body.revision, 1);
      assert.equal((await tableRows(runtime.db, "SELECT * FROM mh_customization_history")).length, 1);

      return { rpcFailurePreserved: true, nonexistentTokenPreserved: true };
    })
  );

  await suite.test("reset creates a tombstone, revisions never reuse, and history remains ordered", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const ownerA = ephemeralAccount();
      const ownerB = ephemeralAccount();
      runtime.control.owners.set(3, ownerA.address.toLowerCase());
      const authA = await authenticate(runtime, ownerA, { ip: "127.1.3.10" });
      const authB = await authenticate(runtime, ownerB, { ip: "127.1.3.20" });

      assertApi(await save(runtime, authA.cookie, 0, validState(3), "127.1.3.11"), 200);
      runtime.control.owners.set(3, ownerB.address.toLowerCase());
      assertApi(await save(runtime, authB.cookie, 1, validState(3, {
        items: [{
          itemId: "side-panel-test-sticker",
          mountZone: "rightSidePanel",
          adjustment: { dx: 5, dy: 0, scale: 1, rotation: 0 }
        }]
      }), "127.1.3.21"), 200);

      const resetResult = assertApi(await reset(runtime, authB.cookie, 2, "127.1.3.22"), 200);
      assert.equal(resetResult.body.reset, true);
      assert.equal(resetResult.body.revision, 3);

      const tombstone = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.deepEqual(tombstone.body, {
        exists: false,
        contractAddress: CONTRACT,
        tokenId: 3,
        revision: 3,
        state: null,
        renderable: false
      });

      assertApi(await save(runtime, authB.cookie, 2, validState(3), "127.1.3.23"), 409, "CUSTOMIZATION_STATE_CONFLICT");
      const fourth = assertApi(await save(runtime, authB.cookie, 3, validState(3), "127.1.3.24"), 200);
      assert.equal(fourth.body.revision, 4);

      const history = await tableRows(runtime.db, `
        SELECT revision, action, owner_at_save, saved_by
        FROM mh_customization_history
        WHERE contract_address = ? AND token_id = ? ORDER BY revision
      `, CONTRACT, 3);
      assert.deepEqual(history.map((entry) => [Number(entry.revision), entry.action]), [
        [1, "SAVE"], [2, "SAVE"], [3, "RESET"], [4, "SAVE"]
      ]);
      assert.equal(history[0].owner_at_save, ownerA.address.toLowerCase());
      assert.ok(history.slice(1).every((entry) => entry.saved_by === ownerB.address.toLowerCase()));

      return { tombstoneRevision: 3, resumedRevision: 4, actions: history.map((entry) => entry.action) };
    })
  );

  await suite.test("every mutation performs a fresh read-only ownerOf eth_call", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const owner = ephemeralAccount();
      runtime.control.owners.set(3, owner.address.toLowerCase());
      const auth = await authenticate(runtime, owner, { ip: "127.1.4.10" });

      assertApi(await save(runtime, auth.cookie, 0, validState(3), "127.1.4.11"), 200);
      assertApi(await save(runtime, auth.cookie, 1, validState(3, {
        items: [{
          itemId: "side-panel-test-sticker",
          mountZone: "rightSidePanel",
          adjustment: { dx: 1, dy: 0, scale: 1, rotation: 0 }
        }]
      }), "127.1.4.12"), 200);
      assertApi(await reset(runtime, auth.cookie, 2, "127.1.4.13"), 200);

      assert.equal(runtime.control.rpcCalls.length, 3);
      assert.ok(runtime.control.rpcCalls.every((payload) => payload.method === "eth_call"));
      assert.ok(runtime.control.rpcCalls.every((payload) => payload.params?.[1] === "latest"));
      assert.ok(runtime.control.rpcCalls.every((payload) => payload.params?.[0]?.to === CONTRACT));
      return { mutationCount: 3, ownerOfCalls: 3, transactionMethods: 0 };
    })
  );

  return suite.result();
}
