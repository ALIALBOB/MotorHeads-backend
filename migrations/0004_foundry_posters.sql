-- 0004_foundry_posters.sql — the per-token POSTER (OpenSea `image`): a JPEG rendered by the Bench at save time from
-- the mint-stand angle, with the saved items on. Served by the site worker at /foundry-art/token-<id>.jpg when present.
-- Apply via `wrangler d1 execute motorheads_registry --remote --file=migrations/0004_foundry_posters.sql`
CREATE TABLE IF NOT EXISTS mh_foundry_posters (
  token_id   INTEGER PRIMARY KEY,
  jpeg_b64   TEXT    NOT NULL,     -- base64 JPEG, <= 700 KB
  bytes      INTEGER NOT NULL,
  wallet     TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
