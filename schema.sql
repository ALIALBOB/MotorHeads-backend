CREATE TABLE IF NOT EXISTS token_visual_state (
  token_id INTEGER PRIMARY KEY,
  owner_address TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  overlay_json TEXT NOT NULL,
  color_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  signature TEXT NOT NULL,
  signed_message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profile (
  token_id INTEGER PRIMARY KEY,
  owner_address TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  mood TEXT NOT NULL,
  awakened_at TEXT NOT NULL,
  memory_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  signature TEXT NOT NULL,
  signed_message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id TEXT PRIMARY KEY,
  token_id INTEGER,
  owner_address TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_chain_state (
  token_id INTEGER PRIMARY KEY,
  owner_address TEXT,
  minted_at_block INTEGER,
  holder_since_block INTEGER,
  last_transfer_block INTEGER,
  transfer_count INTEGER NOT NULL DEFAULT 0,
  sale_count INTEGER NOT NULL DEFAULT 0,
  last_sale_block INTEGER,
  last_sale_price_wei TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_event (
  event_id TEXT PRIMARY KEY,
  token_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  from_address TEXT,
  to_address TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_indexer_checkpoint (
  checkpoint_key TEXT PRIMARY KEY,
  indexed_to_block INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_metrics (
  metric_key TEXT PRIMARY KEY,
  latest_block INTEGER,
  gas_wei TEXT,
  gas_level TEXT NOT NULL DEFAULT 'idle',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS part_catalog (
  part_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  rarity TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_event_log_token_id ON event_log(token_id);
CREATE INDEX IF NOT EXISTS idx_event_log_owner_address ON event_log(owner_address);
CREATE INDEX IF NOT EXISTS idx_token_visual_state_owner_address ON token_visual_state(owner_address);
CREATE INDEX IF NOT EXISTS idx_token_chain_state_owner_address ON token_chain_state(owner_address);
CREATE INDEX IF NOT EXISTS idx_chain_event_token_id ON chain_event(token_id);
CREATE INDEX IF NOT EXISTS idx_chain_event_block_number ON chain_event(block_number);
CREATE INDEX IF NOT EXISTS idx_chain_event_tx_hash ON chain_event(tx_hash);
