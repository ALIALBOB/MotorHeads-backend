-- 0003_foundry_items.sql — the per-token Foundry record, first field: the BENCH ITEMS worn by a 3D MotorHead.
-- Apply via `wrangler d1 execute motorheads_registry --remote --file=migrations/0003_foundry_items.sql`
-- (execute-file track, same as 0002; NO triggers).
--
-- One row per robot token. `items` is a JSON array of { glb, anchor?, dx, dy, dz, rx, ry, rz, s } (see
-- src/foundry/items.js validateItems). Read by the site worker for /foundry/anim/:id (window.__COMP__.items)
-- and written from the Bench by the robot's owner (SIWE session) or the admin wallet.
CREATE TABLE IF NOT EXISTS mh_foundry_items (
  token_id   INTEGER PRIMARY KEY,
  items      TEXT    NOT NULL,
  wallet     TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
