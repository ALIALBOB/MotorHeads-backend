# Customization D1 Staging Migration Runbook

Status: future staging procedure only

This document does not authorize a production migration. Phase 3A.1 ran only
ephemeral/local D1 tests. Production flags remain false and the production D1
database must not be targeted by this procedure.

## Hard Gates

Before any command:

1. obtain explicit staging-migration approval;
2. use a dedicated staging Worker configuration and a distinct staging D1
   database ID;
3. confirm `CUSTOMIZATION_READS_ENABLED=false`,
   `CUSTOMIZATION_WRITES_ENABLED=false`, and
   `CUSTOMIZATION_AUTH_ENABLED=false`;
4. confirm `HOLDER_PLACEMENT_BASE_URL` is unset until separately reviewed;
5. record branch, commit, Wrangler version, staging database name, and database
   ID;
6. verify no command resolves to the production database ID.

Never use the repository's production `db:migrate:prod` shortcut for staging.
Use an explicit reviewed staging config on every remote command.

## 1. Backup

Export the dedicated staging database before migration:

```powershell
npx wrangler d1 export <STAGING_DB_NAME> --remote --config wrangler.staging.toml --output .\tmp\staging-before-customization.sql
```

Store the export outside Git, hash it, and verify it is non-empty. The `tmp/`
path is ignored. Do not include raw database content in reports or commits.

## 2. Local Dry Run

First validate the exact migration against disposable local D1:

```powershell
npx wrangler d1 migrations apply <STAGING_DB_NAME> --local --config wrangler.staging.toml
npm run test:customization
node tests/customization/migration-audit.mjs
```

The audit must report schema/migration parity, all five expected tables, all six
indexes, and `trg_mh_customization_history_revision`. Review the migration for
destructive statements. Version 0001 creates customization tables and does not
drop legacy data.

## 3. Apply to Staging

Keep all customization flags false. Apply only after backup and dry-run review:

```powershell
npx wrangler d1 migrations list <STAGING_DB_NAME> --remote --config wrangler.staging.toml
npx wrangler d1 migrations apply <STAGING_DB_NAME> --remote --config wrangler.staging.toml
```

Save sanitized command status and migration identifiers. Do not log credentials,
cookies, nonces, signatures, RPC URLs, or database rows.

## 4. Verify

With flags still false:

1. list applied staging migrations;
2. query `sqlite_master` for the expected tables, indexes, and trigger;
3. run legacy health and chain-state smoke tests;
4. confirm legacy five-minute indexing remains operational;
5. confirm customization routes return their disabled-feature responses;
6. run a separately approved staging test with synthetic accounts only after
   staging bindings, RPC, SIWE, CORS, and placement source are reviewed;
7. verify no Ethereum transaction path exists.

Enabling reads, auth, or writes is a separate approval after migration
verification.

## 5. Rollback and Restore

There is no automatic destructive down migration. If staging verification
fails:

1. keep all customization flags false;
2. stop the staging Worker or route traffic to the prior staging deployment;
3. preserve the failed database and logs for diagnosis;
4. create a fresh staging D1 database;
5. restore the verified pre-migration SQL export into that fresh database;
6. update only the staging config to the restored database ID;
7. rerun legacy smoke and chain-state compatibility checks.

Do not drop production tables and do not attempt an ad hoc reverse migration.
Any restore command must be reviewed against the exact installed Wrangler
version and tested locally first.

## 6. Post-Check Record

Record:

- staging database name/ID and backup SHA-256;
- source commit and migration hash;
- migration list before and after;
- parity and smoke-test results;
- feature flags, all still false;
- rollback decision;
- confirmation that no production database, NFT contract, metadata, CID,
  Filebase object, animation, image, or OpenSea state changed.
