import { runApiSuite } from "../tests/customization/api-suite.mjs";
import { runAuthSuite } from "../tests/customization/auth-suite.mjs";
import { runFoundryItemsSuite } from "../tests/customization/foundry-items-suite.mjs";
import { runFoundryEconomySuite } from "../tests/customization/foundry-economy-suite.mjs";
import { runFoundryRoundsSuite } from "../tests/customization/foundry-rounds-suite.mjs";
import { runHardeningSuite } from "../tests/customization/hardening-suite.mjs";
import { runMigrationAudit } from "../tests/customization/migration-audit.mjs";
import { runOwnershipSuite } from "../tests/customization/ownership-suite.mjs";
import { runRegressionSuite } from "../tests/customization/regression-suite.mjs";
import { assertSuitePassed, writeReport } from "../tests/customization/test-support.mjs";

const SUITES = Object.freeze({
  auth: { run: runAuthSuite, report: "auth-test-results.json" },
  ownership: { run: runOwnershipSuite, report: "ownership-test-results.json" },
  api: { run: runApiSuite, report: "api-test-results.json" },
  hardening: { run: runHardeningSuite, report: "hardening-test-results.json" },
  regression: { run: runRegressionSuite, report: "regression-results.json" },
  foundry: { run: runFoundryItemsSuite, report: "foundry-items-results.json" },
  economy: { run: runFoundryEconomySuite, report: "foundry-economy-results.json" },
  rounds: { run: runFoundryRoundsSuite, report: "foundry-rounds-results.json" }
});

function selectedGroups() {
  const argument = process.argv.find((entry) => entry.startsWith("--group="));
  if (!argument) return Object.keys(SUITES);
  const group = argument.slice("--group=".length);
  if (!Object.hasOwn(SUITES, group)) {
    throw new Error(`Unknown customization test group: ${group}`);
  }
  return [group];
}

const summaries = [];

for (const group of selectedGroups()) {
  const definition = SUITES[group];
  const result = await definition.run();
  const reportPath = writeReport(definition.report, result);
  summaries.push({ group, ...result.summary, reportPath });
  assertSuitePassed(result);

  if (group === "regression") {
    const audit = await runMigrationAudit();
    writeReport("migration-audit.json", audit);
  }
}

console.log(JSON.stringify({ status: "PASS", suites: summaries }, null, 2));
