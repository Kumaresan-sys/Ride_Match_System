// GoApp Ride Service
// Ride lifecycle state machine, idempotency, cancellation
//
// DB_BACKEND=mock  → rides stored in in-memory Map (zero setup)
// DB_BACKEND=pg    → rides persisted to PostgreSQL via pg-ride-repository

const crypto = require('crypto');
const config = require('../config');
const redis = require('./redis-client');
const matchingEngine = require('./matching-engine');
const pricingService = require('./pricing-service');
const notificationService = require('./notification-service');
const { haversine } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');
const driverWalletService = require('./driver-wallet-service');
const rideSessionService  = require('./ride-session-service');

const USE_PG = config.db.backend === 'pg';
const pgRepo = USE_PG ? require('../repositories/pg/pg-ride-repository') : null;

const S = config.rideStatuses;

class RideService {
  constructor() {
    this.rides              = new Map(); // rideId -> ride object (always maintained in-memory as hot cache)
    this.cancellationCounts = new Map(); // `${type}:${userId}` -> { count, windowStart }
  }

  // ═══════════════════════════════════════════
  // CREATE RIDE REQUEST (with idempotency)
  // ═══════════════════════════════════════════
  async createRide({ riderId, pickupLat, pickupLng, destLat, destLng, rideType, idempotencyKey }) {
    // ─── Idempotency Check ───
    if (idempotencyKey) {
      const check = await redis.checkIdempotency(idempotencyKey);
      if (check.isDuplicate) {
        logger.warn('RIDE', `Duplicate request detected (idempotency: ${idempotencyKey.slice(0, 8)})`);
        return { ...check.existingResult, duplicate: true };
      }
    }

    // ─── Create Ride ───
    const rideId = `RIDE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const now = Date.now();

    // Get fare estimates (async: uses Google Maps road distance when configured)
    const estimates = await pricingService.getEstimates(pickupLat, pickupLng, destLat, destLng);
    const fareEstimate = estimates.estimates[rideType] || estimates.estimates.sedan;

    const ride = {
      rideId,
      riderId,
      driverId: null,
      pickupLat, pickupLng,
      destLat, destLng,
      rideType: rideType || 'sedan',
      status: S.REQUESTED,
      fareEstimate,
      finalFare: null,
      surgeMultiplier: estimates.surgeMultiplier,
      idempotencyKey,
      statusHistory: [{ status: S.REQUESTED, at: now }],
      createdAt: now,
      acceptedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      cancelledBy: null,
    };

    this.rides.set(rideId, ride);

    // Persist to PostgreSQL (non-blocking — in-memory Map remains source of truth during the ride)
    if (USE_PG) {
      pgRepo.createRide({
        rideId,
        riderId,
        rideType: rideType || 'sedan',
        pickupLat, pickupLng,
        destLat, destLng,
        fareEstimate: fareEstimate.finalFare,
        surgeMultiplier: estimates.surgeMultiplier,
        idempotencyKey,
      }).catch(err => logger.warn('RIDE', `pg createRide failed (non-fatal): ${err.message}`));
    }

    // Index active ride in Redis for fast recovery lookup (4-hour TTL)
    if (riderId) redis.set(`active_ride:${riderId}`, rideId, 4 * 3600);

    // Track session for app-crash recovery
    rideSessionService.onRideCreated(riderId, rideId);

    // Store idempotency
    if (idempotencyKey) {
      redis.setIdempotency(idempotencyKey, { rideId, status: S.REQUESTED }, 300);
    }

    logger.success('RIDE', `Created ride ${rideId} for rider ${riderId}`, {
      type: rideType, fare: `₹${fareEstimate.finalFare}`, surge: estimates.surgeMultiplier,
    });

    eventBus.publish('ride_requested', {
      rideId, riderId, rideType, pickupLat, pickupLng, destLat, destLng,
      fareEstimate: fareEstimate.finalFare,
    });

    // ─── Start Matching ───
    this._updateStatus(rideId, S.MATCHING);
    notificationService.notifyRideRequested(riderId, rideId);

    const matchResult = await matchingEngine.startMatching(ride);

    if (matchResult.success) {
      ride.driverId = matchResult.driverId;
      ride.acceptedAt = Date.now();
      ride.matchResult = matchResult;
      this._updateStatus(rideId, S.ACCEPTED);
      this._updateStatus(rideId, S.DRIVER_ARRIVING);

      notificationService.notifyRideMatched(riderId, matchResult.driverId, {
        rideId,
        driverName: matchResult.driverName,
        vehicleType: matchResult.vehicleType,
        vehicleNumber: matchResult.vehicleNumber,
        etaMin: matchResult.etaMin,
        score: matchResult.score,
      });
      eventBus.publish('ride_matched', {
        rideId,
        riderId,
        driverId: matchResult.driverId,
        etaMin: matchResult.etaMin,
      });

      return {
        rideId,
        status: S.DRIVER_ARRIVING,
        driver: {
          driverId: matchResult.driverId,
          name: matchResult.driverName,
          vehicleType: matchResult.vehicleType,
          vehicleNumber: matchResult.vehicleNumber,
          etaMin: matchResult.etaMin,
          score: matchResult.score,
        },
        fareEstimate: fareEstimate.finalFare,
        matchTimeSec: matchResult.matchTimeSec,
      };
    } else {
      this._updateStatus(rideId, S.NO_DRIVERS);
      notificationService.notifyNoDrivers(riderId, rideId);
      return {
        rideId,
        status: S.NO_DRIVERS,
        message: matchResult.message,
        canRetry: matchResult.canRetry,
        retryCooldownSec: matchResult.retryCooldownSec,
      };
    }
  }

  // ═══════════════════════════════════════════
  // RIDE STATE TRANSITIONS
  // ═══════════════════════════════════════════
  driverArrived(rideId) {
    const ride = this.rides.get(rideId);
    if (!ride || ride.status !== S.DRIVER_ARRIVING) return null;

    this._updateStatus(rideId, S.DRIVER_ARRIVED);
    eventBus.publish('driver_arrived', { rideId, driverId: ride.driverId, riderId: ride.riderId });
    logger.success('RIDE', `Driver arrived at pickup for ride ${rideId}`);

    const arrivedDriver = matchingEngine.getDriver(ride.driverId);
    notificationService.notifyDriverArrived(ride.riderId, arrivedDriver?.name || 'Your driver', rideId);

    return ride;
  }

  startTrip(rideId) {
    const ride = this.rides.get(rideId);
    if (!ride || ride.status !== S.DRIVER_ARRIVED) return null;

    ride.startedAt = Date.now();
    this._updateStatus(rideId, S.TRIP_STARTED);
    eventBus.publish('ride_started', { rideId, driverId: ride.driverId, riderId: ride.riderId });
    logger.success('RIDE', `Trip started for ride ${rideId}`);

    notificationService.notifyTripStarted(ride.riderId, rideId);

    return ride;
  }

  completeTrip(rideId, actualDistanceKm, actualDurationMin) {
    const ride = this.rides.get(rideId);
    if (!ride || ride.status !== S.TRIP_STARTED) return null;

    ride.completedAt = Date.now();

    // Calculate final fare with actual distance/duration
    const finalFare = pricingService.calculateFare(
      ride.rideType,
      actualDistanceKm || ride.fareEstimate.distanceKm,
      actualDurationMin || ride.fareEstimate.durationMin,
      ride.surgeMultiplier
    );
    ride.finalFare = finalFare;

    this._updateStatus(rideId, S.TRIP_COMPLETED, {
      completedAt:    ride.completedAt,
      finalFare:      finalFare.finalFare,
      actualDistanceM: actualDistanceKm ? Math.round(actualDistanceKm * 1000) : null,
      actualDurationS: actualDurationMin ? Math.round(actualDurationMin * 60) : null,
    });

    // Update driver stats
    const driver = matchingEngine.getDriver(ride.driverId);
    if (driver) {
      driver.ridesCompleted = (driver.ridesCompleted || 0) + 1;
      driver.lastTripEndTime = Date.now();
      driver.status = 'online';
    }

    // Release lock and clear active-ride index
    redis.releaseLock(rideId);
    if (ride.riderId) redis.del(`active_ride:${ride.riderId}`);

    eventBus.publish('ride_completed', {
      rideId, driverId: ride.driverId, riderId: ride.riderId,
      fare: finalFare.finalFare, driverEarnings: finalFare.driverEarnings,
    });

    logger.divider(`RIDE COMPLETED: ${rideId}`);
    logger.success('RIDE', `Fare: ₹${finalFare.finalFare} | Driver: ₹${finalFare.driverEarnings} | Platform: ₹${finalFare.platformCommission}`);

    // Credit driver earnings and deduct platform commission
    if (ride.driverId) {
      const platformFee = Math.round(finalFare.platformCommission * 100) / 100;
      const driverEarnings = Math.round(finalFare.driverEarnings * 100) / 100;
      driverWalletService.deductCommission(ride.driverId, platformFee, rideId);
      driverWalletService.creditEarnings(ride.driverId, driverEarnings, rideId);
    }
    rideSessionService.onRideEnded(ride.riderId);

    notificationService.notifyTripCompleted(ride.riderId, ride.driverId, {
      rideId,
      finalFare: finalFare.finalFare,
      driverEarnings: finalFare.driverEarnings,
    });

    this._pruneOldRides();

    return {
      rideId,
      status: S.TRIP_COMPLETED,
      fare: finalFare,
      tripDuration: ride.completedAt - ride.startedAt,
    };
  }

  // ═══════════════════════════════════════════
  // CANCELLATION (FIX #4)
  // ═══════════════════════════════════════════
  cancelRide(rideId, cancelledBy, userId) {
    const ride = this.rides.get(rideId);
    if (!ride) return { success: false, reason: 'Ride not found' };

    const now = Date.now();
    let cancelFee = 0;
    let penalty = null;

    if (cancelledBy === 'rider') {
      if (ride.status === S.MATCHING || ride.status === S.BROADCAST) {
        // Cancel during matching - no penalty
        matchingEngine.cancelMatching(rideId);
        this._updateStatus(rideId, S.CANCELLED_BY_RIDER);
        eventBus.publish('ride_cancelled_by_rider', { rideId, phase: 'during_matching' });

      } else if (ride.status === S.ACCEPTED || ride.status === S.DRIVER_ARRIVING) {
        // Cancel after accept
        const timeSinceAccept = (now - ride.acceptedAt) / 1000;

        if (timeSinceAccept <= config.cancellation.gracePeriodSec) {
          // Within grace period - no fee
          logger.info('RIDE', `Rider cancelled within grace period (${Math.round(timeSinceAccept)}s)`);
        } else {
          // After grace period - fee applies
          const etaAtCancel = Math.round(timeSinceAccept / 60);
          cancelFee = config.cancellation.baseCancelFee + (etaAtCancel * config.cancellation.cancelFeePerMin);
          logger.warn('RIDE', `Rider cancellation fee: ₹${cancelFee}`);
        }

        // Free the driver
        const driver = matchingEngine.getDriver(ride.driverId);
        if (driver) driver.status = 'online';
        redis.releaseLock(rideId);

        this._updateStatus(rideId, S.CANCELLED_BY_RIDER);
        eventBus.publish('ride_cancelled_by_rider', {
          rideId, phase: 'after_accept', cancelFee, driverId: ride.driverId,
        });

        // Notify the driver that the rider cancelled
        notificationService.notifyCancelledByRider(ride.driverId, rideId, cancelFee);
      }

      // Track rider cancellations
      penalty = this._trackCancellation('rider', userId);

    } else if (cancelledBy === 'driver') {
      // Driver cancels after accepting
      const lastStage = ride.matchResult?.stage || 1;
      const cancelledDriverId = ride.driverId;

      // Exclude this driver from re-matching
      matchingEngine.excludeDriver(rideId, cancelledDriverId);

      // Free the driver
      const driver = matchingEngine.getDriver(cancelledDriverId);
      if (driver) driver.status = 'online';
      redis.releaseLock(rideId);

      this._updateStatus(rideId, S.CANCELLED_BY_DRIVER);
      eventBus.publish('ride_cancelled_by_driver', { rideId, driverId: cancelledDriverId });

      // Track driver cancellations
      penalty = this._trackCancellation('driver', userId);

      logger.warn('RIDE', `Driver cancelled ride ${rideId} - resuming matching from stage ${lastStage}`);

      // Notify rider that driver cancelled and we are finding a new one
      notificationService.notifyCancelledByDriver(ride.riderId, rideId);

      // Resume matching asynchronously so the rider isn't left stranded
      ride.driverId = null;
      this._updateStatus(rideId, S.MATCHING);
      matchingEngine.resumeMatching(ride, lastStage).then(matchResult => {
        if (matchResult.success) {
          ride.driverId = matchResult.driverId;
          ride.acceptedAt = Date.now();
          ride.matchResult = matchResult;
          this._updateStatus(rideId, S.ACCEPTED);
          this._updateStatus(rideId, S.DRIVER_ARRIVING);

          // Notify rider that a new driver was found
          notificationService.notifyRematchSuccess(ride.riderId, matchResult.driverId, {
            rideId,
            driverName: matchResult.driverName,
            vehicleType: matchResult.vehicleType,
            vehicleNumber: matchResult.vehicleNumber,
            etaMin: matchResult.etaMin,
          });
        } else {
          this._updateStatus(rideId, S.NO_DRIVERS);
          notificationService.notifyNoDrivers(ride.riderId, rideId);
        }
      }).catch(err => {
        logger.error('RIDE', `Re-matching failed for ride ${rideId}: ${err.message}`);
        this._updateStatus(rideId, S.NO_DRIVERS);
        notificationService.notifyNoDrivers(ride.riderId, rideId);
      });
    }

    ride.cancelledAt = now;
    ride.cancelledBy = cancelledBy;
    if (ride.riderId) redis.del(`active_ride:${ride.riderId}`);
    rideSessionService.onRideEnded(ride.riderId);

    this._pruneOldRides();

    return {
      success: true,
      rideId,
      cancelledBy,
      cancelFee,
      penalty,
    };
  }

  // ─── Ride Pruning (prevents unbounded Map growth) ───
  _pruneOldRides() {
    if (this.rides.size < 10000) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [rideId, ride] of this.rides) {
      const terminal = ride.completedAt || ride.cancelledAt;
      if (terminal && terminal < cutoff) this.rides.delete(rideId);
    }
  }

  // ─── Cancellation Tracking ───
  _trackCancellation(type, userId) {
    const key = `${type}:${userId}`;
    const windowMs = type === 'driver' ? 24 * 3600 * 1000 : 3600 * 1000;
    const now = Date.now();

    let record = this.cancellationCounts.get(key);
    if (!record || (now - record.windowStart) > windowMs) {
      record = { count: 0, windowStart: now };
    }

    record.count++;
    this.cancellationCounts.set(key, record);

    const thresholds = type === 'driver'
      ? config.cancellation.driver.window24h
      : config.cancellation.rider.window1h;

    let penalty = null;
    if (record.count > (thresholds.threshold5 || 5)) {
      penalty = {
        level: 'severe',
        action: type === 'driver' ? '60-min queue timeout + warning' : '30-min request block',
        count: record.count,
      };
      logger.error('RIDE', `${type} ${userId}: SEVERE penalty (${record.count} cancellations)`);
    } else if (record.count > (thresholds.threshold3 || 3)) {
      penalty = {
        level: 'moderate',
        action: type === 'driver' ? '15-min queue timeout' : 'Cancellation fee',
        count: record.count,
      };
      logger.warn('RIDE', `${type} ${userId}: Moderate penalty (${record.count} cancellations)`);
    }

    return penalty;
  }

  // ─── Status Management ───
  _updateStatus(rideId, newStatus, pgExtra = {}) {
    const ride = this.rides.get(rideId);
    if (!ride) return;
    const prev = ride.statusHistory[ride.statusHistory.length - 1]?.status || 'NEW';
    ride.status = newStatus;
    ride.statusHistory.push({ status: newStatus, at: Date.now() });
    logger.info('RIDE', `Ride ${rideId}: ${prev} → ${newStatus}`);

    // Persist status change to PostgreSQL
    if (USE_PG) {
      pgRepo.updateStatus(rideId, newStatus, pgExtra)
        .catch(err => logger.warn('RIDE', `pg updateStatus failed (non-fatal): ${err.message}`));
    }
  }

  // ─── Active ride lookup by riderId (for app session recovery) ───
  getActiveRide(riderId) {
    const activeStatuses = new Set([
      'MATCHING', 'BROADCAST', 'ACCEPTED',
      'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'TRIP_STARTED',
    ]);
    // Fast path: Redis index
    const cachedId = redis.get('active_ride:' + riderId);
    if (cachedId) {
      const r = this.rides.get(cachedId);
      if (r && activeStatuses.has(r.status)) return r;
      redis.del('active_ride:' + riderId);
    }
    // Fallback: linear scan
    for (const ride of this.rides.values()) {
      if (ride.riderId === riderId && activeStatuses.has(ride.status)) return ride;
    }
    return null;
  }

  getRide(rideId) {
    // Hot cache first; fall back to DB
    if (this.rides.has(rideId)) return this.rides.get(rideId);
    if (USE_PG) return pgRepo.getRide(rideId);
    return undefined;
  }

  getAllRides() {
    if (USE_PG) return pgRepo.getAllRides();
    return [...this.rides.values()].map(r => ({
      rideId:    r.rideId,
      riderId:   r.riderId,
      driverId:  r.driverId,
      status:    r.status,
      rideType:  r.rideType,
      fare:      r.finalFare?.finalFare || r.fareEstimate?.finalFare,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  getStats() {
    if (USE_PG) return pgRepo.getStats();

    const rides = [...this.rides.values()];
    const statuses = {};
    rides.forEach(r => { statuses[r.status] = (statuses[r.status] || 0) + 1; });

    const completed    = rides.filter(r => r.status === S.TRIP_COMPLETED);
    const totalRevenue = completed.reduce((sum, r) => sum + (r.finalFare?.finalFare || 0), 0);
    const avgMatchTime = completed.length > 0
      ? Math.round(completed.reduce((sum, r) => sum + (r.acceptedAt - r.createdAt), 0) / completed.length / 1000)
      : 0;

    return {
      totalRides:     rides.length,
      statuses,
      completedRides: completed.length,
      totalRevenue:   `₹${totalRevenue}`,
      avgMatchTimeSec: avgMatchTime,
    };
  }
}

module.exports = new RideService();
