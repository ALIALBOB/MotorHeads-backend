export const HOLDER_PLACEMENT_CATALOG_VERSION = 1;

export const CONFIDENCE_THRESHOLDS = Object.freeze({
  high: 0.85,
  medium: 0.65
});

export const SAFE_INITIAL_MOUNT_ZONES = Object.freeze([
  "chest",
  "leftShoulder",
  "rightShoulder",
  "leftArm",
  "rightArm",
  "backpack",
  "leftSidePanel",
  "rightSidePanel",
  "background"
]);

export const HEAD_PROFILE_ALIASES = Object.freeze({
  "CRT TV": "tv-head",
  "Ledger BTC Head": "tv-head",
  "Signal Tower": "tv-head",
  "Full Gold Head": "tv-head",
  "Clock Head": "clock-head",
  "Reader Clock": "clock-head",
  "Round Clock": "clock-head",
  "Computer Head": "computer-head",
  "Terminal Head": "computer-head",
  "Monitor Head": "computer-head",
  "Orb Head": "round-head",
  "Glass Dome": "round-head",
  "Round Dome": "round-head",
  "Canister Head": "canister-head",
  "Tube Head": "canister-head"
});

export function confidenceLevel(confidence) {
  const value = Number(confidence || 0);
  if (value >= CONFIDENCE_THRESHOLDS.high) return "HIGH";
  if (value >= CONFIDENCE_THRESHOLDS.medium) return "MEDIUM";
  return "LOW";
}

export function isHighConfidence(confidence) {
  return confidenceLevel(confidence) === "HIGH";
}

export function normalizeMountZone(zone) {
  const text = String(zone || "").trim();
  if (text === "fullCanvasBackground" || text === "canvas" || text === "fullCanvas") return "background";
  if (text === "petBackpack") return "backpack";
  return text;
}

export function inferHeadProfile(headName) {
  const exact = HEAD_PROFILE_ALIASES[headName];
  if (exact) return exact;
  const text = String(headName || "").toLowerCase();
  if (text.includes("tv") || text.includes("screen") || text.includes("ledger") || text.includes("reader")) return "tv-head";
  if (text.includes("clock")) return "clock-head";
  if (text.includes("computer") || text.includes("terminal") || text.includes("monitor")) return "computer-head";
  if (text.includes("dome") || text.includes("orb") || text.includes("round")) return "round-head";
  if (text.includes("canister") || text.includes("tube")) return "canister-head";
  return "unknown-head";
}

export function profileCompatible(rule, tokenManifest) {
  const allowed = rule?.compatibleHeadProfiles;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  const headProfile = tokenManifest?.profiles?.headProfile || inferHeadProfile(tokenManifest?.profiles?.head);
  return allowed.includes(headProfile);
}

export function selectVariantId(rule, tokenManifest) {
  if (!rule) return null;
  if (!rule.variants) return rule.variantId || rule.id;
  const headProfile = tokenManifest?.profiles?.headProfile || inferHeadProfile(tokenManifest?.profiles?.head);
  return rule.variants[headProfile] || rule.variants.default || null;
}

export function walletHasGoldenAccess(walletInventory = {}) {
  return Boolean(
    walletInventory.goldenAccess ||
    walletInventory.goldenHolder ||
    walletInventory.fullGoldHolder ||
    walletInventory.hasGoldenTrait ||
    walletInventory.visualEdition === "Full Gold Edition"
  );
}

export function walletHasItemAccess(rule, walletInventory = {}) {
  if (!rule?.requirements) return true;
  if (rule.requirements.golden && !walletHasGoldenAccess(walletInventory)) return false;
  if (rule.requirements.itemId && !walletInventory.unlockedItemIds?.includes(rule.requirements.itemId)) return false;
  if (rule.requirements.collection && !walletInventory.collections?.includes(rule.requirements.collection)) return false;
  return true;
}

export function compatibilityReasonForZone(zone, rule) {
  if (rule?.slot === "headwear") return "NOT YET COMPATIBLE WITH THIS HEAD";
  return "This mount position still needs calibration for this MotorHead.";
}
