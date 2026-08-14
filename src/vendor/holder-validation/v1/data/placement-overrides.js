export const PLACEMENT_OVERRIDES = Object.freeze({});

export function getPlacementOverride(tokenId, itemId = null, overrides = PLACEMENT_OVERRIDES) {
  const tokenOverride = overrides[String(tokenId)] || overrides[Number(tokenId)] || null;
  if (!tokenOverride || !itemId) return tokenOverride;
  return tokenOverride.itemOverrides?.[itemId] || tokenOverride;
}
