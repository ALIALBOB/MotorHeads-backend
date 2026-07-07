import assert from "node:assert/strict";
import { buildTransferProcessingPlan, saleTierFromWei, saleWeiForAnimation } from "../src/chainState.js";
import worker from "../src/index.js";

const env = {
  CORS_ORIGIN: "http://localhost:5173",
  ALLOW_UNVERIFIED_WRITES: "false"
};

async function call(path, init = {}) {
  const response = await worker.fetch(new Request(`https://api.motorheads.local${path}`, init), env, {});
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null
  };
}

{
  const { response, body } = await call("/health");
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
}

{
  const { response, body } = await call("/v1/config");
  assert.equal(response.status, 200);
  assert.equal(body.collection.maxSupply, 5555);
}

{
  const { response, body } = await call("/v1/parts");
  assert.equal(response.status, 200);
  assert.ok(body.parts.length >= 10);
}

{
  const { response, body } = await call("/v1/chain/summary");
  assert.equal(response.status, 200);
  assert.equal(body.chain.gasLevel, "idle");
}

{
  const { response, body } = await call("/v1/tokens/1/chain-state");
  assert.equal(response.status, 200);
  assert.equal(body.chainState.tokenId, 1);
  assert.equal(body.chainState.saleCount, 0);
  assert.equal(body.chainState.evolutionTier, "new");
}

{
  const logs = [
    { blockNumber: 10, logIndex: 0 },
    { blockNumber: 10, logIndex: 1 },
    { blockNumber: 11, logIndex: 0 },
    { blockNumber: 11, logIndex: 1 },
    { blockNumber: 11, logIndex: 2 },
    { blockNumber: 12, logIndex: 0 }
  ];
  const plan = buildTransferProcessingPlan(logs, 10, 20, 4);
  assert.equal(plan.logsToProcess.length, 4);
  assert.equal(plan.checkpointToBlock, 10);
  assert.deepEqual(plan.nextCursor, { blockNumber: 11, logIndex: 1 });
  assert.equal(plan.logsDeferred, 2);
  assert.equal(plan.partial, true);
}

{
  const logs = [
    { blockNumber: 30, logIndex: 0 },
    { blockNumber: 30, logIndex: 1 },
    { blockNumber: 30, logIndex: 2 },
    { blockNumber: 30, logIndex: 3 },
    { blockNumber: 31, logIndex: 0 }
  ];
  const plan = buildTransferProcessingPlan(logs, 30, 31, 2);
  assert.equal(plan.logsToProcess.length, 2);
  assert.equal(plan.checkpointToBlock, 29);
  assert.deepEqual(plan.nextCursor, { blockNumber: 30, logIndex: 1 });
  assert.equal(plan.logsDeferred, 3);
  assert.equal(plan.partial, true);
}

{
  const plan = buildTransferProcessingPlan([], 40, 55, 1000);
  assert.equal(plan.logsToProcess.length, 0);
  assert.equal(plan.checkpointToBlock, 55);
  assert.equal(plan.nextCursor, null);
  assert.equal(plan.partial, false);
}

{
  const logs = [
    { blockNumber: 47, logIndex: 0 },
    { blockNumber: 47, logIndex: 1 },
    { blockNumber: 47, logIndex: 2 },
    { blockNumber: 47, logIndex: 3 }
  ];
  const plan = buildTransferProcessingPlan(logs, 47, 60, 2, { baseCheckpointToBlock: 44 });
  assert.equal(plan.logsToProcess.length, 2);
  assert.equal(plan.checkpointToBlock, 44);
  assert.deepEqual(plan.nextCursor, { blockNumber: 47, logIndex: 1 });
  assert.equal(plan.logsDeferred, 2);
  assert.equal(plan.partial, true);
}

{
  assert.equal(saleTierFromWei("239415000000000"), "verified");
  assert.equal(saleTierFromWei("5300000000000000"), "verified");
  assert.equal(saleTierFromWei("1000000000000000000"), "silver");
  assert.equal(saleTierFromWei("10000000000000000000"), "mythic");
  assert.equal(saleWeiForAnimation("378873333333333"), "0378873333333333");
  assert.equal(saleWeiForAnimation("1471150000000000"), "1471150000000000");
  assert.equal(saleWeiForAnimation(null), null);
}

{
  const { response, body } = await call("/v1/tokens/1/state");
  assert.equal(response.status, 200);
  assert.equal(body.state.tokenId, 1);
  assert.equal(body.state.source, "default");
}

{
  const { response, body } = await call("/v1/tokens/1/state", {
    method: "PUT",
    body: JSON.stringify({ overlays: [] })
  });
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "signature_required");
}

console.log("MotorHeads backend smoke test passed.");
