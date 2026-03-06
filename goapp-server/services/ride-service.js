// GoApp Ride Service
// Ride lifecycle state machine, idempotency, cancellation

const crypto = require('crypto');
const config = require('../config');
const redis = require('./redis-mock');
const matchingEngine = require('./matching-engine');
const pricingService = require('./pricing-service');
const notificationService = require('./notification-service');
const { haversine } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');

const S = config.rideStatuses;

class RideService {
  constructor() {
    this.rides = new Map(); // rideId -> ride object
    this.cancellationCounts = new Map(); // `${type}:${userId}` -> { count, windowStart }
  }

  // ═══════════════════════════════════════════
  // CREATE RIDE REQUEST (with idempotency)
  // ═══════════════════════════════════════════
  async createRide({ riderId, pickupLat, pickupLng, destLat, destLng, rideType, idempotencyKey }) {
    // ─── Idempotency Check ───
    if (idempotencyKey) {
      const check = redis.checkIdempotency(idempotencyKey);
      if (check.isDuplicate) {
        logger.warn('RIDE', `Duplicate request detected (idempotency: ${idempotencyKey.substr(0, 8)})`);
        return { ...check.existingResult, duplicate: true };
      }
    }

    // ─── Create Ride ───
    const rideId = `RIDE-${crypto.randomUUID().substr(0, 8).toUpperCase()}`;
    const now = Date.now();

    // Get fare estimates
    const estimates = pricingService.getEstimates(pickupLat, pickupLng, destLat, destLng);
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

    this._updateStatus(rideId, S.TRIP_COMPLETED);

    // Update driver stats
    const driver = matchingEngine.getDriver(ride.driverId);
    if (driver) {
      driver.ridesCompleted = (driver.ridesCompleted || 0) + 1;
      driver.lastTripEndTime = Date.now();
      driver.status = 'online';
    }

    // Release lock
    redis.releaseLock(rideId);

    eventBus.publish('ride_completed', {
      rideId, driverId: ride.driverId, riderId: ride.riderId,
      fare: finalFare.finalFare, driverEarnings: finalFare.driverEarnings,
    });

    logger.divider(`RIDE COMPLETED: ${rideId}`);
    logger.success('RIDE', `Fare: ₹${finalFare.finalFare} | Driver: ₹${finalFare.driverEarnings} | Platform: ₹${finalFare.platformCommission}`);

    notificationService.notifyTripCompleted(ride.riderId, ride.driverId, {
      rideId,
      finalFare: finalFare.finalFare,
      driverEarnings: finalFare.driverEarnings,
    });

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

    return {
      success: true,
      rideId,
      cancelledBy,
      cancelFee,
      penalty,
    };
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
  _updateStatus(rideId, newStatus) {
    const ride = this.rides.get(rideId);
    if (!ride) return;
    ride.status = newStatus;
    ride.statusHistory.push({ status: newStatus, at: Date.now() });
    logger.info('RIDE', `Ride ${rideId}: ${ride.statusHistory[ride.statusHistory.length - 2]?.status || 'NEW'} → ${newStatus}`);
  }

  getRide(rideId) {
    return this.rides.get(rideId);
  }

  getAllRides() {
    return [...this.rides.values()].map(r => ({
      rideId: r.rideId,
      riderId: r.riderId,
      driverId: r.driverId,
      status: r.status,
      rideType: r.rideType,
      fare: r.finalFare?.finalFare || r.fareEstimate?.finalFare,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  getStats() {
    const rides = [...this.rides.values()];
    const statuses = {};
    rides.forEach(r => { statuses[r.status] = (statuses[r.status] || 0) + 1; });

    const completed = rides.filter(r => r.status === S.TRIP_COMPLETED);
    const totalRevenue = completed.reduce((sum, r) => sum + (r.finalFare?.finalFare || 0), 0);
    const avgMatchTime = completed.length > 0
      ? Math.round(completed.reduce((sum, r) => sum + (r.acceptedAt - r.createdAt), 0) / completed.length / 1000)
      : 0;

    return {
      totalRides: rides.length,
      statuses,
      completedRides: completed.length,
      totalRevenue: `₹${totalRevenue}`,
      avgMatchTimeSec: avgMatchTime,
    };
  }
}

module.exports = new RideService();
