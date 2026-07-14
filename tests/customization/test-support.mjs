import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ROOT, errorCode } from "./harness.mjs";

function safeError(error) {
  return {
    name: String(error?.name || "Error"),
    code: error?.code ? String(error.code) : null,
    message: String(error?.message || error || "Unknown test failure").slice(0, 1000)
  };
}

export function createSuite(group) {
  const cases = [];

  return {
    group,
    cases,
    async test(name, run) {
      const started = performance.now();
      try {
        const evidence = await run();
        cases.push({
          name,
          status: "PASS",
          durationMs: Math.round(performance.now() - started),
          ...(evidence === undefined ? {} : { evidence })
        });
      } catch (error) {
        cases.push({
          name,
          status: "FAIL",
          durationMs: Math.round(performance.now() - started),
          error: safeError(error)
        });
      }
    },
    result() {
      const passed = cases.filter((entry) => entry.status === "PASS").length;
      const failed = cases.length - passed;
      return {
        schemaVersion: 1,
        group,
        generatedAt: new Date().toISOString(),
        environment: "local Miniflare with ephemeral D1 and mocked read-only services",
        summary: { total: cases.length, passed, failed },
        cases
      };
    }
  };
}

export function assertApi(result, status, code = null) {
  assert.equal(result.response.status, status, JSON.stringify(result.body));
  if (code !== null) assert.equal(errorCode(result), code, JSON.stringify(result.body));
  return result;
}

export async function withRuntime(createRuntime, options, run) {
  const runtime = await createRuntime(options);
  try {
    return await run(runtime);
  } finally {
    await runtime.close();
  }
}

export function writeReport(fileName, result) {
  const directory = path.join(ROOT, "reports", "customization-backend-beta");
  fs.mkdirSync(directory, { recursive: true });
  const outputPath = path.join(directory, fileName);
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return outputPath;
}

export function assertSuitePassed(result) {
  if (result.summary.failed > 0) {
    const names = result.cases.filter((entry) => entry.status === "FAIL").map((entry) => entry.name);
    throw new Error(`${result.group} suite failed: ${names.join(", ")}`);
  }
}
