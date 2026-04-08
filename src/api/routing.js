// ──────────────────────────────────────────────────────────────────────────────
// OSRM routing — public demo server at router.project-osrm.org.
// Free for light use, no key. For production, self-host or use a paid provider.
// Docs: http://project-osrm.org/docs/v5.24.0/api/
// ──────────────────────────────────────────────────────────────────────────────
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

// In-memory route cache. Keyed by rounded origin+destination so small GPS
// jitter still hits the cache. Bounded to keep memory tiny.
const routeCache = new Map();
const ROUTE_CACHE_MAX = 30;

function cacheKey(origin, destination) {
  // ~11m precision at the equator — close enough that adjacent GPS samples
  // share a key while still distinguishing genuinely different start points.
  const r = (n) => n.toFixed(4);
  return `${r(origin.lat)},${r(origin.lng)}|${r(destination.lat)},${r(destination.lng)}`;
}

function cachePut(key, value) {
  if (routeCache.size >= ROUTE_CACHE_MAX) {
    const first = routeCache.keys().next().value;
    routeCache.delete(first);
  }
  routeCache.set(key, value);
}

/**
 * Decode a Google-encoded polyline string into an array of [lat, lng] pairs.
 * Matches the output of Python's `polyline.decode`.
 */
export function decodePolyline(str, precision = 5) {
  const factor = Math.pow(10, precision);
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates = [];

  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    coordinates.push([lat / factor, lng / factor]);
  }
  return coordinates;
}

/**
 * Fetch a driving route from OSRM.
 * Inputs are { lat, lng } objects.
 * Returns { route, distance, duration } where:
 *   route    — array of {lat,lng} points along the road
 *   distance — total distance in metres
 *   duration — total driving time in seconds
 */
export async function fetchOsrmRoute(origin, destination, signal) {
  const key = cacheKey(origin, destination);
  const cached = routeCache.get(key);
  if (cached) return cached;

  const url = `${OSRM_URL}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=polyline`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(`OSRM: ${data.code || 'no route'}`);
  }
  const best = data.routes[0];
  const coords = decodePolyline(best.geometry).map(([lat, lng]) => ({ lat, lng }));
  const result = { route: coords, distance: best.distance, duration: best.duration };
  cachePut(key, result);
  return result;
}
