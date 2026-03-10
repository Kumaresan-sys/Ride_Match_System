// GoApp Ride Service
// Ride lifecycle state machine, idempotency, cancellation
//
// Rides are persisted to PostgreSQL via pg-ride-repository.
// this.rides is a hot-cache Map for fast in-flight lookups — NOT a mock.

const crypto = require('crypto');
const config = require('../config');
const redis = require('./redis-client');
const matchingEngine = require('./matching-engine');
const pricingService = require('./pricing-service');
const notificationService = require('./notification-service');
const zoneMappingService = require('./zone-mapping-service');
const zoneMetricsService = require('./zone-metrics-service');
const { haversine } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');
const driverWalletService = require('./driver-wallet-service');
const rideSessionService  = require('./ride-session-service');
const pgRepo = require('../repositories/pg/pg-ride-repository');
const RedisStateStore = require('../infra/redis/state-store');
const KafkaProducer = require('../infra/kafka/producer');
const { TOPICS } = require('../infra/kafka/topics');

const S = config.rideStatuses;

class RideService {
  constructor() {
    this.rides              = new Map(); // rideId -> ride object (hot cache for active rides)
    this.cancellationCounts = new Map(); // `${type}:${userId}` -> { count, windowStart }
    this.redisStateV2       = Boolean(config.architecture?.featureFlags?.redisStateV2);
    this.stateStore         = new RedisStateStore(redis);
    this.kafkaProducer      = new KafkaProducer();
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
    const rideId   = `RIDE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const dbRideId = crypto.randomUUID();
    const now      = Date.now();

    // Get fare estimates (async: uses Google Maps road distance when configured)
    const estimates = await pricingService.getEstimates(pickupLat, pickupLng, destLat, destLng);
    const fareEstimate = estimates.estimates[rideType] || estimates.estimates.sedan;
    let zoneMatch = {
      pickupZoneId: null,
      pickupZoneCode: null,
      dropZoneId: null,
      dropZoneCode: null,
    };
    try {
      zoneMatch = await zoneMappingService.resolvePickupAndDrop(
        pickupLat,
        pickupLng,
        destLat,
        destLng,
      );
    } catch (err) {
      logger.warn('ZONE_MAP', `Zone assignment unavailable for ride request: ${err.message}`);
    }

    const ride = {
      rideId,
      dbRideId,
      riderId,
      driverId: null,
      pickupLat, pickupLng,
      destLat, destLng,
      pickupZoneId: zoneMatch.pickupZoneId,
      pickupZoneCode: zoneMatch.pickupZoneCode,
      dropZoneId: zoneMatch.dropZoneId,
      dropZoneCode: zoneMatch.dropZoneCode,
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

    const outboxEnabled = Boolean(config.architecture?.featureFlags?.kafkaOutbox);
    await pgRepo.createRide({
      rideId: dbRideId,
      rideNumber: rideId,
      riderId,
      rideType: rideType || 'sedan',
      pickupLat, pickupLng,
      destLat, destLng,
      pickupZoneId: zoneMatch.pickupZoneId,
      dropZoneId: zoneMatch.dropZoneId,
      fareEstimate: fareEstimate.finalFare,
      surgeMultiplier: estimates.surgeMultiplier,
      idempotencyKey,
      outboxEvent: outboxEnabled
        ? {
          topic: TOPICS.RIDE_REQUESTED,
          eventType: 'ride_requested',
          aggregateType: 'ride',
          aggregateId: rideId,
          partitionKey: rideId,
          payload: {
            rideId,
            riderId,
            pickupLat,
            pickupLng,
            destLat,
            destLng,
            rideType: ride.rideType,
            requestedAt: now,
          },
        }
        : null,
    });

    this.rides.set(rideId, ride);

    // Index active ride in Redis for fast recovery lookup (4-hour TTL)
    if (riderId) {
      if (this.redisStateV2) {
        await this.stateStore.setRiderActiveRide(riderId, rideId, 4 * 3600);
        await this.stateStore.setActiveRide(rideId, {
          rideId,
          riderId,
          status: ride.status,
          pickupLat,
          pickupLng,
          destLat,
          destLng,
          rideType: ride.rideType,
          createdAt: now,
        }, 4 * 3600);
      } else {
        await redis.set(`active_ride:${riderId}`, rideId, { EX: 4 * 3600 });
      }
    }

    // Track session for app-crash recovery
    await rideSessionService.onRideCreated(riderId, rideId);

    // Store idempotency
    if (idempotencyKey) {
      await redis.setIdempotency(idempotencyKey, { rideId, status: S.REQUESTED }, 300);
    }

    logger.success('RIDE', `Created ride ${rideId} for rider ${riderId}`, {
      type: rideType, fare: `₹${fareEstimate.finalFare}`, surge: estimates.surgeMultiplier,
    });

    eventBus.publish('ride_requested', {
      rideId, riderId, rideType, pickupLat, pickupLng, destLat, destLng,
      pickupZoneId: ride.pickupZoneId,
      dropZoneId: ride.dropZoneId,
      fareEstimate: fareEstimate.finalFare,
    });
    zoneMetricsService.recordRequested({
      zoneId: ride.pickupZoneId,
      riderId: ride.riderId,
      eventTime: new Date(now).toISOString(),
    }).catch((err) => logger.warn('ZONE_METRICS', `recordRequested failed: ${err.message}`));

    // ─── Strict async matching ownership cutover ───
    if (!outboxEnabled) {
      await this.kafkaProducer.publish(TOPICS.RIDE_REQUESTED, {
        rideId,
        riderId,
        pickupLat,
        pickupLng,
        destLat,
        destLng,
        rideType: ride.rideType,
        requestedAt: now,
      }, rideId);
    }

    return {
      rideId,
      pickupZoneId: ride.pickupZoneId,
      dropZoneId: ride.dropZoneId,
      status: S.REQUESTED,
      queuedForMatching: true,
      fareEstimate: fareEstimate.finalFare,
    };
  }

  async processRideRequestedEvent(event = {}) {
    const rideId = event.rideId;
    if (!rideId) return { success: false, reason: 'MISSING_RIDE_ID' };

    let ride = this.rides.get(rideId);
    if (!ride) {
      const fromDb = await pgRepo.getRide(rideId);
      if (!fromDb) return { success: false, reason: 'RIDE_NOT_FOUND' };
      ride = {
        ...fromDb,
        rideId: fromDb.rideId || rideId,
        statusHistory: [],
      };
      this.rides.set(rideId, ride);
    }

    if ([S.MATCHING, S.ACCEPTED, S.DRIVER_ARRIVING, S.TRIP_STARTED, S.TRIP_COMPLETED].includes(ride.status)) {
      return { success: true, duplicate: true, rideId };
    }

    this._updateStatus(rideId, S.MATCHING);
    notificationService.notifyRideRequested(ride.riderId, rideId);
    const matchResult = await matchingEngine.startMatching(ride);

    if (matchResult.success) {
      ride.driverId = matchResult.driverId;
      ride.acceptedAt = Date.now();
      ride.matchResult = matchResult;
      this._updateStatus(rideId, S.ACCEPTED);
      this._updateStatus(rideId, S.DRIVER_ARRIVING);
      eventBus.publish('ride_matched', {
        rideId,
        riderId: ride.riderId,
        driverId: matchResult.driverId,
        etaMin: matchResult.etaMin,
      });
      notificationService.notifyRideMatched(ride.riderId, matchResult.driverId, {
        rideId,
        driverName: matchResult.driverName,
        vehicleType: matchResult.vehicleType,
        vehicleNumber: matchResult.vehicleNumber,
        etaMin: matchResult.etaMin,
        score: matchResult.score,
      });
      if (!config.architecture?.featureFlags?.kafkaOutbox) {
        await this.kafkaProducer.publish(TOPICS.RIDE_MATCHED, {
          rideId,
          riderId: ride.riderId,
          driverId: matchResult.driverId,
          etaMin: matchResult.etaMin,
        }, rideId);
      }
      return { success: true, rideId, driverId: matchResult.driverId };
    }

    this._updateStatus(rideId, S.NO_DRIVERS);
    notificationService.notifyNoDrivers(ride.riderId, rideId);
    return { success: false, rideId, reason: matchResult.reason || 'NO_DRIVERS' };
  }

  // ═══════════════════════════════════════════
  // RIDE STATE TRANSITIONS
  // ═══════════════════════════════════════════
  async driverArrived(rideId) {
    const ride = this.rides.get(rideId);
    if (!ride || ride.status !== S.DRIVER_ARRIVING) return null;

    this._updateStatus(rideId, S.DRIVER_ARRIVED);
    eventBus.publish('driver_arrived', { rideId, driverId: ride.driverId, riderId: ride.riderId });
    logger.success('RIDE', `Driver arrived at pickup for ride ${rideId}`);

    const arrivedDriver = await matchingEngine.getDriver(ride.driverId);
    notificationService.notifyDriverArrived(ride.riderId, arrivedDriver?.name || 'Your driver', rideId);

    return ride;
  }

  async startTrip(rideId) {
    const ride = this.rides.get(rideId);
    if (!ride || ride.status !== S.DRIVER_ARRIVED) return null;

    ride.startedAt = Date.now();
    this._updateStatus(rideId, S.TRIP_STARTED);
    eventBus.publish('ride_started', { rideId, driverId: ride.driverId, riderId: ride.riderId });
    logger.success('RIDE', `Trip started for ride ${rideId}`);

    notificationService.notifyTripStarted(ride.riderId, rideId);

    return ride;
  }

  async completeTrip(rideId, actualDistanceKm, actualDurationMin) {
    const ride = this.rides.get(rideId);
    if (!ride || ride.status !== S.TRIP_STARTED) return null;

    ride.completedAt = Date.now();

    // Calculate final fare with actual distance/duration
    const finalFare = await pricingService.calculateFare(
      ride.rideType,
      actualDistanceKm || ride.fareEstimate.distanceKm,
      actualDurationMin || ride.fareEstimate.durationMin,
      ride.surgeMultiplier
    );
    ride.finalFare = finalFare;

    this._updateStatus(rideId, S.TRIP_COMPLETED, {
      completedAt:     ride.completedAt,
      finalFare:       finalFare.finalFare,
      actualDistanceM: actualDistanceKm ? Math.round(actualDistanceKm * 1000) : null,
      actualDurationS: actualDurationMin ? Math.round(actualDurationMin * 60) : null,
    });

    // Update driver stats
    const driver = await matchingEngine.getDriver(ride.driverId);
    if (driver) {
      driver.ridesCompleted = (driver.ridesCompleted || 0) + 1;
      driver.lastTripEndTime = Date.now();
      driver.status = 'online';
    }

    // Release lock and clear active-ride index
    if (this.redisStateV2) {
      await this.stateStore.releaseRideAssignLock(rideId, ride.matchResult?.lockToken || ride.driverId || null);
      if (ride.riderId) await this.stateStore.clearRiderActiveRide(ride.riderId);
      await this.stateStore.setActiveRide(rideId, {
        rideId,
        riderId: ride.riderId,
        driverId: ride.driverId,
        status: S.TRIP_COMPLETED,
        completedAt: ride.completedAt,
      }, 3600);
    } else {
      await redis.releaseLock(rideId);
      if (ride.riderId) await redis.del(`active_ride:${ride.riderId}`);
    }

    eventBus.publish('ride_completed', {
      rideId, driverId: ride.driverId, riderId: ride.riderId,
      pickupZoneId: ride.pickupZoneId,
      dropZoneId: ride.dropZoneId,
      fare: finalFare.finalFare, driverEarnings: finalFare.driverEarnings,
    });
    const waitSec = ride.acceptedAt
      ? Math.max(0, Math.round((ride.acceptedAt - ride.createdAt) / 1000))
      : null;
    const tripSec = ride.startedAt
      ? Math.max(0, Math.round((ride.completedAt - ride.startedAt) / 1000))
      : null;
    zoneMetricsService.recordCompleted({
      zoneId: ride.pickupZoneId,
      riderId: ride.riderId,
      eventTime: new Date(ride.completedAt).toISOString(),
      fareInr: finalFare.finalFare,
      waitSec,
      tripSec,
    }).catch((err) => logger.warn('ZONE_METRICS', `recordCompleted failed: ${err.message}`));

    logger.divider(`RIDE COMPLETED: ${rideId}`);
    logger.success('RIDE', `Fare: ₹${finalFare.finalFare} | Driver: ₹${finalFare.driverEarnings} | Platform: ₹${finalFare.platformCommission}`);

    // Credit driver earnings and deduct platform commission
    if (ride.driverId) {
      const platformFee    = Math.round(finalFare.platformCommission * 100) / 100;
      const driverEarnings = Math.round(finalFare.driverEarnings * 100) / 100;
      await driverWalletService.settleRidePayout(ride.driverId, {
        platformFee,
        earnings: driverEarnings,
        rideId,
      });
    }
    await rideSessionService.onRideEnded(ride.riderId);

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
  // CANCELLATION
  // ═══════════════════════════════════════════
  async cancelRide(rideId, cancelledBy, userId) {
    const ride = this.rides.get(rideId);
    if (!ride) return { success: false, reason: 'Ride not found' };

    const now = Date.now();
    let cancelFee = 0;
    let penalty = null;

    if (cancelledBy === 'rider') {
      if (ride.status === S.MATCHING || ride.status === S.BROADCAST) {
        // Cancel during matching - no penalty
        await matchingEngine.cancelMatching(rideId);
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
        const driver = await matchingEngine.getDriver(ride.driverId);
        if (driver) driver.status = 'online';
        if (this.redisStateV2) await this.stateStore.releaseRideAssignLock(rideId, ride.matchResult?.lockToken || ride.driverId || null);
        else await redis.releaseLock(rideId);

        this._updateStatus(rideId, S.CANCELLED_BY_RIDER);
        eventBus.publish('ride_cancelled_by_rider', {
          rideId, phase: 'after_accept', cancelFee, driverId: ride.driverId,
        });

        // Notify the driver that the rider cancelled
        notificationService.notifyCancelledByRider(ride.driverId, rideId, cancelFee);
      }

      // Track rider cancellations
      penalty = await this._trackCancellation('rider', userId);

    } else if (cancelledBy === 'driver') {
      // Driver cancels after accepting
      const lastStage = ride.matchResult?.stage || 1;
      const cancelledDriverId = ride.driverId;

      // Exclude this driver from re-matching
      await matchingEngine.excludeDriver(rideId, cancelledDriverId);

      // Free the driver
      const driver = await matchingEngine.getDriver(cancelledDriverId);
      if (driver) driver.status = 'online';
      if (this.redisStateV2) await this.stateStore.releaseRideAssignLock(rideId, ride.matchResult?.lockToken || ride.driverId || null);
      else await redis.releaseLock(rideId);

      this._updateStatus(rideId, S.CANCELLED_BY_DRIVER);
      eventBus.publish('ride_cancelled_by_driver', { rideId, driverId: cancelledDriverId });

      // Track driver cancellations
      penalty = await this._trackCancellation('driver', userId);

      logger.warn('RIDE', `Driver cancelled ride ${rideId} - resuming matching from stage ${lastStage}`);

      // Notify rider that driver cancelled and we are finding a new one
      notificationService.notifyCancelledByDriver(ride.riderId, rideId);

      // Resume matching asynchronously so the rider isn't left stranded
      ride.driverId = null;
      this._updateStatus(rideId, S.MATCHING);
      matchingEngine.resumeMatching(ride, lastStage).then(matchResult => {
        if (matchResult.success) {
          ride.driverId  = matchResult.driverId;
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
          zoneMetricsService.recordNoDriver({
            zoneId: ride.pickupZoneId,
            riderId: ride.riderId,
            eventTime: new Date().toISOString(),
          }).catch((err) => logger.warn('ZONE_METRICS', `recordNoDriver failed: ${err.message}`));
          notificationService.notifyNoDrivers(ride.riderId, rideId);
        }
      }).catch(err => {
        logger.error('RIDE', `Re-matching failed for ride ${rideId}: ${err.message}`);
        this._updateStatus(rideId, S.NO_DRIVERS);
        zoneMetricsService.recordNoDriver({
          zoneId: ride.pickupZoneId,
          riderId: ride.riderId,
          eventTime: new Date().toISOString(),
        }).catch((e) => logger.warn('ZONE_METRICS', `recordNoDriver failed: ${e.message}`));
        notificationService.notifyNoDrivers(ride.riderId, rideId);
      });
    }

    ride.cancelledAt = now;
    ride.cancelledBy = cancelledBy;
    zoneMetricsService.recordCancelled({
      zoneId: ride.pickupZoneId,
      riderId: ride.riderId,
      eventTime: new Date(now).toISOString(),
    }).catch((err) => logger.warn('ZONE_METRICS', `recordCancelled failed: ${err.message}`));
    if (ride.riderId) {
      if (this.redisStateV2) await this.stateStore.clearRiderActiveRide(ride.riderId);
      else await redis.del(`active_ride:${ride.riderId}`);
    }
    if (this.redisStateV2) {
      await this.stateStore.setActiveRide(rideId, {
        rideId,
        riderId: ride.riderId,
        driverId: ride.driverId,
        status: ride.status,
        cancelledAt: ride.cancelledAt,
        cancelledBy,
      }, 3600);
    }
    await rideSessionService.onRideEnded(ride.riderId);

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
  async _trackCancellation(type, userId) {
    if (this.redisStateV2) {
      const ttlSec = type === 'driver' ? 24 * 3600 : 3600;
      const count = await this.stateStore.incrementCancelCount(type, userId, ttlSec);
      const thresholds = type === 'driver'
        ? config.cancellation.driver.window24h
        : config.cancellation.rider.window1h;

      if (count > (thresholds.threshold5 || 5)) {
        return {
          level: 'severe',
          action: type === 'driver' ? '60-min queue timeout + warning' : '30-min request block',
          count,
        };
      }
      if (count > (thresholds.threshold3 || 3)) {
        return {
          level: 'moderate',
          action: type === 'driver' ? '15-min queue timeout' : 'Cancellation fee',
          count,
        };
      }
      return null;
    }

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
    pgRepo.updateStatus(rideId, newStatus, pgExtra)
      .catch(err => logger.warn('RIDE', `pg updateStatus failed (non-fatal): ${err.message}`));

    if (this.redisStateV2 && ride.riderId) {
      this.stateStore.setActiveRide(rideId, {
        rideId,
        riderId: ride.riderId,
        driverId: ride.driverId,
        status: newStatus,
        updatedAt: Date.now(),
      }, 4 * 3600).catch((err) => logger.warn('RIDE', `REDIS_STATE_V2 setActiveRide failed: ${err.message}`));
    }
  }

  // ─── Active ride lookup by riderId (for app session recovery) ───
  async getActiveRideAsync(riderId) {
    const activeStatuses = new Set([
      'MATCHING', 'BROADCAST', 'ACCEPTED',
      'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'TRIP_STARTED',
    ]);

    if (this.redisStateV2) {
      const rideId = await this.stateStore.getRiderActiveRide(riderId);
      if (rideId) {
        const hot = this.rides.get(rideId);
        if (hot && activeStatuses.has(hot.status)) return hot;

        const [activeSnapshot, fromDb] = await Promise.all([
          this.stateStore.getActiveRide(rideId).catch(() => null),
          pgRepo.getRide(rideId).catch(() => null),
        ]);

        const hydrated = fromDb || activeSnapshot;
        if (hydrated && activeStatuses.has(String(hydrated.status || '').toUpperCase())) {
          this.rides.set(rideId, {
            ...hydrated,
            rideId,
            riderId: hydrated.riderId || riderId,
            statusHistory: hydrated.statusHistory || [],
            createdAt: hydrated.createdAt || Date.now(),
          });
          return this.rides.get(rideId);
        }
      }
    } else {
      const cachedId = await redis.get(`active_ride:${riderId}`);
      if (cachedId) {
        const r = this.rides.get(cachedId);
        if (r && activeStatuses.has(r.status)) return r;
      }
    }

    for (const ride of this.rides.values()) {
      if (ride.riderId === riderId && activeStatuses.has(ride.status)) return ride;
    }
    return null;
  }

  getActiveRide(riderId) {
    const activeStatuses = new Set([
      'MATCHING', 'BROADCAST', 'ACCEPTED',
      'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'TRIP_STARTED',
    ]);
    // Hot-cache scan remains synchronous path for recovery endpoints.
    for (const ride of this.rides.values()) {
      if (ride.riderId === riderId && activeStatuses.has(ride.status)) return ride;
    }
    return null;
  }

  getRide(rideId) {
    return this.rides.get(rideId) || null;
  }

  async getRideAsync(rideId) {
    const hot = this.getRide(rideId);
    if (hot) return hot;
    return pgRepo.getRide(rideId);
  }

  getAllRides() {
    return pgRepo.getAllRides();
  }

  getRidesPage(options = {}) {
    return pgRepo.getRidesPage(options);
  }

  getStats() {
    return pgRepo.getStats();
  }
}

module.exports = new RideService();
