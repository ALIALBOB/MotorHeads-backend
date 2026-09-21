// The Foundry per-token record: switches (overrides) + items, and the three gates — ownership on Ethereum, garage
// activation, parts held by the garage. Runs on the local Miniflare runtime with the OWNERSHIP_RPC mock answering
// ownerOf (control.owners) and any other eth_call (control.callResults: calldata prefix -> result word).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { LOCAL_ORIGIN, ROOT, authenticate, callApi, createRuntime } from "./harness.mjs";
import { assertApi, createSuite, withRuntime } from "./test-support.mjs";
import { SEL } from "../../src/foundry/chain.js";

const ephemeral = () => privateKeyToAccount(generatePrivateKey());
const WORD0 = "0x" + "0".repeat(64), WORD1 = "0x" + "0".repeat(63) + "1";
const GARAGE = "0x" + "0".repeat(24) + "ab".repeat(20);
const ITEMS = (id) => `/v1/foundry/items/${id}`;

function sqlOf(file) { return fs.readFileSync(path.join(ROOT, "migrations", file), "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ").trim(); }
// the record's tables come from the execute-file migrations, not schema.sql — apply the ones a case needs
async function applyMigrations(runtime, files) { for (const f of files) await runtime.db.exec(sqlOf(f)); }
const RECORD_TABLES = ["0003_foundry_items.sql", "0004_foundry_posters.sql"];
const WITH_OVERRIDES = [...RECORD_TABLES, "0006_foundry_overrides.sql"];
const ETH_ONLY = { FOUNDRY_FREE_SWITCHES: "true",   /* this suite tests the RECORD (validation, gates, migrations); that switches are SOLD is tested in foundry-economy-suite */ FOUNDRY_OWNERSHIP: "eth" };   // never touch the Robinhood RPC from a test

function put(runtime, cookie, id, body, ip = "127.2.2.2") {
  return callApi(runtime, ITEMS(id), { method: "PUT", origin: LOCAL_ORIGIN, cookie, headers: { "CF-Connecting-IP": ip }, body });
}

export async function runFoundryItemsSuite() {
  const suite = createSuite("foundry");

  await suite.test("selectors match the garage ABI the site already uses", () => {
    assert.equal(SEL.ownerOf, "0x6352211e");
    assert.equal(SEL.activated, "0x32fad9d8");
    assert.equal(SEL.garageOf, "0x3500754c");
    assert.equal(SEL.balanceOf1155, "0x00fdd58e");
    assert.equal(SEL.activationFeeWei, "0x0ad6c12a");
    return { selectors: SEL };
  });

  await suite.test("GET is public, and a token without a record answers empty switches and items", () =>
    withRuntime(createRuntime, { bindings: ETH_ONLY }, async (runtime) => {
      await applyMigrations(runtime, WITH_OVERRIDES);
      const r = assertApi(await callApi(runtime, ITEMS(7)), 200);
      assert.deepEqual(r.body.items, []); assert.deepEqual(r.body.overrides, {}); assert.equal(r.body.updatedAt, null);
      assert.equal(r.response.headers.get("access-control-allow-origin"), "*");
    }));

  await suite.test("PUT needs a session, and only the Ethereum owner of the 2D token may save", () =>
    withRuntime(createRuntime, { bindings: ETH_ONLY }, async (runtime) => {
      await applyMigrations(runtime, WITH_OVERRIDES);
      const owner = ephemeral(), stranger = ephemeral();
      runtime.control.owners.set(7, owner.address.toLowerCase());
      const anon = await callApi(runtime, ITEMS(7), { method: "PUT", origin: LOCAL_ORIGIN, body: { items: [] } });
      assert.equal(anon.response.status, 401, JSON.stringify(anon.body));
      const s = await authenticate(runtime, stranger, { ip: "127.3.3.3" });
      assertApi(await put(runtime, s.cookie, 7, { items: [], overrides: { head: "carousel" } }), 403, "NOT_OWNER");
      const o = await authenticate(runtime, owner, { ip: "127.3.3.4" });
      const ok = assertApi(await put(runtime, o.cookie, 7, { items: [], overrides: { head: "carousel" } }), 200);
      assert.deepEqual(ok.body.overrides, { head: "carousel" });
    }));

  await suite.test("switches save, read back, and validate against the roster; the colourway is locked", () =>
    withRuntime(createRuntime, { bindings: ETH_ONLY }, async (runtime) => {
      await applyMigrations(runtime, WITH_OVERRIDES);
      const owner = ephemeral(); runtime.control.owners.set(7, owner.address.toLowerCase());
      const o = await authenticate(runtime, owner, { ip: "127.4.4.4" });
      const saved = assertApi(await put(runtime, o.cookie, 7, { items: [{ glb: "tophat" }], overrides: { head: "Carousel", body: "body_cyber", pack: "none", expr: "sly" } }), 200);
      assert.deepEqual(saved.body.overrides, { head: "carousel", body: "body_cyber", pack: "", expr: "sly" });
      const back = assertApi(await callApi(runtime, ITEMS(7)), 200);
      assert.deepEqual(back.body.overrides, { head: "carousel", body: "body_cyber", pack: "", expr: "sly" });
      assert.deepEqual(back.body.items, [{ glb: "tophat" }]);
      assertApi(await put(runtime, o.cookie, 7, { overrides: { head: "not_a_head" } }), 400, "OVERRIDE_UNKNOWN");
      assertApi(await put(runtime, o.cookie, 7, { overrides: { body: "carousel" } }), 400, "OVERRIDE_UNKNOWN");
      assertApi(await put(runtime, o.cookie, 7, { overrides: { expr: "furious" } }), 400, "OVERRIDE_UNKNOWN");
      assertApi(await put(runtime, o.cookie, 7, { overrides: { scheme: "gold" } }), 400, "COLOURWAY_LOCKED");
      assertApi(await put(runtime, o.cookie, 7, { overrides: { colourway: "gold" } }), 400, "COLOURWAY_LOCKED");
      assertApi(await put(runtime, o.cookie, 7, { overrides: { wings: "yes" } }), 400, "OVERRIDES_INVALID");
      assertApi(await put(runtime, o.cookie, 7, { overrides: [] }), 400, "OVERRIDES_INVALID");
      // nothing above may have touched the saved record
      assert.deepEqual(assertApi(await callApi(runtime, ITEMS(7)), 200).body.overrides, { head: "carousel", body: "body_cyber", pack: "", expr: "sly" });
    }));

  await suite.test("a field left out keeps what is saved; null resets the switches; a re-save with no changes stays base", () =>
    withRuntime(createRuntime, { bindings: ETH_ONLY }, async (runtime) => {
      await applyMigrations(runtime, WITH_OVERRIDES);
      const owner = ephemeral(); runtime.control.owners.set(7, owner.address.toLowerCase());
      const o = await authenticate(runtime, owner, { ip: "127.5.5.5" });
      assertApi(await put(runtime, o.cookie, 7, { items: [{ glb: "thugshades" }], overrides: { head: "carousel" } }), 200);
      // the old Bench client sends items only — the switch must survive
      const itemsOnly = assertApi(await put(runtime, o.cookie, 7, { items: [] }), 200);
      assert.deepEqual(itemsOnly.body.overrides, { head: "carousel" }); assert.deepEqual(itemsOnly.body.items, []);
      // switches only — the items must survive
      assertApi(await put(runtime, o.cookie, 7, { items: [{ glb: "tophat" }] }), 200);
      const switchOnly = assertApi(await put(runtime, o.cookie, 7, { overrides: { expr: "angry" } }), 200);
      assert.deepEqual(switchOnly.body.items, [{ glb: "tophat" }]); assert.deepEqual(switchOnly.body.overrides, { expr: "angry" });
      const reset = assertApi(await put(runtime, o.cookie, 7, { overrides: null }), 200);
      assert.deepEqual(reset.body.overrides, {});
      assert.deepEqual(assertApi(await callApi(runtime, ITEMS(7)), 200).body.overrides, {});
    }));

  await suite.test("activation gate: with FOUNDRY_REQUIRE_ACTIVATION a save needs ScrapCrates.activated(tokenId)", () =>
    withRuntime(createRuntime, { bindings: { ...ETH_ONLY, FOUNDRY_REQUIRE_ACTIVATION: "true" } }, async (runtime) => {
      await applyMigrations(runtime, WITH_OVERRIDES);
      const owner = ephemeral(); runtime.control.owners.set(7, owner.address.toLowerCase());
      const o = await authenticate(runtime, owner, { ip: "127.6.6.6" });
      runtime.control.callResults.set(SEL.activated, WORD0);
      const off = assertApi(await put(runtime, o.cookie, 7, { overrides: { head: "carousel" } }), 403, "NOT_ACTIVATED");
      assert.match(off.body.error.message, /not activated/i);   // the error body keeps the redacted production shape (no details)
      runtime.control.callResults.set(SEL.activated, WORD1);
      assertApi(await put(runtime, o.cookie, 7, { overrides: { head: "carousel" } }), 200);
      // the RPC failing is a 503, never a silent pass
      runtime.control.callResults.delete(SEL.activated);
      assertApi(await put(runtime, o.cookie, 7, { overrides: { head: "clock_head" } }), 503, "ACTIVATION_CHECK_UNAVAILABLE");
      const calls = runtime.control.rpcCalls.filter((c) => c.method === "eth_call" && String(c.params[0].data).startsWith(SEL.activated));
      assert.ok(calls.length >= 3, "activated() was read on chain");
      assert.equal(String(calls[0].params[0].to).toLowerCase(), "0x50dc22553988de047a00328963faee8ec5e19b12");
    }));

  await suite.test("parts gate: an item mapped to a ScrapParts id must sit in the token's garage", () =>
    withRuntime(createRuntime, { bindings: { ...ETH_ONLY, FOUNDRY_PART_IDS: JSON.stringify({ items: { tophat: 5 }, head: { carousel: 12 } }) } }, async (runtime) => {
      await applyMigrations(runtime, WITH_OVERRIDES);
      const owner = ephemeral(); runtime.control.owners.set(7, owner.address.toLowerCase());
      const o = await authenticate(runtime, owner, { ip: "127.7.7.7" });
      // unmapped item + unmapped switch: free, no parts read at all
      assertApi(await put(runtime, o.cookie, 7, { items: [{ glb: "thugshades" }], overrides: { head: "clock_head" } }), 200);
      assert.equal(runtime.control.rpcCalls.filter((c) => String(c.params?.[0]?.data || "").startsWith(SEL.garageOf)).length, 0);
      runtime.control.callResults.set(SEL.garageOf, GARAGE);   // already a 32-byte word: 12 zero bytes + the 20-byte address
      runtime.control.callResults.set(SEL.balanceOf1155, WORD0);
      const denied = assertApi(await put(runtime, o.cookie, 7, { items: [{ glb: "tophat" }], overrides: { head: "carousel" } }), 403, "PART_NOT_OWNED");
      assert.match(denied.body.error.message, /parts 5, 12/);   // the missing ids travel in the message, not in details
      runtime.control.callResults.set(SEL.balanceOf1155, WORD1);
      const ok = assertApi(await put(runtime, o.cookie, 7, { items: [{ glb: "tophat" }], overrides: { head: "carousel" } }), 200);
      assert.deepEqual(ok.body.items, [{ glb: "tophat" }]);
      const bal = runtime.control.rpcCalls.filter((c) => String(c.params?.[0]?.data || "").startsWith(SEL.balanceOf1155));
      assert.ok(bal.length >= 2, "balanceOf(garage, id) was read");
      assert.equal(String(bal[0].params[0].to).toLowerCase(), "0x3f6adfe2fa714c28b2c6ec4762d089069675f2a2");
      assert.ok(String(bal[0].params[0].data).toLowerCase().includes("ab".repeat(20)), "queried the token's garage");
    }));

  await suite.test("admin wallets bypass the gates", () =>
    withRuntime(createRuntime, { bindings: { ...ETH_ONLY, FOUNDRY_REQUIRE_ACTIVATION: "true" } }, async (runtime) => {
      await applyMigrations(runtime, WITH_OVERRIDES);
      const admin = ephemeral();
      const rt2 = runtime; rt2.control.owners.set(7, ephemeral().address.toLowerCase());   // someone else owns it
      const a = await authenticate(runtime, admin, { ip: "127.8.8.8" });
      // not an admin yet: refused as a non-owner
      assertApi(await put(runtime, a.cookie, 7, { overrides: { head: "carousel" } }), 403, "NOT_OWNER");
      return { note: "admin list is FOUNDRY_ADMIN_WALLETS (a binding), covered by the next case" };
    }));

  await suite.test("admin wallets bypass the gates (FOUNDRY_ADMIN_WALLETS)", async () => {
    const admin = ephemeral();
    return withRuntime(createRuntime, { bindings: { ...ETH_ONLY, FOUNDRY_REQUIRE_ACTIVATION: "true", FOUNDRY_ADMIN_WALLETS: admin.address } }, async (runtime) => {
      await applyMigrations(runtime, WITH_OVERRIDES);
      runtime.control.owners.set(7, ephemeral().address.toLowerCase());
      const a = await authenticate(runtime, admin, { ip: "127.9.9.9" });
      const ok = assertApi(await put(runtime, a.cookie, 7, { overrides: { head: "carousel" } }), 200);
      assert.deepEqual(ok.body.overrides, { head: "carousel" });
    });
  });

  await suite.test("before migration 0006: reads still work, items still save, a switch answers 503 OVERRIDES_UNAVAILABLE", () =>
    withRuntime(createRuntime, { bindings: ETH_ONLY }, async (runtime) => {
      await applyMigrations(runtime, RECORD_TABLES);
      const owner = ephemeral(); runtime.control.owners.set(7, owner.address.toLowerCase());
      const o = await authenticate(runtime, owner, { ip: "127.10.10.10" });
      assertApi(await put(runtime, o.cookie, 7, { items: [{ glb: "tophat" }] }), 200);
      const back = assertApi(await callApi(runtime, ITEMS(7)), 200);
      assert.deepEqual(back.body.items, [{ glb: "tophat" }]); assert.deepEqual(back.body.overrides, {});
      assertApi(await put(runtime, o.cookie, 7, { overrides: { head: "carousel" } }), 503, "OVERRIDES_UNAVAILABLE");
    }));

  // A poster is rendered at Save and then just SITS in the table — nothing clears it when the robot stops
  // wearing what it shows. #1 was saved in the Thug Shades, the part moved to #48, and #1's poster kept
  // showing glasses it no longer owns while the metadata (correctly) served the plain still: one token,
  // two pictures. The poster now stands in only while the token really is customised, judged on the SAME
  // view of the record the metadata uses — so a part that moved away drops out of it too (that filter has
  // its own regression test in foundry-economy-suite; here the record is emptied directly, which needs no
  // chain and exercises the same rule).
  await suite.test("a saved poster is served only while the robot is still customised", () =>
    withRuntime(createRuntime, { bindings: { ...ETH_ONLY } }, async (runtime) => {
      await applyMigrations(runtime, WITH_OVERRIDES);
      const owner = ephemeral(); runtime.control.owners.set(7, owner.address.toLowerCase());
      runtime.control.owners.set(8, owner.address.toLowerCase());
      const o = await authenticate(runtime, owner, { ip: "127.7.7.9" });
      const JPEG = "data:image/jpeg;base64," + btoa("ÿØÿ" + "p".repeat(64));
      // callApi answers { response, body, text } — the status lives on response, not on the result
      const poster = async (id) => (await callApi(runtime, `/v1/foundry/poster/${id}`)).response.status;

      assert.equal(await poster(7), 404, "a token with no record has nothing to stand in for");

      assertApi(await put(runtime, o.cookie, 7, { items: [{ glb: "thugshades" }], poster: JPEG }), 200);
      assert.equal(await poster(7), 200, "a robot wearing a part shows the poster that was rendered for it");

      assertApi(await put(runtime, o.cookie, 7, { items: [] }), 200);                 // the parts come off
      assert.equal(await poster(7), 404, "once the robot wears nothing, its poster is not its picture any more");

      assertApi(await put(runtime, o.cookie, 7, { items: [{ glb: "thugshades" }] }), 200);
      assert.equal(await poster(7), 200, "putting the part back brings the poster back — the row was kept, not deleted");

      // a SWITCHED robot is customised too, even with no items on it
      assertApi(await put(runtime, o.cookie, 8, { overrides: { head: "clock_head" }, poster: JPEG }), 200);
      assert.equal(await poster(8), 200, "a switched build is a custom robot, so its poster stands");
      assertApi(await put(runtime, o.cookie, 8, { overrides: null }), 200);           // back to base
      assert.equal(await poster(8), 404, "back to the base build, the poster stops standing in");
      return { noRecord: 404, worn: 200, strippedBare: 404, restored: 200, switched: 200, backToBase: 404 };
    }));

  return suite.result();
}
