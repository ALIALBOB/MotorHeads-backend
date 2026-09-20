-- 0012_foundry_custom_builds.sql — CUSTOM BUILDS are SOLD (founder 2026-09-19: "switching head and body and backpacks and
-- expression only to custom one and its not free"). Apply ONCE via
--   wrangler d1 execute motorheads_registry --remote --file=migrations/0012_foundry_custom_builds.sql   (execute-file track; NO triggers)
-- A catalogue row gets a KIND: 'item' = a wearable part (what every row was), or 'head' | 'body' | 'pack' | 'expr' = a custom
-- build whose item_key IS the roster key it switches the robot to. A robot may only be switched to a custom build it OWNS
-- (bought, or won from a crate) — there is no free switch any more.
ALTER TABLE mh_foundry_catalogue ADD COLUMN kind TEXT NOT NULL DEFAULT 'item';
