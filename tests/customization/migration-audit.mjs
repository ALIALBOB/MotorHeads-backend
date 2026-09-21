import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ROOT, createRuntime, tableRows } from "./harness.mjs";

// The audit used to compare schema.sql against migration 0001 alone. That was true when 0001 was the
// only migration and has been meaningless since 0002 added a table 0001 knows nothing about — and
// because the audit only runs after the regression suite passes, and that suite had been red on stale
// hashes since roughly 2026-07, nobody ever saw it stop holding.
//
// What is true, and worth guarding: schema.sql is the base (the Phase 3A beta plus share-to-earn), and
// the Foundry lives in 0003 onwards. So building schema.sql and applying 0003.. must land in exactly
// the same place as replaying 0001.. from nothing. That catches schema.sql drifting away from the
// migrations it does cover, and proves the chain is self-consistent end to end.
//
// KNOWN GAP, deliberately not papered over here: schema.sql is NOT a complete fresh-database
// definition — it stops at 0002, so `npm run db:migrate:prod` alone would leave a new database with no
// Foundry tables at all. It cannot simply be completed, because three suites use schema.sql as a
// PRE-Foundry base on purpose (foundry-items' "before migration 0006" case proves the backend answers
// 503 instead of crashing when a migration has not been applied). Fixing it properly means giving the
// harness its own base, which is a bigger change than this audit should make on its own.
const MIGRATIONS = Object.freeze(fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort());
const BASE_COVERED = 2;                     // migrations already folded into schema.sql: 0001, 0002
const AFTER_BASE = Object.freeze(MIGRATIONS.slice(BASE_COVERED));
const sqlOf = (f) => fs.readFileSync(path.join(ROOT, "migrations", f), "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();

const REQUIRED_TABLES = Object.freeze([
  "mh_auth_nonces",
  "mh_auth_sessions",
  "mh_customization_history",
  "mh_customization_states",
  "mh_rate_limits"
]);

// `schemaFile` seeds the database; `then` is replayed on top of it, statement by statement, so the
// migration side is built exactly the way production was built.
async function describe(schemaFile, then = []) {
  const runtime = await createRuntime({ schemaFile });
  try {
    for (const file of then) await runtime.db.exec(sqlOf(file));
    const objects = await tableRows(runtime.db, `
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name LIKE 'mh_%' OR name LIKE 'trg_mh_%' OR name LIKE 'idx_mh_%'
      ORDER BY type, name
    `);
    const tables = {};
    for (const table of REQUIRED_TABLES) {
      tables[table] = (await tableRows(runtime.db, `PRAGMA table_info(${table})`)).map((column) => ({
        name: column.name,
        type: column.type,
        notnull: Number(column.notnull),
        defaultValue: column.dflt_value,
        primaryKeyOrder: Number(column.pk)
      }));
    }
    return {
      objects: objects.map((entry) => ({
        type: entry.type,
        name: entry.name,
        table: entry.tbl_name,
        sql: String(entry.sql || "").replace(/\s+/g, " ").trim()
      })),
      tables
    };
  } finally {
    await runtime.close();
  }
}

export async function runMigrationAudit() {
  assert.deepEqual(MIGRATIONS.slice(0, BASE_COVERED), ["0001_website_customization_beta.sql", "0002_share_to_earn.sql"],
    "schema.sql covers exactly the first two migrations — if that changed, BASE_COVERED is wrong");
  const schema = await describe("schema.sql", AFTER_BASE);
  const migration = await describe("migrations/" + MIGRATIONS[0], MIGRATIONS.slice(1));
  assert.deepEqual(migration, schema, "replaying every migration must land in the same place as schema.sql + " + AFTER_BASE.length + " Foundry migrations");

  for (const table of REQUIRED_TABLES) assert.ok(schema.tables[table].length > 0, `missing ${table}`);
  assert.deepEqual(
    schema.tables.mh_customization_states.filter((column) => column.primaryKeyOrder > 0).map((column) => column.name),
    ["contract_address", "token_id"]
  );
  assert.deepEqual(
    schema.tables.mh_customization_history.filter((column) => column.primaryKeyOrder > 0).map((column) => column.name),
    ["contract_address", "token_id", "revision"]
  );
  assert.ok(schema.objects.some((entry) => entry.name === "trg_mh_customization_history_revision"));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "local ephemeral Miniflare D1 only",
    status: "PASS",
    migrationFiles: MIGRATIONS,
    productionApplied: false,
    parityWithSchemaSql: true,
    tables: Object.fromEntries(Object.entries(schema.tables).map(([name, columns]) => [name, columns.map((column) => column.name)])),
    indexes: schema.objects.filter((entry) => entry.type === "index" && !entry.name.startsWith("sqlite_autoindex")).map((entry) => entry.name),
    triggers: schema.objects.filter((entry) => entry.type === "trigger").map((entry) => entry.name)
  };
}
