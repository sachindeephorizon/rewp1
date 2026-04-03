/**
 * 2D Kalman Filter with constant-velocity prediction.
 * Adaptive R scales measurement noise by GPS accuracy.
 * Velocity is decayed when stationary to prevent ghost drift.
 */
export class KalmanFilter2D {
  constructor() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    this.Q = 0.00001;
    this.R = 0.0001;
    this.stationaryCount = 0;
  }

  update(measurement, dt, accuracy, isStationary = false) {
    if (!this.x) {
      this.x = [...measurement];
      return this.x;
    }

    if (isStationary) {
      this.stationaryCount++;
      // After a few stationary readings, kill velocity completely
      if (this.stationaryCount >= 3) {
        this.v = [0, 0];
      } else {
        // Decay velocity aggressively while becoming stationary
        this.v = [this.v[0] * 0.2, this.v[1] * 0.2];
      }
    } else {
      this.stationaryCount = 0;
    }

    const predicted = [
      this.x[0] + this.v[0] * dt,
      this.x[1] + this.v[1] * dt,
    ];
    const predictedP = this.P + this.Q;

    const adaptiveR = this.R * Math.max(1, accuracy / 5);
    const K = predictedP / (predictedP + adaptiveR);

    this.x = [
      predicted[0] + K * (measurement[0] - predicted[0]),
      predicted[1] + K * (measurement[1] - predicted[1]),
    ];

    if (dt > 0 && !isStationary) {
      this.v = [
        (this.x[0] - predicted[0] + this.v[0] * dt) / dt,
        (this.x[1] - predicted[1] + this.v[1] * dt) / dt,
      ];
    }

    this.P = (1 - K) * predictedP;
    return this.x;
  }

  reset() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    this.stationaryCount = 0;
  }
}
