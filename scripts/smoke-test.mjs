import assert from "node:assert/strict";
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
