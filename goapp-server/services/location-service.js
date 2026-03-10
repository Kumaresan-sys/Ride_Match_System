// GoApp Driver Location Service
// Distributed location authority via Redis GEO + Redis hashes, with PostGIS persistence.

'use strict';

const redis = require('./redis-client');
const config = require('../config');
const { detectSpoofing } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');
const pgRepo = require('../repositories/pg/pg-location-repository');
const RedisStateStore = require('../infra/redis/state-store');

const stateStore = new RedisStateStore(redis);

class LocationService {
  async updateLocation(driverId, { lat, lng, speed, heading, clientTimestamp }) {
    const now = Date.now();
    const prior = await stateStore.getDriverState(driverId).catch(() => ({}));
    const geoBucket = String(prior?.city || prior?.homeCity || 'default').toLowerCase();
    const prevLat = Number(prior?.lat);
    const prevLng = Number(prior?.lng);
    const prevUpdatedAt = Number(prior?.lastLocationUpdate);

    if (Number.isFinite(prevLat) && Number.isFinite(prevLng) && Number.isFinite(prevUpdatedAt)) {
      const timeDiff = (now - prevUpdatedAt) / 1000;
      if (timeDiff > 0) {
        const spoofCheck = detectSpoofing({ lat: prevLat, lng: prevLng }, { lat, lng }, timeDiff);
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
        }
      }
    }

    await Promise.all([
      stateStore.updateDriverLocation(driverId, geoBucket, lat, lng, 60),
      stateStore.setDriverState(driverId, {
        lat,
        lng,
        speed: speed || 0,
        heading: heading || 0,
        city: geoBucket,
        status: 'online',
        lastLocationUpdate: now,
      }, 60),
      pgRepo.recordLocation(driverId, { lat, lng, speed, heading }).catch((err) => {
        logger.warn('LOCATION', `PostGIS write failed (non-fatal): ${err.message}`);
      }),
    ]);

    eventBus.publish('driver_location_update', {
      driverId,
      lat,
      lng,
      speed,
      heading,
      clientTimestamp,
      timestamp: now,
    });

    return { success: true, lat, lng };
  }

  async getDriverLocation(driverId) {
    const state = await stateStore.getDriverState(driverId);
    if (!state || !state.lastLocationUpdate) return null;
    const age = Math.max(0, Math.round((Date.now() - Number(state.lastLocationUpdate)) / 1000));
    return {
      lat: Number(state.lat),
      lng: Number(state.lng),
      speed: Number(state.speed || 0),
      heading: Number(state.heading || 0),
      stale: age > (config.scoring?.freshness?.boostThresholdSec || 3),
      expired: age > (config.scoring?.freshness?.maxAgeSec || 8),
      ageSec: age,
      updatedAt: Number(state.lastLocationUpdate),
    };
  }

  async findNearby(lat, lng, radiusKm, maxCount, geoBucket = 'default') {
    let raw = await stateStore.geoSearchDrivers(geoBucket, lat, lng, radiusKm, maxCount * 3);
    if ((!raw || raw.length === 0) && geoBucket !== 'default') {
      raw = await stateStore.geoSearchDrivers('default', lat, lng, radiusKm, maxCount * 3);
    }
    const drivers = await Promise.all((raw || []).map(async (item) => {
      const driverId = item.member;
      const state = await stateStore.getDriverState(driverId).catch(() => null);
      if (!state || !state.lastLocationUpdate) return null;
      const ageSec = Math.round((Date.now() - Number(state.lastLocationUpdate)) / 1000);
      if (ageSec > (config.scoring?.freshness?.maxAgeSec || 8)) return null;
      return {
        driverId,
        lat: Number(state.lat),
        lng: Number(state.lng),
        distance: Number(item.distance),
        speed: Number(state.speed || 0),
        heading: Number(state.heading || 0),
        lastUpdate: Number(state.lastLocationUpdate),
        ageSec,
      };
    }));

    const fresh = drivers.filter(Boolean).slice(0, maxCount);
    if (fresh.length > 0) return fresh;

    logger.info('LOCATION', 'Redis GEO empty/stale - falling back to PostGIS spatial query');
    const pgResults = await pgRepo.findNearbyDrivers(lat, lng, radiusKm, maxCount);
    return pgResults.map((r) => ({
      driverId: r.driverId,
      lat: r.lat,
      lng: r.lng,
      distance: r.distanceKm,
      speed: r.speed || 0,
      heading: r.heading || 0,
      lastUpdate: r.lastUpdate,
      ageSec: Math.round((Date.now() - new Date(r.lastUpdate).getTime()) / 1000),
    }));
  }

  async removeDriver(driverId) {
    const state = await stateStore.getDriverState(driverId).catch(() => ({}));
    const geoBucket = String(state?.city || state?.homeCity || 'default').toLowerCase();
    await Promise.all([
      redis.georemove(stateStore.geoDriversKey(geoBucket), driverId).catch(() => {}),
      redis.del(stateStore.driverStateKey(driverId)).catch(() => {}),
      redis.del(stateStore.driverLocationKey(driverId)).catch(() => {}),
      pgRepo.removeDriverLocation(driverId).catch(() => {}),
    ]);
    logger.info('LOCATION', `Driver ${driverId} removed from tracking`);
  }

  getAllTracked() {
    return [];
  }

  async getStats() {
    const base = {
      trackedDrivers: 0,
      redisGeoMembers: null,
    };
    const pgStats = await pgRepo.getStats().catch(() => ({}));
    return { ...base, ...pgStats };
  }
}

module.exports = new LocationService();
