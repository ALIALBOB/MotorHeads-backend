export function roundCoord(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function rectToPolygon(bounds) {
  const x = Number(bounds.x || 0);
  const y = Number(bounds.y || 0);
  const w = Number(bounds.w || 0);
  const h = Number(bounds.h || 0);
  return [
    [roundCoord(x), roundCoord(y)],
    [roundCoord(x + w), roundCoord(y)],
    [roundCoord(x + w), roundCoord(y + h)],
    [roundCoord(x), roundCoord(y + h)]
  ];
}

export function boundsFromPolygon(points = []) {
  if (!points.length) return null;
  const xs = points.map((point) => Number(point[0]));
  const ys = points.map((point) => Number(point[1]));
  const x1 = Math.min(...xs);
  const y1 = Math.min(...ys);
  const x2 = Math.max(...xs);
  const y2 = Math.max(...ys);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
}

export function boundsForSurface(surface) {
  if (!surface) return null;
  if (surface.bounds) return surface.bounds;
  if (surface.points) return boundsFromPolygon(surface.points);
  return null;
}

export function itemBounds(transform, size, adjustment = {}) {
  const scale = Number(adjustment.scale ?? transform.scale ?? 1);
  const x = Number(transform.x || 0) + Number(adjustment.dx || 0);
  const y = Number(transform.y || 0) + Number(adjustment.dy || 0);
  const w = Number(size?.width || 0) * scale;
  const h = Number(size?.height || 0) * scale;
  return { x: x - w / 2, y: y - h / 2, w, h, cx: x, cy: y };
}

export function rectsOverlap(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value || 0)));
}

export function clampItemBoundsToSurface(bounds, surfaceBounds) {
  if (!bounds || !surfaceBounds) return { dx: 0, dy: 0 };
  let dx = 0;
  let dy = 0;
  if (bounds.x < surfaceBounds.x) dx = surfaceBounds.x - bounds.x;
  if (bounds.x + bounds.w > surfaceBounds.x + surfaceBounds.w) dx = surfaceBounds.x + surfaceBounds.w - bounds.x - bounds.w;
  if (bounds.y < surfaceBounds.y) dy = surfaceBounds.y - bounds.y;
  if (bounds.y + bounds.h > surfaceBounds.y + surfaceBounds.h) dy = surfaceBounds.y + surfaceBounds.h - bounds.y - bounds.h;
  return { dx, dy };
}

export function protectedRegionBounds(region) {
  if (!region) return null;
  if (region.bounds) return region.bounds;
  if (region.points) return boundsFromPolygon(region.points);
  return null;
}
