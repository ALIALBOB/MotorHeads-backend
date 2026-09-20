-- 0010_foundry_crates.sql — 3D parts can also be WON from a crate (founder 2026-09-18: "3d crates as rewards"). Apply ONCE via
--   wrangler d1 execute motorheads_registry --remote --file=migrations/0010_foundry_crates.sql      (execute-file track; NO triggers)
-- A catalogue part gets the ScrapParts (ERC-1155) id it is minted as when it drops from the Foundry crate (ScrapCrates crate
-- id 5 — ids 1-4 are the 2D effect/background crates, part ids 1-36 are theirs; the 3D parts start at 101). A robot OWNS a
-- part if it bought it (mh_foundry_owned) OR its garage holds that part id on Ethereum. 0 = cannot drop from a crate.
ALTER TABLE mh_foundry_catalogue ADD COLUMN part_id INTEGER NOT NULL DEFAULT 0;
UPDATE mh_foundry_catalogue SET part_id = 101 WHERE item_key = 'tophat'       AND part_id = 0;
UPDATE mh_foundry_catalogue SET part_id = 102 WHERE item_key = 'aviatorduck'  AND part_id = 0;
UPDATE mh_foundry_catalogue SET part_id = 103 WHERE item_key = 'thugshades'   AND part_id = 0;
UPDATE mh_foundry_catalogue SET part_id = 104 WHERE item_key = 'steamgoggles' AND part_id = 0;
