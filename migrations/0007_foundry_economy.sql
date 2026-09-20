-- 0007_foundry_economy.sql — the ETH-only Foundry economy (founder 2026-09-18). Apply via
--   wrangler d1 execute motorheads_registry --remote --file=migrations/0007_foundry_economy.sql      (execute-file track; NO triggers)
-- Additive: three new tables, nothing existing is touched.
--
-- Every verified ETH payment to the treasury. tx_hash is the PRIMARY KEY: one transaction can pay for exactly one thing, ever.
CREATE TABLE IF NOT EXISTS mh_eth_payments (
  tx_hash      TEXT    PRIMARY KEY,
  wallet       TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  token_id     INTEGER NOT NULL,
  ref          TEXT    NOT NULL,
  value_wei    TEXT    NOT NULL,
  block_number INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
-- The upgrade tier of a robot (2..5). Tier 1 = activation, which lives ON CHAIN (ScrapCrates.activated) and is never stored here.
CREATE TABLE IF NOT EXISTS mh_foundry_tiers (
  token_id   INTEGER PRIMARY KEY,
  tier       INTEGER NOT NULL,
  wallet     TEXT    NOT NULL,
  tx_hash    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 333 Archives attached to robots. archive_id is the PRIMARY KEY: one archive powers one robot at a time.
CREATE TABLE IF NOT EXISTS mh_foundry_attachments (
  archive_id  INTEGER PRIMARY KEY,
  token_id    INTEGER NOT NULL,
  wallet      TEXT    NOT NULL,
  attached_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mh_foundry_attachments_token ON mh_foundry_attachments (token_id);
