// GoApp Configuration - All system constants from Architecture V2

module.exports = {
  server: {
    port: 3000,
    wsPort: 3001,
  },

  matching: {
    stages: [
      { stage: 1, radiusKm: 2, maxDrivers: 3, timeoutSec: 10 },
      { stage: 2, radiusKm: 5, maxDrivers: 5, timeoutSec: 15 },
      { stage: 3, radiusKm: 10, maxDrivers: 8, timeoutSec: 20 },
    ],
    maxTotalTimeoutSec: 45,
    retryCooldownSec: 10,
  },

  scoring: {
    weights: {
      eta: 0.30,
      idle: 0.15,
      acceptance: 0.15,
      completion: 0.15,
      rating: 0.15,
      heading: 0.10,
    },
    freshness: {
      boostThresholdSec: 3,
      boostValue: 0.10,
      penaltyThresholdSec: 5,
      penaltyValue: -0.15,
      maxAgeSec: 8,
    },
    maxIdleMinutes: 30,
    maxETAMinutes: 20,
    avgCitySpeedKmh: 25,
  },

  location: {
    updateIntervalMs: 3000,  // 3-5 seconds
    ttlSec: 8,
    earthRadiusKm: 6371,
  },

  pricing: {
    rateCards: {
      mini:    { baseFare: 25,  perKm: 8,  perMin: 1.5, minFare: 50,  commission: 0.20 },
      sedan:   { baseFare: 40,  perKm: 12, perMin: 2.0, minFare: 80,  commission: 0.20 },
      suv:     { baseFare: 60,  perKm: 16, perMin: 2.5, minFare: 120, commission: 0.20 },
      premium: { baseFare: 100, perKm: 22, perMin: 3.5, minFare: 200, commission: 0.18 },
    },
    surge: {
      alpha: 0.3,
      maxCap: 3.0,
      minThreshold: 1.2,
      cooldownSec: 300,       // 5 minutes
      recalcIntervalSec: 60,
      zoneSizeKm: 0.46,       // H3 Level 8 approx
    },
  },

  cancellation: {
    gracePeriodSec: 30,
    baseCancelFee: 30,
    cancelFeePerMin: 5,
    driver: {
      window24h: { threshold3: 3, penalty3: 15 * 60, threshold5: 5, penalty5: 60 * 60 },
    },
    rider: {
      window1h: { threshold3: 3, fee: 50, threshold5: 5, blockMin: 30 },
    },
  },

  fraud: {
    maxSpeedKmh: 200,
    autoSuspendSpeedKmh: 300,
    jumpDistanceM: 500,
    jumpTimeSec: 5,
    maxJumpsIn10Min: 3,
    minRouteEfficiency: 0.3,
  },

  rating: {
    windowSize: 500,
    defaultRating: 5.0,
    warningThreshold: 4.0,
    reviewThreshold: 3.5,
    suspendThreshold: 3.0,
  },

  admin: {
    // Override with GOAPP_ADMIN_TOKEN env var in production
    token: process.env.GOAPP_ADMIN_TOKEN || 'goapp-admin-secret',
  },

  firebase: {
    // Firebase service account credentials (required for FCM push notifications).
    // Download from: Firebase Console → Project Settings → Service Accounts → Generate new private key
    projectId:   process.env.FIREBASE_PROJECT_ID   || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    // Paste the full -----BEGIN RSA PRIVATE KEY----- block (newlines as \n in .env)
    privateKey:  process.env.FIREBASE_PRIVATE_KEY  || '',
  },

  rideStatuses: {
    REQUESTED: 'REQUESTED',
    MATCHING: 'MATCHING',
    BROADCAST: 'BROADCAST',
    ACCEPTED: 'ACCEPTED',
    DRIVER_ARRIVING: 'DRIVER_ARRIVING',
    DRIVER_ARRIVED: 'DRIVER_ARRIVED',
    TRIP_STARTED: 'TRIP_STARTED',
    TRIP_COMPLETED: 'TRIP_COMPLETED',
    CANCELLED_BY_RIDER: 'CANCELLED_BY_RIDER',
    CANCELLED_BY_DRIVER: 'CANCELLED_BY_DRIVER',
    NO_DRIVERS: 'NO_DRIVERS',
  },
};
