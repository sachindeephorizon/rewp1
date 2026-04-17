/**
 * Tier Signal Service
 *
 * This module acts as the interface to an external safety service that
 * provides risk signals. The phone's GPS tier switches based on these signals.
 *
 * Tier model:
 *   Tier 1 — Passive (cell tower / WiFi, ~1-2% battery/hr)
 *            Default when everything is smooth
 *
 *   Tier 2 — Active GPS balanced (~4-6% battery/hr)
 *            Triggered by: short route deviation OR inactivity
 *
 *   Tier 3 — Full GPS max accuracy (~10-15% battery/hr)
 *            Triggered by: long route deviation OR missed check-in
 *            Emergency mode — battery secondary to safety
 *
 * Usage:
 *   import { TierSignalService } from '../services/tierSignal';
 *
 *   const tierService = new TierSignalService();
 *   tierService.onTierChange((tier, reason) => {
 *     // switch GPS accuracy + interval
 *   });
 *
 *   // External service pushes signals:
 *   tierService.pushSignal({ type: 'short_deviation' });
 *   tierService.pushSignal({ type: 'long_deviation' });
 *   tierService.pushSignal({ type: 'missed_checkin' });
 *   tierService.pushSignal({ type: 'inactivity' });
 *   tierService.clearSignal('short_deviation');
 *
 * The phone also calls tierService.reportMovement(distanceLast10Min, nearDestination)
 * every GPS tick to let the service compute inactivity locally.
 */

// How long a tier-2 signal stays active before auto-dropping to tier-1 (ms)
const TIER2_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// How long a tier-3 signal stays active before auto-dropping (ms)
const TIER3_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Inactivity thresholds
const INACTIVITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const INACTIVITY_DISTANCE_M = 30; // <30m in 10 min = inactive

export const TIERS = {
  TIER_1: 1, // passive — cell tower / WiFi
  TIER_2: 2, // active GPS balanced
  TIER_3: 3, // full GPS emergency
};

export class TierSignalService {
  constructor() {
    this._currentTier = TIERS.TIER_1;
    this._reason = 'default';
    this._listeners = [];

    // Active signals: { type: string, at: number, timeout: number }
    this._signals = new Map();

    // Movement tracking for inactivity computation
    this._positionHistory = []; // [{ lat, lng, timestamp }]

    // Auto-decay timer
    this._decayInterval = setInterval(() => this._decaySignals(), 30000);
  }

  /** Subscribe to tier changes. Returns unsubscribe function. */
  onTierChange(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== callback);
    };
  }

  /** Get current tier (1, 2, or 3) */
  get currentTier() {
    return this._currentTier;
  }

  /** Get reason for current tier */
  get currentReason() {
    return this._reason;
  }

  /**
   * Push a signal from the external service.
   * @param {{ type: string }} signal
   *   type: 'short_deviation' | 'long_deviation' | 'missed_checkin' | 'inactivity' | 'clear_all'
   */
  pushSignal(signal) {
    if (signal.type === 'clear_all') {
      this._signals.clear();
      this._recompute();
      return;
    }

    const timeout = this._isEmergencySignal(signal.type)
      ? TIER3_TIMEOUT_MS
      : TIER2_TIMEOUT_MS;

    this._signals.set(signal.type, {
      type: signal.type,
      at: Date.now(),
      timeout,
    });

    this._recompute();
  }

  /**
   * Clear a specific signal (e.g. when deviation resolves).
   */
  clearSignal(type) {
    this._signals.delete(type);
    this._recompute();
  }

  /**
   * Report current movement stats from the GPS tick.
   * The service uses this to compute inactivity locally.
   *
   * @param {number} lat - current latitude
   * @param {number} lng - current longitude
   * @param {boolean} nearDestination - true if within ~500m of destination
   */
  reportPosition(lat, lng, nearDestination) {
    const now = Date.now();

    this._positionHistory.push({ lat, lng, timestamp: now });

    // Trim history to last 10 minutes
    const cutoff = now - INACTIVITY_WINDOW_MS;
    this._positionHistory = this._positionHistory.filter((p) => p.timestamp >= cutoff);

    // Compute distance covered in the window
    const distanceCovered = this._computeWindowDistance();

    // Inactivity check: <30m in 10min AND not near destination
    if (
      this._positionHistory.length >= 3 && // need enough samples
      distanceCovered < INACTIVITY_DISTANCE_M &&
      !nearDestination
    ) {
      if (!this._signals.has('inactivity')) {
        this.pushSignal({ type: 'inactivity' });
      }
    } else {
      if (this._signals.has('inactivity')) {
        this.clearSignal('inactivity');
      }
    }
  }

  /** Stop the service (cleanup timers) */
  destroy() {
    clearInterval(this._decayInterval);
    this._listeners = [];
    this._signals.clear();
    this._positionHistory = [];
  }

  /** Reset to tier 1 */
  reset() {
    this._signals.clear();
    this._positionHistory = [];
    this._recompute();
  }

  // ── Private ──────────────────────────────────────────────────────

  _isEmergencySignal(type) {
    return type === 'long_deviation' || type === 'missed_checkin';
  }

  _decaySignals() {
    const now = Date.now();
    let changed = false;
    for (const [key, sig] of this._signals) {
      if (now - sig.at > sig.timeout) {
        this._signals.delete(key);
        changed = true;
      }
    }
    if (changed) this._recompute();
  }

  _recompute() {
    let newTier = TIERS.TIER_1;
    let reason = 'default';

    for (const [, sig] of this._signals) {
      if (this._isEmergencySignal(sig.type)) {
        newTier = TIERS.TIER_3;
        reason = sig.type;
        break; // tier 3 is max, no need to check further
      }
      if (newTier < TIERS.TIER_2) {
        newTier = TIERS.TIER_2;
        reason = sig.type;
      }
    }

    if (newTier !== this._currentTier) {
      const prevTier = this._currentTier;
      this._currentTier = newTier;
      this._reason = reason;
      for (const listener of this._listeners) {
        try {
          listener(newTier, reason, prevTier);
        } catch {}
      }
    }
  }

  _computeWindowDistance() {
    if (this._positionHistory.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < this._positionHistory.length; i++) {
      total += this._haversine(
        this._positionHistory[i - 1].lat,
        this._positionHistory[i - 1].lng,
        this._positionHistory[i].lat,
        this._positionHistory[i].lng
      );
    }
    return total;
  }

  _haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
}
