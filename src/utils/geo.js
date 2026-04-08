/**
 * Haversine distance between two { latitude, longitude } points.
 * Returns meters.
 */
export const getDistance = (a, b) => {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

// ──────────────────────────────────────────────────────────────────────────────
// Snap-to-route helpers. These use { lat, lng } objects (matching the route
// shape returned by OSRM) — distinct from getDistance above which uses
// { latitude, longitude }. All distances in metres.
// ──────────────────────────────────────────────────────────────────────────────

const EARTH_R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance between two { lat, lng } points, in metres. */
export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

// Equirectangular projection into local-tangent metres around `ref`.
// Accurate to <0.1% for short segments — far below GPS noise.
function toMeters(p, ref) {
  const x = toRad(p.lng - ref.lng) * Math.cos(toRad(ref.lat)) * EARTH_R;
  const y = toRad(p.lat - ref.lat) * EARTH_R;
  return { x, y };
}

function fromMeters(m, ref) {
  const lat = ref.lat + (m.y / EARTH_R) * (180 / Math.PI);
  const lng =
    ref.lng + (m.x / (EARTH_R * Math.cos(toRad(ref.lat)))) * (180 / Math.PI);
  return { lat, lng };
}

// Closest point on segment a→b to p, plus perpendicular distance.
function closestOnSegment(p, a, b) {
  const P = toMeters(p, a);
  const B = toMeters(b, a);
  const lenSq = B.x * B.x + B.y * B.y;
  let t = lenSq > 0 ? (P.x * B.x + P.y * B.y) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: t * B.x, y: t * B.y };
  const dist = Math.hypot(P.x - proj.x, P.y - proj.y);
  return { point: fromMeters(proj, a), distance: dist };
}

/**
 * Find the closest point on a polyline to `point`. Search starts at
 * `fromIndex` so callers can prevent backward snapping when the user is
 * progressing forward along the route.
 *
 * Returns { point, segmentIndex, distance } or null if route is too short.
 */
export function snapToRoute(point, route, fromIndex = 0) {
  if (!route || route.length < 2) return null;
  const start = Math.max(0, Math.min(fromIndex, route.length - 2));
  let best = null;
  for (let i = start; i < route.length - 1; i++) {
    const r = closestOnSegment(point, route[i], route[i + 1]);
    if (!best || r.distance < best.distance) {
      best = { point: r.point, segmentIndex: i, distance: r.distance };
    }
  }
  return best;
}

/** Return [snappedPoint, route[segmentIndex+1], …, route[last]]. */
export function sliceRouteFrom(route, segmentIndex, snappedPoint) {
  return [snappedPoint, ...route.slice(segmentIndex + 1)];
}

/** Total length of a polyline in metres. */
export function routeLengthMeters(route) {
  if (!route || route.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    total += haversineMeters(route[i], route[i + 1]);
  }
  return total;
}

/** Format metres as "1.2 km" or "450 m". */
export function formatDistanceMeters(m) {
  if (!Number.isFinite(m) || m < 0) return '--';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
