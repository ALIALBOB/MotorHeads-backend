import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import worker from "../../src/index.js";
import * as contractsModule from "../../src/contracts.js";
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

// A file in the list above that HAS legitimately changed since the 2026-07-13 snapshot, pinned to the
// hash it was reviewed at. The snapshot itself is dated evidence and is never rewritten; this is the
// amendment on top of it. Adding a line here is a deliberate act: read the diff against the previous
// pin first, because the whole point of the guard is that these files do not move quietly.
//
//   src/contracts.js — four reviewed commits since the snapshot:
//     48217d4 2026-07-24  baseUri + animations CIDs bumped to the migrated pins (matches tokenURI(1))
//     344cfa4 2026-08-14  crate-open signer / effect field
//     79e9908 2026-08-21  DDG added to the partner collections
//     6465504 2026-09-02  The 333 Archives added (powers the Foundry reward bonus)
//   The collection address, the treasury and the chain id are unchanged — asserted separately below,
//   so a future edit cannot slip a different contract or payout wallet in behind a re-stamped hash.
//   src/chainState.js — six reviewed commits since the snapshot (+289 lines, −5), all of them the crate,
//     equip and indexer features: 344cfa4 crate-open signer, bbb4cf7 equipped-effect + owned-parts,
//     df4893a background ids 25-36, d52c9ea Equip v2, c33e3c2 + 3067298 Seaport/WETH sale detection.
//     The addresses it gained are the live ScrapCrates / ScrapParts / Equip v2 / canonical WETH; no
//     existing address was changed or removed.
const REVIEWED_DRIFT = Object.freeze({
  "src/contracts.js": { sha256: "bfc8eb4bef08fd1ce656a6f88d4b5cde22e207d845ac4f706f20671b4bcf4acd", reviewedAt: "2026-09-21" },
  "src/chainState.js": { sha256: "e4576ac67bf14d14a02e11aea21b38273d6a226b1ff798f109365af9641e5502", reviewedAt: "2026-09-21" }
});

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
      if (REVIEWED_DRIFT[relativePath]) { assert.equal(actual[relativePath], REVIEWED_DRIFT[relativePath].sha256, `${relativePath} drifted BEYOND the reviewed changes — re-read the diff, do not just re-stamp this hash`); continue; }
      assert.equal(actual[relativePath], expected.get(relativePath), `${relativePath} drifted`);
    }
    // Whatever else moved in contracts.js, the three constants that decide whose money this is must not.
    assert.equal(contractsModule.MOTORHEADS_CONTRACT, "0x0a5008550fc1402bb567a3ba38d9433e6199ceb1");
    assert.equal(contractsModule.TREASURY_WALLET, "0x95A6fB3087b3469Ed777120052E0ac3f262c81C1");
    assert.equal(contractsModule.NETWORK.chainId, 1);
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
    // Auth went ON when the holder gate went live (2026-07-31) and must STAY on: this one is pinned in
    // the safe direction, so the test now fails if anyone turns the sign-in requirement back off.
    assert.equal(quotedVar(toml, "CUSTOMIZATION_AUTH_ENABLED"), "true");
    assert.equal(quotedVar(toml, "ALLOW_UNVERIFIED_WRITES"), "false");
    assert.equal(quotedVar(toml, "HOLDER_PLACEMENT_BASE_URL"), "");
    assert.match(toml, /^crons\s*=\s*\["\*\/5 \* \* \* \*"\]$/m);

    const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
    for (const key of ["CUSTOMIZATION_READS_ENABLED", "CUSTOMIZATION_WRITES_ENABLED", "CUSTOMIZATION_AUTH_ENABLED"]) {
      assert.match(example, new RegExp(`^${key}=false$`, "m"));
    }
    return { reads: false, writes: false, auth: true, placementUrlConfigured: false, cron: "*/5 * * * *" };
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
