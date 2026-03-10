// GoApp Ride Session Recovery Service
// Session and recovery metadata is stored in Redis for cross-instance restore.

'use strict';

const { logger, eventBus } = require('../utils/logger');
const redis = require('./redis-client');
const config = require('../config');

const HEARTBEAT_TTL_SEC = 120;
const SESSION_TTL_SEC = 24 * 3600;
const RECOVERY_LOG_MAX = 2000;

class RideSessionService {
  constructor() {
    this.redisStateV2 = Boolean(config.architecture?.featureFlags?.redisStateV2);
  }

  _sessionKey(riderId) {
    return `ride:session:${riderId}`;
  }

  _activeSessionsKey() {
    return 'ride:sessions:active';
  }

  _recoveryLogKey() {
    return 'ride:recovery:logs';
  }

  async _getSession(riderId) {
    const raw = await redis.get(this._sessionKey(riderId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async _setSession(riderId, payload, ttlSec = SESSION_TTL_SEC) {
    await redis.set(this._sessionKey(riderId), JSON.stringify(payload), { EX: ttlSec });
    await redis.sAdd(this._activeSessionsKey(), String(riderId));
    await redis.expire(this._activeSessionsKey(), SESSION_TTL_SEC);
  }

  async onRideCreated(riderId, rideId) {
    if (!riderId || !rideId) return;
    const now = Date.now();
    await this._setSession(riderId, {
      rideId,
      lastHeartbeatAt: now,
      restoredAt: null,
      recoveryCount: 0,
      createdAt: now,
    });
  }

  async onRideEnded(riderId) {
    if (!riderId) return;
    await Promise.all([
      redis.del(this._sessionKey(riderId)),
      redis.sRem(this._activeSessionsKey(), String(riderId)),
    ]);
  }

  async restoreSession(riderId, { rideService, locationService, matchingEngine } = {}) {
    if (!rideService) {
      return { hasActiveRide: false, error: 'Service not available' };
    }

    const ride = await (rideService.getActiveRideAsync
      ? rideService.getActiveRideAsync(riderId)
      : Promise.resolve(rideService.getActiveRide(riderId)));
    if (!ride) {
      return { hasActiveRide: false, message: 'No active ride found for this rider.' };
    }

    const now = Date.now();
    const rideId = ride.rideId;
    const elapsedSec = ride.startedAt ? Math.round((now - ride.startedAt) / 1000) : 0;
    const matchedSec = ride.acceptedAt ? Math.round((now - ride.acceptedAt) / 1000) : null;
    const requestedSec = Math.round((now - ride.createdAt) / 1000);

    let driverSnapshot = null;
    if (ride.driverId) {
      const [driverMeta, driverLoc] = await Promise.all([
        matchingEngine ? matchingEngine.getDriver(ride.driverId) : Promise.resolve(null),
        locationService ? locationService.getDriverLocation(ride.driverId) : Promise.resolve(null),
      ]);

      driverSnapshot = {
        driverId: ride.driverId,
        name: driverMeta?.name || ride.matchResult?.driverName || 'Your Driver',
        vehicleType: driverMeta?.vehicleType || ride.rideType,
        vehicleBrand: driverMeta?.vehicleBrand || null,
        vehicleNumber: driverMeta?.vehicleNumber || ride.matchResult?.vehicleNumber || null,
        rating: driverMeta?.rating || null,
        currentLat: driverLoc?.lat || null,
        currentLng: driverLoc?.lng || null,
        locationAgeSec: driverLoc?.ageSec || null,
        locationStale: driverLoc?.stale || false,
        speed: driverLoc?.speed || null,
        heading: driverLoc?.heading || null,
        etaMin: ride.matchResult?.etaMin || null,
      };
    }

    const fareMeter = {
      estimatedFare: ride.fareEstimate?.finalFare || null,
      estimatedDistanceKm: ride.fareEstimate?.distanceKm || null,
      estimatedDurationMin: ride.fareEstimate?.durationMin || null,
      surgeMultiplier: ride.surgeMultiplier || 1.0,
      elapsedSec,
      estimatedProgressPct: ride.startedAt && ride.fareEstimate?.durationMin
        ? Math.min(100, Math.round((elapsedSec / (ride.fareEstimate.durationMin * 60)) * 100))
        : 0,
    };

    const wsChannel = `ride_${rideId}`;
    const wsReconnectAction = {
      action: 'reconnect',
      rideId,
      channel: wsChannel,
    };

    const existing = await this._getSession(riderId);
    const session = existing || {
      rideId,
      lastHeartbeatAt: now,
      restoredAt: null,
      recoveryCount: 0,
      createdAt: now,
    };
    session.restoredAt = now;
    session.recoveryCount = (session.recoveryCount || 0) + 1;
    await this._setSession(riderId, session);

    await this._logRecovery({
      type: 'restore',
      riderId,
      rideId,
      rideStatus: ride.status,
      elapsedSec,
      requestedSec,
      recoveryCount: session.recoveryCount,
    });

    eventBus.publish('ride_session_restored', { riderId, rideId, status: ride.status, elapsedSec });
    logger.info('RIDE_SESSION', `Session restored for rider ${riderId}: ride ${rideId} [${ride.status}] after ${requestedSec}s`);

    return {
      hasActiveRide: true,
      recoveredAt: new Date(now).toISOString(),
      recoveryCount: session.recoveryCount,
      ride: {
        rideId,
        status: ride.status,
        rideType: ride.rideType,
        pickupLat: ride.pickupLat,
        pickupLng: ride.pickupLng,
        destLat: ride.destLat,
        destLng: ride.destLng,
        createdAt: new Date(ride.createdAt).toISOString(),
        acceptedAt: ride.acceptedAt ? new Date(ride.acceptedAt).toISOString() : null,
        startedAt: ride.startedAt ? new Date(ride.startedAt).toISOString() : null,
        elapsedSec,
        matchedSec,
        statusHistory: Array.isArray(ride.statusHistory)
          ? ride.statusHistory.map((h) => ({ status: h.status, at: new Date(h.at).toISOString() }))
          : [],
      },
      driver: driverSnapshot,
      fareMeter,
      wsChannel,
      wsReconnectAction,
    };
  }

  async heartbeat(riderId, rideId) {
    const now = Date.now();
    const session = (await this._getSession(riderId)) || {
      rideId,
      lastHeartbeatAt: now,
      restoredAt: null,
      recoveryCount: 0,
      createdAt: now,
    };

    session.rideId = rideId || session.rideId || null;
    session.lastHeartbeatAt = now;
    await this._setSession(riderId, session);

    if (this.redisStateV2) {
      const riderActiveKey = `rider:active_ride:${riderId}`;
      const activeRide = await redis.get(riderActiveKey);
      if (activeRide) {
        await redis.expire(riderActiveKey, SESSION_TTL_SEC);
      }
    } else {
      const cachedRideId = await redis.get(`active_ride:${riderId}`);
      if (cachedRideId) {
        await redis.expire(`active_ride:${riderId}`, SESSION_TTL_SEC);
      }
    }

    await this._logRecovery({ type: 'heartbeat', riderId, rideId });
    return { alive: true, rideId, heartbeatAt: new Date(now).toISOString() };
  }

  async logWsReconnect(riderId, rideId, rideStatus) {
    await this._logRecovery({
      type: 'ws_reconnect',
      riderId,
      rideId,
      rideStatus,
    });
    logger.info('RIDE_SESSION', `WS reconnected: rider ${riderId} → ride ${rideId} [${rideStatus}]`);
  }

  async _logRecovery(entry) {
    const log = {
      logId: `REC-${Date.now()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
      ...entry,
      createdAt: new Date().toISOString(),
    };

    await redis.lPush(this._recoveryLogKey(), JSON.stringify(log));
    await redis.lTrim(this._recoveryLogKey(), 0, RECOVERY_LOG_MAX - 1);
    await redis.expire(this._recoveryLogKey(), SESSION_TTL_SEC);
    return log;
  }

  async getRecoveryLogs({ type = null, riderId = null, limit = 50 } = {}) {
    const safeLimit = Math.min(Number(limit) || 50, 500);
    const rows = await redis.lRange(this._recoveryLogKey(), 0, safeLimit - 1);
    let logs = rows.map((row) => {
      try {
        return JSON.parse(row);
      } catch (_) {
        return null;
      }
    }).filter(Boolean);

    if (type) logs = logs.filter((log) => log.type === type);
    if (riderId) logs = logs.filter((log) => String(log.riderId) === String(riderId));

    return logs;
  }

  async getStats() {
    const [activeSessions, totalLogged] = await Promise.all([
      redis.sCard(this._activeSessionsKey()),
      redis.lLen(this._recoveryLogKey()),
    ]);

    const logs = await this.getRecoveryLogs({ limit: 500 });
    const restores = logs.filter((log) => log.type === 'restore').length;
    const heartbeats = logs.filter((log) => log.type === 'heartbeat').length;
    const wsReconnects = logs.filter((log) => log.type === 'ws_reconnect').length;

    return {
      activeSessions,
      totalRecoveries: restores,
      totalHeartbeats: heartbeats,
      totalWsReconnects: wsReconnects,
      totalLogged,
      heartbeatTtlSec: HEARTBEAT_TTL_SEC,
    };
  }
}

module.exports = new RideSessionService();
