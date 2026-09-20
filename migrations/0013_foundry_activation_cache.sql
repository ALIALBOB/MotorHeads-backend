-- 0013_foundry_activation_cache.sql — ACTIVATION IN THE METADATA (founder 2026-09-19: "does the metadata say active or not?
-- if not people can't know to sell an active one or to buy an active one"). Apply ONCE via
--   wrangler d1 execute motorheads_registry --remote --file=migrations/0013_foundry_activation_cache.sql   (execute-file track; NO triggers)
-- tokenURI is read by marketplaces for every token in the collection, so it can never afford an Ethereum call per robot.
-- Activation is ONE-WAY on ScrapCrates: once a robot is activated it can never go back. So a true is cached FOR EVER and
-- costs nothing to serve; a false is re-checked at most every 15 minutes (active = 0 with the time it was last looked up).
CREATE TABLE IF NOT EXISTS mh_foundry_activated (
  token_id  INTEGER PRIMARY KEY,
  active    INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL
);
