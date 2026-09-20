-- 0008_foundry_shop.sql — Bench parts bought with ETH (founder 2026-09-18: "buy items with eth and get bonus percent"). Apply via
--   wrangler d1 execute motorheads_registry --remote --file=migrations/0008_foundry_shop.sql      (execute-file track; NO triggers)
-- Additive: two new tables + the four starter parts. Until it is applied the shop is simply empty and parts stay free.
--
-- The price list. price_wei is TEXT (wei never fits an INTEGER safely in JS); bonus = the reward-weight bonus the part
-- gives the robot that owns it (0.01 = +1%; all parts together are capped at +5% by the economy). Edited from /admin.
CREATE TABLE IF NOT EXISTS mh_foundry_catalogue (
  item_key   TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  price_wei  TEXT    NOT NULL,
  bonus      REAL    NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
-- A part belongs to the ROBOT (it moves with the NFT when it sells), bought once, paid by the mh_eth_payments row tx_hash.
CREATE TABLE IF NOT EXISTS mh_foundry_owned (
  token_id  INTEGER NOT NULL,
  item_key  TEXT    NOT NULL,
  wallet    TEXT    NOT NULL,
  tx_hash   TEXT    NOT NULL,
  bought_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, item_key)
);
-- Starter parts: 0.002 ETH, +1% each (placeholders the founder re-prices from /admin — INSERT OR IGNORE never overwrites an edit).
INSERT OR IGNORE INTO mh_foundry_catalogue (item_key, name, price_wei, bonus, active, sort, updated_at) VALUES
  ('tophat',       'Top Hat',       '2000000000000000', 0.01, 1, 1, 0),
  ('aviatorduck',  'Aviator Duck',  '2000000000000000', 0.01, 1, 2, 0),
  ('thugshades',   'Thug Shades' ,  '2000000000000000', 0.01, 1, 3, 0),
  ('steamgoggles', 'Steam Goggles', '2000000000000000', 0.01, 1, 4, 0);
