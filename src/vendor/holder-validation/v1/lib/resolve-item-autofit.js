import { getItemPlacementRule, ITEM_PLACEMENT_RULES } from "../data/item-placement-rules.js";
import {
  compatibilityReasonForZone,
  isHighConfidence,
  normalizeMountZone,
  profileCompatible,
  selectVariantId,
  walletHasItemAccess
} from "../data/compatibility-rules.js";
import { getPlacementOverride, PLACEMENT_OVERRIDES } from "../data/placement-overrides.js";

function incompatible({ tokenId, itemId, mountZone, reason, code = "INCOMPATIBLE", confidence = 0 }) {
  return {
    compatible: false,
    supported: false,
    code,
    reason,
    tokenId,
    itemId,
    mountZone,
    variantId: null,
    baseTransform: null,
    adjustmentLimits: null,
    surface: null,
    protectedRegions: [],
    confidence
  };
}

export function resolveItemAutoFit({
  tokenId,
  itemId,
  requestedMountZone = null,
  tokenManifest = null,
  itemRules = ITEM_PLACEMENT_RULES,
  overrides = PLACEMENT_OVERRIDES,
  walletInventory = {},
  publicMode = true
} = {}) {
  const rule = getItemPlacementRule(itemId, itemRules);
  if (!rule) {
    return incompatible({ tokenId, itemId, mountZone: requestedMountZone, reason: "Unknown holder workshop item.", code: "ITEM_UNKNOWN" });
  }
  if (!tokenManifest) {
    return incompatible({ tokenId, itemId, mountZone: requestedMountZone, reason: "Token placement manifest is required.", code: "TOKEN_MANIFEST_MISSING" });
  }

  const override = getPlacementOverride(tokenManifest.tokenId || tokenId, itemId, overrides);
  if (override?.compatible === false) {
    return incompatible({
      tokenId: tokenManifest.tokenId || tokenId,
      itemId,
      mountZone: requestedMountZone,
      reason: override.reason || "This item has an explicit token override.",
      code: "TOKEN_OVERRIDE_REJECTED"
    });
  }

  if (rule.status !== "available") {
    return incompatible({
      tokenId: tokenManifest.tokenId || tokenId,
      itemId,
      mountZone: requestedMountZone,
      reason: "This item is not available for public placement.",
      code: "ITEM_UNAVAILABLE"
    });
  }
  if (!walletHasItemAccess(rule, walletInventory)) {
    return incompatible({
      tokenId: tokenManifest.tokenId || tokenId,
      itemId,
      mountZone: requestedMountZone,
      reason: "Wallet does not meet this item's holder requirement.",
      code: "WALLET_REQUIREMENT_FAILED"
    });
  }
  if (!profileCompatible(rule, tokenManifest)) {
    return incompatible({
      tokenId: tokenManifest.tokenId || tokenId,
      itemId,
      mountZone: requestedMountZone,
      reason: rule.slot === "headwear" ? "NOT YET COMPATIBLE WITH THIS HEAD" : "No compatible item variant exists for this MotorHead.",
      code: "PROFILE_INCOMPATIBLE"
    });
  }

  const requested = normalizeMountZone(requestedMountZone || rule.mountZones[0]);
  const allowedZones = rule.mountZones.map(normalizeMountZone);
  const mountZone = allowedZones.includes(requested) ? requested : allowedZones[0];
  if (!mountZone) {
    return incompatible({ tokenId: tokenManifest.tokenId || tokenId, itemId, mountZone: requested, reason: "No approved mount zone is configured.", code: "MOUNT_ZONE_UNSUPPORTED" });
  }

  const surface = override?.surfaces?.[mountZone] || tokenManifest.surfaces?.[mountZone] || null;
  const confidence = Number(surface?.confidence ?? tokenManifest.confidence?.[mountZone]?.surface ?? 0);
  const anchorConfidence = Number(tokenManifest.confidence?.[mountZone]?.anchor ?? surface?.rawAnchorConfidence ?? confidence);
  if (!surface) {
    return incompatible({
      tokenId: tokenManifest.tokenId || tokenId,
      itemId,
      mountZone,
      reason: compatibilityReasonForZone(mountZone, rule),
      code: "MOUNT_ZONE_UNSUPPORTED"
    });
  }
  if (publicMode && (!isHighConfidence(confidence) || anchorConfidence < 0.65)) {
    return incompatible({
      tokenId: tokenManifest.tokenId || tokenId,
      itemId,
      mountZone,
      reason: compatibilityReasonForZone(mountZone, rule),
      code: "CONFIDENCE_TOO_LOW",
      confidence
    });
  }

  const variantId = override?.variantId || selectVariantId(rule, tokenManifest);
  if (!variantId) {
    return incompatible({
      tokenId: tokenManifest.tokenId || tokenId,
      itemId,
      mountZone,
      reason: "No compatible visual variant exists for this MotorHead.",
      code: "VARIANT_UNAVAILABLE",
      confidence
    });
  }

  const anchor = surface.anchor || { x: 512, y: 512 };
  const anchorOffset = rule.anchorOffset || {};
  return {
    compatible: true,
    supported: true,
    reason: null,
    tokenId: tokenManifest.tokenId || tokenId,
    itemId,
    mountZone,
    variantId,
    baseTransform: {
      x: Number(override?.baseTransform?.x ?? Number(anchor.x) + Number(anchorOffset.x || 0)),
      y: Number(override?.baseTransform?.y ?? Number(anchor.y) + Number(anchorOffset.y || 0)),
      scaleX: Number(override?.baseTransform?.scaleX ?? 1),
      scaleY: Number(override?.baseTransform?.scaleY ?? 1),
      scale: Number(override?.baseTransform?.scale ?? 1),
      rotation: Number(override?.baseTransform?.rotation ?? 0),
      z: Number(override?.baseTransform?.z ?? rule.z ?? 100)
    },
    renderSize: rule.renderSize,
    adjustmentLimits: rule.adjustmentLimits,
    surface,
    protectedRegions: Object.entries(tokenManifest.protectedRegions || {}).map(([id, region]) => ({ id, ...region })),
    confidence
  };
}
