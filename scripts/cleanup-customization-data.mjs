import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCleanupCommands, cleanupConfig } from "../src/customization/cleanup.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE = "motorheads_registry";
const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

if (process.argv.length > 2) {
  throw new Error("This maintenance command accepts no arguments and is local-only.");
}

function runWrangler(args) {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Local Wrangler maintenance failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function renderNumericBindings(sql, bindings) {
  let index = 0;
  const rendered = sql.replace(/\?/g, () => {
    const value = Number(bindings[index]);
    index += 1;
    if (!Number.isSafeInteger(value)) throw new Error("Cleanup binding must be a safe integer.");
    return String(value);
  });
  if (index !== bindings.length) throw new Error("Cleanup binding count mismatch.");
  return rendered;
}

runWrangler(["d1", "execute", DATABASE, "--local", "--file=schema.sql"]);

const config = cleanupConfig(process.env);
const nowSeconds = Math.floor(Date.now() / 1000);
const commands = buildCleanupCommands({ ...config, nowSeconds });
const sql = `${commands.map((command) => renderNumericBindings(command.sql, command.bindings)).join(";\n")};`;
const output = runWrangler(["d1", "execute", DATABASE, "--local", "--command", sql]);

console.log(JSON.stringify({
  status: "PASS",
  mode: "local D1 only",
  database: DATABASE,
  maxRowsPerTable: config.maxRowsPerTable,
  tables: commands.map((command) => command.name),
  wrangler: output
}, null, 2));
