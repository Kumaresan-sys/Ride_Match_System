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
const rideCancellationReasonService = require('./ride-cancellation-reason-service');
const { haversine } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');
const driverWalletService = require('./driver-wallet-service');
const rideSessionService  = require('./ride-session-service');
const pgRepo = require('../repositories/pg/pg-ride-repository');
const domainProjectionService = require('./domain-projection-service');
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

  _isDevelopmentAutoAcceptEnabled() {
    return String(process.env.NODE_ENV || 'development').trim() === 'development'
      && Boolean(config.development?.devAutoAcceptMatches);
  }

  _scheduleDevelopmentMatchingFallback(rideId) {
    if (!this._isDevelopmentAutoAcceptEnabled() || !rideId) return;

    setTimeout(async () => {
      try {
        const currentHotRide = this.rides.get(rideId);
        const currentDbRide = await pgRepo.getRide(rideId).catch(() => null);
        const effectiveStatus = String(
          currentHotRide?.status ||
          currentDbRide?.status ||
          ''
        ).trim().toUpperCase();

        if ([S.ACCEPTED, S.DRIVER_ARRIVING, S.DRIVER_ARRIVED, S.TRIP_STARTED, S.TRIP_COMPLETED].includes(effectiveStatus)) {
          return;
        }

        if (effectiveStatus === S.CANCELLED || effectiveStatus === S.NO_DRIVERS) {
          return;
        }

        const result = await this.processRideRequestedEvent({ rideId });
        logger.info('RIDE', `Development matching fallback processed ${rideId}`, {
          rideId,
          success: Boolean(result?.success),
          reason: result?.reason || null,
          driverId: result?.driverId || null,
        });
      } catch (err) {
        logger.warn('RIDE', `Development matching fallback failed for ${rideId}: ${err.message}`);
      }
    }, 1200);
  }

  // ═══════════════════════════════════════════
  // CREATE RIDE REQUEST (with idempotency)
  // ═══════════════════════════════════════════
  async createRide({
    riderId,
    pickupLat,
    pickupLng,
    destLat,
    destLng,
    pickupAddress = null,
    destAddress = null,
    rideType,
    idempotencyKey,
  }) {
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
      pickupAddress: pickupAddress || null,
      destAddress: destAddress || null,
      pickupZoneId: zoneMatch.pickupZoneId,
      pickupZoneCode: zoneMatch.pickupZoneCode,
      dropZoneId: zoneMatch.dropZoneId,
      dropZoneCode: zoneMatch.dropZoneCode,
      rideType: rideType || 'sedan',
      estimatedDistanceM: Math.round((fareEstimate.distanceKm || 0) * 1000),
      estimatedDurationS: Math.round((fareEstimate.durationMin || 0) * 60),
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
      otp: null,
    };

    const outboxEnabled = Boolean(config.architecture?.featureFlags?.kafkaOutbox);
    const rideWritePayload = {
      rideId: dbRideId,
      rideNumber: rideId,
      riderId,
      rideType: rideType || 'sedan',
      pickupLat, pickupLng,
      destLat, destLng,
      pickupAddress: pickupAddress || null,
      destAddress: destAddress || null,
      estimatedDistanceM: Math.round((fareEstimate.distanceKm || 0) * 1000),
      estimatedDurationS: Math.round((fareEstimate.durationMin || 0) * 60),
      fareEstimateDetails: fareEstimate,
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
            pickupAddress: pickupAddress || null,
            destAddress: destAddress || null,
            rideType: ride.rideType,
            estimatedDistanceM: Math.round((fareEstimate.distanceKm || 0) * 1000),
            estimatedDurationS: Math.round((fareEstimate.durationMin || 0) * 60),
            baseFare: fareEstimate.breakdown?.baseFare ?? null,
            distanceCharge: fareEstimate.breakdown?.distanceCharge ?? null,
            timeCharge: fareEstimate.breakdown?.timeCharge ?? null,
            subtotal: fareEstimate.breakdown?.subtotal ?? null,
            serviceCost: fareEstimate.breakdown?.serviceCost ?? fareEstimate.serviceCost ?? null,
            gstPct: fareEstimate.breakdown?.gstPct ?? fareEstimate.gstPct ?? null,
            gstAmount: fareEstimate.breakdown?.gstAmount ?? fareEstimate.gstAmount ?? null,
            commissionPct:
              fareEstimate.breakdown?.commissionPct ?? fareEstimate.commissionPct ?? null,
            surgeMultiplier:
              fareEstimate.breakdown?.surgeMultiplier ?? estimates.surgeMultiplier,
            platformCommission: fareEstimate.platformCommission ?? null,
            requestedAt: now,
          },
        }
        : null,
    };

    try {
      await pgRepo.createRide(rideWritePayload);
    } catch (err) {
      const missingProjection = /Rider projection not found/i.test(String(err?.message || ''));
      if (!missingProjection) throw err;

      logger.warn('RIDE', `Rider projection missing for user ${riderId}; attempting on-demand sync.`);
      const syncResult = await domainProjectionService.syncRiderByUserId(riderId).catch((syncErr) => {
        logger.warn('RIDE', `Rider projection sync failed for user ${riderId}: ${syncErr.message}`);
        return null;
      });
      if (!syncResult?.synced) {
        throw err;
      }
      await pgRepo.createRide(rideWritePayload);
    }

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
          pickupAddress: pickupAddress || null,
          destAddress: destAddress || null,
          rideType: ride.rideType,
          estimatedDistanceM: Math.round((fareEstimate.distanceKm || 0) * 1000),
          estimatedDurationS: Math.round((fareEstimate.durationMin || 0) * 60),
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
        pickupAddress: pickupAddress || null,
        destAddress: destAddress || null,
        rideType: ride.rideType,
        estimatedDistanceM: Math.round((fareEstimate.distanceKm || 0) * 1000),
        estimatedDurationS: Math.round((fareEstimate.durationMin || 0) * 60),
        baseFare: fareEstimate.breakdown?.baseFare ?? null,
        distanceCharge: fareEstimate.breakdown?.distanceCharge ?? null,
        timeCharge: fareEstimate.breakdown?.timeCharge ?? null,
        subtotal: fareEstimate.breakdown?.subtotal ?? null,
        serviceCost: fareEstimate.breakdown?.serviceCost ?? fareEstimate.serviceCost ?? null,
        gstPct: fareEstimate.breakdown?.gstPct ?? fareEstimate.gstPct ?? null,
        gstAmount: fareEstimate.breakdown?.gstAmount ?? fareEstimate.gstAmount ?? null,
        commissionPct:
          fareEstimate.breakdown?.commissionPct ?? fareEstimate.commissionPct ?? null,
        surgeMultiplier:
          fareEstimate.breakdown?.surgeMultiplier ?? estimates.surgeMultiplier,
        platformCommission: fareEstimate.platformCommission ?? null,
        requestedAt: now,
      }, rideId);
    }

    this._scheduleDevelopmentMatchingFallback(rideId);

    return {
      rideId,
      pickupZoneId: ride.pickupZoneId,
      dropZoneId: ride.dropZoneId,
      status: S.REQUESTED,
      queuedForMatching: true,
      fareEstimate: fareEstimate.finalFare,
    };
  }

  _generateRideOtp() {
    return String(crypto.randomInt(1000, 10000)).padStart(4, '0');
  }

  async _hydrateAssignedDriverDetails(ride, matchResult = {}) {
    if (!ride || !matchResult?.driverId) return null;
    const driverProfile = await matchingEngine.getDriver(matchResult.driverId).catch(() => null);
    const rating = Number(driverProfile?.rating);

    ride.driverName =
      matchResult.driverName ||
      driverProfile?.name ||
      ride.driverName ||
      null;
    ride.driverPhone =
      driverProfile?.phoneNumber ||
      driverProfile?.phone ||
      ride.driverPhone ||
      null;
    ride.driverVehicleType =
      matchResult.vehicleType ||
      driverProfile?.vehicleType ||
      ride.driverVehicleType ||
      null;
    ride.driverVehicleNumber =
      matchResult.vehicleNumber ||
      driverProfile?.vehicleNumber ||
      ride.driverVehicleNumber ||
      null;
    ride.driverRating = Number.isFinite(rating) ? rating : (ride.driverRating ?? null);
    ride.driverAvatarUrl =
      matchResult.avatarUrl ||
      driverProfile?.avatarUrl ||
      ride.driverAvatarUrl ||
      null;
    ride.driverCompletedRides =
      Number.isFinite(Number(matchResult.completedRides))
        ? Number(matchResult.completedRides)
        : (Number.isFinite(Number(driverProfile?.completedRides))
          ? Number(driverProfile.completedRides)
          : (ride.driverCompletedRides ?? null));

    ride.matchResult = {
      ...matchResult,
      driverName: ride.driverName || matchResult.driverName || null,
      driverPhone: ride.driverPhone || matchResult.driverPhone || null,
      vehicleType: ride.driverVehicleType || matchResult.vehicleType || null,
      vehicleNumber: ride.driverVehicleNumber || matchResult.vehicleNumber || null,
      driverRating: ride.driverRating ?? null,
      avatarUrl: ride.driverAvatarUrl || matchResult.avatarUrl || null,
      completedRides: ride.driverCompletedRides ?? matchResult.completedRides ?? null,
    };

    return driverProfile;
  }

  async _issueRideOtp(ride) {
    if (!ride?.rideId) return null;
    const otp = this._generateRideOtp();
    try {
      const persisted = await pgRepo.upsertRideOtp(
        ride.dbRideId || ride.rideId,
        otp,
        { expiresAt: new Date(Date.now() + 30 * 60 * 1000) }
      );
      ride.otp = persisted?.otp || otp;
      return ride.otp;
    } catch (err) {
      logger.warn('RIDE', `Failed to issue ride OTP for ${ride.rideId}: ${err.message}`);
      ride.otp = otp;
      return otp;
    }
  }

  async processRideRequestedEvent(event = {}) {
    const normalizedEvent = (event && typeof event.payload === 'object' && !event.rideId)
      ? { ...event, ...event.payload }
      : event;
    const rideId = normalizedEvent.rideId || normalizedEvent.aggregateId || null;
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
      const driverDbId = await pgRepo.resolveDriverDbId(matchResult.driverId).catch(() => null);
      ride.driverId = matchResult.driverId;
      ride.acceptedAt = Date.now();
      await this._hydrateAssignedDriverDetails(ride, matchResult);
      await this._issueRideOtp(ride);
      this._updateStatus(rideId, S.ACCEPTED, { driverDbId, acceptedAt: ride.acceptedAt });
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

    await this._finalizeNoDrivers(rideId, {
      reasonCode: 'NO_DRIVERS_IN_ZONE',
    });
    notificationService.notifyNoDrivers(ride.riderId, rideId);
    return { success: false, rideId, reason: matchResult.reason || 'NO_DRIVERS' };
  }

  // ═══════════════════════════════════════════
  // RIDE STATE TRANSITIONS
  // ═══════════════════════════════════════════
  async driverArrived(rideId) {
    const ride = this.rides.get(rideId);
    if (!ride || ride.status !== S.DRIVER_ARRIVING) return null;

    ride.arrivedAt = Date.now();
    this._updateStatus(rideId, S.DRIVER_ARRIVED, { arrivedAt: ride.arrivedAt });
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
  async cancelRide(rideId, cancelledBy, userId, options = {}) {
    const ride = this.rides.get(rideId);
    if (!ride) return { success: false, reason: 'Ride not found' };

    const now = Date.now();
    let cancelFee = 0;
    let penalty = null;
    let terminalCancellation = null;
    const requestedReasonCode = String(options?.reasonCode || '').trim() || null;
    const requestedReasonText = String(options?.reasonText || '').trim() || null;

    if (cancelledBy === 'rider') {
      if (ride.status === S.MATCHING || ride.status === S.BROADCAST) {
        const resolvedReason = await rideCancellationReasonService.resolveReason({
          actorType: 'rider',
          reasonCode: requestedReasonCode,
          note: requestedReasonText,
          fallbackCode: 'CHANGE_OF_PLANS',
        });

        // Cancel during matching - no penalty
        await matchingEngine.cancelMatching(rideId);
        this._updateStatus(rideId, S.CANCELLED_BY_RIDER, { skipPg: true });
        eventBus.publish('ride_cancelled_by_rider', { rideId, phase: 'during_matching' });
        terminalCancellation = {
          cancelledBy: 'rider',
          cancellerId: userId,
          reasonCatalogId: resolvedReason.id,
          reasonCode: resolvedReason.code,
          reasonText: resolvedReason.reasonText,
          cancellationFee: 0,
          isFeeWaived: true,
          waiverReason: 'cancelled_during_matching',
          timeSinceRequest: Math.max(0, Math.round((now - (ride.createdAt || now)) / 1000)),
          cancelledAt: now,
        };

      } else if (ride.status === S.ACCEPTED || ride.status === S.DRIVER_ARRIVING) {
        const resolvedReason = await rideCancellationReasonService.resolveReason({
          actorType: 'rider',
          reasonCode: requestedReasonCode,
          note: requestedReasonText,
          fallbackCode: 'CHANGE_OF_PLANS',
        });

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

        this._updateStatus(rideId, S.CANCELLED_BY_RIDER, { skipPg: true });
        eventBus.publish('ride_cancelled_by_rider', {
          rideId, phase: 'after_accept', cancelFee, driverId: ride.driverId,
        });
        terminalCancellation = {
          cancelledBy: 'rider',
          cancellerId: userId,
          reasonCatalogId: resolvedReason.id,
          reasonCode: resolvedReason.code,
          reasonText: resolvedReason.reasonText,
          cancellationFee: cancelFee,
          isFeeWaived: cancelFee <= 0,
          waiverReason: cancelFee <= 0 ? 'grace_period' : null,
          timeSinceRequest: Math.max(0, Math.round((now - (ride.createdAt || now)) / 1000)),
          timeSinceAccept: Math.max(0, Math.round(timeSinceAccept)),
          cancelledAt: now,
        };

        // Notify the driver that the rider cancelled
        notificationService.notifyCancelledByRider(ride.driverId, rideId, cancelFee);
      }

      // Track rider cancellations
      penalty = await this._trackCancellation('rider', userId);

    } else if (cancelledBy === 'driver') {
      const resolvedReason = await rideCancellationReasonService.resolveReason({
        actorType: 'driver',
        reasonCode: requestedReasonCode,
        note: requestedReasonText,
        fallbackCode: 'DRIVER_OTHER',
      });

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

      this._updateStatus(rideId, S.CANCELLED_BY_DRIVER, { skipPg: true });
      eventBus.publish('ride_cancelled_by_driver', { rideId, driverId: cancelledDriverId });
      await this._persistCancellationRecord(rideId, {
        cancelledBy: 'driver',
        cancellerId: userId || cancelledDriverId || null,
        reasonCatalogId: resolvedReason.id,
        reasonCode: resolvedReason.code,
        reasonText: resolvedReason.reasonText,
        cancellationFee: 0,
        isFeeWaived: true,
        waiverReason: 'driver_cancelled',
        timeSinceRequest: Math.max(0, Math.round((now - (ride.createdAt || now)) / 1000)),
        timeSinceAccept: ride.acceptedAt
          ? Math.max(0, Math.round((now - ride.acceptedAt) / 1000))
          : null,
        cancelledAt: now,
      }, {
        status: S.CANCELLED_BY_DRIVER,
        eventType: 'ride_cancelled_by_driver',
        actorType: 'driver',
        actorId: userId || cancelledDriverId || null,
        setCancelledAt: false,
      });

      // Track driver cancellations
      penalty = await this._trackCancellation('driver', userId);

      logger.warn('RIDE', `Driver cancelled ride ${rideId} - resuming matching from stage ${lastStage}`);

      // Notify rider that driver cancelled and we are finding a new one
      notificationService.notifyCancelledByDriver(ride.riderId, rideId);

      // Resume matching asynchronously so the rider isn't left stranded
      ride.driverId = null;
      this._updateStatus(rideId, S.MATCHING);
      matchingEngine.resumeMatching(ride, lastStage).then(async (matchResult) => {
        if (matchResult.success) {
          const driverDbId = await pgRepo.resolveDriverDbId(matchResult.driverId).catch(() => null);
          ride.driverId  = matchResult.driverId;
          ride.acceptedAt = Date.now();
          await this._hydrateAssignedDriverDetails(ride, matchResult);
          await this._issueRideOtp(ride);
          ride.cancelledAt = null;
          ride.cancelledBy = null;
          ride.cancellationReasonCode = null;
          ride.cancellationReasonText = null;
          this._updateStatus(rideId, S.ACCEPTED, { driverDbId, acceptedAt: ride.acceptedAt });
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
          this._finalizeNoDrivers(rideId, {
            reasonCode: 'NO_DRIVERS_IN_ZONE',
          }).catch((err) => logger.warn('RIDE', `finalizeNoDrivers failed: ${err.message}`));
          notificationService.notifyNoDrivers(ride.riderId, rideId);
        }
      }).catch(err => {
        logger.error('RIDE', `Re-matching failed for ride ${rideId}: ${err.message}`);
        this._finalizeNoDrivers(rideId, {
          reasonCode: 'NO_DRIVERS_IN_ZONE',
        }).catch((e) => logger.warn('RIDE', `finalizeNoDrivers failed: ${e.message}`));
        notificationService.notifyNoDrivers(ride.riderId, rideId);
      });
    }

    if (terminalCancellation) {
      ride.cancelledAt = now;
      ride.cancelledBy = terminalCancellation.cancelledBy;
      ride.reasonCatalogId = terminalCancellation.reasonCatalogId || null;
      ride.cancellationReasonCode = terminalCancellation.reasonCode;
      ride.cancellationReasonText = terminalCancellation.reasonText;
      await this._persistCancellationRecord(rideId, terminalCancellation, {
        status: ride.status,
        eventType: 'ride_cancelled',
        actorType: terminalCancellation.cancelledBy,
        actorId: terminalCancellation.cancellerId || null,
        setCancelledAt: true,
      });
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
          cancelledBy: ride.cancelledBy,
          cancellationReasonCode: ride.cancellationReasonCode,
          cancellationReasonText: ride.cancellationReasonText,
        }, 3600);
      }
      await rideSessionService.onRideEnded(ride.riderId);
    }

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

  _buildNoDriversReasonText(ride) {
    const zone = String(
      ride?.pickupZoneName ||
      ride?.pickupZoneCode ||
      ride?.pickupZoneId ||
      ''
    ).trim();
    return zone
      ? `No drivers found in pickup zone ${zone}.`
      : 'No drivers found in your pickup zone.';
  }

  async _persistCancellationRecord(rideId, details, options = {}) {
    try {
      if (options.status || options.eventType) {
        await pgRepo.recordCancellation(rideId, details, options);
        return;
      }
      await pgRepo.insertRideCancellation(rideId, details);
    } catch (err) {
      logger.warn('RIDE', `pg insertRideCancellation failed (non-fatal): ${err.message}`);
    }
  }

  async _finalizeNoDrivers(rideId, options = {}) {
    const ride = this.rides.get(rideId);
    if (!ride) return;

    const now = Date.now();
    const reasonCode = String(options.reasonCode || '').trim() || 'NO_DRIVERS_IN_ZONE';
    const fallbackReasonText =
      String(options.reasonText || '').trim() || this._buildNoDriversReasonText(ride);
    const resolvedReason = await rideCancellationReasonService.resolveReason({
      actorType: 'system',
      reasonCode,
      displayText: fallbackReasonText,
      fallbackCode: 'NO_DRIVERS_IN_ZONE',
    });

    ride.cancelledAt = now;
    ride.cancelledBy = 'system';
    ride.reasonCatalogId = resolvedReason.id;
    ride.cancellationReasonCode = resolvedReason.code;
    ride.cancellationReasonText = resolvedReason.reasonText;

    this._updateStatus(rideId, S.NO_DRIVERS, { cancelledAt: now, skipPg: true });
    await this._persistCancellationRecord(rideId, {
      cancelledBy: 'system',
      cancellerId: null,
      reasonCatalogId: resolvedReason.id,
      reasonCode: resolvedReason.code,
      reasonText: resolvedReason.reasonText,
      cancellationFee: 0,
      isFeeWaived: true,
      waiverReason: 'no_driver_available',
      timeSinceRequest: Math.max(0, Math.round((now - (ride.createdAt || now)) / 1000)),
      cancelledAt: now,
    }, {
      status: S.NO_DRIVERS,
      eventType: 'ride_cancelled_system',
      actorType: 'system',
      actorId: null,
      setCancelledAt: true,
    });

    zoneMetricsService.recordNoDriver({
      zoneId: ride.pickupZoneId,
      riderId: ride.riderId,
      eventTime: new Date(now).toISOString(),
    }).catch((err) => logger.warn('ZONE_METRICS', `recordNoDriver failed: ${err.message}`));

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
        cancelledBy: ride.cancelledBy,
        cancellationReasonCode: ride.cancellationReasonCode,
        cancellationReasonText: ride.cancellationReasonText,
      }, 3600);
    }

    eventBus.publish('ride_no_drivers', { rideId, riderId: ride.riderId });
    await rideSessionService.onRideEnded(ride.riderId);
  }

  // ─── Status Management ───
  _updateStatus(rideId, newStatus, pgExtra = {}) {
    const ride = this.rides.get(rideId);
    if (!ride) return;
    const { skipPg = false, ...persistExtra } = pgExtra || {};
    const prev = ride.statusHistory[ride.statusHistory.length - 1]?.status || 'NEW';
    ride.status = newStatus;
    ride.statusHistory.push({ status: newStatus, at: Date.now() });
    logger.info('RIDE', `Ride ${rideId}: ${prev} → ${newStatus}`);

    // Persist status change to PostgreSQL
    if (!skipPg) {
      pgRepo.updateStatus(rideId, newStatus, persistExtra)
        .catch(err => logger.warn('RIDE', `pg updateStatus failed (non-fatal): ${err.message}`));
    }

    if (this.redisStateV2 && ride.riderId) {
      this.stateStore.setActiveRide(rideId, {
        rideId,
        riderId: ride.riderId,
        driverId: ride.driverId,
        status: newStatus,
        pickupLat: ride.pickupLat,
        pickupLng: ride.pickupLng,
        destLat: ride.destLat,
        destLng: ride.destLng,
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

  _statusRank(status) {
    switch (String(status || '').toUpperCase()) {
      case 'REQUESTED':
        return 1;
      case 'MATCHING':
      case 'BROADCAST':
        return 2;
      case 'ACCEPTED':
        return 3;
      case 'DRIVER_ARRIVING':
        return 4;
      case 'DRIVER_ARRIVED':
        return 5;
      case 'TRIP_STARTED':
        return 6;
      case 'TRIP_COMPLETED':
        return 7;
      case 'NO_DRIVERS':
      case 'CANCELLED':
      case 'CANCELLED_BY_RIDER':
      case 'CANCELLED_BY_DRIVER':
        return 8;
      default:
        return 0;
    }
  }

  _mergeRideState(hot, fromDb) {
    if (!hot) return fromDb || null;
    if (!fromDb) return hot;

    const hotRank = this._statusRank(hot.status);
    const dbRank = this._statusRank(fromDb.status);
    const dbIsFresher =
      dbRank > hotRank ||
      (!hot.driverId && !!fromDb.driverId) ||
      (!hot.otp && !!fromDb.otp);

    const preferred = dbIsFresher ? fromDb : hot;
    const fallback = dbIsFresher ? hot : fromDb;

    return {
      ...fallback,
      ...preferred,
      rideId: preferred.rideId || fallback.rideId,
      dbRideId: preferred.dbRideId || fallback.dbRideId,
      riderId: preferred.riderId || fallback.riderId,
      driverId: preferred.driverId || fallback.driverId,
      driverName: preferred.driverName || fallback.driverName || fallback.matchResult?.driverName || null,
      driverPhone: preferred.driverPhone || fallback.driverPhone || fallback.matchResult?.driverPhone || null,
      driverVehicleNumber:
        preferred.driverVehicleNumber ||
        fallback.driverVehicleNumber ||
        fallback.matchResult?.vehicleNumber ||
        null,
      driverVehicleType:
        preferred.driverVehicleType ||
        fallback.driverVehicleType ||
        fallback.matchResult?.vehicleType ||
        null,
      driverRating:
        preferred.driverRating ??
        fallback.driverRating ??
        fallback.matchResult?.driverRating ??
        null,
      driverAvatarUrl:
        preferred.driverAvatarUrl ||
        fallback.driverAvatarUrl ||
        fallback.matchResult?.avatarUrl ||
        null,
      driverCompletedRides:
        preferred.driverCompletedRides ??
        fallback.driverCompletedRides ??
        fallback.matchResult?.completedRides ??
        null,
      otp: preferred.otp || fallback.otp || null,
      otpVerifiedAt: preferred.otpVerifiedAt || fallback.otpVerifiedAt || null,
      matchResult: hot.matchResult || fromDb.matchResult || null,
      statusHistory: hot.statusHistory || fromDb.statusHistory || [],
      createdAt: hot.createdAt || fromDb.createdAt || Date.now(),
      acceptedAt: hot.acceptedAt || fromDb.acceptedAt || null,
      arrivedAt: hot.arrivedAt || fromDb.arrivedAt || null,
      startedAt: hot.startedAt || fromDb.startedAt || null,
      completedAt: hot.completedAt || fromDb.completedAt || null,
      cancelledAt: hot.cancelledAt || fromDb.cancelledAt || null,
      driverLat: hot.driverLat ?? fromDb.driverLat ?? null,
      driverLng: hot.driverLng ?? fromDb.driverLng ?? null,
      etaMin: hot.etaMin ?? fromDb.etaMin ?? null,
      distanceKmRemaining: hot.distanceKmRemaining ?? fromDb.distanceKmRemaining ?? null,
      durationMinRemaining: hot.durationMinRemaining ?? fromDb.durationMinRemaining ?? null,
      trackingChannel: hot.trackingChannel || fromDb.trackingChannel || null,
      trackingPhase: hot.trackingPhase || fromDb.trackingPhase || null,
      currentLegPath: hot.currentLegPath || fromDb.currentLegPath || [],
      polylineIndex: hot.polylineIndex ?? fromDb.polylineIndex ?? 0,
    };
  }

  async getRideAsync(rideId) {
    const hot = this.getRide(rideId);
    const fromDb = await pgRepo.getRide(rideId).catch(() => null);
    const merged = this._mergeRideState(hot, fromDb);
    if (merged && rideId) {
      this.rides.set(rideId, merged);
    }
    return merged;
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
