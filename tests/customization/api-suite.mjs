import assert from "node:assert/strict";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { hashNormalizedState } from "../../src/customization/canonical-state.js";
import {
  CONTRACT,
  LOCAL_ORIGIN,
  TOKEN_MANIFESTS,
  authenticate,
  callApi,
  clearManifestCache,
  createRuntime,
  customizationPath,
  tableRows,
  validState
} from "./harness.mjs";
import { assertApi, createSuite, withRuntime } from "./test-support.mjs";

function ephemeralAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

async function ownedContext(runtime, tokenId = 3, ip = "127.2.0.10") {
  const account = ephemeralAccount();
  runtime.control.owners.set(tokenId, account.address.toLowerCase());
  const auth = await authenticate(runtime, account, { ip });
  return { account, auth };
}

function put(runtime, tokenId, cookie, expectedRevision, state, ip = "127.2.0.20") {
  return callApi(runtime, customizationPath(tokenId), {
    method: "PUT",
    origin: LOCAL_ORIGIN,
    cookie,
    headers: { "CF-Connecting-IP": ip },
    body: { expectedRevision, state }
  });
}

function candidate(itemId, mountZone, adjustment = {}) {
  return {
    itemId,
    mountZone,
    adjustment: { dx: 0, dy: 0, scale: 1, rotation: 0, ...adjustment }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
}

export async function runApiSuite() {
  const suite = createSuite("api");

  await suite.test("valid selected-token manifest is fetched once, transforms clamp, and public GET is minimal", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { account, auth } = await ownedContext(runtime);
      const state = validState(3, {
        items: [candidate("side-panel-test-sticker", "rightSidePanel", {
          dx: 999,
          dy: -999,
          scale: 99,
          rotation: 99
        })]
      });
      const saved = assertApi(await put(runtime, 3, auth.cookie, 0, state), 200);
      assert.equal(saved.body.revision, 1);
      assert.match(saved.body.stateHash, /^0x[0-9a-f]{64}$/);

      const read = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.equal(read.body.exists, true);
      assert.equal(read.body.renderable, true);
      assert.equal(read.body.state.items.length, 1);
      assert.deepEqual(
        {
          dx: read.body.state.items[0].dx,
          dy: read.body.state.items[0].dy,
          scale: read.body.state.items[0].scale,
          rotation: read.body.state.items[0].rotation
        },
        { dx: 33.75, dy: -11.75, scale: 1.25, rotation: 0.349066 }
      );
      for (const field of ["ownerAtSave", "savedBy", "session", "sessionHash", "nonceHash", "signature", "walletHistory"]) {
        assert.equal(field in read.body, false, `public read leaked ${field}`);
      }
      const [internal] = await tableRows(runtime.db, `
        SELECT owner_at_save, saved_by FROM mh_customization_history
        WHERE contract_address = ? AND token_id = ? AND revision = 1
      `, CONTRACT, 3);
      assert.equal(internal.owner_at_save, account.address.toLowerCase());
      assert.equal(internal.saved_by, account.address.toLowerCase());
      assert.equal(runtime.control.manifestCalls.length, 1);
      assert.equal(runtime.control.manifestCalls[0].tokenId, 3);
      return {
        selectedTokenFetches: 1,
        normalizedTransform: { dx: 33.75, dy: -11.75, scale: 1.25, rotation: 0.349066 },
        clamping: ["sticker limits", "selected-token surface bounds"]
      };
    })
  );

  await suite.test("real token 1 protected regions are enforced by the shared validator", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { auth } = await ownedContext(runtime, 1, "127.2.1.10");
      const cases = [
        ["left-shoulder-test-sticker", "leftShoulder", "sellCounter"],
        ["right-shoulder-test-sticker", "rightShoulder", "transferCounter"],
        ["backpack-test-sticker", "backpack", "transferCounter"]
      ];
      for (let index = 0; index < cases.length; index += 1) {
        const [itemId, mountZone, region] = cases[index];
        const state = validState(1, { items: [candidate(itemId, mountZone)] });
        assertApi(await put(runtime, 1, auth.cookie, 0, state, `127.2.1.${20 + index}`), 409, "PROTECTED_REGION_OVERLAP");
      }
      assert.equal((await tableRows(runtime.db, "SELECT * FROM mh_customization_states")).length, 0);
      return { fixtureLayoutHash: TOKEN_MANIFESTS[1].source.layoutHash, rejectedRegions: cases.map((entry) => entry[2]) };
    })
  );

  await suite.test("unknown, coming-soon, visual-pending, pet, Golden, and badge items are not saveable", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { auth } = await ownedContext(runtime, 3, "127.2.2.10");
      const cases = [
        ["not-in-catalog", "rightSidePanel", "ITEM_UNKNOWN"],
        ["shoulder-plate-part", "rightShoulder", "ITEM_NOT_SAVEABLE"],
        ["backpack-pack-part", "backpack", "ITEM_NOT_SAVEABLE"],
        ["holder-pet", "rightShoulder", "ITEM_NOT_SAVEABLE"],
        ["golden-aviator-sunglasses", "eyes", "ITEM_NOT_SAVEABLE"],
        ["archive-chest-badge", "chest", "ITEM_NOT_SAVEABLE"]
      ];
      for (let index = 0; index < cases.length; index += 1) {
        const [itemId, zone, code] = cases[index];
        assertApi(await put(runtime, 3, auth.cookie, 0, validState(3, {
          items: [candidate(itemId, zone)]
        }), `127.2.2.${20 + index}`), 409, code);
      }
      return { rejected: cases.map(([itemId, , code]) => ({ itemId, code })) };
    })
  );

  await suite.test("mount zones, duplicate items, and category limits are enforced", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { auth } = await ownedContext(runtime, 3, "127.2.3.10");
      assertApi(await put(runtime, 3, auth.cookie, 0, validState(3, {
        items: [candidate("side-panel-test-sticker", "headTop")]
      }), "127.2.3.20"), 409, "MOUNT_ZONE_UNSUPPORTED");

      assertApi(await put(runtime, 3, auth.cookie, 0, validState(3, {
        items: [
          candidate("side-panel-test-sticker", "rightSidePanel"),
          candidate("side-panel-test-sticker", "rightSidePanel")
        ]
      }), "127.2.3.21"), 409, "DUPLICATE_ITEM_REJECTED");

      assertApi(await put(runtime, 3, auth.cookie, 0, validState(3, {
        items: [
          candidate("left-shoulder-test-sticker", "leftShoulder", { dy: -36, scale: 0.75 }),
          candidate("right-shoulder-test-sticker", "rightShoulder", { dy: -36, scale: 0.75 }),
          candidate("side-panel-test-sticker", "rightSidePanel"),
          candidate("backpack-test-sticker", "backpack")
        ]
      }), "127.2.3.22"), 409, "CATEGORY_LIMIT_EXCEEDED");
      return { invalidZone: true, duplicateRejected: true, stickerLimit: 3 };
    })
  );

  await suite.test("collection, token, state versions, source hash, and background are bound to the route", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { auth } = await ownedContext(runtime, 3, "127.2.4.10");
      assertApi(await callApi(runtime, customizationPath(3, "0x0000000000000000000000000000000000000001")), 400, "UNSUPPORTED_COLLECTION");
      assertApi(await callApi(runtime, customizationPath(0)), 400, "INVALID_TOKEN_ID");
      assertApi(await callApi(runtime, customizationPath(5556)), 400, "INVALID_TOKEN_ID");

      const mismatches = [
        [{ tokenId: 1 }, 400, "TOKEN_ID_MISMATCH"],
        [{ schemaVersion: 2 }, 409, "STATE_VERSION_MISMATCH"],
        [{ chainId: 8453 }, 409, "STATE_VERSION_MISMATCH"],
        [{ catalogVersion: 2 }, 409, "STATE_VERSION_MISMATCH"],
        [{ placementManifestVersion: 2 }, 409, "STATE_VERSION_MISMATCH"],
        [{ sourceLayoutHash: "f".repeat(64) }, 409, "SOURCE_LAYOUT_HASH_MISMATCH"],
        [{ backgroundId: "orange-archive" }, 409, "BACKGROUND_NOT_SAVEABLE"]
      ];
      for (let index = 0; index < mismatches.length; index += 1) {
        const [override, status, code] = mismatches[index];
        assertApi(await put(runtime, 3, auth.cookie, 0, validState(3, override), `127.2.4.${20 + index}`), status, code);
      }
      return { routeBound: true, versionBound: true, layoutHashBound: true, backgroundsDisabled: true };
    })
  );

  await suite.test("body limits, exact schemas, prototype keys, depth, URLs, images, text, and invalid numbers are rejected before ownerOf", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { auth } = await ownedContext(runtime, 3, "127.2.5.10");
      const path = customizationPath(3);
      const rawRequest = (body, headers = {}) => callApi(runtime, path, {
        method: "PUT",
        origin: LOCAL_ORIGIN,
        cookie: auth.cookie,
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "127.2.5.20", ...headers },
        body
      });

      assertApi(await rawRequest(JSON.stringify({ padding: "x".repeat(33 * 1024) })), 413, "REQUEST_TOO_LARGE");
      assertApi(await rawRequest("not-json"), 400, "INVALID_JSON");
      assertApi(await callApi(runtime, path, {
        method: "PUT",
        origin: LOCAL_ORIGIN,
        cookie: auth.cookie,
        headers: { "Content-Type": "text/plain" },
        body: "{}"
      }), 415, "JSON_CONTENT_TYPE_REQUIRED");

      assertApi(await put(runtime, 3, auth.cookie, 0, { ...validState(3), assetUrl: "https://evil.example/a.svg" }, "127.2.5.21"), 400, "INVALID_REQUEST_SHAPE");
      assertApi(await put(runtime, 3, auth.cookie, 0, { ...validState(3), image: "data:image/svg+xml,<svg/>" }, "127.2.5.22"), 400, "INVALID_REQUEST_SHAPE");
      assertApi(await put(runtime, 3, auth.cookie, 0, { ...validState(3), text: "execute me" }, "127.2.5.23"), 400, "INVALID_REQUEST_SHAPE");
      assertApi(await put(runtime, 3, auth.cookie, 0, validState(3, {
        items: Array.from({ length: 17 }, (_, index) => candidate(`item-${index}`, "rightSidePanel"))
      }), "127.2.5.24"), 400, "ITEM_LIMIT_EXCEEDED");
      assertApi(await put(runtime, 3, auth.cookie, 0, validState(3, {
        items: [candidate("side-panel-test-sticker", "rightSidePanel", { dx: Number.NaN })]
      }), "127.2.5.25"), 400, "INVALID_NUMBER");

      const base = JSON.stringify({ expectedRevision: 0, state: validState(3) });
      const prototypeBody = base.replace(/\}\}$/, ',"__proto__":{"polluted":true}}}');
      assertApi(await rawRequest(prototypeBody), 400, "PROTOTYPE_KEY_REJECTED");
      const deepBody = JSON.stringify({ nested: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } } });
      assertApi(await rawRequest(deepBody), 400, "INVALID_REQUEST_SHAPE");

      assert.equal(runtime.control.rpcCalls.length, 0);
      assert.equal({}.polluted, undefined);
      return { maxBodyBytes: 32768, maxItems: 16, ownerCallsForRejectedBodies: 0, prototypeUnchanged: true };
    })
  );

  await suite.test("canonical normalized-state Keccak hash is deterministic and semantically sensitive", async () => {
    const base = {
      schemaVersion: 1,
      chainId: 1,
      tokenContract: CONTRACT,
      tokenId: 3,
      catalogVersion: 1,
      placementManifestVersion: 1,
      sourceLayoutHash: TOKEN_MANIFESTS[3].source.layoutHash,
      backgroundId: null,
      items: [{ itemId: "side-panel-test-sticker", dx: 0, dy: 0, scale: 1, rotation: 0 }]
    };
    const original = hashNormalizedState(base);
    const reordered = hashNormalizedState(reverseKeys(base));
    const negativeZero = hashNormalizedState({ ...clone(base), items: [{ ...base.items[0], dx: -0 }] });
    assert.equal(original.stateHash, reordered.stateHash);
    assert.equal(original.canonicalJson, reordered.canonicalJson);
    assert.equal(original.stateHash, negativeZero.stateHash);

    const mutations = {
      transform: { ...clone(base), items: [{ ...base.items[0], dx: 1 }] },
      token: { ...clone(base), tokenId: 4 },
      catalog: { ...clone(base), catalogVersion: 2 },
      sourceLayout: { ...clone(base), sourceLayoutHash: "a".repeat(64) }
    };
    for (const value of Object.values(mutations)) assert.notEqual(hashNormalizedState(value).stateHash, original.stateHash);
    return {
      algorithm: "Keccak-256(UTF8(recursive lexicographic canonical JSON))",
      keyOrderInvariant: true,
      negativeZeroNormalized: true,
      changedFieldsAlterHash: Object.keys(mutations)
    };
  });

  await suite.test("manifest cache is selected-token-only and manifest failures preserve current state", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { auth } = await ownedContext(runtime, 3, "127.2.7.10");
      assertApi(await put(runtime, 3, auth.cookie, 0, validState(3), "127.2.7.20"), 200);
      assert.equal(runtime.control.manifestCalls.length, 1);

      runtime.control.manifestMode = "unavailable";
      assertApi(await put(runtime, 3, auth.cookie, 1, validState(3, {
        items: [candidate("side-panel-test-sticker", "rightSidePanel", { dx: 2 })]
      }), "127.2.7.21"), 200);
      assert.equal(runtime.control.manifestCalls.length, 1, "valid cached manifest should avoid another fetch");

      assert.equal(await clearManifestCache(runtime, 3), true);
      assertApi(await put(runtime, 3, auth.cookie, 2, validState(3), "127.2.7.22"), 503, "PLACEMENT_DATA_UNAVAILABLE");
      assert.equal(runtime.control.manifestCalls.length, 3, "transient manifest failure should retry once");
      let read = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.equal(read.body.revision, 2);
      assert.equal(read.body.exists, true);

      runtime.control.manifestMode = "invalid-schema";
      assertApi(await put(runtime, 3, auth.cookie, 2, validState(3), "127.2.7.23"), 503, "PLACEMENT_DATA_INVALID");
      runtime.control.manifestMode = "oversized-no-length";
      assertApi(await put(runtime, 3, auth.cookie, 2, validState(3), "127.2.7.24"), 503, "PLACEMENT_DATA_INVALID");
      read = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.equal(read.body.revision, 2);
      assert.equal((await tableRows(runtime.db, "SELECT * FROM mh_customization_history")).length, 2);
      return { cacheHitAvoidedFetch: true, transientRetries: 1, activeRevisionAfterFailures: 2 };
    })
  );

  await suite.test("D1-backed write limiter blocks excess mutation and resets after its durable window", () =>
    withRuntime(createRuntime, {
      bindings: {
        CUSTOMIZATION_WRITE_RATE_LIMIT: "1",
        CUSTOMIZATION_WRITE_RATE_WINDOW_SECONDS: "60"
      }
    }, async (runtime) => {
      const { auth } = await ownedContext(runtime, 3, "127.2.8.10");
      assertApi(await put(runtime, 3, auth.cookie, 0, validState(3), "127.2.8.20"), 200);
      assertApi(await put(runtime, 3, auth.cookie, 1, validState(3), "127.2.8.21"), 429, "RATE_LIMITED");
      let read = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.equal(read.body.revision, 1);

      await runtime.db.prepare("UPDATE mh_rate_limits SET expires_at = 0 WHERE request_count > 0").run();
      assertApi(await put(runtime, 3, auth.cookie, 1, validState(3, {
        items: [candidate("side-panel-test-sticker", "rightSidePanel", { dx: 1 })]
      }), "127.2.8.22"), 200);
      read = assertApi(await callApi(runtime, customizationPath(3)), 200);
      assert.equal(read.body.revision, 2);
      const buckets = await tableRows(runtime.db, "SELECT request_count, expires_at FROM mh_rate_limits");
      assert.ok(buckets.length >= 3, "auth and write limits should be persisted in D1");
      return { writeLimit: 1, windowSeconds: 60, blockedRevision: 1, postResetRevision: 2, durableStore: "D1" };
    })
  );

  await suite.test("structured errors and feature locks fail closed without queued writes", () =>
    withRuntime(createRuntime, { flags: false }, async (runtime) => {
      const disabled = assertApi(await callApi(runtime, customizationPath(3), {
        method: "PUT",
        origin: LOCAL_ORIGIN,
        body: { expectedRevision: 0, state: validState(3) }
      }), 503, "CUSTOMIZATION_WRITES_DISABLED");
      assert.deepEqual(Object.keys(disabled.body.error).sort(), ["code", "message", "retryable"]);
      assert.equal(disabled.body.error.retryable, false);
      assert.equal((await tableRows(runtime.db, "SELECT * FROM mh_customization_states")).length, 0);
      assert.equal(runtime.control.rpcCalls.length, 0);
      assert.equal(runtime.control.manifestCalls.length, 0);
      return { writesLocked: true, queuedWrites: 0, ownerCalls: 0, manifestCalls: 0 };
    })
  );

  return suite.result();
}
