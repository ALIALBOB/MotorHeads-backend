// Reward rounds on the ON-CHAIN POOL: the backend snapshots every activated robot's weight, splits the pot, builds the Merkle
// tree and hands out the openRound / claim transactions; the money and the claimed flags are the contract's. The pool contract
// itself is mocked here at the eth_call level (Multicall3 decoded call by call); the REAL contract is exercised with this
// module's tree and calldata in the contracts repo (test/FoundryRewardPool.test.js).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { LOCAL_ORIGIN, ROOT, callApi, createRuntime } from "./harness.mjs";
import { assertApi, createSuite, withRuntime } from "./test-support.mjs";
import { SEL, SEL_AGGREGATE3 } from "../../src/foundry/chain.js";
import { buildTree, poolCall } from "../../src/foundry/rounds.js";

const ephemeral = () => privateKeyToAccount(generatePrivateKey());
const ROBOTS = "0x0a5008550fc1402bb567a3ba38d9433e6199ceb1", POOL = "0x" + "9".repeat(40);
const W = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0"), hex = (n) => "0x" + BigInt(n).toString(16);
const sqlOf = (f) => fs.readFileSync(path.join(ROOT, "migrations", f), "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
const MC_ABI = [{ name: "aggregate3", type: "function", stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] }],
  outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] }];
const selOf = (name, args) => poolCall(name, args).slice(0, 10);
const S = { roundCount: selOf("roundCount"), reserved: selOf("reserved"), owner: selOf("owner"), robots: selOf("robots"), roundInfo: selOf("roundInfo", [1n]), isClaimed: selOf("isClaimed", [1n, 1n]) };

// a fake chain: which robots are activated, and a FoundryRewardPool with its balance, rounds and claimed flags
const ARCHIVE333 = "0x5eb82c9b5ced4c98982633976941d2cc23f4f9b9";
function chain(control, { active, owner, robots = ROBOTS }) {
  const pool = { balance: 0n, reserved: 0n, rounds: [], claimed: new Set(), owner, robots, archiveHolder: "0x00000000000000000000000000000000000000aa" };   /* by default the same wallet holds the robot and its archives */
  control.rpcMethods.set("eth_getBalance", () => hex(pool.balance));
  control.callResults.set(SEL_AGGREGATE3, (data) => { const { args } = decodeFunctionData({ abi: MC_ABI, data });
    return encodeFunctionResult({ abi: MC_ABI, functionName: "aggregate3", result: args[0].map((c) => { const sel = c.callData.slice(0, 10).toLowerCase(), a1 = c.callData.length >= 74 ? BigInt("0x" + c.callData.slice(10, 74)) : 0n, a2 = c.callData.length >= 138 ? BigInt("0x" + c.callData.slice(74, 138)) : 0n;
      if (c.target.toLowerCase() === POOL) {
        if (sel === S.roundCount) return { success: true, returnData: W(pool.rounds.length) }; if (sel === S.reserved) return { success: true, returnData: W(pool.reserved) };
        if (sel === S.owner) return { success: true, returnData: W(BigInt(pool.owner)) }; if (sel === S.robots) return { success: true, returnData: W(BigInt(pool.robots)) };
        if (sel === S.roundInfo) { const r = pool.rounds[Number(a1) - 1]; return r ? { success: true, returnData: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }], [r.root, r.total, r.claimed, r.open]) } : { success: false, returnData: "0x" }; }
        if (sel === S.isClaimed) return { success: true, returnData: W(pool.claimed.has(a1 + ":" + a2) ? 1 : 0) };
        return { success: false, returnData: "0x" }; }
      if (sel === SEL.activated.toLowerCase()) return { success: true, returnData: W(active.has(Number(a1)) ? 1 : 0) };
      // a 333 only adds weight while its holder also owns the robot, so the snapshot reads ownerOf on BOTH collections
      if (sel === SEL.ownerOf.toLowerCase()) return { success: true, returnData: W(BigInt(c.target.toLowerCase() === ARCHIVE333 ? pool.archiveHolder : "0x00000000000000000000000000000000000000aa")) };
      return { success: false, returnData: "0x" }; }) }); });
  return pool;
}
const adminHeaders = async (acct) => { const message = "MotorHeads Admin Access\nWallet: " + acct.address + "\nTime: " + new Date().toISOString(); return { "x-wallet-address": acct.address, "x-signature": await acct.signMessage({ message }), "x-signed-message": btoa(message), "CF-Connecting-IP": "127.30.0.9" }; };

export async function runFoundryRoundsSuite() {
  const suite = createSuite("rounds"); const admin = ephemeral();
  const world = async (runtime) => {
    for (const f of ["0007_foundry_economy.sql", "0008_foundry_shop.sql", "0009_foundry_rounds.sql", "0011_foundry_pool.sql"]) await runtime.db.exec(sqlOf(f));
    // #7 = tier 3 with two 333s and a +1% part (6 x 1.11 = 6.66); #8 = activated only (1); #20 = tier 2 (2.5); #30 = tier 5 but NOT activated
    await runtime.db.exec("INSERT INTO mh_foundry_tiers (token_id, tier, wallet, tx_hash, updated_at) VALUES (7, 3, 'x', 'x', 0), (20, 2, 'x', 'y', 0), (30, 5, 'x', 'z', 0)");
    await runtime.db.exec("INSERT INTO mh_foundry_attachments (archive_id, token_id, wallet, attached_at) VALUES (301, 7, 'x', 0), (302, 7, 'x', 0)");
    await runtime.db.exec("INSERT INTO mh_foundry_owned (token_id, item_key, wallet, tx_hash, bought_at) VALUES (7, 'tophat', 'x', 'x', 0)");
    return chain(runtime.control, { active: new Set([7, 8, 20]), owner: admin.address });
  };
  const asAdmin = async (runtime, method, route, body) => callApi(runtime, "/v1/foundry/" + route, { method, origin: LOCAL_ORIGIN, headers: await adminHeaders(admin), body });
  const bindings = { bindings: { FOUNDRY_ADMIN_WALLETS: admin.address } };

  await suite.test("a 333 stops paying once it leaves the robot owner's wallet — the attachment row alone is not enough", () =>
    withRuntime(createRuntime, bindings, async (runtime) => {
      const p = await world(runtime);   // #7 carries two archives: 6 x (1 + 0.10 + 0.01) = 6.66, and #8 = 1, #20 = 2.5
      const weight = async () => (assertApi(await asAdmin(runtime, "POST", "rounds/preview", { potWei: "1000000000000000000" }), 200)).body.totalWeight;
      assert.equal(await weight(), 10.16);
      p.archiveHolder = "0x00000000000000000000000000000000000000bb";   // the holder sold both archives but left them attached
      assert.equal(await weight(), 9.56);                                 // 6.66 -> 6.06: the +10% is gone, the tier and the part stay
      p.archiveHolder = "0x00000000000000000000000000000000000000aa";     // bought back
      assert.equal(await weight(), 10.16);
    }));

  await suite.test("the pool address is only accepted if the chain says it is a pool for THIS collection owned by the treasury", () =>
    withRuntime(createRuntime, bindings, async (runtime) => {
      const pool = await world(runtime);
      assert.equal(assertApi(await callApi(runtime, "/v1/foundry/pool"), 200).body.pool, null);
      assertApi(await callApi(runtime, "/v1/foundry/pool", { method: "PUT", origin: LOCAL_ORIGIN, body: { address: POOL } }), 401);                       // nobody but the admin
      assertApi(await asAdmin(runtime, "PUT", "pool", { address: "0x123" }), 400, "POOL_INVALID");
      assertApi(await asAdmin(runtime, "PUT", "pool", { address: "0x" + "8".repeat(40) }), 400, "POOL_INVALID");                                           // an address that is not a pool
      pool.robots = "0x" + "1".repeat(40); assertApi(await asAdmin(runtime, "PUT", "pool", { address: POOL }), 400, "POOL_WRONG_COLLECTION"); pool.robots = ROBOTS;
      pool.owner = ephemeral().address; assertApi(await asAdmin(runtime, "PUT", "pool", { address: POOL }), 400, "POOL_WRONG_OWNER"); pool.owner = admin.address;
      pool.balance = 2n * 10n ** 18n; pool.reserved = 5n * 10n ** 17n;
      assertApi(await asAdmin(runtime, "PUT", "pool", { address: POOL }), 200);
      const p = assertApi(await callApi(runtime, "/v1/foundry/pool"), 200).body.pool;
      assert.equal(p.address, POOL); assert.equal(p.balanceWei, "2000000000000000000"); assert.equal(p.reservedWei, "500000000000000000"); assert.equal(p.availableWei, "1500000000000000000"); assert.equal(p.roundCount, 0);
    }));

  await suite.test("a draft round: only activated robots, the pot split exactly by weight, a tree the contract will accept — and nothing public until it is confirmed on chain", () =>
    withRuntime(createRuntime, bindings, async (runtime) => {
      const pool = await world(runtime);
      assertApi(await asAdmin(runtime, "POST", "rounds", { potWei: "1016000000000000000" }), 409, "POOL_NOT_SET");
      pool.balance = 10n ** 18n; assertApi(await asAdmin(runtime, "PUT", "pool", { address: POOL }), 200);
      assertApi(await asAdmin(runtime, "POST", "rounds", { potWei: "1016000000000000000" }), 409, "POOL_NOT_FUNDED");                                       // 1 ETH in the pool, 1.016 asked
      pool.balance = 2n * 10n ** 18n;
      assertApi(await callApi(runtime, "/v1/foundry/rounds", { method: "POST", origin: LOCAL_ORIGIN, body: { potWei: "1" } }), 401);
      assertApi(await asAdmin(runtime, "POST", "rounds", { potWei: "0" }), 400, "POT_INVALID");
      const pre = assertApi(await asAdmin(runtime, "POST", "rounds/preview", {}), 200).body; assert.equal(pre.robots, 3); assert.equal(pre.totalWeight, 10.16); assert.deepEqual(pre.top[0], { token: 7, tier: 3, attached333: 2, itemBonus: 0.01, weight: 6.66 });
      const d = assertApi(await asAdmin(runtime, "POST", "rounds", { potWei: "1016000000000000000", note: "Round one" }), 200).body;
      assert.equal(d.round.status, "draft"); assert.equal(d.round.onchainId, 1); assert.equal(d.round.robots, 3); assert.equal(d.round.potWei, "1016000000000000000");
      // the tree is exactly the one over (1, robot, amount) — 1.016 ETH over 10.16 weight = 0.1 ETH per 1x
      const rows = [[1, 7, 666000000000000000n], [1, 8, 100000000000000000n], [1, 20, 250000000000000000n]], tree = buildTree(rows);
      assert.equal(d.round.root, tree.root); assert.equal(d.call.to, POOL); assert.equal(d.call.data, poolCall("openRound", [tree.root, 1016000000000000000n, 1n]));
      // a draft is invisible to holders
      assert.deepEqual(assertApi(await callApi(runtime, "/v1/foundry/rounds"), 200).body.rounds, []);
      assert.deepEqual(assertApi(await callApi(runtime, "/v1/foundry/rewards?tokens=7,8,20"), 200).body.shares, []);
      assertApi(await callApi(runtime, "/v1/foundry/claimcall?round=1&tokens=7"), 404, "NOTHING_TO_CLAIM");
      // confirm needs the chain to agree
      assertApi(await asAdmin(runtime, "POST", "rounds/" + d.round.id + "/confirm", {}), 409, "ROUND_NOT_ON_CHAIN");
      pool.rounds.push({ root: keccak256("0x01"), total: 1016000000000000000n, claimed: 0n, open: true });
      assertApi(await asAdmin(runtime, "POST", "rounds/" + d.round.id + "/confirm", {}), 409, "ROUND_MISMATCH");                                             // someone opened a different root
      pool.rounds[0].root = tree.root; pool.reserved = 1016000000000000000n;
      assert.equal(assertApi(await asAdmin(runtime, "POST", "rounds/" + d.round.id + "/confirm", {}), 200).body.confirmed, true);
      const r = assertApi(await callApi(runtime, "/v1/foundry/rounds"), 200).body.rounds[0];
      assert.equal(r.status, "open"); assert.equal(r.onchainId, 1); assert.equal(r.robots, 3); assert.equal(r.totalWeight, 10.16); assert.equal(r.note, "Round one");
    }));

  await suite.test("holders: shares with their state READ FROM THE CONTRACT, and a claim transaction whose proofs open the tree", () =>
    withRuntime(createRuntime, bindings, async (runtime) => {
      const pool = await world(runtime); pool.balance = 2n * 10n ** 18n; assertApi(await asAdmin(runtime, "PUT", "pool", { address: POOL }), 200);
      const d = assertApi(await asAdmin(runtime, "POST", "rounds", { potWei: "1016000000000000000" }), 200).body;
      pool.rounds.push({ root: d.round.root, total: 1016000000000000000n, claimed: 0n, open: true }); assertApi(await asAdmin(runtime, "POST", "rounds/" + d.round.id + "/confirm", {}), 200);
      let sh = assertApi(await callApi(runtime, "/v1/foundry/rewards?tokens=7,8,20,30"), 200).body;
      assert.equal(sh.pool, POOL); assert.deepEqual(sh.shares.map((s) => [s.round, s.token, s.weight, s.amountWei, s.status]), [[1, 7, 6.66, "666000000000000000", "claimable"], [1, 8, 1, "100000000000000000", "claimable"], [1, 20, 2.5, "250000000000000000", "claimable"]]);   // #30: not activated = no share
      // an upgrade AFTER the snapshot changes nothing in this round
      await runtime.db.exec("UPDATE mh_foundry_tiers SET tier = 5 WHERE token_id = 20");
      assert.equal(assertApi(await callApi(runtime, "/v1/foundry/rewards?tokens=20"), 200).body.shares[0].amountWei, "250000000000000000");
      // the claim transaction: exactly claim(1, [7,8], amounts, proofs) with proofs of the same tree
      const tree = buildTree([[1, 7, 666000000000000000n], [1, 8, 100000000000000000n], [1, 20, 250000000000000000n]]);
      const c = assertApi(await callApi(runtime, "/v1/foundry/claimcall?round=1&tokens=8,7,30"), 200).body;
      assert.equal(c.to, POOL); assert.deepEqual(c.tokens, [7, 8]); assert.equal(c.amountWei, "766000000000000000");
      assert.equal(c.data, poolCall("claim", [1n, [7n, 8n], [666000000000000000n, 100000000000000000n], [tree.proof(0), tree.proof(1)]]));
      assertApi(await callApi(runtime, "/v1/foundry/claimcall?round=2&tokens=7"), 404, "NOTHING_TO_CLAIM");
      assertApi(await callApi(runtime, "/v1/foundry/claimcall?tokens=7"), 400, "CLAIM_INVALID");
      // the contract is the truth: once it says claimed / closed, so does the page
      pool.claimed.add("1:7"); pool.rounds[0].claimed = 666000000000000000n;
      sh = assertApi(await callApi(runtime, "/v1/foundry/rewards?tokens=7,8"), 200).body.shares; assert.deepEqual(sh.map((s) => s.status), ["paid", "claimable"]);
      assert.equal(assertApi(await callApi(runtime, "/v1/foundry/rounds"), 200).body.rounds[0].claimedWei, "666000000000000000");
      pool.rounds[0].open = false;
      assert.deepEqual(assertApi(await callApi(runtime, "/v1/foundry/rewards?tokens=7,8"), 200).body.shares.map((s) => s.status), ["paid", "expired"]);
      assert.equal(assertApi(await callApi(runtime, "/v1/foundry/rounds"), 200).body.rounds[0].status, "closed");
    }));

  await suite.test("no snapshot without Ethereum, and a new draft replaces an abandoned one", () =>
    withRuntime(createRuntime, bindings, async (runtime) => {
      const pool = await world(runtime); pool.balance = 5n * 10n ** 18n; assertApi(await asAdmin(runtime, "PUT", "pool", { address: POOL }), 200);
      const a = assertApi(await asAdmin(runtime, "POST", "rounds", { potWei: "1000000000000000000" }), 200).body, b = assertApi(await asAdmin(runtime, "POST", "rounds", { potWei: "2000000000000000000" }), 200).body;
      const drafts = assertApi(await callApi(runtime, "/v1/foundry/rounds?drafts=1", { origin: LOCAL_ORIGIN, headers: await adminHeaders(admin) }), 200).body.rounds;
      assert.deepEqual(drafts.map((r) => [r.id, r.status]), [[b.round.id, "draft"]]); assert.notEqual(a.round.id, b.round.id);
      assertApi(await asAdmin(runtime, "POST", "rounds/" + b.round.id + "/discard", {}), 200); assertApi(await asAdmin(runtime, "POST", "rounds/" + b.round.id + "/discard", {}), 404, "NOT_A_DRAFT");
      runtime.control.callResults.delete(SEL_AGGREGATE3);
      assertApi(await asAdmin(runtime, "POST", "rounds", { potWei: "1000000000000000000" }), 503, "POOL_UNAVAILABLE");
      assert.equal((await runtime.db.prepare("SELECT COUNT(*) AS n FROM mh_reward_rounds").first()).n, 0);
    }));

  return suite.result();
}
