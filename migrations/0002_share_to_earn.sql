-- 0002_share_to_earn.sql — "Share to Earn" weekly X campaign (holder submissions + admin review).
-- Apply via `wrangler d1 execute motorheads_registry --local|--remote --file=migrations/0002_share_to_earn.sql`
-- (execute-file track, same as schema.sql; NO triggers here so `migrations apply` would also be safe).

-- One active campaign at a time; admin finalizes + opens the next week.
CREATE TABLE IF NOT EXISTS mh_share_campaigns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  week_key     TEXT    NOT NULL UNIQUE,                 -- ISO week, e.g. "2026-W34"
  hashtag      TEXT    NOT NULL DEFAULT '#MotorHeads',
  handle       TEXT    NOT NULL DEFAULT '@Motor_Heads_',
  prize_desc   TEXT,
  base_reward  INTEGER NOT NULL DEFAULT 1,              -- crates per approved post
  top_n        INTEGER NOT NULL DEFAULT 3,              -- # of top posters who get the premium bundle
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','finalized','archived')),
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mh_share_campaigns_status ON mh_share_campaigns (status);

-- One row per submission. UNIQUE(campaign_id, wallet) = 1 post/wallet/week; UNIQUE(tweet_id) = no tweet reuse.
CREATE TABLE IF NOT EXISTS mh_share_submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id   INTEGER NOT NULL,
  wallet        TEXT    NOT NULL,
  tweet_id      TEXT    NOT NULL,
  tweet_url     TEXT    NOT NULL,
  author_handle TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  is_winner     INTEGER NOT NULL DEFAULT 0,
  reward_kind   TEXT    CHECK (reward_kind IN ('crate','crate_effect') OR reward_kind IS NULL),
  granted       INTEGER NOT NULL DEFAULT 0,
  grant_ref     TEXT,
  note          TEXT,
  submitted_at  INTEGER NOT NULL,
  reviewed_at   INTEGER,
  UNIQUE (campaign_id, wallet),
  UNIQUE (tweet_id)
);
CREATE INDEX IF NOT EXISTS idx_mh_share_sub_campaign_status ON mh_share_submissions (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_mh_share_sub_wallet          ON mh_share_submissions (wallet);
CREATE INDEX IF NOT EXISTS idx_mh_share_sub_grant           ON mh_share_submissions (campaign_id, status, granted);
