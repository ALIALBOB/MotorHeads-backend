-- 0011_foundry_pool.sql — reward rounds move ON CHAIN (founder 2026-09-19: "a pool for reward where I can manually transfer
-- eth there but also I can withdraw back to my wallet, and people can ... depending on their tier claim rewards"). Apply ONCE via
--   wrangler d1 execute motorheads_registry --remote --file=migrations/0011_foundry_pool.sql      (execute-file track; NO triggers)
-- The pool is the FoundryRewardPool contract; a round is a Merkle root over (roundId, tokenId, amount). The backend keeps the
-- snapshot, the amounts and each robot's proof so the page can build the claim transaction; the MONEY and the claimed flags
-- live in the contract. No round was ever opened under the manual-payout design of 0009, so its claimed_by / paid_* columns
-- simply stay unused.
CREATE TABLE IF NOT EXISTS mh_foundry_settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE mh_reward_rounds ADD COLUMN onchain_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mh_reward_rounds ADD COLUMN root TEXT;
ALTER TABLE mh_reward_rounds ADD COLUMN pool TEXT;
ALTER TABLE mh_reward_shares ADD COLUMN proof TEXT;
