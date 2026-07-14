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

CREATE TABLE IF NOT EXISTS safety_budget_daily (
  budget_key TEXT NOT NULL,
  day_key TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  limit_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (budget_key, day_key)
);

CREATE INDEX IF NOT EXISTS idx_event_log_token_id ON event_log(token_id);
CREATE INDEX IF NOT EXISTS idx_event_log_owner_address ON event_log(owner_address);
CREATE INDEX IF NOT EXISTS idx_token_visual_state_owner_address ON token_visual_state(owner_address);
CREATE INDEX IF NOT EXISTS idx_token_chain_state_owner_address ON token_chain_state(owner_address);
CREATE INDEX IF NOT EXISTS idx_chain_event_token_id ON chain_event(token_id);
CREATE INDEX IF NOT EXISTS idx_chain_event_block_number ON chain_event(block_number);
CREATE INDEX IF NOT EXISTS idx_chain_event_tx_hash ON chain_event(tx_hash);

-- Phase 3A local-only website customization foundation.
CREATE TABLE IF NOT EXISTS mh_auth_nonces (
  nonce_hash TEXT PRIMARY KEY,
  address_hint TEXT,
  domain TEXT NOT NULL,
  uri TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_session_hash TEXT,
  created_ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_mh_auth_nonces_expires_at ON mh_auth_nonces(expires_at);

CREATE TABLE IF NOT EXISTS mh_auth_sessions (
  session_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent_hash TEXT,
  ip_prefix_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_mh_auth_sessions_address ON mh_auth_sessions(address);
CREATE INDEX IF NOT EXISTS idx_mh_auth_sessions_expires_at ON mh_auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS mh_customization_states (
  contract_address TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  catalog_version INTEGER NOT NULL,
  placement_manifest_version INTEGER NOT NULL,
  source_layout_hash TEXT NOT NULL,
  validator_version INTEGER NOT NULL,
  validator_artifact_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  owner_at_save TEXT NOT NULL,
  saved_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (contract_address, token_id)
);
CREATE INDEX IF NOT EXISTS idx_mh_customization_states_updated_at ON mh_customization_states(updated_at);

CREATE TABLE IF NOT EXISTS mh_customization_history (
  contract_address TEXT NOT NULL,
  token_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('SAVE', 'RESET')),
  schema_version INTEGER NOT NULL,
  catalog_version INTEGER NOT NULL,
  placement_manifest_version INTEGER NOT NULL,
  source_layout_hash TEXT NOT NULL,
  validator_version INTEGER NOT NULL,
  validator_artifact_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  owner_at_save TEXT NOT NULL,
  saved_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (contract_address, token_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_mh_customization_history_token ON mh_customization_history(contract_address, token_id, revision);

CREATE TRIGGER IF NOT EXISTS trg_mh_customization_history_revision
BEFORE INSERT ON mh_customization_history
FOR EACH ROW
WHEN NEW.revision != COALESCE(
  (SELECT revision FROM mh_customization_states
   WHERE contract_address = NEW.contract_address AND token_id = NEW.token_id),
  0
) + 1
BEGIN
  SELECT RAISE(ABORT, 'CUSTOMIZATION_STATE_CONFLICT');
END;

CREATE TABLE IF NOT EXISTS mh_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mh_rate_limits_expires_at ON mh_rate_limits(expires_at);
