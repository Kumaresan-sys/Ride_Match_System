// GoApp Math Utilities - All formulas from Formula Reference V2

const config = require('../config');
const R = config.location.earthRadiusKm;

// ─── Degree / Radian Conversion ───
function toRad(deg) { return deg * (Math.PI / 180); }
function toDeg(rad) { return rad * (180 / Math.PI); }

// ═══════════════════════════════════════════
// FORMULA 01: Haversine Distance
// ═══════════════════════════════════════════
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);

  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.asin(Math.sqrt(a));

  return R * c; // km
}

// ═══════════════════════════════════════════
// FORMULA 03: Bearing Between Two Points
// ═══════════════════════════════════════════
function bearing(lat1, lon1, lat2, lon2) {
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);

  const x = Math.sin(dLon) * Math.cos(rLat2);
  const y = Math.cos(rLat1) * Math.sin(rLat2)
          - Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);

  const bearingRad = Math.atan2(x, y);
  return (toDeg(bearingRad) + 360) % 360; // 0-360 degrees
}

// ═══════════════════════════════════════════
// FORMULA 04: Predictive Location Interpolation
// ═══════════════════════════════════════════
function predictLocation(lastLat, lastLng, speedMs, headingDeg, elapsedSec) {
  const headingRad = toRad(headingDeg);
  const predictedLat = lastLat + (speedMs * elapsedSec * Math.cos(headingRad)) / 111320;
  const predictedLng = lastLng + (speedMs * elapsedSec * Math.sin(headingRad)) / (111320 * Math.cos(toRad(lastLat)));

  return { lat: predictedLat, lng: predictedLng, interpolated: true };
}

// ═══════════════════════════════════════════
// FORMULA 02: Composite Driver Scoring
// ═══════════════════════════════════════════
function calculateCompositeScore(driver, riderLat, riderLng, maxETAInPool) {
  const W = config.scoring.weights;
  const F = config.scoring.freshness;

  // A. ETA Score (using Haversine-based quick ETA)
  const distKm = haversine(driver.lat, driver.lng, riderLat, riderLng);
  const etaMin = (distKm / config.scoring.avgCitySpeedKmh) * 60;
  const etaScore = maxETAInPool > 0 ? 1 - (etaMin / maxETAInPool) : 1;

  // B. Idle Score
  const idleMin = (Date.now() - driver.lastTripEndTime) / 60000;
  const idleScore = Math.min(idleMin / config.scoring.maxIdleMinutes, 1.0);

  // C. Acceptance Rate Score
  const acceptanceScore = driver.ridesOffered > 0
    ? driver.ridesAccepted / driver.ridesOffered : 0.5;

  // D. Completion Rate Score
  const completionScore = driver.ridesAccepted > 0
    ? driver.ridesCompleted / driver.ridesAccepted : 0.5;

  // E. Rating Score (normalized 1-5 → 0-1)
  const ratingScore = (driver.rating - 1.0) / 4.0;

  // F. Heading Score (cosine similarity)
  const bearingToRider = bearing(driver.lat, driver.lng, riderLat, riderLng);
  const headingDiff = toRad(driver.heading - bearingToRider);
  const headingScore = (1 + Math.cos(headingDiff)) / 2;

  // G. Freshness Modifier
  const locationAge = (Date.now() - driver.lastLocationUpdate) / 1000;
  let freshnessModifier = 0;
  if (locationAge < F.boostThresholdSec) freshnessModifier = F.boostValue;
  else if (locationAge > F.penaltyThresholdSec) freshnessModifier = F.penaltyValue;

  // Composite Score
  const score = (W.eta * Math.max(0, etaScore))
              + (W.idle * idleScore)
              + (W.acceptance * acceptanceScore)
              + (W.completion * completionScore)
              + (W.rating * ratingScore)
              + (W.heading * headingScore)
              + freshnessModifier;

  return {
    score: Math.round(score * 1000) / 1000,
    breakdown: {
      etaScore: Math.round(etaScore * 1000) / 1000,
      idleScore: Math.round(idleScore * 1000) / 1000,
      acceptanceScore: Math.round(acceptanceScore * 1000) / 1000,
      completionScore: Math.round(completionScore * 1000) / 1000,
      ratingScore: Math.round(ratingScore * 1000) / 1000,
      headingScore: Math.round(headingScore * 1000) / 1000,
      freshnessModifier,
    },
    distKm: Math.round(distKm * 100) / 100,
    etaMin: Math.round(etaMin * 10) / 10,
    locationAgeSec: Math.round(locationAge * 10) / 10,
  };
}

// ═══════════════════════════════════════════
// FORMULA 10: GPS Spoofing Detection
// ═══════════════════════════════════════════
function detectSpoofing(prevLocation, currLocation, timeDiffSec) {
  const distKm = haversine(prevLocation.lat, prevLocation.lng, currLocation.lat, currLocation.lng);
  const speedKmh = (distKm / timeDiffSec) * 3600;
  const jumpDistM = distKm * 1000;

  const flags = [];

  if (speedKmh > config.fraud.autoSuspendSpeedKmh) {
    flags.push({ type: 'AUTO_SUSPEND', reason: `Speed ${Math.round(speedKmh)} km/h > ${config.fraud.autoSuspendSpeedKmh} km/h` });
  } else if (speedKmh > config.fraud.maxSpeedKmh) {
    flags.push({ type: 'GPS_SPOOF_FLAG', reason: `Speed ${Math.round(speedKmh)} km/h > ${config.fraud.maxSpeedKmh} km/h` });
  }

  if (jumpDistM > config.fraud.jumpDistanceM && timeDiffSec < config.fraud.jumpTimeSec) {
    flags.push({ type: 'LOCATION_JUMP', reason: `Jumped ${Math.round(jumpDistM)}m in ${timeDiffSec}s` });
  }

  return {
    isSuspicious: flags.length > 0,
    speedKmh: Math.round(speedKmh),
    jumpDistM: Math.round(jumpDistM),
    flags,
  };
}

function detectRouteInflation(pickupLat, pickupLng, dropoffLat, dropoffLng, actualRouteKm) {
  const straightLineKm = haversine(pickupLat, pickupLng, dropoffLat, dropoffLng);
  const efficiency = straightLineKm / actualRouteKm;

  return {
    straightLineKm: Math.round(straightLineKm * 100) / 100,
    actualRouteKm,
    efficiency: Math.round(efficiency * 1000) / 1000,
    isFlagged: efficiency < config.fraud.minRouteEfficiency,
  };
}

module.exports = {
  haversine, bearing, predictLocation, calculateCompositeScore,
  detectSpoofing, detectRouteInflation, toRad, toDeg,
};
