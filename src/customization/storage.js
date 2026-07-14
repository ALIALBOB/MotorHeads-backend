import { changes, requireDatabase } from "./database.js";
import { ApiError } from "./http.js";

function iso(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

async function currentRow(db, contractAddress, tokenId) {
  return db.prepare(`
    SELECT contract_address, token_id, schema_version, catalog_version,
      placement_manifest_version, source_layout_hash, validator_version,
      validator_artifact_hash, state_json, state_hash, revision, active,
      owner_at_save, saved_by, created_at, updated_at
    FROM mh_customization_states
    WHERE contract_address = ? AND token_id = ?
  `).bind(contractAddress, tokenId).first();
}

function conflict(currentRevision) {
  return new ApiError(409, "CUSTOMIZATION_STATE_CONFLICT", "Customization state changed since it was loaded.", {
    details: { currentRevision: Number(currentRevision) }
  });
}

export async function readCustomization(env, contractAddress, tokenId) {
  const row = await currentRow(requireDatabase(env), contractAddress, tokenId);
  if (!row) {
    return { exists: false, contractAddress, tokenId, revision: 0, state: null, renderable: false };
  }
  if (!Number(row.active)) {
    return { exists: false, contractAddress, tokenId, revision: Number(row.revision), state: null, renderable: false };
  }
  let state;
  try {
    state = JSON.parse(row.state_json);
  } catch {
    throw new ApiError(503, "CUSTOMIZATION_READ_UNAVAILABLE", "Saved customization is temporarily unavailable; use the original MotorHead.", { retryable: true });
  }
  return {
    exists: true,
    contractAddress,
    tokenId,
    revision: Number(row.revision),
    stateHash: row.state_hash,
    state,
    updatedAt: iso(row.updated_at),
    renderable: true
  };
}

export async function saveCustomization(env, {
  contractAddress,
  tokenId,
  expectedRevision,
  normalizedState,
  canonicalJson,
  stateHash,
  ownerAddress,
  validator
}) {
  const db = requireDatabase(env);
  const existing = await currentRow(db, contractAddress, tokenId);
  const currentRevision = Number(existing?.revision || 0);
  if (currentRevision !== expectedRevision) throw conflict(currentRevision);
  const revision = expectedRevision + 1;
  const now = Math.floor(Date.now() / 1000);

  const history = db.prepare(`
    INSERT INTO mh_customization_history
      (contract_address, token_id, revision, action, schema_version, catalog_version,
       placement_manifest_version, source_layout_hash, validator_version,
       validator_artifact_hash, state_json, state_hash, owner_at_save, saved_by, created_at)
    VALUES (?, ?, ?, 'SAVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    contractAddress, tokenId, revision, normalizedState.schemaVersion,
    normalizedState.catalogVersion, normalizedState.placementManifestVersion,
    normalizedState.sourceLayoutHash, validator.validationVersion,
    validator.artifactSha256, canonicalJson, stateHash, ownerAddress, ownerAddress, now
  );
  const current = db.prepare(`
    INSERT INTO mh_customization_states
      (contract_address, token_id, schema_version, catalog_version,
       placement_manifest_version, source_layout_hash, validator_version,
       validator_artifact_hash, state_json, state_hash, revision, active,
       owner_at_save, saved_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(contract_address, token_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      catalog_version = excluded.catalog_version,
      placement_manifest_version = excluded.placement_manifest_version,
      source_layout_hash = excluded.source_layout_hash,
      validator_version = excluded.validator_version,
      validator_artifact_hash = excluded.validator_artifact_hash,
      state_json = excluded.state_json,
      state_hash = excluded.state_hash,
      revision = excluded.revision,
      active = 1,
      owner_at_save = excluded.owner_at_save,
      saved_by = excluded.saved_by,
      updated_at = excluded.updated_at
    WHERE mh_customization_states.revision = ?
  `).bind(
    contractAddress, tokenId, normalizedState.schemaVersion, normalizedState.catalogVersion,
    normalizedState.placementManifestVersion, normalizedState.sourceLayoutHash,
    validator.validationVersion, validator.artifactSha256, canonicalJson, stateHash,
    revision, ownerAddress, ownerAddress, now, now, expectedRevision
  );

  try {
    const results = await db.batch([history, current]);
    if (changes(results?.[1]) !== 1) throw conflict((await currentRow(db, contractAddress, tokenId))?.revision || 0);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const latest = await currentRow(db, contractAddress, tokenId);
    if (Number(latest?.revision || 0) !== expectedRevision) throw conflict(Number(latest?.revision || 0));
    throw new ApiError(503, "CUSTOMIZATION_WRITE_UNAVAILABLE", "Customization could not be saved. Existing state was not changed.", { retryable: true });
  }
  return { revision, stateHash, updatedAt: iso(now) };
}

export async function resetCustomization(env, {
  contractAddress,
  tokenId,
  expectedRevision,
  ownerAddress
}) {
  const db = requireDatabase(env);
  const existing = await currentRow(db, contractAddress, tokenId);
  if (!existing || !Number(existing.active)) {
    throw new ApiError(404, "CUSTOMIZATION_NOT_FOUND", "No active customization exists for this MotorHead.", {
      details: { currentRevision: Number(existing?.revision || 0) }
    });
  }
  if (Number(existing.revision) !== expectedRevision) throw conflict(Number(existing.revision));
  const revision = expectedRevision + 1;
  const now = Math.floor(Date.now() / 1000);

  const history = db.prepare(`
    INSERT INTO mh_customization_history
      (contract_address, token_id, revision, action, schema_version, catalog_version,
       placement_manifest_version, source_layout_hash, validator_version,
       validator_artifact_hash, state_json, state_hash, owner_at_save, saved_by, created_at)
    VALUES (?, ?, ?, 'RESET', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    contractAddress, tokenId, revision, existing.schema_version, existing.catalog_version,
    existing.placement_manifest_version, existing.source_layout_hash,
    existing.validator_version, existing.validator_artifact_hash, existing.state_json,
    existing.state_hash, ownerAddress, ownerAddress, now
  );
  const current = db.prepare(`
    UPDATE mh_customization_states SET
      revision = ?, active = 0, owner_at_save = ?, saved_by = ?, updated_at = ?
    WHERE contract_address = ? AND token_id = ? AND revision = ? AND active = 1
  `).bind(revision, ownerAddress, ownerAddress, now, contractAddress, tokenId, expectedRevision);

  try {
    const results = await db.batch([history, current]);
    if (changes(results?.[1]) !== 1) throw conflict((await currentRow(db, contractAddress, tokenId))?.revision || 0);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const latest = await currentRow(db, contractAddress, tokenId);
    if (Number(latest?.revision || 0) !== expectedRevision) throw conflict(Number(latest?.revision || 0));
    throw new ApiError(503, "CUSTOMIZATION_WRITE_UNAVAILABLE", "Customization could not be reset. Existing state was not changed.", { retryable: true });
  }
  return { revision, resetAt: iso(now) };
}

export async function readCustomizationHistory(env, contractAddress, tokenId) {
  const result = await requireDatabase(env).prepare(`
    SELECT revision, action, state_hash, owner_at_save, saved_by, created_at
    FROM mh_customization_history
    WHERE contract_address = ? AND token_id = ? ORDER BY revision ASC
  `).bind(contractAddress, tokenId).all();
  return (result?.results || []).map((row) => ({ ...row, revision: Number(row.revision) }));
}
