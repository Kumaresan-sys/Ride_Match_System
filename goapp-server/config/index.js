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

  // ─── SMS / OTP Delivery ─────────────────────────────────────────────────
  sms: {
    // Provider: 'twilio' | 'msg91' | '2factor' | 'console' (dev)
    provider: process.env.SMS_PROVIDER || 'console',
    twilio: {
      accountSid:  process.env.TWILIO_ACCOUNT_SID  || '',
      authToken:   process.env.TWILIO_AUTH_TOKEN   || '',
      fromNumber:  process.env.TWILIO_FROM_NUMBER  || '',
    },
    msg91: {
      authKey:    process.env.MSG91_AUTH_KEY    || '',
      senderId:   process.env.MSG91_SENDER_ID   || 'GOAPP',
      templateId: process.env.MSG91_TEMPLATE_ID || '',
    },
    twofactor: {
      apiKey: process.env.TWOFACTOR_API_KEY || '',
    },
  },

  // ─── Coins / Wallet ──────────────────────────────────────────────────────
  coins: {
    coinInrValue:     parseFloat(process.env.COIN_INR_VALUE     || '0.10'),  // ₹ per coin
    coinsPerInrEarn:  parseFloat(process.env.COINS_PER_INR_EARN || '10'),    // earn 1 coin per ₹10
    minRedeemCoins:   parseInt(process.env.MIN_REDEEM_COINS     || '10', 10),
    maxRedeemPct:     parseFloat(process.env.MAX_REDEEM_PCT      || '0.20'), // max 20% of fare
  },

  // ─── Security ────────────────────────────────────────────────────────────
  security: {
    corsOrigin:   process.env.CORS_ORIGIN    || '*',
    maxBodyBytes: parseInt(process.env.MAX_BODY_BYTES || String(256 * 1024), 10),
    sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || String(24 * 3600 * 1000), 10),
  },

  firebase: {
    // Firebase service account credentials (required for FCM push notifications).
    // Download from: Firebase Console → Project Settings → Service Accounts → Generate new private key
    projectId:   process.env.FIREBASE_PROJECT_ID   || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    // Paste the full -----BEGIN RSA PRIVATE KEY----- block (newlines as \n in .env)
    privateKey:  process.env.FIREBASE_PRIVATE_KEY  || '',
  },

  // ─── Google Maps ─────────────────────────────────────────────────────────
  googleMaps: {
    // Enable: set GOOGLE_MAPS_API_KEY in environment. Falls back to Haversine if unset.
    apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    // Distance Matrix: use traffic-aware durations for fare/ETA accuracy
    trafficModel: 'best_guess',  // 'best_guess' | 'pessimistic' | 'optimistic'
    // Places Autocomplete: restrict results to India
    autocompleteCountry: 'in',
    // Timeout for Maps API calls (ms). Fallback to Haversine on timeout.
    timeoutMs: 3000,
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
