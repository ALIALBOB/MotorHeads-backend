-- 0005_foundry_fits.sql — the FITTING BENCH's saved art fits (/foundry-gallery).
-- Apply via `wrangler d1 execute motorheads_registry --remote --file=migrations/0005_foundry_fits.sql`
-- (execute-file track, same as 0002-0004; NO triggers.)
--
-- These are AUTHORING values, not per-token data: where the face sits on each head, and where each backpack sits
-- on each body. The founder fits them by hand in the bench; they used to live only in his browser's localStorage,
-- so nobody else could read them and a cleared browser lost the work. One row per fit:
--   kind 'face' -> key = head name           data = { face:{dx,dy,dz,ds}, head:{dx,dy,dz,ds}, note }
--   kind 'pack' -> key = "<pack>|<body>"     data = { dx,dy,dz,ds, note }
-- Written by the admin wallet over a SIWE session; read publicly (they are just offsets, and the viewer will
-- eventually bake them into FACEPOS / HEADPOS / PACKFIT).
CREATE TABLE IF NOT EXISTS mh_foundry_fits (
  kind       TEXT    NOT NULL,
  fit_key    TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  wallet     TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, fit_key)
);
CREATE INDEX IF NOT EXISTS idx_mh_foundry_fits_updated ON mh_foundry_fits (updated_at DESC);
