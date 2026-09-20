-- 0006_foundry_overrides.sql — the per-token Foundry record grows the OWNER'S SWITCHES (founder 2026-09-17: switching
-- head / body / backpack / expression and adding parts are DAY ONE). `overrides` is a JSON object
-- { head?, body?, pack?, expr? } validated against src/foundry/roster.json (the colourway is never switchable);
-- NULL = the token is exactly its frozen DNA. Read by the site worker for /foundry/anim/:id and /foundry/meta/:id.
--
-- Apply via `wrangler d1 execute motorheads_registry --remote --file=migrations/0006_foundry_overrides.sql`
-- (execute-file track, same as 0003; NO triggers). Additive — ADD COLUMN only, nothing rewritten, no data touched.
-- The code tolerates the column being absent (reads fall back, a save WITH overrides answers 503 OVERRIDES_UNAVAILABLE),
-- so deploying the backend before this runs cannot break the animation data path.
ALTER TABLE mh_foundry_items ADD COLUMN overrides TEXT;
