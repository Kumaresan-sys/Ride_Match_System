'use strict';

const config = require('../config');
const domainDb = require('../infra/db/domain-db');
const matchingEngine = require('./matching-engine');
const locationService = require('./location-service');
const DocumentStorageService = require('./document-storage-service');
const domainProjectionService = require('./domain-projection-service');
const { logger } = require('../utils/logger');

const DEFAULT_CENTER = {
  lat: 13.0833913,
  lng: 80.1499398,
};

const mediaStorage = new DocumentStorageService(config);

const SEED_BLUEPRINTS = [
  {
    index: 1,
    userId: '10000000-0000-4000-8000-000000000001',
    driverId: '20000000-0000-4000-8000-000000000001',
    vehicleId: '30000000-0000-4000-8000-000000000001',
    name: 'Arun Bike',
    phoneNumber: '+919876500001',
    email: 'dev.driver.arun@goapp.local',
    driverType: 'bike',
    vehicleType: 'bike',
    vehicleMake: 'Hero',
    vehicleModel: 'Splendor',
    vehicleColor: 'Green',
    vehicleNumber: 'TN09DEV1001',
    homeCity: 'Chennai',
    acceptanceRate: 0.99,
    completionRate: 0.99,
    averageRating: 4.9,
    completedRides: 155,
    cancelRate: 0.01,
    walletBalance: 1500,
    heading: 40,
    speed: 18,
    lastTripEndOffsetMin: 55,
    offsetLat: 0.00010,
    offsetLng: 0.00008,
  },
  {
    index: 2,
    userId: '10000000-0000-4000-8000-000000000002',
    driverId: '20000000-0000-4000-8000-000000000002',
    vehicleId: '30000000-0000-4000-8000-000000000002',
    name: 'Bala Bike',
    phoneNumber: '+919876500002',
    email: 'dev.driver.bala@goapp.local',
    driverType: 'bike',
    vehicleType: 'bike',
    vehicleMake: 'Bajaj',
    vehicleModel: 'Pulsar',
    vehicleColor: 'Black',
    vehicleNumber: 'TN09DEV1002',
    homeCity: 'Chennai',
    acceptanceRate: 0.95,
    completionRate: 0.97,
    averageRating: 4.8,
    completedRides: 132,
    cancelRate: 0.02,
    walletBalance: 1400,
    heading: 75,
    speed: 16,
    lastTripEndOffsetMin: 40,
    offsetLat: 0.00055,
    offsetLng: 0.00045,
  },
  {
    index: 3,
    userId: '10000000-0000-4000-8000-000000000003',
    driverId: '20000000-0000-4000-8000-000000000003',
    vehicleId: '30000000-0000-4000-8000-000000000003',
    name: 'Charan Bike',
    phoneNumber: '+919876500003',
    email: 'dev.driver.charan@goapp.local',
    driverType: 'bike',
    vehicleType: 'bike',
    vehicleMake: 'TVS',
    vehicleModel: 'Apache',
    vehicleColor: 'Blue',
    vehicleNumber: 'TN09DEV1003',
    homeCity: 'Chennai',
    acceptanceRate: 0.92,
    completionRate: 0.95,
    averageRating: 4.7,
    completedRides: 118,
    cancelRate: 0.03,
    walletBalance: 1300,
    heading: 105,
    speed: 14,
    lastTripEndOffsetMin: 28,
    offsetLat: 0.00110,
    offsetLng: 0.00095,
  },
  {
    index: 4,
    userId: '10000000-0000-4000-8000-000000000004',
    driverId: '20000000-0000-4000-8000-000000000004',
    vehicleId: '30000000-0000-4000-8000-000000000004',
    name: 'Dinesh Auto',
    phoneNumber: '+919876500004',
    email: 'dev.driver.dinesh@goapp.local',
    driverType: 'auto',
    vehicleType: 'auto',
    vehicleMake: 'Bajaj',
    vehicleModel: 'RE',
    vehicleColor: 'Yellow',
    vehicleNumber: 'TN09DEV1004',
    homeCity: 'Chennai',
    acceptanceRate: 0.96,
    completionRate: 0.98,
    averageRating: 4.8,
    completedRides: 204,
    cancelRate: 0.02,
    walletBalance: 1600,
    heading: 180,
    speed: 12,
    lastTripEndOffsetMin: 46,
    offsetLat: -0.00030,
    offsetLng: 0.00060,
  },
  {
    index: 5,
    userId: '10000000-0000-4000-8000-000000000005',
    driverId: '20000000-0000-4000-8000-000000000005',
    vehicleId: '30000000-0000-4000-8000-000000000005',
    name: 'Eswar Mini',
    phoneNumber: '+919876500005',
    email: 'dev.driver.eswar@goapp.local',
    driverType: 'standard',
    vehicleType: 'mini',
    vehicleMake: 'Hyundai',
    vehicleModel: 'Xcent',
    vehicleColor: 'Silver',
    vehicleNumber: 'TN09DEV1005',
    homeCity: 'Chennai',
    acceptanceRate: 0.94,
    completionRate: 0.97,
    averageRating: 4.8,
    completedRides: 287,
    cancelRate: 0.02,
    walletBalance: 1700,
    heading: 225,
    speed: 20,
    lastTripEndOffsetMin: 33,
    offsetLat: -0.00085,
    offsetLng: -0.00040,
  },
  {
    index: 6,
    userId: '10000000-0000-4000-8000-000000000006',
    driverId: '20000000-0000-4000-8000-000000000006',
    vehicleId: '30000000-0000-4000-8000-000000000006',
    name: 'Farook Sedan',
    phoneNumber: '+919876500006',
    email: 'dev.driver.farook@goapp.local',
    driverType: 'standard',
    vehicleType: 'sedan',
    vehicleMake: 'Maruti',
    vehicleModel: 'Dzire',
    vehicleColor: 'White',
    vehicleNumber: 'TN09DEV1006',
    homeCity: 'Chennai',
    acceptanceRate: 0.97,
    completionRate: 0.98,
    averageRating: 4.9,
    completedRides: 364,
    cancelRate: 0.01,
    walletBalance: 1800,
    heading: 300,
    speed: 24,
    lastTripEndOffsetMin: 62,
    offsetLat: 0.00095,
    offsetLng: -0.00110,
  },
];

function isDevelopmentRuntime() {
  return String(process.env.NODE_ENV || 'development').trim() === 'development';
}

function toFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function createSeedFleet(options = {}) {
  const centerLat = toFiniteNumber(
    options.centerLat,
    toFiniteNumber(config.development?.driverSeedCenterLat, DEFAULT_CENTER.lat),
  );
  const centerLng = toFiniteNumber(
    options.centerLng,
    toFiniteNumber(config.development?.driverSeedCenterLng, DEFAULT_CENTER.lng),
  );
  const requestedCount = Math.max(
    1,
    Math.min(
      toFiniteNumber(options.count, Number(config.development?.driverSeedCount) || SEED_BLUEPRINTS.length),
      SEED_BLUEPRINTS.length,
    ),
  );

  return SEED_BLUEPRINTS.slice(0, requestedCount).map((blueprint) => ({
    ...blueprint,
    lat: Number((centerLat + blueprint.offsetLat).toFixed(7)),
    lng: Number((centerLng + blueprint.offsetLng).toFixed(7)),
    walletBalance: toFiniteNumber(
      options.walletBalance,
      toFiniteNumber(config.development?.driverWalletBalance, blueprint.walletBalance),
    ),
  }));
}

function profilePhotoDocumentId(index) {
  return `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function buildSeedProfileSvg(driver) {
  const initials = String(driver.name || 'D')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'D';
  const palette = ['#0F766E', '#1D4ED8', '#C2410C', '#7C3AED', '#B91C1C', '#0F766E'];
  const accent = palette[(Number(driver.index) - 1) % palette.length];
  const label = String(driver.vehicleType || 'driver').toUpperCase();
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <rect width="256" height="256" rx="40" fill="#E5E7EB"/>
      <circle cx="128" cy="98" r="52" fill="${accent}"/>
      <circle cx="128" cy="94" r="26" fill="#F8FAFC"/>
      <path d="M58 214c9-38 39-60 70-60s61 22 70 60" fill="${accent}" opacity="0.92"/>
      <text x="128" y="236" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#111827">${label}</text>
      <text x="128" y="108" text-anchor="middle" font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="#111827">${initials}</text>
    </svg>`,
    'utf8'
  );
}

class DevDriverSeedService {
  constructor() {
    this.heartbeatTimer = null;
    this.heartbeatFleet = [];
  }

  async seedDrivers(options = {}) {
    if (!isDevelopmentRuntime()) {
      return { skipped: true, reason: 'non_development_runtime' };
    }

    const fleet = createSeedFleet(options);
    const vehicleTypeMap = await this._loadVehicleTypes(fleet);

    for (const driver of fleet) {
      const vehicleTypeId = vehicleTypeMap.get(driver.vehicleType);
      if (!vehicleTypeId) {
        throw new Error(`Vehicle type "${driver.vehicleType}" not found in drivers_db.vehicle_types`);
      }

      await this._upsertIdentityUser(driver);
      await this._upsertDriversDomain(driver, vehicleTypeId);
      await this._upsertDriverMedia(driver);
      await this._upsertRideProjection(driver);
      await this._upsertPaymentsDomain(driver);
      await domainProjectionService.syncDriverByLookup(driver.driverId).catch(() => null);
      await matchingEngine.registerDriver({
        driverId: driver.driverId,
        name: driver.name,
        phoneNumber: driver.phoneNumber,
        vehicleType: driver.vehicleType,
        vehicleNumber: driver.vehicleNumber,
        rating: driver.averageRating,
        acceptanceRate: driver.acceptanceRate,
        completionRate: driver.completionRate,
        cancelRate: driver.cancelRate,
        completedRides: driver.completedRides,
        avatarUrl: driver.avatarUrl,
        lastTripEndTime: Date.now() - (driver.lastTripEndOffsetMin * 60 * 1000),
      });
      await locationService.updateLocation(driver.driverId, {
        lat: driver.lat,
        lng: driver.lng,
        speed: driver.speed,
        heading: driver.heading,
      });
    }

    if (options.keepAlive) {
      this._startHeartbeat(fleet);
    }

    logger.info('DEV_DRIVER_SEED', `Seeded ${fleet.length} development drivers`, {
      count: fleet.length,
      centerLat: fleet[0]?.lat || null,
      centerLng: fleet[0]?.lng || null,
      driverIds: fleet.map((driver) => driver.driverId),
      reason: options.reason || 'manual',
    });

    return {
      success: true,
      count: fleet.length,
      driverIds: fleet.map((driver) => driver.driverId),
      center: {
        lat: toFiniteNumber(options.centerLat, config.development?.driverSeedCenterLat),
        lng: toFiniteNumber(options.centerLng, config.development?.driverSeedCenterLng),
      },
    };
  }

  async seedDriversOnBoot() {
    if (!config.development?.seedDriversOnBoot) {
      return { skipped: true, reason: 'seed_disabled' };
    }
    return this.seedDrivers({ reason: 'server_boot', keepAlive: true });
  }

  _startHeartbeat(fleet) {
    this.heartbeatFleet = Array.isArray(fleet) ? fleet : [];
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    const intervalMs = Math.max(1000, Number(config.development?.driverSeedHeartbeatMs || 5000));
    this.heartbeatTimer = setInterval(() => {
      this._refreshHeartbeat().catch((err) => {
        logger.warn('DEV_DRIVER_SEED', `Heartbeat refresh failed: ${err.message}`);
      });
    }, intervalMs);

    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }

    logger.info('DEV_DRIVER_SEED', `Started heartbeat for ${this.heartbeatFleet.length} drivers`, {
      count: this.heartbeatFleet.length,
      intervalMs,
    });
  }

  async _refreshHeartbeat() {
    if (!this.heartbeatFleet.length) return;
    await Promise.all(this.heartbeatFleet.map((driver) => locationService.updateLocation(driver.driverId, {
      lat: driver.lat,
      lng: driver.lng,
      speed: driver.speed,
      heading: driver.heading,
    })));
  }

  async _loadVehicleTypes(fleet) {
    const names = [...new Set(fleet.map((driver) => driver.vehicleType))];
    const { rows } = await domainDb.query(
      'drivers',
      `SELECT id, name
       FROM vehicle_types
       WHERE name = ANY($1::text[])`,
      [names],
      { role: 'writer', strongRead: true },
    );
    return new Map(rows.map((row) => [row.name, row.id]));
  }

  async _upsertIdentityUser(driver) {
    await domainDb.withTransaction('identity', async (client) => {
      await client.query(
        `INSERT INTO users (
           id,
           phone_number,
           email,
           phone_verified,
           user_type,
           status
         )
         VALUES ($1, $2, $3, true, 'driver', 'active')
         ON CONFLICT (id)
         DO UPDATE SET
           phone_number = EXCLUDED.phone_number,
           email = EXCLUDED.email,
           phone_verified = EXCLUDED.phone_verified,
           user_type = EXCLUDED.user_type,
           status = EXCLUDED.status,
           deleted_at = NULL,
           updated_at = NOW()`,
        [driver.userId, driver.phoneNumber, driver.email],
      );

      await client.query(
        `INSERT INTO user_profiles (
           user_id,
           display_name,
           updated_at
         )
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           updated_at = NOW()`,
        [driver.userId, driver.name],
      );
    });
  }

  async _upsertDriversDomain(driver, vehicleTypeId) {
    await domainDb.withTransaction('drivers', async (client) => {
      await client.query(
        `INSERT INTO drivers (
           id,
           user_id,
           license_number,
           license_expiry,
           license_state,
           driver_type,
           onboarding_status,
           is_eligible,
           max_concurrent_rides,
           home_city,
           approved_at
         )
         VALUES ($1, $2, $3, CURRENT_DATE + INTERVAL '2 years', 'TN', $4, 'approved', true, 1, $5, NOW())
         ON CONFLICT (id)
         DO UPDATE SET
           user_id = EXCLUDED.user_id,
           license_number = EXCLUDED.license_number,
           license_expiry = EXCLUDED.license_expiry,
           license_state = EXCLUDED.license_state,
           driver_type = EXCLUDED.driver_type,
           onboarding_status = 'approved',
           is_eligible = true,
           max_concurrent_rides = EXCLUDED.max_concurrent_rides,
           home_city = EXCLUDED.home_city,
           approved_at = COALESCE(drivers.approved_at, NOW()),
           updated_at = NOW()`,
        [
          driver.driverId,
          driver.userId,
          `DEV-LIC-${String(driver.index).padStart(4, '0')}`,
          driver.driverType,
          driver.homeCity,
        ],
      );

      await client.query(
        `INSERT INTO vehicles (
           id,
           driver_id,
           vehicle_type_id,
           make,
           model,
           year,
           color,
           license_plate,
           registration_number,
           registration_expiry,
           status,
           is_primary
         )
         VALUES ($1, $2, $3, $4, $5, 2024, $6, $7, $7, CURRENT_DATE + INTERVAL '2 years', 'active', true)
         ON CONFLICT (id)
         DO UPDATE SET
           driver_id = EXCLUDED.driver_id,
           vehicle_type_id = EXCLUDED.vehicle_type_id,
           make = EXCLUDED.make,
           model = EXCLUDED.model,
           color = EXCLUDED.color,
           license_plate = EXCLUDED.license_plate,
           registration_number = EXCLUDED.registration_number,
           registration_expiry = EXCLUDED.registration_expiry,
           status = 'active',
           is_primary = true,
           updated_at = NOW()`,
        [
          driver.vehicleId,
          driver.driverId,
          vehicleTypeId,
          driver.vehicleMake,
          driver.vehicleModel,
          driver.vehicleColor,
          driver.vehicleNumber,
        ],
      );

      await client.query(
        `INSERT INTO driver_user_projection (
           driver_id,
           user_id,
           display_name,
           phone_number,
           status,
           onboarding_status,
           is_eligible,
           home_city,
           vehicle_number,
           vehicle_type,
           avatar_url,
           avatar_version,
           average_rating,
           acceptance_rate,
           completion_rate,
           completed_rides_count,
           updated_at
         )
         VALUES ($1, $2, $3, $4, 'active', 'approved', true, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (driver_id)
         DO UPDATE SET
           user_id = EXCLUDED.user_id,
           display_name = EXCLUDED.display_name,
           phone_number = EXCLUDED.phone_number,
           status = 'active',
           onboarding_status = 'approved',
           is_eligible = true,
           home_city = EXCLUDED.home_city,
           vehicle_number = EXCLUDED.vehicle_number,
           vehicle_type = EXCLUDED.vehicle_type,
           avatar_url = EXCLUDED.avatar_url,
           avatar_version = EXCLUDED.avatar_version,
           average_rating = EXCLUDED.average_rating,
           acceptance_rate = EXCLUDED.acceptance_rate,
           completion_rate = EXCLUDED.completion_rate,
           completed_rides_count = EXCLUDED.completed_rides_count,
           updated_at = NOW()`,
        [
          driver.driverId,
          driver.userId,
          driver.name,
          driver.phoneNumber,
          driver.homeCity,
          driver.vehicleNumber,
          driver.vehicleType,
          driver.avatarUrl || null,
          driver.avatarVersion || null,
          driver.averageRating,
          driver.acceptanceRate,
          driver.completionRate,
          driver.completedRides || 0,
        ],
      );

      await client.query(
        `INSERT INTO driver_availability (
           id,
           driver_id,
           is_available,
           vehicle_type_id,
           capacity_remaining,
           updated_at
         )
         VALUES ($1, $2, true, $3, 1, NOW())
         ON CONFLICT (driver_id)
         DO UPDATE SET
           is_available = true,
           vehicle_type_id = EXCLUDED.vehicle_type_id,
           capacity_remaining = EXCLUDED.capacity_remaining,
           current_ride_id = NULL,
           will_be_free_at = NULL,
           updated_at = NOW()`,
        [
          `40000000-0000-4000-8000-${String(driver.index).padStart(12, '0')}`,
          driver.driverId,
          vehicleTypeId,
        ],
      );
    });
  }

  async _upsertRideProjection(driver) {
    await domainDb.withTransaction('rides', async (client) => {
      await client.query(
        `INSERT INTO ride_driver_projection (
           driver_id,
           user_id,
           display_name,
           phone_number,
           status,
           onboarding_status,
           is_eligible,
           home_city,
           vehicle_number,
           vehicle_type,
           avatar_url,
           avatar_version,
           average_rating,
           acceptance_rate,
           completion_rate,
           completed_rides_count,
           updated_at
         )
         VALUES ($1, $2, $3, $4, 'active', 'approved', true, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (driver_id)
         DO UPDATE SET
           user_id = EXCLUDED.user_id,
           display_name = EXCLUDED.display_name,
           phone_number = EXCLUDED.phone_number,
           status = 'active',
           onboarding_status = 'approved',
           is_eligible = true,
           home_city = EXCLUDED.home_city,
           vehicle_number = EXCLUDED.vehicle_number,
           vehicle_type = EXCLUDED.vehicle_type,
           avatar_url = EXCLUDED.avatar_url,
           avatar_version = EXCLUDED.avatar_version,
           average_rating = EXCLUDED.average_rating,
           acceptance_rate = EXCLUDED.acceptance_rate,
           completion_rate = EXCLUDED.completion_rate,
           completed_rides_count = EXCLUDED.completed_rides_count,
           updated_at = NOW()`,
        [
          driver.driverId,
          driver.userId,
          driver.name,
          driver.phoneNumber,
          driver.homeCity,
          driver.vehicleNumber,
          driver.vehicleType,
          driver.avatarUrl || null,
          driver.avatarVersion || null,
          driver.averageRating,
          driver.acceptanceRate,
          driver.completionRate,
          driver.completedRides || 0,
        ],
      );
    });
  }

  async _upsertPaymentsDomain(driver) {
    await domainDb.withTransaction('payments', async (client) => {
      await client.query(
        `INSERT INTO payment_driver_projection (
           driver_id,
           user_id,
           display_name,
           phone_number,
           status,
           onboarding_status,
           is_eligible,
           home_city,
           vehicle_number,
           vehicle_type,
           avatar_url,
           avatar_version,
           average_rating,
           acceptance_rate,
           completion_rate,
           completed_rides_count,
           updated_at
         )
         VALUES ($1, $2, $3, $4, 'active', 'approved', true, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (driver_id)
         DO UPDATE SET
           user_id = EXCLUDED.user_id,
           display_name = EXCLUDED.display_name,
           phone_number = EXCLUDED.phone_number,
           status = 'active',
           onboarding_status = 'approved',
           is_eligible = true,
           home_city = EXCLUDED.home_city,
           vehicle_number = EXCLUDED.vehicle_number,
           vehicle_type = EXCLUDED.vehicle_type,
           avatar_url = EXCLUDED.avatar_url,
           avatar_version = EXCLUDED.avatar_version,
           average_rating = EXCLUDED.average_rating,
           acceptance_rate = EXCLUDED.acceptance_rate,
           completion_rate = EXCLUDED.completion_rate,
           completed_rides_count = EXCLUDED.completed_rides_count,
           updated_at = NOW()`,
        [
          driver.driverId,
          driver.userId,
          driver.name,
          driver.phoneNumber,
          driver.homeCity,
          driver.vehicleNumber,
          driver.vehicleType,
          driver.avatarUrl || null,
          driver.avatarVersion || null,
          driver.averageRating,
          driver.acceptanceRate,
          driver.completionRate,
          driver.completedRides || 0,
        ],
      );

      await client.query(
        `INSERT INTO driver_wallets (
           driver_id,
           balance,
           min_balance_required,
           total_earned,
           total_deducted,
           total_incentives,
           is_frozen,
           updated_at
         )
         VALUES ($1, $2, 300, 0, 0, 0, false, NOW())
         ON CONFLICT (driver_id)
         DO UPDATE SET
           balance = GREATEST(EXCLUDED.balance, driver_wallets.balance),
           min_balance_required = 300,
           is_frozen = false,
           frozen_reason = NULL,
           updated_at = NOW()`,
        [driver.driverId, driver.walletBalance],
      );
    });
  }

  async _upsertDriverMedia(driver) {
    const documentId = profilePhotoDocumentId(driver.index);
    const originalFilename = `${driver.vehicleType}-${driver.index}.svg`;
    const mimeType = 'image/svg+xml';
    const buffer = buildSeedProfileSvg(driver);
    const existingDoc = await domainDb.query(
      'drivers',
      `SELECT storage_key AS "storageKey", stored_path AS "storedPath"
       FROM driver_documents
       WHERE id = $1
       LIMIT 1`,
      [documentId],
      { role: 'reader', strongRead: true }
    ).then((result) => result.rows[0] || null);

    const saved = await mediaStorage.save(driver.driverId, 'profile_photo', originalFilename, buffer);
    const avatarVersion = Math.floor(Date.now() / 1000);
    const completedRides = Math.max(0, Number(driver.completedRides || 0));
    const totalRides = Math.max(
      completedRides,
      Math.round(completedRides / Math.max(0.01, Number(driver.completionRate || 1))),
    );
    const cancelledRides = Math.max(0, totalRides - completedRides);

    await domainDb.withTransaction('drivers', async (client) => {
      await client.query(
        `UPDATE driver_documents
         SET is_active = false,
             updated_at = NOW()
         WHERE driver_id = $1
           AND document_type = 'profile_photo'
           AND id <> $2`,
        [driver.driverId, documentId],
      );

      await client.query(
        `INSERT INTO driver_documents (
           id,
           driver_id,
           document_type,
           document_url,
           storage_backend,
           storage_key,
           stored_path,
           mime_type,
           file_size_bytes,
           checksum_sha256,
           original_filename,
           is_active,
           verification_status,
           verified_at,
           uploaded_at,
           updated_at
         )
         VALUES (
           $1, $2, 'profile_photo', $3, 'local', $4, $5, $6, $7, $8, $9, true, 'verified', NOW(), NOW(), NOW()
         )
         ON CONFLICT (id)
         DO UPDATE SET
           driver_id = EXCLUDED.driver_id,
           document_type = EXCLUDED.document_type,
           document_url = EXCLUDED.document_url,
           storage_backend = EXCLUDED.storage_backend,
           storage_key = EXCLUDED.storage_key,
           stored_path = EXCLUDED.stored_path,
           mime_type = EXCLUDED.mime_type,
           file_size_bytes = EXCLUDED.file_size_bytes,
           checksum_sha256 = EXCLUDED.checksum_sha256,
           original_filename = EXCLUDED.original_filename,
           is_active = true,
           verification_status = 'verified',
           rejection_reason = NULL,
           verified_by = NULL,
           verified_at = NOW(),
           updated_at = NOW()`,
        [
          documentId,
          driver.driverId,
          mediaStorage.buildDocumentUrl(driver.driverId, documentId),
          saved.storageKey,
          saved.storedPath,
          mimeType,
          saved.fileSizeBytes,
          saved.checksumSha256,
          originalFilename,
        ],
      );

      await client.query(
        `INSERT INTO driver_performance_metrics (
           driver_id,
           metric_date,
           total_rides,
           completed_rides,
           cancelled_rides,
           acceptance_rate,
           cancellation_rate,
           avg_rating,
           online_hours,
           total_earnings,
           total_distance_km,
           complaints
         )
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, 9.5, $8, 420.0, 0)
         ON CONFLICT (driver_id, metric_date)
         DO UPDATE SET
           total_rides = EXCLUDED.total_rides,
           completed_rides = EXCLUDED.completed_rides,
           cancelled_rides = EXCLUDED.cancelled_rides,
           acceptance_rate = EXCLUDED.acceptance_rate,
           cancellation_rate = EXCLUDED.cancellation_rate,
           avg_rating = EXCLUDED.avg_rating,
           online_hours = EXCLUDED.online_hours,
           total_earnings = EXCLUDED.total_earnings,
           total_distance_km = EXCLUDED.total_distance_km,
           complaints = EXCLUDED.complaints`,
        [
          driver.driverId,
          totalRides,
          completedRides,
          cancelledRides,
          driver.acceptanceRate,
          driver.cancelRate,
          driver.averageRating,
          Math.round(completedRides * 180),
        ],
      );
    });

    if (
      existingDoc &&
      (existingDoc.storageKey !== saved.storageKey || existingDoc.storedPath !== saved.storedPath)
    ) {
      await mediaStorage.delete(existingDoc.storageKey || null, existingDoc.storedPath || null).catch(() => {});
    }

    driver.avatarVersion = avatarVersion;
    driver.avatarUrl = mediaStorage.buildAvatarUrl(driver.driverId, avatarVersion);
  }
}

module.exports = new DevDriverSeedService();
module.exports.createSeedFleet = createSeedFleet;
module.exports.SEED_BLUEPRINTS = SEED_BLUEPRINTS;
module.exports.getSeedDriverIds = () => SEED_BLUEPRINTS.map((driver) => driver.driverId);
module.exports.getSeedDriverUserIds = () => SEED_BLUEPRINTS.map((driver) => driver.userId);
