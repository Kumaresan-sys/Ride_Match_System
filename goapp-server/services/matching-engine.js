// GoApp Matching Engine
// Worker-owned, Redis-backed, deterministic matching.

'use strict';

const crypto = require('crypto');
const config = require('../config');
const redis = require('./redis-client');
const locationService = require('./location-service');
const { haversine } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');
const driverWalletService = require('./driver-wallet-service');
const notificationService = require('./notification-service');
const perfMonitor = require('./perf-monitor');
const RedisStateStore = require('../infra/redis/state-store');
const pgDriverRepo = require('../repositories/pg/pg-driver-repository');

const OFFER_BATCH_SIZE = 5;
const OFFER_TIMEOUT_SEC = 7;
const MAX_MATCH_WINDOW_MS = 30_000;

class MatchingEngine {
  constructor() {
    this.stateStore = new RedisStateStore(redis);
  }

  async registerDriver(driver) {
    await this.stateStore.setDriverState(driver.driverId, {
      status: driver.status || 'offline',
      vehicleType: driver.vehicleType || '',
      rating: Number(driver.rating || 0),
      name: driver.name || '',
      vehicleNumber: driver.vehicleNumber || '',
    });
    await this.stateStore.setDriverEligibility(driver.driverId, {
      eligible: true,
      reason: 'registered',
      updatedAt: Date.now(),
    }, 300);
  }

  async getDriver(driverId) {
    const dbDriver = await pgDriverRepo.getDriver(driverId).catch(() => null);
    if (dbDriver) return dbDriver;

    const state = await this.stateStore.getDriverState(driverId).catch(() => null);
    if (!state || Object.keys(state).length === 0) return null;

    return {
      driverId,
      name: state.name || 'Driver',
      vehicleType: state.vehicleType || 'sedan',
      vehicleNumber: state.vehicleNumber || null,
      rating: Number(state.rating || 0),
      status: state.status || 'offline',
    };
  }

  async updateDriverStatus(driverId, status) {
    await this.stateStore.setDriverState(driverId, { status });
  }

  async updateDriverRating(driverId, newRating) {
    await this.stateStore.setDriverState(driverId, { rating: Number(newRating || 0) });
  }

  async startMatching(ride, fromStage = 1) {
    const { rideId, pickupLat, pickupLng } = ride;
    const startedAt = Date.now();
    const configuredWindowMs = Math.max(1, Number(config.matching.maxTotalTimeoutSec || 30)) * 1000;
    const hardDeadline = startedAt + Math.min(configuredWindowMs, MAX_MATCH_WINDOW_MS);

    logger.divider(`MATCHING STARTED: Ride ${rideId}`);
    logger.info('MATCHING', `Pickup: (${pickupLat}, ${pickupLng})`);

    await this.stateStore.setMatchState(rideId, {
      rideId,
      currentStage: 0,
      startedAt,
      cancelled: false,
    }, Math.max(config.matching.maxTotalTimeoutSec + 300, 600));

    eventBus.publish('ride_matching_started', { rideId, rideType: ride.rideType });

    const stages = config.matching.stages.filter((s) => s.stage >= fromStage);
    for (const stage of stages) {
      const state = await this.stateStore.getMatchState(rideId);
      if (state?.cancelled) {
        logger.warn('MATCHING', `Ride ${rideId} cancelled during matching`);
        await this.stateStore.clearMatchState(rideId);
        return { success: false, reason: 'CANCELLED' };
      }

      await this.stateStore.setMatchState(rideId, { ...state, currentStage: stage.stage }, 1800);
      eventBus.publish('ride_matching_stage_changed', { rideId, stage: stage.stage, radiusKm: stage.radiusKm });

      const nearbyDrivers = await this._findCandidates(ride, stage);
      if (nearbyDrivers.length === 0) {
        if (Date.now() >= hardDeadline) break;
        continue;
      }

      const rankedDrivers = await this._scoreAndRank(nearbyDrivers, ride, stage);
      const batchResult = await this._broadcastInBatches(rideId, rankedDrivers, stage, startedAt, hardDeadline);
      if (batchResult.accepted) {
        await this.stateStore.clearMatchState(rideId);
        perfMonitor.recordMatch(true, Date.now() - startedAt);
        return batchResult;
      }

      if (Date.now() >= hardDeadline) break;
    }

    await this.stateStore.clearMatchState(rideId);
    perfMonitor.recordMatch(false, Date.now() - startedAt);
    eventBus.publish('ride_no_drivers', { rideId });

    return {
      success: false,
      reason: 'NO_DRIVERS',
      message: 'No drivers available. Please try again in a moment.',
      canRetry: true,
      retryCooldownSec: config.matching.retryCooldownSec,
    };
  }

  async _findCandidates(ride, stage) {
    const { pickupLat, pickupLng, rideType } = ride;
    const excluded = new Set(await this.stateStore.getExcludedDrivers(ride.rideId));
    const nearby = await locationService.findNearby(pickupLat, pickupLng, stage.radiusKm, stage.maxDrivers * 3);

    const eligibilityEntries = await Promise.all(
      nearby.map(async (loc) => {
        const cached = await this.stateStore.getDriverEligibility(loc.driverId).catch(() => null);
        if (cached && typeof cached.eligible !== 'undefined') return [loc.driverId, cached];
        const computed = await driverWalletService.canReceiveRide(loc.driverId);
        await this.stateStore.setDriverEligibility(loc.driverId, computed, 120).catch(() => {});
        return [loc.driverId, computed];
      }),
    );

    const stateEntries = await Promise.all(
      nearby.map(async (loc) => [loc.driverId, await this.stateStore.getDriverState(loc.driverId)]),
    );

    const eligibilityMap = new Map(eligibilityEntries);
    const stateMap = new Map(stateEntries);

    const candidates = nearby.filter((loc) => {
      const state = stateMap.get(loc.driverId) || {};
      if ((state.status || '').toLowerCase() !== 'online') return false;
      if (rideType && state.vehicleType && state.vehicleType !== rideType) return false;
      if (excluded.has(String(loc.driverId))) return false;
      return Boolean(eligibilityMap.get(loc.driverId)?.eligible);
    });

    logger.info('MATCHING', `Found ${nearby.length} nearby -> ${candidates.length} eligible candidates`);
    return candidates;
  }

  _normalizeRate(value, fallback = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n > 1) return Math.max(0, Math.min(1, n / 100));
    return Math.max(0, Math.min(1, n));
  }

  _hashJitter(seed) {
    const h = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
    const value = parseInt(h, 16) / 0xffffffff;
    return Math.max(0, Math.min(1, value));
  }

  async _scoreAndRank(candidates, ride, stage) {
    const { pickupLat, pickupLng, rideId } = ride;

    const profiles = await Promise.all(candidates.map(async (candidate) => {
      const db = await pgDriverRepo.getDriver(candidate.driverId).catch(() => null);
      const state = await this.stateStore.getDriverState(candidate.driverId).catch(() => ({}));
      return {
        driverId: candidate.driverId,
        name: db?.name || state?.name || `Driver-${String(candidate.driverId).slice(0, 6)}`,
        vehicleType: db?.vehicleType || state?.vehicleType || 'sedan',
        vehicleNumber: db?.vehicleNumber || state?.vehicleNumber || null,
        rating: Number(db?.rating || state?.rating || config.rating.defaultRating || 5),
        acceptanceRate: this._normalizeRate(db?.acceptanceRate ?? state?.acceptanceRate ?? 1),
        completionRate: this._normalizeRate(db?.completionRate ?? state?.completionRate ?? 1),
        cancelRate: this._normalizeRate(state?.cancelRate ?? 0, 0),
        lastTripEndTime: Number(state?.lastTripEndTime || Date.now()),
        ...candidate,
      };
    }));

    const withEta = profiles.map((candidate) => {
      const distKm = haversine(candidate.lat, candidate.lng, pickupLat, pickupLng);
      const etaMin = (distKm / config.scoring.avgCitySpeedKmh) * 60;
      return {
        ...candidate,
        _distKm: distKm,
        _etaMin: etaMin,
      };
    });

    const maxEta = Math.max(...withEta.map((candidate) => candidate._etaMin), 1);

    const scored = withEta.map((candidate) => {
      const etaNorm = Math.max(0, Math.min(1, 1 - (candidate._etaMin / maxEta)));
      const now = Date.now();
      const idleMin = Math.max(0, (now - Number(candidate.lastTripEndTime || now)) / 60000);
      const idleTimeNorm = Math.max(0, Math.min(1, idleMin / 30));
      const fairnessJitter = this._hashJitter(`${rideId}:${candidate.driverId}:${stage.stage}`);

      const score = (0.40 * etaNorm)
        + (0.20 * candidate.acceptanceRate)
        + (0.15 * candidate.completionRate)
        + (0.10 * (1 - candidate.cancelRate))
        + (0.10 * idleTimeNorm)
        + (0.05 * fairnessJitter);

      return {
        driverId: candidate.driverId,
        driverName: candidate.name,
        vehicleType: candidate.vehicleType,
        vehicleNumber: candidate.vehicleNumber,
        score: Math.round(score * 1000) / 1000,
        etaMin: Math.round(candidate._etaMin * 10) / 10,
        distKm: Math.round(candidate._distKm * 100) / 100,
        breakdown: {
          etaNorm: Math.round(etaNorm * 1000) / 1000,
          acceptanceRate: Math.round(candidate.acceptanceRate * 1000) / 1000,
          completionRate: Math.round(candidate.completionRate * 1000) / 1000,
          cancelRate: Math.round(candidate.cancelRate * 1000) / 1000,
          idleTimeNorm: Math.round(idleTimeNorm * 1000) / 1000,
          fairnessJitter: Math.round(fairnessJitter * 1000) / 1000,
        },
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, stage.maxDrivers);
  }

  _chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(items.slice(i, i + size));
    }
    return out;
  }

  async _broadcastInBatches(rideId, rankedDrivers, stage, startedAt, hardDeadline) {
    const batches = this._chunk(rankedDrivers, OFFER_BATCH_SIZE);
    for (const batch of batches) {
      const remainingMs = hardDeadline - Date.now();
      if (remainingMs <= 0) break;

      const timeoutSec = Math.max(1, Math.min(OFFER_TIMEOUT_SEC, Math.floor(remainingMs / 1000)));
      const result = await this._broadcastAndWaitBatch({
        rideId,
        drivers: batch,
        stage,
        timeoutSec,
        startedAt,
      });

      if (result.accepted) return result;
    }

    return { accepted: false, reason: 'TIMEOUT' };
  }

  async _broadcastAndWaitBatch({ rideId, drivers, stage, timeoutSec, startedAt }) {
    eventBus.publish('ride_broadcast_sent', {
      rideId,
      stage: stage.stage,
      driverIds: drivers.map((driver) => driver.driverId),
      timeoutSec,
    });

    const offers = await Promise.all(drivers.map((driver) => this.stateStore.setRideOffer(
      rideId,
      driver.driverId,
      {
        offerId: `${rideId}:${driver.driverId}:${Date.now()}`,
        rideId,
        driverId: driver.driverId,
        stage: stage.stage,
        score: driver.score,
        etaMin: driver.etaMin,
      },
      timeoutSec + 30,
    )));

    await Promise.all(offers.map((offer, idx) => notificationService.notifyDriverRideOffer(offer.driverId, {
      offerId: offer.offerId,
      rideId,
      stage: stage.stage,
      etaMin: drivers[idx].etaMin,
      score: drivers[idx].score,
      ttlSec: timeoutSec,
    }).catch(() => {})));

    return new Promise((resolve) => {
      let settled = false;
      let pollTimer = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        resolve(result);
      };

      const timeout = setTimeout(async () => {
        await this.stateStore.clearAcceptedDriver(rideId).catch(() => {});
        settle({ accepted: false, reason: 'TIMEOUT' });
      }, timeoutSec * 1000);

      pollTimer = setInterval(async () => {
        try {
          const acceptedDriverId = await this.stateStore.getAcceptedDriver(rideId);
          if (!acceptedDriverId) return;

          const winner = drivers.find((driver) => String(driver.driverId) === String(acceptedDriverId));
          if (!winner) return;

          clearTimeout(timeout);

          const lockResult = await this._claimRide(rideId, winner.driverId);
          await this.stateStore.clearAcceptedDriver(rideId);
          if (!lockResult.acquired) {
            settle({ accepted: false, reason: 'LOCK_CONTENTION' });
            return;
          }

          await this.updateDriverStatus(winner.driverId, 'on_trip');

          drivers
            .filter((driver) => String(driver.driverId) !== String(winner.driverId))
            .forEach((driver) => eventBus.publish('ride_accept_rejected', {
              rideId,
              driverId: driver.driverId,
              reason: 'winner_selected',
            }));

          settle({
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
            lockToken: lockResult.lockToken,
            matchTimeSec: Math.round((Date.now() - startedAt) / 1000),
          });
        } catch (err) {
          logger.warn('MATCHING', `Offer polling failed for ${rideId}: ${err.message}`);
        }
      }, 250);
    });
  }

  async _claimRide(rideId, driverId) {
    const lockResult = await this.stateStore.acquireRideAssignLock(rideId, driverId, 60);
    if (lockResult.acquired) {
      eventBus.publish('ride_accepted', { rideId, driverId });
    } else {
      eventBus.publish('ride_accept_rejected', {
        rideId,
        driverId,
        holder: lockResult.holder,
      });
    }
    return lockResult;
  }

  async cancelMatching(rideId) {
    const state = await this.stateStore.getMatchState(rideId);
    if (!state) return;
    await this.stateStore.setMatchState(rideId, { ...state, cancelled: true }, 3600);
    eventBus.publish('ride_cancelled_during_matching', { rideId });
  }

  async excludeDriver(rideId, driverId) {
    await this.stateStore.addExcludedDriver(rideId, driverId, 3600);
  }

  async resumeMatching(ride, fromStage) {
    return this.startMatching(ride, fromStage);
  }

  async getActiveMatches() {
    return [];
  }

  async acceptOffer(rideId, driverId, offerId = null) {
    const offer = await this.stateStore.getRideOffer(rideId, driverId);
    if (!offer) {
      return { success: false, error: 'No active offer found for this driver/ride.' };
    }
    if (offerId && String(offer.offerId) !== String(offerId)) {
      return { success: false, error: 'Offer is stale or does not belong to this ride.' };
    }

    const accepted = await this.stateStore.markRideAccepted(rideId, driverId, OFFER_TIMEOUT_SEC + 10);
    if (accepted !== 'OK') {
      return { success: false, error: 'Ride already accepted by another driver.' };
    }

    return {
      success: true,
      rideId,
      driverId,
      offerId: offer.offerId,
    };
  }
}

module.exports = new MatchingEngine();
