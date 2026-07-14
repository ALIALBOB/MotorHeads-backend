import { CATEGORY_LIMITS } from "../data/category-limits.js";
import { ITEM_PLACEMENT_RULES, getItemPlacementRule } from "../data/item-placement-rules.js";
import { HOLDER_PLACEMENT_CATALOG_VERSION } from "../data/compatibility-rules.js";
import { PLACEMENT_OVERRIDES } from "../data/placement-overrides.js";
import { clampItemAdjustment } from "./clamp-item-adjustment.js";
import { resolveItemAutoFit } from "./resolve-item-autofit.js";

function error(code, itemId, message, extra = {}) {
  return { code, itemId: itemId || null, message, ...extra };
}

function adjustmentHasBackgroundMovement(adjustment = {}) {
  return Number(adjustment.dx || 0) !== 0 ||
    Number(adjustment.dy || 0) !== 0 ||
    Number(adjustment.rotation || 0) !== 0 ||
    Number(adjustment.scale ?? 1) !== 1;
}

export function validateHolderLayout({
  tokenId,
  tokenManifest = null,
  walletInventory = {},
  backgroundId = null,
  items = [],
  catalogVersion = HOLDER_PLACEMENT_CATALOG_VERSION,
  placementManifestVersion = tokenManifest?.source?.placementManifestVersion ?? null,
  itemRules = ITEM_PLACEMENT_RULES,
  overrides = PLACEMENT_OVERRIDES,
  publicMode = true
} = {}) {
  const errors = [];
  if (!tokenManifest) {
    return {
      valid: false,
      normalizedLayout: null,
      errors: [error("TOKEN_MANIFEST_MISSING", null, "Token placement manifest is required.")]
    };
  }

  const candidateItems = [];
  if (backgroundId) {
    candidateItems.push({ itemId: backgroundId, mountZone: "background", adjustment: {} });
  }
  candidateItems.push(...items);

  const categoryCounts = new Map();
  const slotCounts = new Map();
  const itemCounts = new Map();
  const exclusiveGroups = new Map();
  const normalizedItems = [];

  for (const candidate of candidateItems) {
    const itemId = candidate.itemId;
    const rule = getItemPlacementRule(itemId, itemRules);
    if (!rule) {
      errors.push(error("ITEM_UNKNOWN", itemId, "Unknown holder workshop item."));
      continue;
    }
    if (rule.category === "background" && adjustmentHasBackgroundMovement(candidate.adjustment)) {
      errors.push(error("BACKGROUND_TRANSFORM_LOCKED", itemId, "Backgrounds cannot move, resize, or rotate."));
    }

    const category = rule.category;
    const slot = rule.slot;
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    slotCounts.set(slot, (slotCounts.get(slot) || 0) + 1);
    itemCounts.set(itemId, (itemCounts.get(itemId) || 0) + 1);

    if (categoryCounts.get(category) > (CATEGORY_LIMITS[category] || Infinity)) {
      const code = category === "background" ? "BACKGROUND_LIMIT" : category === "pet" ? "PET_LIMIT" : "CATEGORY_LIMIT_EXCEEDED";
      errors.push(error(code, itemId, `Too many ${category} items mounted.`));
    }
    if (slotCounts.get(slot) > 1 && ["headwear", "eyewear", "mouthAccessory", "neckAccessory", "backpackAccessory"].includes(slot)) {
      errors.push(error("SLOT_LIMIT_EXCEEDED", itemId, `Only one ${slot} item can be mounted.`));
    }
    if (!rule.allowDuplicates && itemCounts.get(itemId) > rule.maxInstances) {
      errors.push(error("DUPLICATE_ITEM_REJECTED", itemId, "This item cannot be mounted repeatedly."));
    }
    if (rule.exclusiveGroup) {
      const existing = exclusiveGroups.get(rule.exclusiveGroup);
      if (existing && existing !== itemId) {
        errors.push(error("EXCLUSIVE_GROUP_CONFLICT", itemId, `Remove ${existing} to equip ${itemId}.`, { conflictsWith: existing }));
      }
      exclusiveGroups.set(rule.exclusiveGroup, itemId);
    }
    for (const conflictId of rule.conflictsWith || []) {
      if (candidateItems.some((other) => other.itemId === conflictId)) {
        errors.push(error("ITEM_CONFLICT", itemId, `Remove ${conflictId} to equip ${itemId}.`, { conflictsWith: conflictId }));
      }
    }

    const resolved = resolveItemAutoFit({
      tokenId,
      itemId,
      requestedMountZone: candidate.mountZone,
      tokenManifest,
      itemRules,
      overrides,
      walletInventory,
      publicMode
    });
    if (!resolved.compatible) {
      errors.push(error(resolved.code || "AUTO_FIT_REJECTED", itemId, resolved.reason || "Auto Fit rejected this item.", { mountZone: resolved.mountZone }));
      continue;
    }

    const clamped = clampItemAdjustment({
      tokenManifest,
      itemRule: rule,
      baseTransform: resolved.baseTransform,
      surface: resolved.surface,
      requestedAdjustment: candidate.adjustment || {},
      protectedRegions: resolved.protectedRegions
    });
    for (const transformError of clamped.errors) {
      errors.push(error(transformError.code, itemId, transformError.message, transformError));
    }

    normalizedItems.push({
      itemId,
      slot,
      category,
      mountZone: resolved.mountZone,
      variantId: resolved.variantId,
      dx: clamped.transform?.dx ?? 0,
      dy: clamped.transform?.dy ?? 0,
      scale: clamped.transform?.scale ?? 1,
      rotation: clamped.transform ? clamped.transform.rotation - resolved.baseTransform.rotation : 0,
      z: clamped.transform?.z ?? resolved.baseTransform.z,
      confidence: resolved.confidence
    });
  }

  const backgroundItems = normalizedItems.filter((item) => item.category === "background");
  const finalBackgroundId = backgroundItems.at(-1)?.itemId || null;
  const layoutItems = normalizedItems.filter((item) => item.category !== "background");

  return {
    valid: errors.length === 0,
    normalizedLayout: errors.length === 0 ? {
      tokenId: tokenManifest.tokenId || tokenId,
      catalogVersion: Number(catalogVersion),
      placementManifestVersion: Number(placementManifestVersion),
      sourceLayoutHash: tokenManifest.source?.layoutHash || null,
      backgroundId: finalBackgroundId,
      items: layoutItems
    } : null,
    errors
  };
}
