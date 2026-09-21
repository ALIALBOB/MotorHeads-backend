// The ETH-only Foundry economy: price list, on-chain activation as tier 1, upgrades paid by a VERIFIED ETH transfer to
// the treasury (every refusal path), one-use transaction hashes, and 333 Archive attachments (+5% each, max 5).
// RPC is mocked: ownerOf via control.owners (any ERC-721 — robots and archives share the map by id), eth_call prefixes via
// control.callResults, whole methods via control.rpcMethods.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { LOCAL_ORIGIN, ROOT, authenticate, callApi, createRuntime } from "./harness.mjs";
import { assertApi, createSuite, withRuntime } from "./test-support.mjs";
import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters } from "viem";
import { SEL, SEL_AGGREGATE3 } from "../../src/foundry/chain.js";
import { TIER_STEP_WEI, weightOf } from "../../src/foundry/economy.js";

const ephemeral = () => privateKeyToAccount(generatePrivateKey());
const MC_ABI = [{ name: "aggregate3", type: "function", stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] }],
  outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] }];
const WORD0 = "0x" + "0".repeat(64), WORD1 = "0x" + "0".repeat(63) + "1";
const TREASURY = "0x95A6fB3087b3469Ed777120052E0ac3f262c81C1";
const hex = (n) => "0x" + BigInt(n).toString(16);
const HASH = (n) => "0x" + String(n).padStart(64, "a");
const sqlOf = (f) => fs.readFileSync(path.join(ROOT, "migrations", f), "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
const post = (runtime, cookie, route, body, ip = "127.20.0.1") => callApi(runtime, "/v1/foundry/" + route, { method: "POST", origin: LOCAL_ORIGIN, cookie, headers: { "CF-Connecting-IP": ip }, body });

// a mined, successful, 3-confirmation transfer unless overridden
function payment(control, { from, to = TREASURY, value, status = "0x1", block = 100, head = 102, missing = false, pending = false }) {
  control.rpcMethods.set("eth_getTransactionByHash", () => (missing ? null : { from, to, value: hex(value), hash: HASH(1) }));
  control.rpcMethods.set("eth_getTransactionReceipt", () => (missing || pending ? null : { status, blockNumber: hex(block) }));
  control.rpcMethods.set("eth_blockNumber", hex(head));
}
async function setup(runtime, { activated = true } = {}) {
  await runtime.db.exec(sqlOf("0007_foundry_economy.sql"));
  const owner = ephemeral(); runtime.control.owners.set(7, owner.address.toLowerCase()); runtime.control.owners.set(8, owner.address.toLowerCase());
  runtime.control.callResults.set(SEL.activated, activated ? WORD1 : WORD0);
  const auth = await authenticate(runtime, owner, { ip: "127.20.0.2" });
  return { owner, cookie: auth.cookie };
}

export async function runFoundryEconomySuite() {
  const suite = createSuite("economy");

  await suite.test("the price list is public, in ETH, and doubles from the activation fee", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const r = assertApi(await callApi(runtime, "/v1/foundry/economy"), 200);
      assert.equal(r.body.currency, "ETH"); assert.equal(r.body.treasury.toLowerCase(), TREASURY.toLowerCase());
      assert.deepEqual(r.body.tiers.map((t) => t.weight), [1, 2.5, 6, 12, 22]);
      assert.deepEqual(r.body.tiers.map((t) => t.stepWei), ["6700000000000000", "13400000000000000", "26800000000000000", "53600000000000000", "107200000000000000"]);
      for (let t = 2; t <= 5; t++) assert.equal(TIER_STEP_WEI[t], TIER_STEP_WEI[t - 1] * 2n);
      assert.equal(r.body.tiers[0].onChain, true); assert.equal(r.body.archive333.max, 5); assert.equal(r.body.archive333.bonusEach, 0.05); assert.equal(r.body.itemBonusCap, 0.05);
      assert.equal(r.response.headers.get("access-control-allow-origin"), "*");
      assert.equal(weightOf(5, 5, 0.2), 28.6);   // 22 x (1 + 0.25 + 0.05): both bonuses capped
      assert.equal(weightOf(0, 5), 0);           // not activated = earns nothing, whatever is attached
    }));

  await suite.test("state: not activated = tier 0 and weight 0; activated on chain = tier 1", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      await setup(runtime, { activated: false });
      let s = assertApi(await callApi(runtime, "/v1/foundry/state/7"), 200);
      assert.equal(s.body.tier, 0); assert.equal(s.body.weight, 0); assert.deepEqual(s.body.next, { tier: 1, priceWei: "6700000000000000", onChain: true });
      runtime.control.callResults.set(SEL.activated, WORD1);
      s = assertApi(await callApi(runtime, "/v1/foundry/state/7"), 200);
      assert.equal(s.body.tier, 1); assert.equal(s.body.weight, 1); assert.deepEqual(s.body.next, { tier: 2, priceWei: "13400000000000000", onChain: false });
      assertApi(await callApi(runtime, "/v1/foundry/state/9999"), 400, "TOKEN_INVALID");
    }));

  await suite.test("upgrade: a verified payment moves the robot exactly one tier, step by step to the top", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { owner, cookie } = await setup(runtime);
      for (let t = 2; t <= 5; t++) {
        payment(runtime.control, { from: owner.address, value: TIER_STEP_WEI[t] });
        const r = assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(t) }), 200);
        assert.equal(r.body.tier, t); assert.equal(r.body.weight, [0, 1, 2.5, 6, 12, 22][t]);
      }
      payment(runtime.control, { from: owner.address, value: TIER_STEP_WEI[5] });
      assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(9) }), 409, "MAX_TIER");
      assert.equal(assertApi(await callApi(runtime, "/v1/foundry/state/7"), 200).body.next, null);
    }));

  await suite.test("upgrade refuses every payment that is not a confirmed transfer of the right amount from that wallet to the treasury", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { owner, cookie } = await setup(runtime); const price = TIER_STEP_WEI[2], c = runtime.control;
      assertApi(await callApi(runtime, "/v1/foundry/upgrade", { method: "POST", origin: LOCAL_ORIGIN, body: { tokenId: 7, txHash: HASH(1) } }), 401);
      assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: "0x123" }), 400, "TX_INVALID");
      payment(c, { from: owner.address, value: price, missing: true });            assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(1) }), 404, "TX_NOT_FOUND");
      payment(c, { from: owner.address, value: price, pending: true });            assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(1) }), 409, "TX_PENDING");
      payment(c, { from: owner.address, value: price, status: "0x0" });            assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(1) }), 400, "TX_FAILED");
      payment(c, { from: ephemeral().address, value: price });                     assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(1) }), 403, "TX_WRONG_SENDER");
      payment(c, { from: owner.address, to: ephemeral().address, value: price });  assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(1) }), 400, "TX_WRONG_RECIPIENT");
      payment(c, { from: owner.address, value: price - 1n });                      assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(1) }), 400, "TX_UNDERPAID");
      payment(c, { from: owner.address, value: price, block: 100, head: 100 });    assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(1) }), 409, "TX_UNCONFIRMED");
      c.rpcMethods.clear();                                                        assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(1) }), 503, "PAYMENT_CHECK_UNAVAILABLE");
      // nothing above may have moved the tier or recorded a payment
      assert.equal(assertApi(await callApi(runtime, "/v1/foundry/state/7"), 200).body.tier, 1);
      assert.equal((await runtime.db.prepare("SELECT COUNT(*) AS n FROM mh_eth_payments").first()).n, 0);
    }));

  await suite.test("a transaction hash pays for one thing, once; and only the owner of an ACTIVATED robot can upgrade", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { owner, cookie } = await setup(runtime);
      payment(runtime.control, { from: owner.address, value: TIER_STEP_WEI[2] });
      assertApi(await post(runtime, cookie, "upgrade", { tokenId: 7, txHash: HASH(2) }), 200);
      assertApi(await post(runtime, cookie, "upgrade", { tokenId: 8, txHash: HASH(2) }), 409, "TX_ALREADY_USED");       // same money, second robot
      assert.equal(assertApi(await callApi(runtime, "/v1/foundry/state/8"), 200).body.tier, 1);
      const stranger = ephemeral(), s = await authenticate(runtime, stranger, { ip: "127.20.0.9" });
      payment(runtime.control, { from: stranger.address, value: TIER_STEP_WEI[2] });
      assertApi(await post(runtime, s.cookie, "upgrade", { tokenId: 8, txHash: HASH(3) }), 403, "NOT_OWNER");
      runtime.control.callResults.set(SEL.activated, WORD0);
      payment(runtime.control, { from: owner.address, value: TIER_STEP_WEI[2] });
      assertApi(await post(runtime, cookie, "upgrade", { tokenId: 8, txHash: HASH(4) }), 409, "NOT_ACTIVATED");
    }));

  await suite.test("333 Archive: +5% each, five at most, one robot at a time, and the current holder can always free it", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { owner, cookie } = await setup(runtime); const o = owner.address.toLowerCase();
      for (const id of [301, 302, 303, 304, 305, 306]) runtime.control.owners.set(id, o);
      let r = assertApi(await post(runtime, cookie, "attach333", { tokenId: 7, archiveId: 301 }), 200);
      assert.deepEqual(r.body.attached333, [301]); assert.equal(r.body.weight, 1.05);
      assertApi(await post(runtime, cookie, "attach333", { tokenId: 8, archiveId: 301 }), 409, "ARCHIVE_BOUND");
      for (const id of [302, 303, 304, 305]) assertApi(await post(runtime, cookie, "attach333", { tokenId: 7, archiveId: id }), 200);
      assert.equal(assertApi(await callApi(runtime, "/v1/foundry/state/7"), 200).body.weight, 1.25);
      assertApi(await post(runtime, cookie, "attach333", { tokenId: 7, archiveId: 306 }), 409, "ARCHIVE_LIMIT");
      runtime.control.owners.set(307, ephemeral().address.toLowerCase());
      assertApi(await post(runtime, cookie, "attach333", { tokenId: 8, archiveId: 307 }), 403, "ARCHIVE_NOT_OWNED");
      // the archive is sold: its NEW holder frees it, without owning the robot
      const buyer = ephemeral(), b = await authenticate(runtime, buyer, { ip: "127.20.0.7" }); runtime.control.owners.set(305, buyer.address.toLowerCase());
      r = assertApi(await post(runtime, b.cookie, "detach333", { archiveId: 305 }), 200); assert.equal(r.body.detached, true); assert.equal(r.body.weight, 1.2);
      assertApi(await post(runtime, b.cookie, "detach333", { archiveId: 301 }), 403, "NOT_OWNER");          // …but nobody else's
      r = assertApi(await post(runtime, cookie, "detach333", { archiveId: 301 }), 200); assert.deepEqual(r.body.attached333, [302, 303, 304]);
    }));

  await suite.test("parts shop: public price list in ETH; a verified payment gives the part to the ROBOT and its bonus to the weight (capped)", () =>
    withRuntime(createRuntime, {}, async (runtime) => {
      const { owner, cookie } = await setup(runtime); await runtime.db.exec(sqlOf("0008_foundry_shop.sql"));
      const cat = assertApi(await callApi(runtime, "/v1/foundry/catalogue"), 200);
      assert.equal(cat.body.currency, "ETH"); assert.deepEqual(cat.body.items.map((i) => i.key), ["tophat", "aviatorduck", "thugshades", "steamgoggles"]);
      assert.equal(cat.body.items[0].priceWei, "2000000000000000"); assert.equal(cat.body.items[0].bonus, 0.01); assert.equal(cat.response.headers.get("access-control-allow-origin"), "*");
      const price = 2000000000000000n;
      payment(runtime.control, { from: owner.address, value: price });
      const r = assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "tophat", txHash: HASH(11) }), 200);
      assert.deepEqual(r.body.items, ["tophat"]); assert.equal(r.body.itemBonus, 0.01); assert.equal(r.body.weight, 1.01);
      assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "tophat", txHash: HASH(12) }), 409, "ITEM_OWNED");          // once per robot
      assertApi(await post(runtime, cookie, "buy", { tokenId: 8, itemKey: "tophat", txHash: HASH(11) }), 409, "TX_ALREADY_USED");     // the same money never buys twice
      assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "jetpack", txHash: HASH(13) }), 404, "ITEM_UNKNOWN");
      payment(runtime.control, { from: owner.address, value: price - 1n });
      assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "aviatorduck", txHash: HASH(14) }), 400, "TX_UNDERPAID");
      const stranger = ephemeral(), s = await authenticate(runtime, stranger, { ip: "127.20.0.19" });
      payment(runtime.control, { from: stranger.address, value: price });
      assertApi(await post(runtime, s.cookie, "buy", { tokenId: 7, itemKey: "aviatorduck", txHash: HASH(15) }), 403, "NOT_OWNER");
      runtime.control.callResults.set(SEL.activated, WORD0); payment(runtime.control, { from: owner.address, value: price });
      assertApi(await post(runtime, cookie, "buy", { tokenId: 8, itemKey: "aviatorduck", txHash: HASH(16) }), 409, "NOT_ACTIVATED");
      // the cap: whatever the parts add up to, a robot never gets more than +5% from them
      runtime.control.callResults.set(SEL.activated, WORD1);
      await runtime.db.exec("UPDATE mh_foundry_catalogue SET bonus = 0.04");
      payment(runtime.control, { from: owner.address, value: price }); assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "aviatorduck", txHash: HASH(17) }), 200);
      const st = assertApi(await callApi(runtime, "/v1/foundry/state/7"), 200); assert.equal(st.body.itemBonus, 0.05); assert.equal(st.body.weight, 1.05);
    }));

  await suite.test("parts shop: the Bench refuses to save a part the robot has not bought; only the treasury edits the price list", () =>
    withRuntime(createRuntime, { bindings: { FOUNDRY_OWNERSHIP: "eth" } }, async (runtime) => {
      const { owner, cookie } = await setup(runtime); for (const f of ["0003_foundry_items.sql", "0004_foundry_posters.sql", "0006_foundry_overrides.sql", "0008_foundry_shop.sql"]) await runtime.db.exec(sqlOf(f));
      const put = (body) => callApi(runtime, "/v1/foundry/items/7", { method: "PUT", origin: LOCAL_ORIGIN, cookie, headers: { "CF-Connecting-IP": "127.20.0.1" }, body });
      const refused = assertApi(await put({ items: [{ glb: "tophat" }] }), 403, "ITEM_NOT_OWNED"); assert.match(refused.body.error.message, /Top Hat/);
      payment(runtime.control, { from: owner.address, value: 2000000000000000n });
      assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "tophat", txHash: HASH(21) }), 200);
      assertApi(await put({ items: [{ glb: "tophat" }] }), 200);
      assertApi(await put({ items: [{ glb: "tophat" }, { glb: "aviatorduck" }] }), 403, "ITEM_NOT_OWNED");
      // price list: the owner of a robot is not an admin
      assertApi(await callApi(runtime, "/v1/foundry/catalogue/tophat", { method: "PUT", origin: LOCAL_ORIGIN, cookie, headers: { "CF-Connecting-IP": "127.20.0.1" }, body: { priceWei: "1" } }), 403, "ADMIN_ONLY");
      assert.equal(assertApi(await callApi(runtime, "/v1/foundry/catalogue"), 200).body.items[0].priceWei, "2000000000000000");
      assertApi(await callApi(runtime, "/v1/foundry/payments", { origin: LOCAL_ORIGIN, cookie }), 403, "ADMIN_ONLY");
    }));

  await suite.test("site fee: $1 in ETH rides on every payment, and a Bench save needs a fee payment of its own (used once, taken last)", () =>
    withRuntime(createRuntime, { bindings: { FOUNDRY_SITE_FEE_USD: "1" } }, async (runtime) => {
      const { owner, cookie } = await setup(runtime); for (const f of ["0003_foundry_items.sql", "0004_foundry_posters.sql", "0006_foundry_overrides.sql", "0008_foundry_shop.sql"]) await runtime.db.exec(sqlOf(f));
      const save = (body) => callApi(runtime, "/v1/foundry/items/7", { method: "PUT", origin: LOCAL_ORIGIN, cookie, headers: { "CF-Connecting-IP": "127.20.0.1" }, body });
      // the quote is public and in ETH (the price feed is not mocked here, so this is the fixed fallback quote)
      const q = assertApi(await callApi(runtime, "/v1/foundry/economy"), 200).body.siteFee; assert.equal(q.usd, 1); assert.equal(q.wei, "300000000000000"); assert.equal(q.source, "fallback");
      // buying at the bare price is now an underpayment; price + fee is accepted
      payment(runtime.control, { from: owner.address, value: 2000000000000000n });
      assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "tophat", txHash: HASH(71) }), 400, "TX_UNDERPAID");
      payment(runtime.control, { from: owner.address, value: 2000000000000000n + 300000000000000n });
      assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "tophat", txHash: HASH(72) }), 200);
      // a save: no fee -> 402 with the amount; an unowned part is refused BEFORE the fee is touched; then the fee is used exactly once
      const need = assertApi(await save({ items: [{ glb: "tophat" }] }), 402, "FEE_REQUIRED"); assert.match(need.body.error.message, /0\.0003 ETH/);
      payment(runtime.control, { from: owner.address, value: 300000000000000n });
      assertApi(await save({ items: [{ glb: "aviatorduck" }], feeTx: HASH(73) }), 403, "ITEM_NOT_OWNED");
      assertApi(await save({ items: [{ glb: "tophat" }], feeTx: HASH(73) }), 200);
      assertApi(await save({ items: [], feeTx: HASH(73) }), 409, "TX_ALREADY_USED");
      payment(runtime.control, { from: owner.address, value: 10000000000000n });
      assertApi(await save({ items: [], feeTx: HASH(74) }), 400, "TX_UNDERPAID");
      const kinds = (await runtime.db.prepare("SELECT kind FROM mh_eth_payments ORDER BY created_at, kind").all()).results.map((r) => r.kind).sort();
      assert.deepEqual(kinds, ["feesave", "item"]);
      // the TREASURY/admin never charges itself, and the page knows it: the amount sent and the amount expected must agree,
      // or an admin's own upgrade fails TX_UNDERPAID (caught before the founder's first real-ETH test)
      const admin2 = ephemeral();
      await withRuntime(createRuntime, { bindings: { FOUNDRY_SITE_FEE_USD: "1", FOUNDRY_ADMIN_WALLETS: admin2.address } }, async (r2) => {
        await r2.db.exec(sqlOf("0007_foundry_economy.sql"));
        for (const f of ["0003_foundry_items.sql", "0004_foundry_posters.sql", "0006_foundry_overrides.sql", "0008_foundry_shop.sql"]) await r2.db.exec(sqlOf(f));
        r2.control.owners.set(7, admin2.address.toLowerCase()); r2.control.callResults.set(SEL.activated, WORD1);
        const ck = (await authenticate(r2, admin2, { ip: "127.20.0.44" })).cookie;
        payment(r2.control, { from: admin2.address, value: 2000000000000000n });   // the bare price, no fee
        assertApi(await post(r2, ck, "buy", { tokenId: 7, itemKey: "tophat", txHash: HASH(81) }), 200);
        assertApi(await callApi(r2, "/v1/foundry/items/7", { method: "PUT", origin: LOCAL_ORIGIN, cookie: ck, headers: { "CF-Connecting-IP": "127.20.0.1" }, body: { items: [] } }), 200);   // …and no fee on a save either
      });
    }));

  await suite.test("custom builds: no free switch — a head is switched only to a CUSTOM build the robot bought; old switches are kept", () => {
    const admin = ephemeral();
    return withRuntime(createRuntime, { bindings: { FOUNDRY_ADMIN_WALLETS: admin.address } }, async (runtime) => {
      const { owner, cookie } = await setup(runtime); for (const f of ["0003_foundry_items.sql", "0004_foundry_posters.sql", "0006_foundry_overrides.sql", "0008_foundry_shop.sql", "0010_foundry_crates.sql", "0012_foundry_custom_builds.sql"]) await runtime.db.exec(sqlOf(f));
      const sign = async (acct) => { const message = "MotorHeads Admin Access\nWallet: " + acct.address + "\nTime: " + new Date().toISOString(); return { "x-wallet-address": acct.address, "x-signature": await acct.signMessage({ message }), "x-signed-message": btoa(message), "CF-Connecting-IP": "127.20.0.31" }; };
      const putCat = async (key, body) => callApi(runtime, "/v1/foundry/catalogue/" + key, { method: "PUT", origin: LOCAL_ORIGIN, headers: await sign(admin), body });
      const save = (body) => callApi(runtime, "/v1/foundry/items/7", { method: "PUT", origin: LOCAL_ORIGIN, cookie, headers: { "CF-Connecting-IP": "127.20.0.1" }, body });
      const HEADS = (await import("../../src/foundry/roster.js")).default.heads, H1 = HEADS[3], H2 = HEADS[4];
      // a build now has a part number, so the switch gate reads the garage on chain: answer it, so "not owned" is a real
      // answer and not the RPC refusing (the chain helpers now throw rather than report an empty answer as "owns nothing")
      const GARAGE = "0x" + "b1".repeat(20);
      runtime.control.callResults.set(SEL_AGGREGATE3, (data) => { const { args } = decodeFunctionData({ abi: MC_ABI, data });
        return encodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", result: args[0].map((c) => { const sel = c.callData.slice(0, 10).toLowerCase();
          if (sel === SEL.garageOf.toLowerCase()) return { success: true, returnData: "0x" + GARAGE.slice(2).padStart(64, "0") };
          if (sel === SEL.balanceOf1155.toLowerCase()) return { success: true, returnData: "0x".padEnd(66, "0") };   // the garage holds nothing
          return { success: false, returnData: "0x" }; }) }); });
      // a robot switched while switching was free keeps that look through later saves
      await runtime.db.prepare("INSERT INTO mh_foundry_items (token_id, items, overrides, wallet, updated_at) VALUES (7, '[]', ?, ?, 1)").bind(JSON.stringify({ head: H2 }), owner.address.toLowerCase()).run();
      assertApi(await save({ items: [] }), 200); assertApi(await save({ overrides: { head: H2 } }), 200);
      // nothing is for sale yet: every new switch is refused
      assertApi(await save({ overrides: { head: H1 } }), 403, "SWITCH_NOT_FOR_SALE"); assertApi(await save({ overrides: { head: H2, pack: "" } }), 403, "SWITCH_NOT_FOR_SALE");
      // the admin puts a custom head on sale: it must be a real head, and its kind is fixed
      assertApi(await putCat("not_a_head", { kind: "head", name: "X", priceWei: "1" }), 400, "BUILD_UNKNOWN"); assertApi(await putCat(H1, { kind: "wings", name: "X", priceWei: "1" }), 400, "KIND_INVALID");
      const cat = assertApi(await putCat(H1, { kind: "head", name: "Custom Head", priceWei: "4000000000000000", bonus: 0.02 }), 200).body.catalogue;
      assert.equal(cat.find((c) => c.key === H1).kind, "head");
      // a build must get a ScrapParts id of its own, or the forge could never sell it (founder 2026-09-20)
      const built = cat.find((c) => c.key === H1);
      assert.ok(built.partId > 100, "a custom build needs its own part number, got " + built.partId);
      assert.ok(!cat.some((c) => c.key !== H1 && c.partId === built.partId), "two catalogue rows share a part number"); assert.equal(cat.find((c) => c.key === "tophat").kind, "item"); assertApi(await putCat(H1, { kind: "body" }), 400, "KIND_LOCKED");
      assert.equal(assertApi(await callApi(runtime, "/v1/foundry/catalogue"), 200).body.items.find((c) => c.key === H1).kind, "head");
      // on sale, but this robot has not bought it
      assertApi(await save({ overrides: { head: H1 } }), 403, "SWITCH_NOT_OWNED");
      assertApi(await save({ items: [{ glb: H1 }] }), 400, "ITEM_UNKNOWN");                                   // a build is never a wearable part
      payment(runtime.control, { from: owner.address, value: 4000000000000000n });
      assert.equal(assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: H1, txHash: HASH(61) }), 200).body.itemBonus, 0.02);
      assert.deepEqual(assertApi(await save({ overrides: { head: H1 } }), 200).body.overrides, { head: H1 });
      assert.deepEqual(assertApi(await save({ overrides: {} }), 200).body.overrides, {});                       // back to base is always free
      assertApi(await save({ overrides: { head: H2 } }), 403, "SWITCH_NOT_FOR_SALE");                          // …and the old free switch is gone once dropped
    });
  });

  await suite.test("parts shop admin: the /admin panel's signed message re-prices, adds and retires parts, and reads the payments log", () => {
    const admin = ephemeral();
    return withRuntime(createRuntime, { bindings: { FOUNDRY_ADMIN_WALLETS: admin.address } }, async (runtime) => {
      const { owner, cookie } = await setup(runtime); await runtime.db.exec(sqlOf("0008_foundry_shop.sql"));
      const sign = async (acct, when = new Date()) => { const message = "MotorHeads Admin Access\nWallet: " + acct.address + "\nTime: " + when.toISOString(); return { "x-wallet-address": acct.address, "x-signature": await acct.signMessage({ message }), "x-signed-message": btoa(message), "CF-Connecting-IP": "127.20.0.30" }; };
      const putCat = async (key, body, headers) => callApi(runtime, "/v1/foundry/catalogue/" + key, { method: "PUT", origin: LOCAL_ORIGIN, headers, body });
      let r = assertApi(await putCat("tophat", { priceWei: "5000000000000000", bonus: 0.02 }, await sign(admin)), 200);
      assert.equal(r.body.catalogue.find((c) => c.key === "tophat").priceWei, "5000000000000000");
      assertApi(await putCat("tophat", { priceWei: "1" }, await sign(owner)), 403, "ADMIN_ONLY");                                   // signed, but not an admin
      assertApi(await putCat("tophat", { priceWei: "1" }, await sign(admin, new Date(Date.now() - 3600e3))), 403, "ADMIN_ONLY");    // a stale signature is worthless
      assertApi(await putCat("tophat", { priceWei: "1.5" }, await sign(admin)), 400, "PRICE_INVALID");
      assertApi(await putCat("tophat", { bonus: 0.2 }, await sign(admin)), 400, "BONUS_INVALID");
      assertApi(await putCat("jetpack", { name: "Jet Pack", priceWei: "3000000000000000", bonus: 0.01, sort: 9 }, await sign(admin)), 200);
      assertApi(await putCat("thugshades", { active: false }, await sign(admin)), 200);
      // Retiring takes a part off SALE — it does not erase it. The public list still names every part and
      // flags which are on sale, because somebody already owns a retired one (or was granted a commission
      // that was never on sale at all) and their Bench has to be able to name it and put it on.
      const pub = assertApi(await callApi(runtime, "/v1/foundry/catalogue"), 200).body.items;
      assert.deepEqual(pub.map((i) => i.key), ["tophat", "aviatorduck", "thugshades", "steamgoggles", "jetpack"]);
      assert.equal(pub.find((c) => c.key === "thugshades").active, false);                                                             // …flagged, so the shop skips it
      assert.deepEqual(pub.filter((c) => c.active !== false).map((c) => c.key), ["tophat", "aviatorduck", "steamgoggles", "jetpack"]);
      // and being listed is NOT being on sale: nobody can buy a retired part, whatever they send
      assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "thugshades", txHash: HASH(30) }), 404, "ITEM_UNKNOWN");
      const all = assertApi(await callApi(runtime, "/v1/foundry/catalogue?all=1", { origin: LOCAL_ORIGIN, headers: await sign(admin) }), 200).body.items;
      assert.equal(all.length, 5); assert.equal(all.find((c) => c.key === "thugshades").active, false);                                 // …and the admin list is unchanged
      // the new price is the price: the old one is now an underpayment
      payment(runtime.control, { from: owner.address, value: 2000000000000000n });
      assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "tophat", txHash: HASH(31) }), 400, "TX_UNDERPAID");
      payment(runtime.control, { from: owner.address, value: 5000000000000000n });
      assert.equal(assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "tophat", txHash: HASH(32) }), 200).body.itemBonus, 0.02);
      const log = assertApi(await callApi(runtime, "/v1/foundry/payments", { origin: LOCAL_ORIGIN, headers: await sign(admin) }), 200).body.payments;
      assert.equal(log.length, 1); assert.equal(log[0].kind, "item"); assert.equal(log[0].ref, "tophat"); assert.equal(log[0].valueWei, "5000000000000000");
    });
  });

  await suite.test("a part MOVED to another robot stops showing on the old one — but never over an RPC blip", () =>
    withRuntime(createRuntime, { bindings: { FOUNDRY_OWNERSHIP: "eth" } }, async (runtime) => {
      const { cookie } = await setup(runtime); for (const f of ["0003_foundry_items.sql", "0004_foundry_posters.sql", "0006_foundry_overrides.sql", "0008_foundry_shop.sql", "0010_foundry_crates.sql"]) await runtime.db.exec(sqlOf(f));
      const GARAGE7 = "0x" + "7".repeat(40); let holds = true, chainUp = true;
      runtime.control.callResults.set(SEL_AGGREGATE3, (data) => { if (!chainUp) throw new Error("rpc down");
        const { args } = decodeFunctionData({ abi: MC_ABI, data });
        return encodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", result: args[0].map((c) => { const sel = c.callData.slice(0, 10).toLowerCase();
          if (sel === SEL.garageOf.toLowerCase()) return { success: true, returnData: "0x" + GARAGE7.slice(2).padStart(64, "0") };
          if (sel === SEL.balanceOf1155.toLowerCase()) { const pid = Number(BigInt("0x" + c.callData.slice(74))); return { success: true, returnData: "0x" + BigInt(holds && pid === 102 ? 1 : 0).toString(16).padStart(64, "0") }; }
          return { success: false, returnData: "0x" }; }) }); });
      const get = async () => assertApi(await callApi(runtime, "/v1/foundry/items/7"), 200).body;
      assertApi(await callApi(runtime, "/v1/foundry/items/7", { method: "PUT", origin: LOCAL_ORIGIN, cookie, headers: { "CF-Connecting-IP": "127.20.0.1" }, body: { items: [{ glb: "aviatorduck" }] } }), 200);
      { const r = await get(); assert.deepEqual(r.items.map((i) => i.glb), ["aviatorduck"]); assert.deepEqual(r.names, { aviatorduck: "Aviator Duck" }); assert.equal(r.state.parts, 1); }
      holds = false;                                                                        // the owner moved it to another robot
      { const r = await get(); assert.deepEqual(r.items, [], "the old robot must stop wearing a part it no longer holds");
        assert.deepEqual(r.names, {}); assert.equal(r.state.parts, 0); }
      chainUp = false;                                                                      // the chain goes quiet: the saved look must come back, not blank out
      { const r = await get(); assert.deepEqual(r.items.map((i) => i.glb), ["aviatorduck"], "an RPC failure must never strip a robot's look"); }
      chainUp = true; holds = true;                                                         // moved back: the placement was kept, so the look returns by itself
      assert.deepEqual((await get()).items.map((i) => i.glb), ["aviatorduck"]);
    }));

  await suite.test("3D crates: a part WON on-chain (held by the robot's garage) counts like a bought one — state, weight, save gate, no double sale", () =>
    withRuntime(createRuntime, { bindings: { FOUNDRY_OWNERSHIP: "eth" } }, async (runtime) => {
      const { owner, cookie } = await setup(runtime); for (const f of ["0003_foundry_items.sql", "0004_foundry_posters.sql", "0006_foundry_overrides.sql", "0008_foundry_shop.sql", "0010_foundry_crates.sql"]) await runtime.db.exec(sqlOf(f));
      const GARAGE7 = "0x" + "7".repeat(40), held = new Set(["7:102"]);                       // #7's garage holds part 102 = the Aviator Duck
      runtime.control.callResults.set(SEL_AGGREGATE3, (data) => { const { args } = decodeFunctionData({ abi: MC_ABI, data });
        return encodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", result: args[0].map((c) => { const sel = c.callData.slice(0, 10).toLowerCase();
          if (sel === SEL.garageOf.toLowerCase()) { const id = Number(BigInt("0x" + c.callData.slice(10))); return { success: true, returnData: "0x" + (id === 7 ? GARAGE7.slice(2) : "0".repeat(40)).padStart(64, "0") }; }
          if (sel === SEL.balanceOf1155.toLowerCase()) { const pid = Number(BigInt("0x" + c.callData.slice(74))); return { success: true, returnData: "0x" + BigInt(held.has("7:" + pid) ? 1 : 0).toString(16).padStart(64, "0") }; }
          return { success: false, returnData: "0x" }; }) }); });
      const cat = assertApi(await callApi(runtime, "/v1/foundry/catalogue"), 200).body; assert.equal(cat.crateId, 5); assert.deepEqual(cat.items.map((i) => i.partId), [101, 102, 103, 104]);
      const st = assertApi(await callApi(runtime, "/v1/foundry/state/7"), 200).body;
      assert.deepEqual(st.items, ["aviatorduck"]); assert.deepEqual(st.won, ["aviatorduck"]); assert.deepEqual(st.bought, []); assert.equal(st.weight, 1.01);
      assert.deepEqual(assertApi(await callApi(runtime, "/v1/foundry/state/8"), 200).body.items, []);                                  // #8 has no garage: owns nothing
      const put = (id, body) => callApi(runtime, "/v1/foundry/items/" + id, { method: "PUT", origin: LOCAL_ORIGIN, cookie, headers: { "CF-Connecting-IP": "127.20.0.1" }, body });
      assertApi(await put(7, { items: [{ glb: "aviatorduck" }] }), 200);                                                                 // won = may be saved
      assertApi(await put(7, { items: [{ glb: "aviatorduck" }, { glb: "tophat" }] }), 403, "ITEM_NOT_OWNED");
      assertApi(await put(8, { items: [{ glb: "aviatorduck" }] }), 403, "ITEM_NOT_OWNED");
      payment(runtime.control, { from: owner.address, value: 2000000000000000n });
      assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "aviatorduck", txHash: HASH(41) }), 409, "ITEM_OWNED");        // never sell a robot what it already won
      assert.equal((await runtime.db.prepare("SELECT COUNT(*) AS n FROM mh_eth_payments").first()).n, 0);
      // the crate itself, read from the chain: loot with odds + this wallet's balance
      // the crates, read from the chain in ONE multicall: crate 5 = four parts with odds, crate 6 = a single-part crate, this wallet holds 3 and 1
      const LOOT = (ids, cum) => encodeAbiParameters([{ type: "uint256" }, { type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256" }], [1n, ids, cum, cum[cum.length - 1]]);
      const garageMock = runtime.control.callResults.get(SEL_AGGREGATE3);
      runtime.control.callResults.set(SEL_AGGREGATE3, (data, p) => { const { args } = decodeFunctionData({ abi: MC_ABI, data }); const sel0 = args[0].length ? args[0][0].callData.slice(0, 10).toLowerCase() : "";
        if (sel0 !== SEL.lootTable.toLowerCase()) return garageMock(data, p);
        return encodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", result: args[0].map((c) => { const sel = c.callData.slice(0, 10).toLowerCase();
          if (sel === SEL.lootTable.toLowerCase()) { const id = Number(BigInt("0x" + c.callData.slice(10))); return { success: true, returnData: id === 5 ? LOOT([101n, 102n, 103n, 104n], [40n, 70n, 90n, 100n]) : id === 6 ? LOOT([102n], [1n]) : encodeAbiParameters([{ type: "uint256" }, { type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256" }], [0n, [], [], 0n]) }; }   // version 0 = no loot table
          const crate = Number(BigInt("0x" + c.callData.slice(74))); return { success: true, returnData: "0x" + BigInt(crate === 5 ? 3 : crate === 6 ? 1 : 0).toString(16).padStart(64, "0") }; }) }); });
      // many robots in ONE request: same answers as state/:id (this mock says every robot is activated only through the single-call prefix,
      // so activation is answered inside the multicall too)
      const prev = runtime.control.callResults.get(SEL_AGGREGATE3);
      runtime.control.callResults.set(SEL_AGGREGATE3, (data, p) => { const { args } = decodeFunctionData({ abi: MC_ABI, data });
        if (args[0].length && args[0][0].callData.slice(0, 10).toLowerCase() === SEL.activated.toLowerCase()) return encodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", result: args[0].map((c) => ({ success: true, returnData: "0x" + BigInt(Number(BigInt("0x" + c.callData.slice(10))) === 9 ? 0 : 1).toString(16).padStart(64, "0") })) });
        return prev(data, p); });
      await runtime.db.exec("INSERT INTO mh_foundry_tiers (token_id, tier, wallet, tx_hash, updated_at) VALUES (8, 4, 'x', 'q', 0)");
      await runtime.db.exec("INSERT INTO mh_foundry_attachments (archive_id, token_id, wallet, attached_at) VALUES (401, 8, 'x', 0)");
      const many = assertApi(await callApi(runtime, "/v1/foundry/states?tokens=7,8,9,8"), 200).body.states;
      assert.deepEqual(many.map((x) => [x.token, x.tier, x.weight, x.items.join()]), [[7, 1, 1.01, "aviatorduck"], [8, 4, 12.6, ""], [9, 0, 0, ""]]);
      assert.deepEqual(many[1].attached333, [401]);
      assertApi(await callApi(runtime, "/v1/foundry/states?tokens=" + Array.from({ length: 201 }, (_, i) => i + 1).join(",")), 400, "TOO_MANY_TOKENS");
      assertApi(await callApi(runtime, "/v1/foundry/states?tokens=abc"), 400, "TOKEN_INVALID");
      const cr = assertApi(await callApi(runtime, "/v1/foundry/crates?wallet=" + owner.address), 200).body;
      assert.equal(cr.crateId, 5); assert.equal(cr.configured, true); assert.equal(cr.balance, 3);
      assert.deepEqual(cr.loot.map((l) => [l.partId, l.key, l.pct]), [[101, "tophat", 40], [102, "aviatorduck", 30], [103, "thugshades", 20], [104, "steamgoggles", 10]]);
      assert.deepEqual(cr.crates.map((c) => [c.crateId, c.name, c.balance, c.loot.length]), [[5, "Parts crate", 3, 4], [6, "Aviator Duck crate", 1, 1]]);   // only crates that HAVE a loot table
      assert.deepEqual(cr.crates[1].loot, [{ partId: 102, key: "aviatorduck", name: "Aviator Duck", pct: 100 }]);
    }));

  await suite.test("a NEW part published from /admin works everywhere at once: files, price list, Bench save, purchase, metadata", () => {
    const admin = ephemeral();
    return withRuntime(createRuntime, { bindings: { FOUNDRY_OWNERSHIP: "eth", FOUNDRY_ADMIN_WALLETS: admin.address } }, async (runtime) => {
      const { owner, cookie } = await setup(runtime); for (const f of ["0003_foundry_items.sql", "0004_foundry_posters.sql", "0006_foundry_overrides.sql", "0008_foundry_shop.sql", "0010_foundry_crates.sql"]) await runtime.db.exec(sqlOf(f));
      const sign = async (acct) => { const message = ["MotorHeads Admin Access", "Wallet: " + acct.address, "Time: " + new Date().toISOString()].join(String.fromCharCode(10)); return { "x-wallet-address": acct.address, "x-signature": await acct.signMessage({ message }), "x-signed-message": btoa(message), "CF-Connecting-IP": "127.20.0.40" }; };
      const b64 = (bytes) => Buffer.from(bytes).toString("base64");
      const GLB = b64([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, ...new Array(40).fill(7)]), PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(30).fill(1)]);
      const publish = async (body, headers) => callApi(runtime, "/v1/foundry/parts", { method: "POST", origin: LOCAL_ORIGIN, headers, body });
      assertApi(await publish({ name: "Jet Pack", priceWei: "3000000000000000", bonus: 0.02, glbBase64: GLB, imageBase64: PNG }, await sign(owner)), 403, "ADMIN_ONLY");
      assertApi(await publish({ name: "Jet Pack", priceWei: "3000000000000000", bonus: 0.02, glbBase64: PNG, imageBase64: PNG }, await sign(admin)), 400, "MODEL_INVALID");   // a picture is not a model
      assertApi(await publish({ name: "Jet Pack", priceWei: "3000000000000000", bonus: 0.02, glbBase64: GLB, imageBase64: GLB }, await sign(admin)), 400, "IMAGE_INVALID");
      assertApi(await publish({ name: "Jet Pack", priceWei: "3000000000000000", bonus: 0.2, glbBase64: GLB, imageBase64: PNG }, await sign(admin)), 400, "BONUS_INVALID");
      const r = assertApi(await publish({ name: "Jet Pack", priceWei: "3000000000000000", bonus: 0.02, glbBase64: GLB, imageBase64: PNG }, await sign(admin)), 200).body;
      assert.deepEqual(r.part, { key: "jetpack", name: "Jet Pack", priceWei: "3000000000000000", bonus: 0.02, partId: 105, active: true });          // the next free part number after 101-104
      assert.equal(assertApi(await publish({ name: "Jet Pack", priceWei: "1", bonus: 0, glbBase64: GLB, imageBase64: PNG }, await sign(admin)), 200).body.part.key, "jetpack2");   // same name again = a new key, never an overwrite
      // the files and the ERC-1155 metadata are public
      const glb = await callApi(runtime, "/v1/foundry/partfile/glb/jetpack"); assert.equal(glb.response.status, 200); assert.equal(glb.response.headers.get("content-type"), "model/gltf-binary");
      const img = await callApi(runtime, "/v1/foundry/partfile/img/105"); assert.equal(img.response.status, 200); assert.equal(img.response.headers.get("content-type"), "image/png");
      assert.equal((await callApi(runtime, "/v1/foundry/partfile/glb/nothing")).response.status, 404);
      const meta = assertApi(await callApi(runtime, "/v1/foundry/partfile/meta/105"), 200).body; assert.equal(meta.name, "Jet Pack"); assert.equal(meta.image, "https://motorheadsonline.com/parts/105.png");
      // it is on the price list, the Bench accepts it, and it is sold like any other part
      assert.ok(assertApi(await callApi(runtime, "/v1/foundry/catalogue"), 200).body.items.some((i) => i.key === "jetpack" && i.partId === 105));
      runtime.control.callResults.set(SEL_AGGREGATE3, (data) => { const { args } = decodeFunctionData({ abi: MC_ABI, data }); return encodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", result: args[0].map(() => ({ success: true, returnData: "0x" + "0".repeat(64) })) }); });   // no garage holds anything
      const put = (body) => callApi(runtime, "/v1/foundry/items/7", { method: "PUT", origin: LOCAL_ORIGIN, cookie, headers: { "CF-Connecting-IP": "127.20.0.1" }, body });
      assertApi(await put({ items: [{ glb: "jetpack" }] }), 403, "ITEM_NOT_OWNED"); assertApi(await put({ items: [{ glb: "rocketboots" }] }), 400, "ITEM_UNKNOWN");
      payment(runtime.control, { from: owner.address, value: 3000000000000000n });
      assert.equal(assertApi(await post(runtime, cookie, "buy", { tokenId: 7, itemKey: "jetpack", txHash: HASH(51) }), 200).body.itemBonus, 0.02);
      assertApi(await put({ items: [{ glb: "jetpack" }] }), 200);
      const rec = assertApi(await callApi(runtime, "/v1/foundry/items/7"), 200).body; assert.deepEqual(rec.names, { jetpack: "Jet Pack" });
      const all = assertApi(await callApi(runtime, "/v1/foundry/catalogue?all=1", { origin: LOCAL_ORIGIN, headers: await sign(admin) }), 200).body.items; assert.equal(all.find((c) => c.key === "jetpack").sold, 1); assert.equal(all.find((c) => c.key === "tophat").sold, 0);
    });
  });

  return suite.result();
}
