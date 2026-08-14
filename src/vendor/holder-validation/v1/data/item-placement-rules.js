import { DEFAULT_ITEM_INSTANCE_RULE, transformLimitsForCategory } from "./category-limits.js";

const WEARABLE = transformLimitsForCategory("wearable");
const STICKER = transformLimitsForCategory("sticker");
const BADGE = transformLimitsForCategory("badge");
const PET = transformLimitsForCategory("pet");
const BACKGROUND = transformLimitsForCategory("background");

function rule(input) {
  return Object.freeze({
    status: "available",
    ...DEFAULT_ITEM_INSTANCE_RULE,
    renderSize: Object.freeze(input.renderSize || { width: 72, height: 72 }),
    allowedProtectedOverlap: Object.freeze(input.allowedProtectedOverlap || []),
    conflictsWith: Object.freeze(input.conflictsWith || []),
    mountZones: Object.freeze(input.mountZones || []),
    adjustmentLimits: Object.freeze(input.adjustmentLimits || transformLimitsForCategory(input.category)),
    ...input
  });
}

export const ITEM_PLACEMENT_RULES = Object.freeze({
  "archive-chest-badge": rule({
    id: "archive-chest-badge",
    label: "Archive Chest Badge",
    slot: "badge",
    category: "badge",
    mountZones: ["chest"],
    renderSize: { width: 70, height: 70 },
    anchorOffset: { x: 0, y: -110 },
    constrainToSurface: false,
    adjustmentLimits: BADGE,
    z: 160
  }),
  "left-shoulder-test-sticker": rule({
    id: "left-shoulder-test-sticker",
    label: "Left Shoulder Sticker",
    slot: "sticker",
    category: "sticker",
    mountZones: ["leftShoulder"],
    renderSize: { width: 64, height: 64 },
    adjustmentLimits: STICKER,
    z: 150
  }),
  "right-shoulder-test-sticker": rule({
    id: "right-shoulder-test-sticker",
    label: "Right Shoulder Sticker",
    slot: "sticker",
    category: "sticker",
    mountZones: ["rightShoulder"],
    renderSize: { width: 64, height: 64 },
    adjustmentLimits: STICKER,
    z: 150
  }),
  "backpack-test-sticker": rule({
    id: "backpack-test-sticker",
    label: "Backpack Sticker",
    slot: "sticker",
    category: "sticker",
    mountZones: ["backpack"],
    renderSize: { width: 58, height: 58 },
    adjustmentLimits: STICKER,
    z: 155
  }),
  "side-panel-test-sticker": rule({
    id: "side-panel-test-sticker",
    label: "Side Panel Sticker",
    slot: "sticker",
    category: "sticker",
    mountZones: ["leftSidePanel", "rightSidePanel"],
    renderSize: { width: 58, height: 58 },
    adjustmentLimits: STICKER,
    z: 155
  }),
  "shoulder-plate-part": rule({
    id: "shoulder-plate-part",
    label: "Shoulder Plate Part",
    slot: "shoulderPart",
    category: "shoulderPart",
    status: "coming-soon",
    mountZones: ["leftShoulder", "rightShoulder"],
    renderSize: { width: 92, height: 54 },
    adjustmentLimits: WEARABLE,
    z: 145
  }),
  "backpack-pack-part": rule({
    id: "backpack-pack-part",
    label: "Backpack Part",
    slot: "backpackAccessory",
    category: "backpackAccessory",
    status: "visual-design-pending",
    mountZones: ["backpack"],
    renderSize: { width: 96, height: 96 },
    adjustmentLimits: WEARABLE,
    z: 142
  }),
  "holder-pet": rule({
    id: "holder-pet",
    label: "Holder Pet",
    slot: "pet",
    category: "pet",
    mountZones: ["backpack", "leftShoulder", "rightShoulder"],
    renderSize: { width: 86, height: 86 },
    adjustmentLimits: PET,
    maxInstances: 1,
    z: 170
  }),
  "golden-aviator-sunglasses": rule({
    id: "golden-aviator-sunglasses",
    label: "Golden Aviator Sunglasses",
    slot: "eyewear",
    category: "goldenTrait",
    mountZones: ["eyes"],
    compatibleHeadProfiles: ["tv-head", "clock-head", "computer-head"],
    variants: {
      "tv-head": "golden-aviator-tv",
      "clock-head": "golden-aviator-clock",
      "computer-head": "golden-aviator-computer"
    },
    renderSize: { width: 156, height: 54 },
    anchorOffset: { x: 0, y: -28 },
    constrainToSurface: false,
    maxInstances: 1,
    exclusiveGroup: "eyewear",
    conflictsWith: ["full-face-visor"],
    allowedProtectedOverlap: ["face", "eyes"],
    requirements: { golden: true },
    adjustmentLimits: WEARABLE,
    z: 180
  }),
  "full-face-visor": rule({
    id: "full-face-visor",
    label: "Full Face Visor",
    slot: "headwear",
    category: "headwear",
    mountZones: ["headTop"],
    compatibleHeadProfiles: ["tv-head", "computer-head", "round-head", "canister-head"],
    variants: {
      "tv-head": "full-face-visor-tv",
      "computer-head": "full-face-visor-computer",
      "round-head": "full-face-visor-round",
      "canister-head": "full-face-visor-canister"
    },
    renderSize: { width: 178, height: 126 },
    maxInstances: 1,
    exclusiveGroup: "headwear",
    conflictsWith: ["golden-aviator-sunglasses"],
    allowedProtectedOverlap: ["face", "eyes"],
    adjustmentLimits: WEARABLE,
    z: 181
  }),
  "orange-archive-background": rule({
    id: "orange-archive-background",
    label: "Orange Archive Background",
    slot: "background",
    category: "background",
    mountZones: ["background"],
    variantId: "orange-archive",
    renderSize: { width: 1024, height: 1024 },
    maxInstances: 1,
    adjustmentLimits: BACKGROUND,
    fixed: true,
    z: -100
  }),
  "teal-archive-background": rule({
    id: "teal-archive-background",
    label: "Teal Archive Background",
    slot: "background",
    category: "background",
    mountZones: ["background"],
    variantId: "teal-archive",
    renderSize: { width: 1024, height: 1024 },
    maxInstances: 1,
    adjustmentLimits: BACKGROUND,
    fixed: true,
    z: -100
  })
});

export function getItemPlacementRule(itemId, rules = ITEM_PLACEMENT_RULES) {
  return rules[itemId] || null;
}

export function listPlacementRules(rules = ITEM_PLACEMENT_RULES) {
  return Object.values(rules);
}
