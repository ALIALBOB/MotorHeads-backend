import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const artifactRoot = path.resolve(scriptDir, "..", "src", "vendor", "holder-validation", "v1");
const manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, "artifact.json"), "utf8"));
const fingerprint = crypto.createHash("sha256");

for (const entry of manifest.files) {
  const bytes = fs.readFileSync(path.join(artifactRoot, entry.artifact));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, entry.sha256, `Holder validator file hash mismatch: ${entry.artifact}`);
  fingerprint.update(entry.artifact);
  fingerprint.update("\0");
  fingerprint.update(bytes);
  fingerprint.update("\0");
}

assert.equal(fingerprint.digest("hex"), manifest.artifactSha256, "Holder validator artifact fingerprint mismatch");
assert.equal(manifest.validationVersion, 1);
assert.equal(manifest.catalogVersion, 1);
assert.equal(manifest.placementManifestVersion, 1);
assert.equal(manifest.sourceRoot, "MotorHeads-5555");
console.log(`Holder validation artifact verified: ${manifest.artifactSha256}`);
