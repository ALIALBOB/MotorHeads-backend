import assert from "node:assert/strict";

import { createRuntime, tableRows } from "./harness.mjs";

const REQUIRED_TABLES = Object.freeze([
  "mh_auth_nonces",
  "mh_auth_sessions",
  "mh_customization_history",
  "mh_customization_states",
  "mh_rate_limits"
]);

async function describe(schemaFile) {
  const runtime = await createRuntime({ schemaFile });
  try {
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
  const schema = await describe("schema.sql");
  const migration = await describe("migrations/0001_website_customization_beta.sql");
  assert.deepEqual(migration, schema, "schema.sql and local migration must produce identical Phase 3A D1 objects");

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
    migrationFile: "migrations/0001_website_customization_beta.sql",
    productionApplied: false,
    parityWithSchemaSql: true,
    tables: Object.fromEntries(Object.entries(schema.tables).map(([name, columns]) => [name, columns.map((column) => column.name)])),
    indexes: schema.objects.filter((entry) => entry.type === "index" && !entry.name.startsWith("sqlite_autoindex")).map((entry) => entry.name),
    triggers: schema.objects.filter((entry) => entry.type === "trigger").map((entry) => entry.name)
  };
}
