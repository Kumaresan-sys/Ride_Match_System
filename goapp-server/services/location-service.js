// GoApp Driver Location Service
// Manages real-time driver positions in Redis GEO

const redis = require('./redis-mock');
const config = require('../config');
const { predictLocation, detectSpoofing } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');

const GEO_KEY = 'drivers:locations';
const driverMeta = new Map(); // driverId -> { speed, heading, prevLocation, jumpCount, ... }

class LocationService {
  // Process incoming GPS update from driver
  updateLocation(driverId, { lat, lng, speed, heading, clientTimestamp }) {
    const now = Date.now();
    const prev = driverMeta.get(driverId);

    // ─── Fraud Detection ───
    if (prev && prev.lat && prev.lng) {
      const timeDiff = (now - prev.updatedAt) / 1000;
      if (timeDiff > 0) {
        const spoofCheck = detectSpoofing(
          { lat: prev.lat, lng: prev.lng },
          { lat, lng },
          timeDiff
        );

        if (spoofCheck.isSuspicious) {
          for (const flag of spoofCheck.flags) {
            logger.error('LOCATION', `Fraud detected for driver ${driverId}: ${flag.reason}`);
            eventBus.publish('fraud_alert_triggered', {
              driverId,
              type: flag.type,
              reason: flag.reason,
              speedKmh: spoofCheck.speedKmh,
            });

            if (flag.type === 'AUTO_SUSPEND') {
              return { success: false, reason: 'SUSPENDED', flag };
            }
          }

          // Track jump count
          const meta = driverMeta.get(driverId) || {};
          meta.jumpCount = (meta.jumpCount || 0) + 1;
          if (meta.jumpCount > config.fraud.maxJumpsIn10Min) {
            logger.error('LOCATION', `Driver ${driverId} suspended: ${meta.jumpCount} location jumps`);
            return { success: false, reason: 'JUMP_LIMIT_EXCEEDED' };
          }
        }
      }
    }

    // ─── Store in Redis GEO ───
    redis.geoadd(GEO_KEY, lng, lat, driverId);

    // ─── Update metadata ───
    driverMeta.set(driverId, {
      lat, lng, speed: speed || 0, heading: heading || 0,
      updatedAt: now,
      prevLat: prev?.lat, prevLng: prev?.lng,
      jumpCount: prev?.jumpCount || 0,
    });

    // Publish location event
    eventBus.publish('driver_location_update', {
      driverId, lat, lng, speed, heading, timestamp: now,
    });

    return { success: true, lat, lng };
  }

  // Get driver's current position (with staleness handling)
  getDriverLocation(driverId) {
    const meta = driverMeta.get(driverId);
    if (!meta) return null;

    const age = (Date.now() - meta.updatedAt) / 1000;

    // Expired - too stale
    if (age > config.scoring.freshness.maxAgeSec) {
      return { ...meta, stale: true, expired: true, ageSec: Math.round(age) };
    }

    // Needs interpolation
    if (age > config.scoring.freshness.boostThresholdSec && meta.speed > 0) {
      const predicted = predictLocation(meta.lat, meta.lng, meta.speed, meta.heading, age);
      return {
        ...predicted, speed: meta.speed, heading: meta.heading,
        stale: true, expired: false, interpolated: true, ageSec: Math.round(age),
      };
    }

    // Fresh
    return { ...meta, stale: false, expired: false, ageSec: Math.round(age) };
  }

  // Find nearby drivers using GEORADIUS
  findNearby(lat, lng, radiusKm, maxCount) {
    const results = redis.georadius(GEO_KEY, lng, lat, radiusKm, { count: maxCount * 3 });

    // Filter out stale drivers
    return results.filter(r => {
      const meta = driverMeta.get(r.member);
      if (!meta) return false;
      const age = (Date.now() - meta.updatedAt) / 1000;
      return age <= config.scoring.freshness.maxAgeSec;
    }).map(r => {
      const meta = driverMeta.get(r.member);
      return {
        driverId: r.member,
        lat: r.lat,
        lng: r.lng,
        distance: r.distance,
        speed: meta?.speed || 0,
        heading: meta?.heading || 0,
        lastUpdate: meta?.updatedAt,
        ageSec: meta ? Math.round((Date.now() - meta.updatedAt) / 1000) : 999,
      };
    });
  }

  // Remove driver from location tracking (went offline)
  removeDriver(driverId) {
    redis.georemove(GEO_KEY, driverId);
    driverMeta.delete(driverId);
    logger.info('LOCATION', `Driver ${driverId} removed from tracking`);
  }

  // Get all tracked drivers
  getAllTracked() {
    const all = [];
    for (const [driverId, meta] of driverMeta) {
      all.push({
        driverId,
        lat: meta.lat,
        lng: meta.lng,
        speed: meta.speed,
        heading: meta.heading,
        ageSec: Math.round((Date.now() - meta.updatedAt) / 1000),
      });
    }
    return all;
  }

  getStats() {
    return {
      trackedDrivers: driverMeta.size,
      redisGeoMembers: redis.geoSets.get(GEO_KEY)?.size || 0,
    };
  }
}

module.exports = new LocationService();
