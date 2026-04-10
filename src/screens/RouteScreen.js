import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

import RouteMap from '../components/RouteMap';
import { fetchOsrmRoute } from '../api/routing';
import { haversineMeters } from '../utils/geo';

// ──────────────────────────────────────────────────────────────────────────────
// Photon geocoder — komoot's OSM-based autocomplete service.
// Free, no API key, designed for type-as-you-go search → much faster than
// Nominatim's public server. Docs: https://photon.komoot.io/
// Supports `lat`/`lon` for location bias and `limit` for result count.
// ──────────────────────────────────────────────────────────────────────────────
const PHOTON_URL = 'https://photon.komoot.io/api/';

// Maximum distance from the user we want to keep, in metres. ~500 km.
const MAX_RESULT_DISTANCE_M = 500_000;

// Tiny in-memory cache so backspace/retype is instant. Keyed by `query|lat|lng`.
const searchCache = new Map();
const CACHE_MAX_ENTRIES = 50;

function buildPhotonUrl(query, origin) {
  const params = new URLSearchParams({ q: query, limit: '10' });
  if (origin) {
    params.set('lat', origin.lat.toFixed(5));
    params.set('lon', origin.lng.toFixed(5));
  }
  return `${PHOTON_URL}?${params.toString()}`;
}

function formatPhotonName(props) {
  // Photon returns { name, street, housenumber, city, state, country, ... }.
  // Build a display string similar to Nominatim's display_name.
  const parts = [
    props.name,
    [props.housenumber, props.street].filter(Boolean).join(' '),
    props.city || props.county,
    props.state,
    props.country,
  ].filter(Boolean);
  // Dedupe consecutive equal parts (e.g. name === city for villages).
  return parts.filter((p, i) => p !== parts[i - 1]).join(', ');
}

/**
 * Fetch place suggestions for a free-text query, biased to the user's
 * location and filtered to ~500 km — similar to how Google Maps autocomplete
 * works. Returns up to 5 { lat, lng, name } objects sorted by distance.
 * `signal` is an optional AbortSignal so stale requests can be cancelled.
 */
async function searchPlaces(query, signal, origin) {
  const q = query.trim();
  if (!q) return [];

  const cacheKey = origin ? `${q}|${origin.lat.toFixed(2)}|${origin.lng.toFixed(2)}` : q;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(buildPhotonUrl(q, origin), {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const data = await res.json();

  let results = (data?.features || [])
    .map((f) => {
      const [lng, lat] = f.geometry?.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, name: formatPhotonName(f.properties || {}) };
    })
    .filter(Boolean);

  if (origin) {
    results = results
      .map((r) => ({ ...r, _d: haversineMeters(origin, { lat: r.lat, lng: r.lng }) }))
      .filter((r) => r._d <= MAX_RESULT_DISTANCE_M)
      .sort((a, b) => a._d - b._d)
      .map(({ _d, ...rest }) => rest);
  }

  const top = results.slice(0, 5);

  // Bounded LRU-ish cache.
  if (searchCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
  searchCache.set(cacheKey, top);

  return top;
}

// Routing is delegated to ../api/routing.js so other screens (e.g. TrackingScreen
// for re-routing on deviation) can reuse the same OSRM client.
const fetchRoute = fetchOsrmRoute;

export default function RouteScreen({ origin, initialDestination, onClose, onConfirm }) {
  const [destination, setDestination] = useState(initialDestination || null);
  const [route, setRoute] = useState(null);
  const [routeInfo, setRouteInfo] = useState(null); // { distance (m), duration (s) }
  const [nameInput, setNameInput] = useState(initialDestination?.name || '');
  const [latInput, setLatInput] = useState('');
  const [lngInput, setLngInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Autocomplete state
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suppressNextSearchRef = useRef(false);
  const abortRef = useRef(null);

  const applyDestination = async (dest) => {
    setError('');
    setDestination(dest);
    // Optimistic UI: show a straight line immediately so the user sees
    // *something* on the map while OSRM is still computing the real route.
    setRoute([origin, { lat: dest.lat, lng: dest.lng }]);
    setRouteInfo(null);
    setLoading(true);
    try {
      const { route: coords, distance, duration } = await fetchRoute(
        origin,
        { lat: dest.lat, lng: dest.lng }
      );
      setRoute(coords);
      setRouteInfo({ distance, duration });
    } catch (e) {
      setError(`Routing failed: ${e.message}. Showing straight line.`);
      // Straight line is already drawn from the optimistic step above.
      setRouteInfo(null);
    } finally {
      setLoading(false);
    }
  };

  // Debounced autocomplete — fires ~400ms after typing stops.
  useEffect(() => {
    if (suppressNextSearchRef.current) {
      suppressNextSearchRef.current = false;
      return;
    }
    const q = nameInput.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const timer = setTimeout(async () => {
      try {
        const results = await searchPlaces(q, controller.signal, origin);
        if (!controller.signal.aborted) {
          setSuggestions(results);
          setShowSuggestions(true);
          setSearching(false);
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          setSearching(false);
          setSuggestions([]);
        }
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [nameInput]);

  const handlePickSuggestion = (item) => {
    suppressNextSearchRef.current = true;
    setNameInput(item.name);
    setSuggestions([]);
    setShowSuggestions(false);
    applyDestination(item);
  };

  const handleManualSubmit = () => {
    const lat = parseFloat(latInput);
    const lng = parseFloat(lngInput);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError('Enter valid latitude and longitude');
      return;
    }
    applyDestination({ lat, lng, name: `${lat.toFixed(4)}, ${lng.toFixed(4)}` });
  };

  const handleMapPick = (point) => {
    const picked = {
      lat: point.lat,
      lng: point.lng,
      name: `Pinned destination (${point.lat.toFixed(5)}, ${point.lng.toFixed(5)})`,
    };
    suppressNextSearchRef.current = true;
    setNameInput(picked.name);
    setLatInput(point.lat.toFixed(6));
    setLngInput(point.lng.toFixed(6));
    setSuggestions([]);
    setShowSuggestions(false);
    applyDestination(picked);
  };

  const handleClear = () => {
    setDestination(null);
    setRoute(null);
    setRouteInfo(null);
    setNameInput('');
    setLatInput('');
    setLngInput('');
    setError('');
  };

  const formatDistance = (m) =>
    m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
  const formatDuration = (s) => {
    const mins = Math.round(s / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `${h} h ${rem} min` : `${h} h`;
  };

  const handleConfirm = () => {
    if (!destination) {
      setError('Set a destination first');
      return;
    }
    onConfirm?.({ destination, route });
    onClose?.();
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <Pressable onPress={onClose} style={s.backBtn} hitSlop={10}>
          <Text style={s.backText}>← Back</Text>
        </Pressable>
        <Text style={s.title}>Set Destination</Text>
        <View style={{ width: 50 }} />
      </View>

      <View style={s.inputCard}>
        <Text style={s.sectionLabel}>Search destination</Text>
        <View style={s.searchWrap}>
          <TextInput
            style={s.searchInput}
            placeholder="search destination"
            placeholderTextColor="#94A3B8"
            value={nameInput}
            onChangeText={(t) => { setNameInput(t); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {searching ? (
            <ActivityIndicator size="small" color="#2563EB" style={s.searchSpinner} />
          ) : nameInput.length > 0 ? (
            <Pressable
              onPress={() => { setNameInput(''); setSuggestions([]); }}
              hitSlop={8}
              style={s.searchClear}
            >
              <Text style={s.searchClearText}>×</Text>
            </Pressable>
          ) : null}
        </View>

        {showSuggestions && suggestions.length > 0 && (
          <View style={s.suggestionList}>
            <FlatList
              data={suggestions}
              keyExtractor={(item, idx) => `${item.lat},${item.lng},${idx}`}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable style={s.suggestionItem} onPress={() => handlePickSuggestion(item)}>
                  <Text style={s.suggestionText} numberOfLines={2}>{item.name}</Text>
                  <Text style={s.suggestionCoords}>
                    {item.lat.toFixed(4)}, {item.lng.toFixed(4)}
                  </Text>
                </Pressable>
              )}
            />
          </View>
        )}

        <Text style={[s.sectionLabel, { marginTop: 10 }]}>Or enter coordinates</Text>
        <View style={s.inputRow}>
          <TextInput
            style={s.input}
            placeholder="Latitude"
            placeholderTextColor="#94A3B8"
            keyboardType="numeric"
            value={latInput}
            onChangeText={setLatInput}
          />
          <TextInput
            style={s.input}
            placeholder="Longitude"
            placeholderTextColor="#94A3B8"
            keyboardType="numeric"
            value={lngInput}
            onChangeText={setLngInput}
          />
        </View>
        <Pressable style={s.primaryBtn} onPress={handleManualSubmit}>
          <Text style={s.primaryBtnText}>Show Route</Text>
        </Pressable>

        {error ? <Text style={s.errorText}>{error}</Text> : null}
      </View>

      <View style={s.mapWrap}>
        <RouteMap
          origin={origin}
          destination={destination}
          route={route}
          onMapPress={handleMapPick}
        />
      </View>

      <View style={s.footer}>
        <View style={{ flex: 1 }}>
          <Text style={s.footerInfo} numberOfLines={1}>
            {destination
              ? destination.name || `${destination.lat.toFixed(5)}, ${destination.lng.toFixed(5)}`
              : 'No destination set'}
          </Text>
          {routeInfo ? (
            <Text style={s.footerMeta}>
              {formatDistance(routeInfo.distance)}
            </Text>
          ) : loading ? (
            <Text style={s.footerMeta}>Computing route…</Text>
          ) : (
            <Text style={s.footerMeta}>Tap anywhere on the map to pin a destination</Text>
          )}
        </View>
        {destination ? (
          <Pressable style={s.clearBtn} onPress={handleClear}>
            <Text style={s.clearBtnText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={s.confirmRow}>
        <Pressable
          style={[s.confirmBtn, !destination && s.confirmBtnDisabled]}
          onPress={handleConfirm}
          disabled={!destination}
        >
          <Text style={s.confirmBtnText}>Use This Destination</Text>
        </Pressable>
      </View>

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: { paddingVertical: 4, paddingRight: 8 },
  backText: { fontSize: 14, fontWeight: '600', color: '#2563EB' },
  title: { fontSize: 16, fontWeight: '800', color: '#0F172A' },
  inputCard: {
    backgroundColor: '#FFF',
    marginHorizontal: 16,
    borderRadius: 12,
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  inputRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  input: {
    flex: 1,
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: '#0F172A',
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 13,
    color: '#0F172A',
  },
  searchSpinner: { marginLeft: 8 },
  searchClear: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  searchClearText: { color: '#FFF', fontSize: 16, fontWeight: '700', lineHeight: 18 },
  suggestionList: {
    maxHeight: 200,
    backgroundColor: '#FFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 8,
  },
  suggestionItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  suggestionText: { fontSize: 12, fontWeight: '600', color: '#0F172A' },
  suggestionCoords: { fontSize: 10, color: '#94A3B8', marginTop: 2 },
  primaryBtn: {
    backgroundColor: '#0F172A',
    paddingVertical: 11,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#FFF', fontSize: 13, fontWeight: '700' },
  errorText: { marginTop: 8, color: '#DC2626', fontSize: 12, fontWeight: '600' },
  mapWrap: {
    flex: 1,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    overflow: 'hidden',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  footerInfo: { fontSize: 12, color: '#475569', fontWeight: '700' },
  footerMeta: { fontSize: 11, color: '#2563EB', fontWeight: '600', marginTop: 2 },
  clearBtn: {
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  clearBtnText: { fontSize: 12, fontWeight: '700', color: '#DC2626' },
  confirmRow: { paddingHorizontal: 20, paddingBottom: 20, paddingTop: 4 },
  confirmBtn: {
    backgroundColor: '#16A34A',
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: 'center',
  },
  confirmBtnDisabled: { backgroundColor: '#94A3B8' },
  confirmBtnText: { color: '#FFF', fontSize: 14, fontWeight: '700' },
});
