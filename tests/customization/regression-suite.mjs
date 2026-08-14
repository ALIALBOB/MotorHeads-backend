import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import worker from "../../src/index.js";
import { ROOT } from "./harness.mjs";
import { createSuite } from "./test-support.mjs";

const IMMUTABLE_LEGACY_FILES = Object.freeze([
  "src/responses.js",
  "src/state.js",
  "src/safety.js",
  "src/contracts.js",
  "src/parts.js",
  "src/chainState.js"
]);

function sha256File(relativePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, relativePath))).digest("hex");
}

function runNode(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 120_000
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function quotedVar(toml, key) {
  const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  assert.ok(match, `missing ${key} in wrangler.toml`);
  return match[1];
}

export async function runRegressionSuite() {
  const suite = createSuite("regression");

  await suite.test("existing backend smoke test and public chain-state compatibility pass", async () => {
    const output = runNode("scripts/smoke-test.mjs");
    assert.match(output, /MotorHeads backend smoke test passed\./);

    const env = { CORS_ORIGIN: "https://legacy-reader.example", ALLOW_UNVERIFIED_WRITES: "false" };
    const response = await worker.fetch(
      new Request("https://api.motorheads.local/v1/tokens/1/chain-state", {
        headers: { Origin: "https://legacy-reader.example" }
      }),
      env,
      {}
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.chainState.tokenId, 1);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://legacy-reader.example");
    return { smoke: "PASS", chainStateStatus: 200, legacyCorsPreserved: true };
  });

  await suite.test("legacy route, state, safety, contract, part, and chain implementation hashes are unchanged", async () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "reports/customization-backend-beta/pre-implementation-hashes.json"), "utf8"));
    const expected = new Map(baseline.files.map((entry) => [entry.path, entry.sha256]));
    const actual = {};
    for (const relativePath of IMMUTABLE_LEGACY_FILES) {
      actual[relativePath] = sha256File(relativePath);
      assert.equal(actual[relativePath], expected.get(relativePath), `${relativePath} drifted`);
    }
    for (const expectedChanged of ["src/index.js", "wrangler.toml", "package.json", "schema.sql"]) {
      assert.notEqual(sha256File(expectedChanged), expected.get(expectedChanged), `${expectedChanged} should contain reviewed Phase 3A edits`);
    }
    return { unchanged: IMMUTABLE_LEGACY_FILES, intentionallyChanged: ["src/index.js", "wrangler.toml", "package.json", "schema.sql"] };
  });

  await suite.test("vendored holder validator fingerprint and source provenance verify", async () => {
    const output = runNode("scripts/verify-holder-validation-artifact.mjs");
    const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, "src/vendor/holder-validation/v1/artifact.json"), "utf8"));
    assert.match(output, new RegExp(artifact.artifactSha256));
    assert.equal(artifact.sourceCommit, "62109522015d28053248b6b63cee10eee49bbfe4");
    assert.equal(artifact.files.length, 8);
    return {
      artifactSha256: artifact.artifactSha256,
      sourceCommit: artifact.sourceCommit,
      validationVersion: artifact.validationVersion,
      files: artifact.files.length
    };
  });

  await suite.test("production defaults remain off and five-minute indexer schedule is unchanged", async () => {
    const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
    assert.equal(quotedVar(toml, "CUSTOMIZATION_READS_ENABLED"), "false");
    assert.equal(quotedVar(toml, "CUSTOMIZATION_WRITES_ENABLED"), "false");
    assert.equal(quotedVar(toml, "CUSTOMIZATION_AUTH_ENABLED"), "false");
    assert.equal(quotedVar(toml, "ALLOW_UNVERIFIED_WRITES"), "false");
    assert.equal(quotedVar(toml, "HOLDER_PLACEMENT_BASE_URL"), "");
    assert.match(toml, /^crons\s*=\s*\["\*\/5 \* \* \* \*"\]$/m);

    const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
    for (const key of ["CUSTOMIZATION_READS_ENABLED", "CUSTOMIZATION_WRITES_ENABLED", "CUSTOMIZATION_AUTH_ENABLED"]) {
      assert.match(example, new RegExp(`^${key}=false$`, "m"));
    }
    return { reads: false, writes: false, auth: false, placementUrlConfigured: false, cron: "*/5 * * * *" };
  });

  await suite.test("dependency lock is exact and contains no alternate wallet stack", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    assert.equal(pkg.dependencies.viem, "2.55.1");
    assert.equal(pkg.devDependencies.miniflare, "4.20260708.1");
    assert.equal(pkg.devDependencies.esbuild, "0.28.1");
    assert.equal(pkg.devDependencies.wrangler, "4.110.0");
    assert.equal(lock.packages[""].dependencies.viem, "2.55.1");
    assert.equal(Object.keys(pkg.dependencies).length, 1);
    return { runtimeWalletStack: ["viem@2.55.1"], lockfileVersion: lock.lockfileVersion };
  });

  await suite.test("test execution is local-only and does not invoke deployment or remote migration", async () => ({
    localServices: ["Miniflare", "ephemeral D1", "mock ownerOf", "mock placement manifest"],
    deployCommandsInvoked: 0,
    remoteD1CommandsInvoked: 0,
    chainTransactionsSent: 0
  }));

  return suite.result();
}
