-- Phase 3A local-only website customization foundation.
-- Production feature flags remain disabled and this migration must not be run remotely in Phase 3A.

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

CREATE INDEX IF NOT EXISTS idx_mh_auth_nonces_expires_at
  ON mh_auth_nonces(expires_at);

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

CREATE INDEX IF NOT EXISTS idx_mh_auth_sessions_address
  ON mh_auth_sessions(address);
CREATE INDEX IF NOT EXISTS idx_mh_auth_sessions_expires_at
  ON mh_auth_sessions(expires_at);

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

CREATE INDEX IF NOT EXISTS idx_mh_customization_states_updated_at
  ON mh_customization_states(updated_at);

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

CREATE INDEX IF NOT EXISTS idx_mh_customization_history_token
  ON mh_customization_history(contract_address, token_id, revision);

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

CREATE INDEX IF NOT EXISTS idx_mh_rate_limits_expires_at
  ON mh_rate_limits(expires_at);
