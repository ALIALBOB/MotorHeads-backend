-- 0009_foundry_rounds.sql — reward rounds in ETH, split by weight (founder 2026-09-18: pot funded by hand, per round). Apply via
--   wrangler d1 execute motorheads_registry --remote --file=migrations/0009_foundry_rounds.sql      (execute-file track; NO triggers)
-- Additive: two new tables. No contract holds a pooled pot: the treasury pays claimed shares itself and the payout
-- transaction is recorded (and checked on Ethereum) next to the share.
--
-- A round = a pot and the SNAPSHOT of every activated robot's weight at the moment it was opened.
-- total_weight_x = the sum of weight_x; weights are stored x10000 so the split is exact integer maths.
CREATE TABLE IF NOT EXISTS mh_reward_rounds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pot_wei        TEXT    NOT NULL,
  total_weight_x INTEGER NOT NULL,
  robots         INTEGER NOT NULL,
  note           TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'open',
  created_by     TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  closed_at      INTEGER
);
-- One robot's share of one round. It belongs to the ROBOT: whoever owns the robot when it is claimed receives it.
CREATE TABLE IF NOT EXISTS mh_reward_shares (
  round_id      INTEGER NOT NULL,
  token_id      INTEGER NOT NULL,
  weight_x      INTEGER NOT NULL,
  amount_wei    TEXT    NOT NULL,
  claimed_by    TEXT,
  claimed_at    INTEGER,
  paid_tx       TEXT,
  paid_at       INTEGER,
  paid_verified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (round_id, token_id)
);
CREATE INDEX IF NOT EXISTS mh_reward_shares_token ON mh_reward_shares (token_id);
CREATE INDEX IF NOT EXISTS mh_reward_shares_claimer ON mh_reward_shares (round_id, claimed_by);
