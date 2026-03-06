// GoApp Pricing Service
// Fare calculation + EMA surge pricing

const config = require('../config');
const { haversine } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');
const googleMapsService = require('./google-maps-service');

class PricingService {
  constructor() {
    this.surgeByZone = new Map();
    this.stats = {
      fareCalculations: 0,
      surgeUpdates: 0,
    };
  }

  calculateFare(rideType, distanceKm, durationMin, surgeMultiplier = 1) {
    const card = config.pricing.rateCards[rideType] || config.pricing.rateCards.mini;
    const baseFare = card.baseFare;
    const distanceCharge = distanceKm * card.perKm;
    const timeCharge = durationMin * card.perMin;
    const subtotal = Math.max(card.minFare, baseFare + distanceCharge + timeCharge);
    const surged = subtotal * surgeMultiplier;
    const finalFare = Math.round(surged);
    const platformCommission = Math.round(finalFare * card.commission);
    const driverEarnings = finalFare - platformCommission;

    this.stats.fareCalculations += 1;

    return {
      rideType,
      distanceKm: Math.round(distanceKm * 100) / 100,
      durationMin: Math.round(durationMin * 10) / 10,
      finalFare,
      driverEarnings,
      platformCommission,
      breakdown: {
        baseFare,
        distanceCharge: Math.round(distanceCharge),
        timeCharge: Math.round(timeCharge),
        subtotal: Math.round(subtotal),
        surgeMultiplier: Math.round(surgeMultiplier * 100) / 100,
      },
    };
  }

  // Synchronous fallback used internally when async isn't available
  _estimatesSync(pickupLat, pickupLng, destLat, destLng) {
    const distanceKm = haversine(pickupLat, pickupLng, destLat, destLng) * 1.25;
    const durationMin = (distanceKm / config.scoring.avgCitySpeedKmh) * 60;
    return { distanceKm, durationMin, source: 'haversine' };
  }

  // Returns fare estimates using Google Maps road distance when available,
  // otherwise falls back to Haversine straight-line × 1.25.
  async getEstimates(pickupLat, pickupLng, destLat, destLng) {
    const { distanceKm, durationMin, source } = await googleMapsService.getRoadDistance(
      pickupLat, pickupLng, destLat, destLng,
    );

    const zoneId = 'chennai:default';
    const surge = this.getSurgeMultiplier(zoneId);

    const estimates = Object.keys(config.pricing.rateCards).reduce((acc, rideType) => {
      const fare = this.calculateFare(rideType, distanceKm, durationMin, surge.multiplier);
      acc[rideType] = {
        ...fare,
        etaMin: Math.max(3, Math.round(durationMin * 0.25)),
      };
      return acc;
    }, {});

    return {
      zoneId,
      surgeMultiplier: surge.multiplier,
      distanceSource: source,  // 'google' | 'haversine'
      estimates,
    };
  }

  getSurgeMultiplier(zoneId) {
    const zone = this.surgeByZone.get(zoneId);
    if (!zone) return { zoneId, multiplier: 1.0, rawSurge: 1.0, smoothedSurge: 1.0 };
    return zone;
  }

  updateSurge(zoneId, demand, supply) {
    const alpha = config.pricing.surge.alpha;
    const prev = this.surgeByZone.get(zoneId);

    const safeSupply = Math.max(1, supply);
    const rawSurge = Math.min(config.pricing.surge.maxCap, Math.max(1, demand / safeSupply));
    const prevSmooth = prev ? prev.smoothedSurge : 1.0;
    const smoothedSurge = (alpha * rawSurge) + ((1 - alpha) * prevSmooth);

    const multiplier = smoothedSurge >= config.pricing.surge.minThreshold
      ? Math.min(config.pricing.surge.maxCap, Math.max(1, smoothedSurge))
      : 1.0;

    const data = {
      zoneId,
      demand,
      supply,
      rawSurge: Math.round(rawSurge * 100) / 100,
      smoothedSurge: Math.round(smoothedSurge * 100) / 100,
      multiplier: Math.round(multiplier * 100) / 100,
      updatedAt: Date.now(),
    };

    this.surgeByZone.set(zoneId, data);
    this.stats.surgeUpdates += 1;

    eventBus.publish('surge_updated', data);
    logger.info('PRICING', `Surge ${zoneId}: raw=${data.rawSurge} smooth=${data.smoothedSurge} final=${data.multiplier}x`);

    return data;
  }

  getSurgeZones() {
    return [...this.surgeByZone.values()];
  }

  getStats() {
    return {
      ...this.stats,
      activeSurgeZones: this.surgeByZone.size,
    };
  }
}

module.exports = new PricingService();
