export const CATEGORY_LIMITS = Object.freeze({
  headwear: 1,
  eyewear: 1,
  mouthAccessory: 1,
  neckAccessory: 1,
  backpackAccessory: 1,
  pet: 1,
  background: 1,
  badge: 2,
  sticker: 3,
  shoulderPart: 2,
  armPart: 2,
  sidePart: 2,
  goldenTrait: 2
});

export const DEFAULT_ITEM_INSTANCE_RULE = Object.freeze({
  maxInstances: 1,
  allowDuplicates: false
});

export const CATEGORY_TRANSFORM_LIMITS = Object.freeze({
  wearable: Object.freeze({
    dx: Object.freeze([-24, 24]),
    dy: Object.freeze([-24, 24]),
    scale: Object.freeze([0.9, 1.1]),
    rotationRad: Object.freeze([-0.122173, 0.122173])
  }),
  sticker: Object.freeze({
    dx: Object.freeze([-36, 36]),
    dy: Object.freeze([-36, 36]),
    scale: Object.freeze([0.75, 1.25]),
    rotationRad: Object.freeze([-0.349066, 0.349066])
  }),
  badge: Object.freeze({
    dx: Object.freeze([-18, 18]),
    dy: Object.freeze([-18, 18]),
    scale: Object.freeze([0.9, 1.05]),
    rotationRad: Object.freeze([-0.087266, 0.087266])
  }),
  pet: Object.freeze({
    dx: Object.freeze([-28, 28]),
    dy: Object.freeze([-28, 28]),
    scale: Object.freeze([0.9, 1.1]),
    rotationRad: Object.freeze([-0.10472, 0.10472])
  }),
  background: Object.freeze({
    dx: Object.freeze([0, 0]),
    dy: Object.freeze([0, 0]),
    scale: Object.freeze([1, 1]),
    rotationRad: Object.freeze([0, 0])
  })
});

export function transformLimitKeyForCategory(category) {
  if (category === "background") return "background";
  if (category === "pet") return "pet";
  if (category === "badge") return "badge";
  if (category === "sticker") return "sticker";
  return "wearable";
}

export function transformLimitsForCategory(category) {
  return CATEGORY_TRANSFORM_LIMITS[transformLimitKeyForCategory(category)] || CATEGORY_TRANSFORM_LIMITS.wearable;
}
