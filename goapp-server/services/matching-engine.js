// GoApp Matching Engine
// Multi-stage matching, composite scoring, distributed locks, timeouts

const config = require('../config');
const redis = require('./redis-mock');
const locationService = require('./location-service');
const { calculateCompositeScore, haversine } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');
const driverWalletService = require('./driver-wallet-service');

class MatchingEngine {
  constructor() {
    this.activeMatches = new Map();  // rideId -> match state
    this.driverPool = new Map();     // driverId -> driver data (from test data)
    this.excludedDrivers = new Map(); // rideId -> Set of excluded driverIds
  }

  registerDriver(driver) {
    this.driverPool.set(driver.driverId, driver);
  }

  getDriver(driverId) {
    return this.driverPool.get(driverId);
  }

  updateDriverStatus(driverId, status) {
    const driver = this.driverPool.get(driverId);
    if (driver) driver.status = status;
  }

  updateDriverRating(driverId, newRating) {
    const driver = this.driverPool.get(driverId);
    if (driver) driver.rating = newRating;
  }

  // ═══════════════════════════════════════════
  // MAIN MATCHING FLOW
  // ═══════════════════════════════════════════
  async startMatching(ride, fromStage = 1) {
    const { rideId, pickupLat, pickupLng, rideType } = ride;

    logger.divider(`MATCHING STARTED: Ride ${rideId}`);
    logger.info('MATCHING', `Pickup: (${pickupLat}, ${pickupLng}) | Type: ${rideType}`);

    const matchState = {
      rideId,
      currentStage: 0,
      startTime: Date.now(),
      cancelled: false,
      result: null,
    };
    this.activeMatches.set(rideId, matchState);

    eventBus.publish('ride_matching_started', { rideId, rideType: ride.rideType });

    // Iterate through stages (optionally starting from a given stage)
    const stages = config.matching.stages.filter(s => s.stage >= fromStage);
    for (let i = 0; i < stages.length; i++) {
      if (matchState.cancelled) {
        logger.warn('MATCHING', `Ride ${rideId} cancelled during matching`);
        return { success: false, reason: 'CANCELLED' };
      }

      const stage = stages[i];
      matchState.currentStage = stage.stage;

      logger.info('MATCHING', `\n  ┌─ Stage ${stage.stage}: ${stage.radiusKm}km radius, max ${stage.maxDrivers} drivers, ${stage.timeoutSec}s timeout`);

      eventBus.publish('ride_matching_stage_changed', {
        rideId, stage: stage.stage, radiusKm: stage.radiusKm,
      });

      // Step 1: Find nearby available drivers
      const nearbyDrivers = this._findCandidates(ride, stage);

      if (nearbyDrivers.length === 0) {
        logger.warn('MATCHING', `  └─ Stage ${stage.stage}: No drivers found in ${stage.radiusKm}km radius`);
        continue;
      }

      // Step 2: Score and rank drivers
      const rankedDrivers = this._scoreAndRank(nearbyDrivers, ride, stage);

      // Step 3: Broadcast to top drivers
      const broadcastResult = await this._broadcastAndWait(rideId, rankedDrivers, stage);

      if (broadcastResult.accepted) {
        matchState.result = broadcastResult;
        this.activeMatches.delete(rideId);
        return broadcastResult;
      }

      // Check total timeout
      const elapsed = (Date.now() - matchState.startTime) / 1000;
      if (elapsed >= config.matching.maxTotalTimeoutSec) {
        logger.error('MATCHING', `Ride ${rideId}: Max total timeout (${config.matching.maxTotalTimeoutSec}s) exceeded`);
        break;
      }
    }

    // All stages exhausted
    logger.error('MATCHING', `Ride ${rideId}: No drivers available after all stages`);
    this.activeMatches.delete(rideId);

    eventBus.publish('ride_no_drivers', { rideId });

    return {
      success: false,
      reason: 'NO_DRIVERS',
      message: 'No drivers available. Please try again in a moment.',
      canRetry: true,
      retryCooldownSec: config.matching.retryCooldownSec,
    };
  }

  // ═══════════════════════════════════════════
  // STEP 1: Find candidate drivers
  // ═══════════════════════════════════════════
  _findCandidates(ride, stage) {
    const { pickupLat, pickupLng, rideType } = ride;
    const excluded = this.excludedDrivers.get(ride.rideId) || new Set();

    // Query Redis GEO
    const nearby = locationService.findNearby(
      pickupLat, pickupLng, stage.radiusKm, stage.maxDrivers * 3 // get extra for filtering
    );

    // Filter: available, correct vehicle type, not excluded
    const candidates = nearby.filter(loc => {
      const driver = this.driverPool.get(loc.driverId);
      if (!driver) return false;
      if (driver.status !== 'online') return false;
      if (rideType && driver.vehicleType !== rideType) return false;
      if (excluded.has(loc.driverId)) return false;
      // Enforce ₹300 minimum wallet balance gate
      const walletEligible = driverWalletService.canReceiveRide(loc.driverId);
      if (!walletEligible.eligible) return false;
      return true;
    });

    logger.info('MATCHING', `  │  Found ${nearby.length} nearby → ${candidates.length} eligible candidates`);
    return candidates;
  }

  // ═══════════════════════════════════════════
  // STEP 2: Composite scoring
  // ═══════════════════════════════════════════
  _scoreAndRank(candidates, ride, stage) {
    const { pickupLat, pickupLng } = ride;

    // Calculate max ETA for normalization
    const etas = candidates.map(c => {
      const distKm = haversine(c.lat, c.lng, pickupLat, pickupLng);
      return (distKm / config.scoring.avgCitySpeedKmh) * 60;
    });
    const maxETA = Math.max(...etas, 1);

    // Score each driver
    const scored = candidates.map(candidate => {
      const driver = this.driverPool.get(candidate.driverId);
      const driverData = {
        ...driver,
        lat: candidate.lat,
        lng: candidate.lng,
        heading: candidate.heading,
        lastLocationUpdate: Date.now() - (candidate.ageSec * 1000),
      };

      const scoreResult = calculateCompositeScore(driverData, pickupLat, pickupLng, maxETA);

      return {
        driverId: candidate.driverId,
        driverName: driver.name,
        vehicleType: driver.vehicleType,
        vehicleNumber: driver.vehicleNumber,
        ...scoreResult,
      };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Take top N for this stage
    const topDrivers = scored.slice(0, stage.maxDrivers);

    // Log ranking
    logger.info('MATCHING', `  │  Driver Rankings:`);
    topDrivers.forEach((d, i) => {
      logger.info('MATCHING',
        `  │  ${i + 1}. ${d.driverName} (${d.driverId}) | Score: ${d.score} | ETA: ${d.etaMin}min | Dist: ${d.distKm}km`);
      logger.info('MATCHING',
        `  │     Breakdown → ETA:${d.breakdown.etaScore} Idle:${d.breakdown.idleScore} Accept:${d.breakdown.acceptanceScore} ` +
        `Complete:${d.breakdown.completionScore} Rating:${d.breakdown.ratingScore} Heading:${d.breakdown.headingScore} Fresh:${d.breakdown.freshnessModifier}`);
    });

    return topDrivers;
  }

  // ═══════════════════════════════════════════
  // STEP 3: Broadcast and wait for acceptance
  // ═══════════════════════════════════════════
  async _broadcastAndWait(rideId, rankedDrivers, stage) {
    logger.info('MATCHING', `  │  Broadcasting to ${rankedDrivers.length} drivers...`);

    eventBus.publish('ride_broadcast_sent', {
      rideId,
      stage: stage.stage,
      driverIds: rankedDrivers.map(d => d.driverId),
    });

    // Simulate driver responses
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn('MATCHING', `  └─ Stage ${stage.stage}: Timeout (${stage.timeoutSec}s) - no driver accepted`);
        resolve({ accepted: false, reason: 'TIMEOUT' });
      }, stage.timeoutSec * 1000);

      // Simulate: random driver accepts within timeout
      const acceptDelay = Math.random() * (stage.timeoutSec * 0.8) * 1000;
      const respondingDrivers = rankedDrivers.filter(() => Math.random() > 0.3);

      if (respondingDrivers.length === 0) {
        return; // Let timeout handle it
      }

      setTimeout(() => {
        clearTimeout(timeout);

        // First responding driver tries to claim
        const winner = respondingDrivers[0];
        const lockResult = this._claimRide(rideId, winner.driverId);

        if (lockResult.acquired) {
          // Notify other drivers
          const losers = rankedDrivers.filter(d => d.driverId !== winner.driverId);
          losers.forEach(d => {
            eventBus.publish('ride_accept_rejected', { rideId, driverId: d.driverId });
            logger.info('MATCHING', `  │  Notified ${d.driverName}: ride taken`);
          });

          // Update driver status
          this.updateDriverStatus(winner.driverId, 'on_trip');

          logger.success('MATCHING', `  └─ MATCHED! Driver ${winner.driverName} (${winner.driverId}) | Score: ${winner.score} | ETA: ${winner.etaMin}min`);

          resolve({
            accepted: true,
            success: true,
            driverId: winner.driverId,
            driverName: winner.driverName,
            vehicleType: winner.vehicleType,
            vehicleNumber: winner.vehicleNumber,
            score: winner.score,
            etaMin: winner.etaMin,
            distKm: winner.distKm,
            stage: stage.stage,
            matchTimeSec: Math.round((Date.now() - (this.activeMatches.get(rideId)?.startTime ?? Date.now())) / 1000),
          });
        }
      }, acceptDelay);
    });
  }

  // ═══════════════════════════════════════════
  // Distributed Lock (SETNX)
  // ═══════════════════════════════════════════
  _claimRide(rideId, driverId) {
    const lockResult = redis.acquireLock(rideId, driverId, 60);

    if (lockResult.acquired) {
      eventBus.publish('ride_accepted', { rideId, driverId });
    } else {
      eventBus.publish('ride_accept_rejected', {
        rideId, driverId, holder: lockResult.holder,
      });
    }

    return lockResult;
  }

  // ═══════════════════════════════════════════
  // Cancellation during matching
  // ═══════════════════════════════════════════
  cancelMatching(rideId) {
    const matchState = this.activeMatches.get(rideId);
    if (matchState) {
      matchState.cancelled = true;
      logger.warn('MATCHING', `Ride ${rideId} matching cancelled`);
      eventBus.publish('ride_cancelled_during_matching', { rideId });
    }
  }

  // Exclude a driver (e.g., after driver cancellation)
  excludeDriver(rideId, driverId) {
    if (!this.excludedDrivers.has(rideId)) {
      this.excludedDrivers.set(rideId, new Set());
    }
    this.excludedDrivers.get(rideId).add(driverId);
  }

  // Continue matching from last stage after driver cancellation
  async resumeMatching(ride, fromStage) {
    logger.info('MATCHING', `Resuming matching for ride ${ride.rideId} from stage ${fromStage}`);
    return this.startMatching(ride, fromStage);
  }

  getActiveMatches() {
    const matches = [];
    for (const [rideId, state] of this.activeMatches) {
      matches.push({
        rideId,
        stage: state.currentStage,
        elapsedSec: Math.round((Date.now() - state.startTime) / 1000),
        cancelled: state.cancelled,
      });
    }
    return matches;
  }
}

module.exports = new MatchingEngine();
