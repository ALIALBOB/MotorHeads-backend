import { clamp, clampItemBoundsToSurface, itemBounds, boundsForSurface, protectedRegionBounds, rectsOverlap } from "./holder-placement-geometry.js";

export function clampItemAdjustment({
  tokenManifest,
  itemRule,
  baseTransform,
  surface = null,
  requestedAdjustment = {},
  protectedRegions = null
} = {}) {
  if (!itemRule || !baseTransform) {
    return { valid: false, transform: null, clamped: {}, errors: [{ code: "TRANSFORM_INPUT_MISSING", message: "Item rule and base transform are required." }] };
  }

  const limits = itemRule.adjustmentLimits || {};
  const fixed = itemRule.category === "background" || itemRule.fixed;
  const dx = fixed ? 0 : clamp(requestedAdjustment.dx ?? 0, limits.dx?.[0] ?? 0, limits.dx?.[1] ?? 0);
  const dy = fixed ? 0 : clamp(requestedAdjustment.dy ?? 0, limits.dy?.[0] ?? 0, limits.dy?.[1] ?? 0);
  const scale = fixed ? 1 : clamp(requestedAdjustment.scale ?? 1, limits.scale?.[0] ?? 1, limits.scale?.[1] ?? 1);
  const rotation = fixed ? 0 : clamp(requestedAdjustment.rotation ?? 0, limits.rotationRad?.[0] ?? 0, limits.rotationRad?.[1] ?? 0);

  const clamped = {
    dx: dx !== Number(requestedAdjustment.dx ?? 0),
    dy: dy !== Number(requestedAdjustment.dy ?? 0),
    scale: scale !== Number(requestedAdjustment.scale ?? 1),
    rotation: rotation !== Number(requestedAdjustment.rotation ?? 0),
    surface: false
  };

  const surfaceBounds = boundsForSurface(surface);
  let finalDx = dx;
  let finalDy = dy;
  if (!fixed && itemRule.constrainToSurface !== false && surfaceBounds) {
    const bounds = itemBounds(baseTransform, itemRule.renderSize, { dx: finalDx, dy: finalDy, scale });
    const correction = clampItemBoundsToSurface(bounds, surfaceBounds);
    finalDx += correction.dx;
    finalDy += correction.dy;
    clamped.surface = correction.dx !== 0 || correction.dy !== 0;
  }

  const transform = {
    x: baseTransform.x + finalDx,
    y: baseTransform.y + finalDy,
    dx: finalDx,
    dy: finalDy,
    scale,
    scaleX: Number(baseTransform.scaleX ?? 1) * scale,
    scaleY: Number(baseTransform.scaleY ?? 1) * scale,
    rotation: Number(baseTransform.rotation || 0) + rotation,
    z: baseTransform.z
  };

  const errors = [];
  if (fixed) {
    const moved = Number(requestedAdjustment.dx || 0) !== 0 || Number(requestedAdjustment.dy || 0) !== 0 || Number(requestedAdjustment.rotation || 0) !== 0 || Number(requestedAdjustment.scale ?? 1) !== 1;
    if (moved) {
      errors.push({ code: "BACKGROUND_TRANSFORM_LOCKED", message: "Backgrounds are fixed full-canvas items and cannot move, resize, or rotate." });
    }
  }

  if (!fixed) {
    const itemRect = itemBounds(transform, itemRule.renderSize);
    const regions = protectedRegions || Object.entries(tokenManifest?.protectedRegions || {}).map(([id, region]) => ({ id, ...region }));
    for (const region of regions) {
      if (itemRule.allowedProtectedOverlap?.includes(region.id)) continue;
      const regionBounds = protectedRegionBounds(region);
      if (regionBounds && region.enforce !== false && rectsOverlap(itemRect, regionBounds)) {
        errors.push({ code: "PROTECTED_REGION_OVERLAP", region: region.id, message: `Item overlaps protected MotorHead region: ${region.id}.` });
      }
    }
  }

  return {
    valid: errors.length === 0,
    transform,
    clamped,
    errors
  };
}
