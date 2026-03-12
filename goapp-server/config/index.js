// GoApp Configuration - All system constants from Architecture V2

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_DEVELOPMENT = NODE_ENV === 'development';

module.exports = {
  server: {
    port:   parseInt(process.env.PORT    || '3000', 10),
    wsPort: parseInt(process.env.WS_PORT || '3001', 10),
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
    token: process.env.GOAPP_ADMIN_TOKEN || (IS_DEVELOPMENT ? 'goapp-admin-secret' : ''),
  },

  // ─── OTP Security ────────────────────────────────────────────────────────
  // Used to HMAC-hash OTPs before DB storage so a DB dump doesn't expose live codes.
  // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  otp: {
    secret: process.env.OTP_SECRET || (IS_DEVELOPMENT ? 'dev-otp-secret-change-me-in-prod' : ''),
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

  whatsapp: {
    enabled: process.env.WHATSAPP_ENABLED
      ? process.env.WHATSAPP_ENABLED === 'true'
      : IS_DEVELOPMENT,
    provider: process.env.WHATSAPP_PROVIDER || (IS_DEVELOPMENT ? 'console' : 'twilio'),
    from: process.env.WHATSAPP_FROM || process.env.TWILIO_WHATSAPP_FROM || '',
    publicBaseUrl:
      process.env.PUBLIC_BASE_URL ||
      process.env.APP_PUBLIC_BASE_URL ||
      `http://localhost:${parseInt(process.env.PORT || '3000', 10)}`,
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
    },
  },

  tripSharing: {
    timezone: process.env.TRIP_SHARE_TIMEZONE || 'Asia/Kolkata',
    nightWindowStartHour: parseInt(process.env.TRIP_SHARE_NIGHT_START_HOUR || '22', 10),
    nightWindowEndHour: parseInt(process.env.TRIP_SHARE_NIGHT_END_HOUR || '6', 10),
    shareTtlHours: parseInt(process.env.TRIP_SHARE_TTL_HOURS || '12', 10),
    pollIntervalSec: parseInt(process.env.TRIP_SHARE_POLL_INTERVAL_SEC || '5', 10),
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
    corsOrigin:   process.env.CORS_ORIGIN    || (IS_DEVELOPMENT ? '*' : ''),
    maxBodyBytes: parseInt(process.env.MAX_BODY_BYTES || String(256 * 1024), 10),
    sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || String(30 * 60 * 1000), 10),
    refreshTokenTtlMs: parseInt(process.env.REFRESH_TOKEN_TTL_MS || String(60 * 24 * 3600 * 1000), 10),
    tokenHashSecret: process.env.TOKEN_HASH_SECRET || (IS_DEVELOPMENT ? 'dev-token-hash-secret-change-me-in-prod' : ''),
    jwt: {
      secret: process.env.JWT_SECRET || (IS_DEVELOPMENT ? 'dev-jwt-secret-change-me-in-prod' : ''),
      issuer: process.env.JWT_ISSUER || 'goapp-server',
      audience: process.env.JWT_AUDIENCE || 'goapp-mobile',
    },
    legacyAuth: {
      deprecationDate: process.env.LEGACY_AUTH_DEPRECATION_DATE || '2026-04-01T00:00:00.000Z',
      disableDate: process.env.LEGACY_AUTH_DISABLE_DATE || '2026-06-01T00:00:00.000Z',
    },
    wsAuthTimeoutMs: parseInt(process.env.WS_AUTH_TIMEOUT_MS || '10000', 10),
  },

  firebase: {
    // Firebase service account credentials (required for FCM push notifications).
    // Download from: Firebase Console → Project Settings → Service Accounts → Generate new private key
    projectId:   process.env.FIREBASE_PROJECT_ID   || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    // Paste the full -----BEGIN RSA PRIVATE KEY----- block (newlines as \n in .env)
    privateKey:  process.env.FIREBASE_PRIVATE_KEY  || '',
  },

  // ─── Document Storage ────────────────────────────────────────────────────
  // STORAGE_BACKEND=local  → saves files to local filesystem (default — no cloud setup)
  // STORAGE_BACKEND=s3     → AWS S3 (not yet implemented; set backend and extend service)
  storage: {
    backend:          process.env.STORAGE_BACKEND          || 'local',
    localPath:        process.env.UPLOAD_DIR               || './uploads/driver-docs',
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || String(10 * 1024 * 1024), 10),
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  },

  chat: {
    uploadDir: process.env.CHAT_MEDIA_UPLOAD_DIR || './uploads/chat-media',
    textMaxChars: parseInt(process.env.CHAT_TEXT_MAX_CHARS || '2000', 10),
    maxAttachments: parseInt(process.env.CHAT_MAX_ATTACHMENTS || '5', 10),
    maxImageSizeBytes: parseInt(process.env.CHAT_MAX_IMAGE_BYTES || String(5 * 1024 * 1024), 10),
    maxVoiceSizeBytes: parseInt(process.env.CHAT_MAX_VOICE_BYTES || String(10 * 1024 * 1024), 10),
    maxVoiceDurationMs: parseInt(process.env.CHAT_MAX_VOICE_DURATION_MS || String(120 * 1000), 10),
    presenceTtlSec: parseInt(process.env.CHAT_PRESENCE_TTL_SEC || '60', 10),
    typingTtlSec: parseInt(process.env.CHAT_TYPING_TTL_SEC || '10', 10),
    defaultPageSize: parseInt(process.env.CHAT_DEFAULT_PAGE_SIZE || '50', 10),
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

  // ─── Database ──────────────────────────────────────────────────────────────
  // Always uses real PostgreSQL via pg.Pool
  db: {
    backend:  'pg',
    host:     process.env.POSTGRES_HOST     || 'localhost',
    port:     parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user:     process.env.POSTGRES_USER     || 'goapp',
    password: process.env.POSTGRES_PASSWORD || 'goapp',
    database: process.env.POSTGRES_DB       || 'goapp_dev',
    pool: {
      min: parseInt(process.env.POSTGRES_POOL_MIN || '2',  10),
      max: parseInt(process.env.POSTGRES_POOL_MAX || '10', 10),
    },
    ssl: process.env.POSTGRES_SSL === 'true',
  },

  // ─── Razorpay Payment Gateway ─────────────────────────────────────────────
  // Get credentials from: https://dashboard.razorpay.com/app/keys
  // Set RAZORPAY_WEBHOOK_SECRET after creating a webhook in the dashboard.
  razorpay: {
    keyId:         process.env.RAZORPAY_KEY_ID         || '',
    keySecret:     process.env.RAZORPAY_KEY_SECRET      || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET  || '',
  },

  // ─── Redis ─────────────────────────────────────────────────────────────────
  // Always uses real Redis
  redis: {
    backend: 'real',
    host:    process.env.REDIS_HOST    || 'localhost',
    port:    parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  // ─── Kafka ─────────────────────────────────────────────────────────────────
  // Real Apache Kafka via kafkajs (can be disabled in local/dev)
  kafka: {
    backend:  process.env.KAFKA_BACKEND || 'real',
    clientId: process.env.KAFKA_CLIENT_ID || 'goapp-server',
    brokers: (process.env.KAFKA_BROKERS  || 'localhost:9092').split(',').map(b => b.trim()),
    producerPartitioner: (process.env.KAFKA_PRODUCER_PARTITIONER || 'legacy').trim().toLowerCase(),
    // Consumer group prefix for multi-instance deployments
    groupPrefix: process.env.KAFKA_GROUP_PREFIX || 'goapp',
  },

  // ─── Architecture Upgrade Flags / Topology ───────────────────────────────
  architecture: {
    featureFlags: {
      matchingV2: process.env.MATCHING_V2 !== 'false',
      // Keep matching + state-store cutovers aligned by default.
      redisStateV2: process.env.REDIS_STATE_V2
        ? process.env.REDIS_STATE_V2 === 'true'
        : process.env.MATCHING_V2 !== 'false',
      kafkaOutbox: process.env.KAFKA_OUTBOX === 'true',
      kafkaEventBridge: process.env.KAFKA_EVENT_BRIDGE === 'true',
      kafkaMatchingWorker: process.env.KAFKA_MATCHING_WORKER === 'true',
      kafkaNotificationWorker: process.env.KAFKA_NOTIFICATION_WORKER === 'true',
      kafkaOutboxRelayWorker: process.env.KAFKA_OUTBOX_RELAY_WORKER === 'true',
      kafkaDomainProjectionWorker: process.env.KAFKA_DOMAIN_PROJECTION_WORKER === 'true',
    },
    dbTopology: {
      identity: {
        database: process.env.IDENTITY_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        writer: {
          host: process.env.IDENTITY_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.IDENTITY_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.IDENTITY_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.IDENTITY_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.IDENTITY_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
        reader: {
          host: process.env.IDENTITY_DB_READER_HOST || process.env.IDENTITY_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.IDENTITY_DB_READER_PORT || process.env.IDENTITY_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.IDENTITY_DB_READER_USER || process.env.IDENTITY_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.IDENTITY_DB_READER_PASSWORD || process.env.IDENTITY_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.IDENTITY_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
      },
      drivers: {
        database: process.env.DRIVERS_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        writer: {
          host: process.env.DRIVERS_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.DRIVERS_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.DRIVERS_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.DRIVERS_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.DRIVERS_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
        reader: {
          host: process.env.DRIVERS_DB_READER_HOST || process.env.DRIVERS_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.DRIVERS_DB_READER_PORT || process.env.DRIVERS_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.DRIVERS_DB_READER_USER || process.env.DRIVERS_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.DRIVERS_DB_READER_PASSWORD || process.env.DRIVERS_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.DRIVERS_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
      },
      rides: {
        database: process.env.RIDES_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        writer: {
          host: process.env.RIDES_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.RIDES_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.RIDES_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.RIDES_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.RIDES_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
        reader: {
          host: process.env.RIDES_DB_READER_HOST || process.env.RIDES_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.RIDES_DB_READER_PORT || process.env.RIDES_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.RIDES_DB_READER_USER || process.env.RIDES_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.RIDES_DB_READER_PASSWORD || process.env.RIDES_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.RIDES_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
      },
      payments: {
        database: process.env.PAYMENTS_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        writer: {
          host: process.env.PAYMENTS_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.PAYMENTS_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.PAYMENTS_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.PAYMENTS_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.PAYMENTS_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
        reader: {
          host: process.env.PAYMENTS_DB_READER_HOST || process.env.PAYMENTS_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.PAYMENTS_DB_READER_PORT || process.env.PAYMENTS_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.PAYMENTS_DB_READER_USER || process.env.PAYMENTS_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.PAYMENTS_DB_READER_PASSWORD || process.env.PAYMENTS_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.PAYMENTS_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
      },
      analytics: {
        database: process.env.ANALYTICS_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        writer: {
          host: process.env.ANALYTICS_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.ANALYTICS_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.ANALYTICS_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.ANALYTICS_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.ANALYTICS_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
        reader: {
          host: process.env.ANALYTICS_DB_READER_HOST || process.env.ANALYTICS_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.ANALYTICS_DB_READER_PORT || process.env.ANALYTICS_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.ANALYTICS_DB_READER_USER || process.env.ANALYTICS_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.ANALYTICS_DB_READER_PASSWORD || process.env.ANALYTICS_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.ANALYTICS_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
      },
      support: {
        database: process.env.SUPPORT_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        writer: {
          host: process.env.SUPPORT_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.SUPPORT_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.SUPPORT_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.SUPPORT_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.SUPPORT_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
        reader: {
          host: process.env.SUPPORT_DB_READER_HOST || process.env.SUPPORT_DB_WRITER_HOST || process.env.POSTGRES_HOST || 'localhost',
          port: parseInt(process.env.SUPPORT_DB_READER_PORT || process.env.SUPPORT_DB_WRITER_PORT || process.env.POSTGRES_PORT || '5432', 10),
          user: process.env.SUPPORT_DB_READER_USER || process.env.SUPPORT_DB_WRITER_USER || process.env.POSTGRES_USER || 'goapp',
          password: process.env.SUPPORT_DB_READER_PASSWORD || process.env.SUPPORT_DB_WRITER_PASSWORD || process.env.POSTGRES_PASSWORD || 'goapp',
          database: process.env.SUPPORT_DB_NAME || process.env.POSTGRES_DB || 'goapp_enterprise',
        },
      },
    },
  },

  development: {
    seedDriversOnBoot: IS_DEVELOPMENT
      ? process.env.DEV_SEED_DRIVERS_ON_BOOT !== 'false'
      : process.env.DEV_SEED_DRIVERS_ON_BOOT === 'true',
    autoAcceptMatches: IS_DEVELOPMENT
      ? process.env.DEV_AUTO_ACCEPT_MATCHES !== 'false'
      : process.env.DEV_AUTO_ACCEPT_MATCHES === 'true',
    driverSeedCenterLat: parseFloat(process.env.DEV_DRIVER_SEED_CENTER_LAT || '13.0833913'),
    driverSeedCenterLng: parseFloat(process.env.DEV_DRIVER_SEED_CENTER_LNG || '80.1499398'),
    driverSeedCount: parseInt(process.env.DEV_DRIVER_SEED_COUNT || '6', 10),
    driverSeedHeartbeatMs: parseInt(process.env.DEV_DRIVER_SEED_HEARTBEAT_MS || '5000', 10),
    autoAcceptDelayMs: parseInt(process.env.DEV_AUTO_ACCEPT_DELAY_MS || '1000', 10),
    autoAcceptTraceLimit: parseInt(process.env.DEV_AUTO_ACCEPT_TRACE_LIMIT || '200', 10),
    driverWalletBalance: parseFloat(process.env.DEV_DRIVER_WALLET_BALANCE || '1500'),
  },

  // Runtime cutover controls. Defaults are hard-on for non-test flows.
  cutover: {
    realRideFlowEnabled: process.env.REAL_RIDE_FLOW_ENABLED !== 'false',
    realWsTrackingEnabled: process.env.REAL_WS_TRACKING_ENABLED !== 'false',
    realPaymentWalletEnabled: process.env.REAL_PAYMENT_WALLET_ENABLED !== 'false',
    realHistoryEnabled: process.env.REAL_HISTORY_ENABLED !== 'false',
  },
};
