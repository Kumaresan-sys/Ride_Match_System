// GoApp Ride Session Recovery Service
//
// Solves: When rider's app is force-closed or killed during an active ride,
// on reopen they need to seamlessly continue the ride without re-requesting.
//
// Flow when app reopens:
//   1. App calls GET /riders/:riderId/active-ride
//      → Returns { hasActiveRide: true, rideId, status } or { hasActiveRide: false }
//
//   2. App calls POST /riders/:riderId/restore
//      → Returns full snapshot: ride details, driver info, driver location,
//        elapsed time, fare meter, WebSocket channel name
//
//   3. App connects WebSocket, sends { action: 'reconnect', rideId }
//      → Server resubscribes client to ride channel and pushes current state
//
// FCM Silent Push:
//   When ride state changes (e.g. TRIP_STARTED) the server sends a silent push
//   with data: { type, rideId, riderId }. The app wakes in background, calls
//   /restore, and navigates directly to the in-progress ride screen.

const { logger, eventBus } = require('../utils/logger');
const redis = require('./redis-mock');

const HEARTBEAT_TTL_SEC = 120; // consider app "alive" if heartbeat within 2 min

class RideSessionService {
  constructor() {
    // riderId → { rideId, lastHeartbeatAt, restoredAt, recoveryCount }
    this.activeSessions = new Map();
    // in-memory recovery log (capped)
    this.recoveryLog = [];
    this._recoveryLogMax = 2000;
  }

  // ─── Called by ride-service on ride creation ──────────────────────────────
  // (ride-service already writes to Redis; this tracks in-memory session info)
  onRideCreated(riderId, rideId) {
    this.activeSessions.set(riderId, {
      rideId,
      lastHeartbeatAt: Date.now(),
      restoredAt: null,
      recoveryCount: 0,
      createdAt: Date.now(),
    });
  }

  // ─── Called by ride-service on ride complete/cancel ───────────────────────
  onRideEnded(riderId) {
    this.activeSessions.delete(riderId);
  }

  // ─── Core recovery method — builds full restore payload ──────────────────
  // Dependencies injected at runtime (to avoid circular requires)
  restoreSession(riderId, { rideService, locationService, matchingEngine } = {}) {
    if (!rideService) {
      return { hasActiveRide: false, error: 'Service not available' };
    }

    const ride = rideService.getActiveRide(riderId);
    if (!ride) {
      return { hasActiveRide: false, message: 'No active ride found for this rider.' };
    }

    const now = Date.now();
    const rideId = ride.rideId;

    // ── Build trip progress ──
    const elapsedSec     = ride.startedAt ? Math.round((now - ride.startedAt) / 1000) : 0;
    const matchedSec     = ride.acceptedAt ? Math.round((now - ride.acceptedAt) / 1000) : null;
    const requestedSec   = Math.round((now - ride.createdAt) / 1000);

    // ── Build driver snapshot ──
    let driverSnapshot = null;
    if (ride.driverId) {
      const driverMeta  = matchingEngine ? matchingEngine.getDriver(ride.driverId) : null;
      const driverLoc   = locationService ? locationService.getDriverLocation(ride.driverId) : null;

      driverSnapshot = {
        driverId:          ride.driverId,
        name:              driverMeta?.name || ride.matchResult?.driverName || 'Your Driver',
        vehicleType:       driverMeta?.vehicleType || ride.rideType,
        vehicleBrand:      driverMeta?.vehicleBrand || null,
        vehicleNumber:     driverMeta?.vehicleNumber || ride.matchResult?.vehicleNumber || null,
        rating:            driverMeta?.rating || null,
        currentLat:        driverLoc?.lat || null,
        currentLng:        driverLoc?.lng || null,
        locationAgeSec:    driverLoc ? Math.round((now - (driverLoc.updatedAt || now)) / 1000) : null,
        locationStale:     driverLoc?.stale || false,
        speed:             driverLoc?.speed || null,
        heading:           driverLoc?.heading || null,
        etaMin:            ride.matchResult?.etaMin || null,
      };
    }

    // ── Fare meter progress ──
    const fareMeter = {
      estimatedFare: ride.fareEstimate?.finalFare || null,
      estimatedDistanceKm: ride.fareEstimate?.distanceKm || null,
      estimatedDurationMin: ride.fareEstimate?.durationMin || null,
      surgeMultiplier: ride.surgeMultiplier || 1.0,
      elapsedSec,
      // Estimate how much of the journey is done (rough: elapsedSec / (estimatedDurationMin * 60))
      estimatedProgressPct: ride.startedAt && ride.fareEstimate?.durationMin
        ? Math.min(100, Math.round((elapsedSec / (ride.fareEstimate.durationMin * 60)) * 100))
        : 0,
    };

    // ── WS reconnect instructions ──
    const wsChannel = `ride_${rideId}`;
    const wsReconnectAction = {
      action:   'reconnect',
      rideId,
      userId:   riderId,
      userType: 'rider',
      channel:  wsChannel,
    };

    // ── Update session tracking ──
    const session = this.activeSessions.get(riderId) || {
      rideId, lastHeartbeatAt: now, recoveryCount: 0, createdAt: now,
    };
    session.restoredAt = now;
    session.recoveryCount = (session.recoveryCount || 0) + 1;
    this.activeSessions.set(riderId, session);

    // ── Log this recovery ──
    this._logRecovery({
      type:               'restore',
      riderId,
      rideId,
      rideStatus:         ride.status,
      elapsedSec,
      requestedSec,
      recoveryCount:      session.recoveryCount,
    });

    eventBus.publish('ride_session_restored', { riderId, rideId, status: ride.status, elapsedSec });
    logger.info('RIDE_SESSION', `Session restored for rider ${riderId}: ride ${rideId} [${ride.status}] after ${requestedSec}s`);

    return {
      hasActiveRide: true,
      recoveredAt:   new Date(now).toISOString(),
      recoveryCount: session.recoveryCount,
      ride: {
        rideId,
        status:        ride.status,
        rideType:      ride.rideType,
        pickupLat:     ride.pickupLat,
        pickupLng:     ride.pickupLng,
        destLat:       ride.destLat,
        destLng:       ride.destLng,
        createdAt:     new Date(ride.createdAt).toISOString(),
        acceptedAt:    ride.acceptedAt ? new Date(ride.acceptedAt).toISOString() : null,
        startedAt:     ride.startedAt ? new Date(ride.startedAt).toISOString() : null,
        elapsedSec,
        matchedSec,
        statusHistory: ride.statusHistory.map(h => ({
          status: h.status,
          at:     new Date(h.at).toISOString(),
        })),
      },
      driver:       driverSnapshot,
      fareMeter,
      wsChannel,
      wsReconnectAction,
    };
  }

  // ─── Heartbeat — rider app pings while active ────────────────────────────
  heartbeat(riderId, rideId) {
    const now = Date.now();
    const session = this.activeSessions.get(riderId);

    if (session) {
      session.lastHeartbeatAt = now;
      this.activeSessions.set(riderId, session);
    } else {
      // App opened but session not tracked — store minimal entry
      this.activeSessions.set(riderId, {
        rideId, lastHeartbeatAt: now, restoredAt: null, recoveryCount: 0, createdAt: now,
      });
    }

    // Update Redis TTL so active-ride key stays alive
    const cachedRideId = redis.get(`active_ride:${riderId}`);
    if (cachedRideId) {
      redis.expire(`active_ride:${riderId}`, 4 * 3600);
    }

    this._logRecovery({ type: 'heartbeat', riderId, rideId });
    return { alive: true, rideId, heartbeatAt: new Date(now).toISOString() };
  }

  // ─── Log WebSocket reconnect event ────────────────────────────────────────
  logWsReconnect(riderId, rideId, rideStatus) {
    this._logRecovery({
      type:       'ws_reconnect',
      riderId,
      rideId,
      rideStatus,
    });
    logger.info('RIDE_SESSION', `WS reconnected: rider ${riderId} → ride ${rideId} [${rideStatus}]`);
  }

  // ─── Internal: append to circular log ────────────────────────────────────
  _logRecovery(entry) {
    const log = {
      logId:     `REC-${Date.now()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
      ...entry,
      createdAt: new Date().toISOString(),
    };
    if (this.recoveryLog.length >= this._recoveryLogMax) {
      this.recoveryLog.shift();
    }
    this.recoveryLog.push(log);
    return log;
  }

  // ─── Query recovery logs (admin) ──────────────────────────────────────────
  getRecoveryLogs({ type = null, riderId = null, limit = 50 } = {}) {
    let logs = this.recoveryLog.slice();
    if (type)    logs = logs.filter(l => l.type === type);
    if (riderId) logs = logs.filter(l => l.riderId === riderId);
    return logs.slice(-Math.min(limit, 500)).reverse();
  }

  // ─── Stats ────────────────────────────────────────────────────────────────
  getStats() {
    const restores   = this.recoveryLog.filter(l => l.type === 'restore').length;
    const heartbeats = this.recoveryLog.filter(l => l.type === 'heartbeat').length;
    const wsReconn   = this.recoveryLog.filter(l => l.type === 'ws_reconnect').length;
    return {
      activeSessions:   this.activeSessions.size,
      totalRecoveries:  restores,
      totalHeartbeats:  heartbeats,
      totalWsReconnects: wsReconn,
      totalLogged:      this.recoveryLog.length,
    };
  }
}

module.exports = new RideSessionService();
