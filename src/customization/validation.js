import { getAddress } from "viem";
import { normalizeMountZone } from "../vendor/holder-validation/v1/data/compatibility-rules.js";
import { getItemPlacementRule } from "../vendor/holder-validation/v1/data/item-placement-rules.js";
import { validateHolderLayout } from "../vendor/holder-validation/v1/lib/validate-holder-layout.js";
import { HOLDER_VALIDATION_ARTIFACT } from "../vendor/holder-validation/v1/artifact-info.js";
import {
  CUSTOMIZATION_CHAIN_ID,
  CUSTOMIZATION_CONTRACT,
  CUSTOMIZATION_SCHEMA_VERSION
} from "./constants.js";
import { ApiError } from "./http.js";

const DISABLED_CATEGORIES = new Set(["goldenTrait", "pet", "badge"]);

function round(value, places) {
  const factor = 10 ** places;
  const result = Math.round(Number(value) * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

function validationDetails(errors) {
  return errors.slice(0, 8).map(({ code, itemId, message, region, mountZone, conflictsWith }) => ({
    code,
    itemId: itemId || null,
    message,
    ...(region ? { region } : {}),
    ...(mountZone ? { mountZone } : {}),
    ...(conflictsWith ? { conflictsWith } : {})
  }));
}

export function validateAndNormalizeState({ routeContract, routeTokenId, state, tokenManifest }) {
  const normalizedContract = getAddress(state.tokenContract).toLowerCase();
  if (normalizedContract !== routeContract || normalizedContract !== CUSTOMIZATION_CONTRACT) {
    throw new ApiError(400, "UNSUPPORTED_COLLECTION", "Only the MotorHeads collection is supported by this beta.");
  }
  if (Number(state.tokenId) !== routeTokenId || Number(tokenManifest.tokenId) !== routeTokenId) {
    throw new ApiError(400, "TOKEN_ID_MISMATCH", "State, route, and placement token IDs must match.");
  }
  if (Number(state.schemaVersion) !== CUSTOMIZATION_SCHEMA_VERSION || Number(state.chainId) !== CUSTOMIZATION_CHAIN_ID) {
    throw new ApiError(409, "STATE_VERSION_MISMATCH", "State schema or chain version does not match this service.");
  }
  if (Number(state.catalogVersion) !== HOLDER_VALIDATION_ARTIFACT.catalogVersion ||
      Number(state.placementManifestVersion) !== HOLDER_VALIDATION_ARTIFACT.placementManifestVersion) {
    throw new ApiError(409, "STATE_VERSION_MISMATCH", "Catalog or placement manifest version does not match this service.");
  }
  const authoritativeHash = String(tokenManifest.source.layoutHash).replace(/^0x/, "").toLowerCase();
  if (state.sourceLayoutHash !== authoritativeHash) {
    throw new ApiError(409, "SOURCE_LAYOUT_HASH_MISMATCH", "Source layout hash does not match the selected MotorHead.");
  }
  if (state.backgroundId !== null) throw new ApiError(409, "BACKGROUND_NOT_SAVEABLE", "Background customization is not saveable in this beta.");

  for (const candidate of state.items) {
    const rule = getItemPlacementRule(candidate.itemId);
    if (!rule) throw new ApiError(409, "ITEM_UNKNOWN", "Customization contains an unknown item.", { details: { itemId: candidate.itemId } });
    if (rule.status !== "available" || DISABLED_CATEGORIES.has(rule.category)) {
      throw new ApiError(409, "ITEM_NOT_SAVEABLE", "This item is not saveable in the website beta.", { details: { itemId: candidate.itemId } });
    }
    const requestedZone = normalizeMountZone(candidate.mountZone);
    const allowedZones = rule.mountZones.map(normalizeMountZone);
    if (!allowedZones.includes(requestedZone)) {
      throw new ApiError(409, "MOUNT_ZONE_UNSUPPORTED", "Item mount zone is not approved.", { details: { itemId: candidate.itemId, mountZone: candidate.mountZone } });
    }
  }

  const result = validateHolderLayout({
    tokenId: routeTokenId,
    tokenManifest,
    walletInventory: {},
    backgroundId: null,
    items: state.items,
    catalogVersion: HOLDER_VALIDATION_ARTIFACT.catalogVersion,
    placementManifestVersion: HOLDER_VALIDATION_ARTIFACT.placementManifestVersion,
    publicMode: true
  });
  if (!result.valid || !result.normalizedLayout) {
    const errors = validationDetails(result.errors || []);
    throw new ApiError(409, errors[0]?.code || "LAYOUT_VALIDATION_FAILED", errors[0]?.message || "Customization layout failed server validation.", { details: { validationErrors: errors } });
  }

  const items = result.normalizedLayout.items.map((item) => ({
    itemId: item.itemId,
    slot: item.slot,
    category: item.category,
    mountZone: item.mountZone,
    variantId: item.variantId,
    dx: round(item.dx, 2),
    dy: round(item.dy, 2),
    scale: round(item.scale, 4),
    rotation: round(item.rotation, 6),
    z: round(item.z, 2)
  })).sort((a, b) =>
    a.z - b.z || a.slot.localeCompare(b.slot) || a.itemId.localeCompare(b.itemId) ||
    a.mountZone.localeCompare(b.mountZone) || String(a.variantId).localeCompare(String(b.variantId))
  );

  return {
    normalizedState: {
      schemaVersion: CUSTOMIZATION_SCHEMA_VERSION,
      chainId: CUSTOMIZATION_CHAIN_ID,
      tokenContract: CUSTOMIZATION_CONTRACT,
      tokenId: routeTokenId,
      catalogVersion: HOLDER_VALIDATION_ARTIFACT.catalogVersion,
      placementManifestVersion: HOLDER_VALIDATION_ARTIFACT.placementManifestVersion,
      sourceLayoutHash: authoritativeHash,
      backgroundId: null,
      items
    },
    validator: HOLDER_VALIDATION_ARTIFACT
  };
}
