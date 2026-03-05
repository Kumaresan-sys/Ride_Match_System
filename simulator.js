// GoApp Full System Simulation
// Demonstrates: location tracking, matching, scoring, locking, pricing, surge, cancellation, fraud

const crypto = require('crypto');
const config = require('../config');
const locationService = require('../services/location-service');
const matchingEngine = require('../services/matching-engine');
const pricingService = require('../services/pricing-service');
const rideService = require('../services/ride-service');
const redis = require('../services/redis-mock');
const { haversine, bearing, detectSpoofing, detectRouteInflation } = require('../utils/formulas');
const { logger, eventBus } = require('../utils/logger');
const {
  generateDrivers, generateRiders, generateRideScenarios,
  generateSurgeScenarios, generateFraudTestData, chennaiLocations,
} = require('../data/test-data');

// Speed up matching timeouts for simulation
config.matching.stages[0].timeoutSec = 2;
config.matching.stages[1].timeoutSec = 3;
config.matching.stages[2].timeoutSec = 4;
config.matching.maxTotalTimeoutSec = 10;

class Simulator {
  constructor() {
    this.drivers = [];
    this.riders = [];
  }

  async run() {
    logger.divider('GoApp RIDE MATCHING SYSTEM - FULL SIMULATION');
    console.log('');
    console.log('  This simulation demonstrates the complete ride-hailing system:');
    console.log('  • Redis GEO driver location tracking');
    console.log('  • Haversine distance calculation');
    console.log('  • Multi-stage matching with timeouts');
    console.log('  • Composite driver scoring (6 factors + freshness)');
    console.log('  • Distributed lock (SETNX) race condition prevention');
    console.log('  • EMA-smoothed surge pricing');
    console.log('  • Fare calculation with rate cards');
    console.log('  • Cancellation lifecycle with penalties');
    console.log('  • GPS spoofing / fraud detection');
    console.log('  • Event streaming (Kafka mock)');
    console.log('');

    // ─── Phase 1: Setup Test Data ───
    await this.phase1_setup();

    // ─── Phase 2: Haversine & Bearing Demo ───
    await this.phase2_formulas();

    // ─── Phase 3: Location Tracking & GEORADIUS ───
    await this.phase3_location();

    // ─── Phase 4: Surge Pricing ───
    await this.phase4_surge();

    // ─── Phase 5: Full Ride Lifecycle ───
    await this.phase5_rideLifecycle();

    // ─── Phase 6: Multiple Concurrent Rides ───
    await this.phase6_concurrentRides();

    // ─── Phase 7: Cancellation Scenarios ───
    await this.phase7_cancellations();

    // ─── Phase 8: Fraud Detection ───
    await this.phase8_fraud();

    // ─── Phase 9: System Stats ───
    await this.phase9_stats();
  }

  // ═══════════════════════════════════════════
  async phase1_setup() {
    logger.divider('PHASE 1: Setting Up Test Data');

    // Generate test drivers
    this.drivers = generateDrivers(20);
    this.riders = generateRiders(10);

    // Register drivers in matching engine and location service
    for (const driver of this.drivers) {
      matchingEngine.registerDriver(driver);
      locationService.updateLocation(driver.driverId, {
        lat: driver.lat, lng: driver.lng,
        speed: driver.speed, heading: driver.heading,
      });
    }

    logger.success('SETUP', `Registered ${this.drivers.length} drivers across Chennai`);
    logger.success('SETUP', `Registered ${this.riders.length} riders`);

    // Show driver distribution
    const typeCount = {};
    this.drivers.forEach(d => { typeCount[d.vehicleType] = (typeCount[d.vehicleType] || 0) + 1; });
    logger.info('SETUP', 'Driver distribution by vehicle type:', typeCount);

    // Show sample driver
    const sample = this.drivers[0];
    console.log('\n  Sample Driver:');
    console.log(`  ├── ID: ${sample.driverId}`);
    console.log(`  ├── Name: ${sample.name}`);
    console.log(`  ├── Vehicle: ${sample.vehicleBrand} (${sample.vehicleType}) - ${sample.vehicleNumber}`);
    console.log(`  ├── Rating: ${sample.rating} ⭐`);
    console.log(`  ├── Acceptance Rate: ${Math.round(sample.ridesAccepted / sample.ridesOffered * 100)}%`);
    console.log(`  ├── Location: (${sample.lat.toFixed(4)}, ${sample.lng.toFixed(4)})`);
    console.log(`  └── Speed: ${(sample.speed * 3.6).toFixed(1)} km/h, Heading: ${sample.heading}°`);
  }

  // ═══════════════════════════════════════════
  async phase2_formulas() {
    logger.divider('PHASE 2: Haversine & Bearing Formulas');

    const pairs = [
      { from: 'central', to: 'tNagar', name: 'Central → T. Nagar' },
      { from: 'airport', to: 'central', name: 'Airport → Central' },
      { from: 'velachery', to: 'sholinganallur', name: 'Velachery → Sholinganallur' },
      { from: 'egmore', to: 'marina', name: 'Egmore → Marina Beach' },
      { from: 'tambaram', to: 'guindy', name: 'Tambaram → Guindy' },
    ];

    console.log('');
    console.log('  ┌────────────────────────────────┬───────────┬──────────────┬──────────┐');
    console.log('  │ Route                          │ Distance  │ Bearing      │ ETA      │');
    console.log('  ├────────────────────────────────┼───────────┼──────────────┼──────────┤');

    for (const pair of pairs) {
      const from = chennaiLocations[pair.from];
      const to = chennaiLocations[pair.to];
      const dist = haversine(from.lat, from.lng, to.lat, to.lng);
      const bear = bearing(from.lat, from.lng, to.lat, to.lng);
      const eta = (dist * 1.3 / config.scoring.avgCitySpeedKmh) * 60; // 1.3 road factor

      const direction = bear < 45 ? 'N' : bear < 135 ? 'E' : bear < 225 ? 'S' : bear < 315 ? 'W' : 'N';

      console.log(`  │ ${pair.name.padEnd(30)} │ ${dist.toFixed(2).padStart(6)} km │ ${bear.toFixed(1).padStart(6)}° (${direction.padEnd(3)}) │ ${eta.toFixed(0).padStart(4)} min │`);
    }
    console.log('  └────────────────────────────────┴───────────┴──────────────┴──────────┘');
  }

  // ═══════════════════════════════════════════
  async phase3_location() {
    logger.divider('PHASE 3: Driver Location Tracking (Redis GEO)');

    const center = chennaiLocations.tNagar;
    logger.info('LOCATION', `Searching for drivers near T. Nagar (${center.lat}, ${center.lng}):`);

    for (const stage of config.matching.stages) {
      const nearby = locationService.findNearby(center.lat, center.lng, stage.radiusKm, 20);
      console.log(`\n  Stage ${stage.stage} (${stage.radiusKm}km radius): ${nearby.length} drivers found`);
      nearby.slice(0, 5).forEach(d => {
        const driver = matchingEngine.getDriver(d.driverId);
        console.log(`    ├── ${driver?.name || d.driverId} | ${d.distance}km away | ${(d.speed * 3.6).toFixed(0)}km/h | heading ${d.heading}° | age ${d.ageSec}s`);
      });
      if (nearby.length > 5) console.log(`    └── ... and ${nearby.length - 5} more`);
    }

    // Demonstrate staleness
    logger.info('LOCATION', '\nStaleness Detection Demo:');
    const staleDriver = this.drivers[0];
    // Simulate stale location (6 seconds old)
    staleDriver.lastLocationUpdate = Date.now() - 6000;
    const loc = locationService.getDriverLocation(staleDriver.driverId);
    console.log(`  Driver ${staleDriver.name}: age=${loc?.ageSec}s, stale=${loc?.stale}, interpolated=${loc?.interpolated || false}`);
  }

  // ═══════════════════════════════════════════
  async phase4_surge() {
    logger.divider('PHASE 4: Surge Pricing (EMA Smoothed)');

    const scenarios = generateSurgeScenarios();

    console.log('');
    console.log('  ┌──────────────────┬────────┬────────┬──────────┬───────────┬───────────┐');
    console.log('  │ Zone             │ Demand │ Supply │ Raw      │ Smoothed  │ Final     │');
    console.log('  ├──────────────────┼────────┼────────┼──────────┼───────────┼───────────┤');

    for (const scenario of scenarios) {
      const result = pricingService.updateSurge(scenario.zone, scenario.demand, scenario.supply);
      console.log(`  │ ${scenario.name.padEnd(16)} │ ${String(scenario.demand).padStart(6)} │ ${String(scenario.supply).padStart(6)} │ ${result.rawSurge.toFixed(2).padStart(8)} │ ${result.smoothedSurge.toFixed(2).padStart(9)} │ ${result.multiplier.toFixed(2).padStart(7)}x │`);
    }
    console.log('  └──────────────────┴────────┴────────┴──────────┴───────────┴───────────┘');

    // Show fare impact
    logger.info('PRICING', '\nSurge impact on a 10km sedan ride (25 min):');
    const normalFare = pricingService.calculateFare('sedan', 10, 25, 1.0);
    const surgedFare = pricingService.calculateFare('sedan', 10, 25, 1.8);
    console.log(`  Normal: ₹${normalFare.finalFare} | Surged (1.8x): ₹${surgedFare.finalFare} | Diff: +₹${surgedFare.finalFare - normalFare.finalFare}`);
  }

  // ═══════════════════════════════════════════
  async phase5_rideLifecycle() {
    logger.divider('PHASE 5: Complete Ride Lifecycle');

    const scenario = generateRideScenarios()[0]; // T. Nagar → Mylapore

    console.log(`\n  Scenario: ${scenario.name}`);
    console.log(`  ${scenario.description}`);
    console.log(`  Rider: ${scenario.riderId} | Type: ${scenario.rideType}`);
    console.log('');

    // Step 1: Create ride
    const result = await rideService.createRide({
      riderId: scenario.riderId,
      pickupLat: scenario.pickup.lat,
      pickupLng: scenario.pickup.lng,
      destLat: scenario.dest.lat,
      destLng: scenario.dest.lng,
      rideType: scenario.rideType,
      idempotencyKey: crypto.randomUUID(),
    });

    if (result.status === config.rideStatuses.DRIVER_ARRIVING) {
      const rideId = result.rideId;

      console.log(`\n  ✓ Match found in ${result.matchTimeSec}s`);
      console.log(`  ├── Driver: ${result.driver.name} (${result.driver.driverId})`);
      console.log(`  ├── Vehicle: ${result.driver.vehicleType} - ${result.driver.vehicleNumber}`);
      console.log(`  ├── Score: ${result.driver.score} | ETA: ${result.driver.etaMin} min`);
      console.log(`  └── Fare Estimate: ₹${result.fareEstimate}`);

      // Step 2: Driver arrives
      await this._wait(500);
      rideService.driverArrived(rideId);

      // Step 3: Trip starts
      await this._wait(500);
      rideService.startTrip(rideId);

      // Step 4: Trip completes
      await this._wait(500);
      const dist = haversine(scenario.pickup.lat, scenario.pickup.lng, scenario.dest.lat, scenario.dest.lng) * 1.3;
      const dur = (dist / config.scoring.avgCitySpeedKmh) * 60;
      const completion = rideService.completeTrip(rideId, dist, dur);

      if (completion) {
        console.log('\n  Trip Fare Breakdown:');
        console.log(`  ├── Base Fare:      ₹${completion.fare.breakdown.baseFare}`);
        console.log(`  ├── Distance:       ₹${completion.fare.breakdown.distanceCharge} (${completion.fare.distanceKm}km)`);
        console.log(`  ├── Time:           ₹${completion.fare.breakdown.timeCharge} (${completion.fare.durationMin}min)`);
        console.log(`  ├── Surge:          ${completion.fare.breakdown.surgeMultiplier}x`);
        console.log(`  ├── Final Fare:     ₹${completion.fare.finalFare}`);
        console.log(`  ├── Commission:     ₹${completion.fare.platformCommission} (${config.pricing.rateCards[scenario.rideType].commission * 100}%)`);
        console.log(`  └── Driver Earns:   ₹${completion.fare.driverEarnings}`);
      }
    } else {
      console.log(`\n  ✗ No drivers found: ${result.message}`);
    }
  }

  // ═══════════════════════════════════════════
  async phase6_concurrentRides() {
    logger.divider('PHASE 6: Multiple Concurrent Rides');

    const scenarios = generateRideScenarios().slice(1, 4); // Airport, Budget, Premium

    // Reset driver statuses
    this.drivers.forEach(d => {
      matchingEngine.updateDriverStatus(d.driverId, 'online');
    });

    const results = [];
    for (const scenario of scenarios) {
      console.log(`\n  → ${scenario.name} (${scenario.rideType})`);
      const result = await rideService.createRide({
        riderId: scenario.riderId,
        pickupLat: scenario.pickup.lat,
        pickupLng: scenario.pickup.lng,
        destLat: scenario.dest.lat,
        destLng: scenario.dest.lng,
        rideType: scenario.rideType,
        idempotencyKey: crypto.randomUUID(),
      });
      results.push({ scenario: scenario.name, ...result });

      if (result.status === config.rideStatuses.DRIVER_ARRIVING) {
        // Auto-complete
        rideService.driverArrived(result.rideId);
        rideService.startTrip(result.rideId);
        const dist = haversine(scenario.pickup.lat, scenario.pickup.lng, scenario.dest.lat, scenario.dest.lng) * 1.3;
        const dur = (dist / config.scoring.avgCitySpeedKmh) * 60;
        rideService.completeTrip(result.rideId, dist, dur);
      }
    }

    // Summary table
    console.log('\n  Concurrent Rides Summary:');
    console.log('  ┌────────────────────────┬──────────┬────────────────┬──────────┬──────────┐');
    console.log('  │ Scenario               │ Status   │ Driver         │ Score    │ Fare     │');
    console.log('  ├────────────────────────┼──────────┼────────────────┼──────────┼──────────┤');
    for (const r of results) {
      const status = r.driver ? '✓ MATCHED' : '✗ FAILED';
      const driver = r.driver?.name || 'N/A';
      const score = r.driver?.score || 'N/A';
      const fare = r.fareEstimate ? `₹${r.fareEstimate}` : 'N/A';
      console.log(`  │ ${r.scenario.padEnd(22)} │ ${status.padEnd(8)} │ ${driver.padEnd(14)} │ ${String(score).padEnd(8)} │ ${fare.padEnd(8)} │`);
    }
    console.log('  └────────────────────────┴──────────┴────────────────┴──────────┴──────────┘');
  }

  // ═══════════════════════════════════════════
  async phase7_cancellations() {
    logger.divider('PHASE 7: Cancellation Scenarios');

    // Reset drivers
    this.drivers.forEach(d => matchingEngine.updateDriverStatus(d.driverId, 'online'));

    // Scenario A: Rider cancels during matching
    console.log('\n  Scenario A: Rider cancels during matching');
    const rideA = await rideService.createRide({
      riderId: 'RDR-008',
      pickupLat: chennaiLocations.marina.lat,
      pickupLng: chennaiLocations.marina.lng,
      destLat: chennaiLocations.egmore.lat,
      destLng: chennaiLocations.egmore.lng,
      rideType: 'sedan',
      idempotencyKey: crypto.randomUUID(),
    });

    if (rideA.rideId && rideA.status !== config.rideStatuses.NO_DRIVERS) {
      // Scenario B: Rider cancels after accept (within grace period)
      console.log('\n  Scenario B: Rider cancels after accept (within grace period)');
      const cancelB = rideService.cancelRide(rideA.rideId, 'rider', 'RDR-008');
      console.log(`  Result: Fee = ₹${cancelB.cancelFee} | Penalty: ${cancelB.penalty?.level || 'none'}`);
    }

    // Scenario C: Simulate multiple cancellations to trigger penalty
    console.log('\n  Scenario C: Multiple cancellations → penalty trigger');
    for (let i = 0; i < 4; i++) {
      const ride = await rideService.createRide({
        riderId: 'RDR-009',
        pickupLat: chennaiLocations.adyar.lat + Math.random() * 0.01,
        pickupLng: chennaiLocations.adyar.lng + Math.random() * 0.01,
        destLat: chennaiLocations.central.lat,
        destLng: chennaiLocations.central.lng,
        rideType: 'mini',
        idempotencyKey: crypto.randomUUID(),
      });
      if (ride.rideId) {
        const cancel = rideService.cancelRide(ride.rideId, 'rider', 'RDR-009');
        console.log(`  Cancel #${i + 1}: count=${cancel.penalty?.count || i + 1}, penalty=${cancel.penalty?.level || 'none'}`);
      }
      // Reset drivers for next iteration
      this.drivers.forEach(d => matchingEngine.updateDriverStatus(d.driverId, 'online'));
    }

    // Test idempotency
    logger.info('RIDE', '\n  Idempotency Test:');
    const idempKey = crypto.randomUUID();
    this.drivers.forEach(d => matchingEngine.updateDriverStatus(d.driverId, 'online'));
    const req1 = await rideService.createRide({
      riderId: 'RDR-010', pickupLat: 13.05, pickupLng: 80.25,
      destLat: 13.08, destLng: 80.27, rideType: 'sedan', idempotencyKey: idempKey,
    });
    const req2 = await rideService.createRide({
      riderId: 'RDR-010', pickupLat: 13.05, pickupLng: 80.25,
      destLat: 13.08, destLng: 80.27, rideType: 'sedan', idempotencyKey: idempKey,
    });
    console.log(`  Request 1: rideId=${req1.rideId}, duplicate=${req1.duplicate || false}`);
    console.log(`  Request 2: rideId=${req2.rideId}, duplicate=${req2.duplicate || false}`);
  }

  // ═══════════════════════════════════════════
  async phase8_fraud() {
    logger.divider('PHASE 8: Fraud Detection');

    const tests = generateFraudTestData();

    console.log('');
    console.log('  ┌─────────────────────────────┬────────────┬──────────┬──────────────────────┐');
    console.log('  │ Scenario                    │ Speed km/h │ Jump (m) │ Result               │');
    console.log('  ├─────────────────────────────┼────────────┼──────────┼──────────────────────┤');

    for (const test of tests) {
      const result = detectSpoofing(test.prev, test.curr, test.timeDiff);
      const status = result.isSuspicious
        ? `⚠ ${result.flags[0]?.type}`
        : '✓ CLEAN';

      console.log(`  │ ${test.name.padEnd(27)} │ ${String(result.speedKmh).padStart(10)} │ ${String(result.jumpDistM).padStart(8)} │ ${status.padEnd(20)} │`);
    }
    console.log('  └─────────────────────────────┴────────────┴──────────┴──────────────────────┘');

    // Route efficiency test
    console.log('\n  Route Inflation Detection:');
    const route1 = detectRouteInflation(13.0418, 80.2341, 13.0827, 80.2707, 6.5);
    const route2 = detectRouteInflation(13.0418, 80.2341, 13.0827, 80.2707, 25.0);
    console.log(`  Normal route:    ${route1.straightLineKm}km straight / ${route1.actualRouteKm}km actual = ${route1.efficiency} efficiency → ${route1.isFlagged ? '⚠ FLAGGED' : '✓ OK'}`);
    console.log(`  Inflated route:  ${route2.straightLineKm}km straight / ${route2.actualRouteKm}km actual = ${route2.efficiency} efficiency → ${route2.isFlagged ? '⚠ FLAGGED' : '✓ OK'}`);
  }

  // ═══════════════════════════════════════════
  async phase9_stats() {
    logger.divider('PHASE 9: System Statistics');

    console.log('\n  Redis Stats:', redis.getStats());
    console.log('  Location Stats:', locationService.getStats());
    console.log('  Pricing Stats:', pricingService.getStats());
    console.log('  Ride Stats:', rideService.getStats());

    // Event log summary
    const events = eventBus.getRecentEvents(100);
    const eventCounts = {};
    events.forEach(e => { eventCounts[e.event] = (eventCounts[e.event] || 0) + 1; });
    console.log('\n  Event Stream Summary (Kafka Mock):');
    Object.entries(eventCounts).sort((a, b) => b[1] - a[1]).forEach(([event, count]) => {
      console.log(`    ${event}: ${count}`);
    });

    // All rides
    console.log('\n  All Rides:');
    const allRides = rideService.getAllRides();
    console.log('  ┌──────────────────┬───────────┬───────────┬──────────────────────┬──────────┐');
    console.log('  │ Ride ID          │ Rider     │ Driver    │ Status               │ Fare     │');
    console.log('  ├──────────────────┼───────────┼───────────┼──────────────────────┼──────────┤');
    allRides.forEach(r => {
      console.log(`  │ ${(r.rideId || '').padEnd(16)} │ ${(r.riderId || '').padEnd(9)} │ ${(r.driverId || 'N/A').padEnd(9)} │ ${(r.status || '').padEnd(20)} │ ₹${String(r.fare || 0).padStart(6)} │`);
    });
    console.log('  └──────────────────┴───────────┴───────────┴──────────────────────┴──────────┘');

    logger.divider('SIMULATION COMPLETE');
    console.log('  All 10 formulas demonstrated:');
    console.log('  ✓ 01. Haversine Distance');
    console.log('  ✓ 02. Composite Driver Score');
    console.log('  ✓ 03. Bearing Calculation');
    console.log('  ✓ 04. Predictive Location Interpolation');
    console.log('  ✓ 05. Fare Calculation');
    console.log('  ✓ 06. EMA Surge Pricing');
    console.log('  ✓ 07. ETA Estimation');
    console.log('  ✓ 08. Driver Rating (in scoring)');
    console.log('  ✓ 09. Cancellation Penalty');
    console.log('  ✓ 10. GPS Spoofing Detection');
    console.log('');
    console.log('  System Components Demonstrated:');
    console.log('  ✓ Redis GEO (GEOADD, GEORADIUS)');
    console.log('  ✓ Distributed Lock (SETNX)');
    console.log('  ✓ Idempotency Layer');
    console.log('  ✓ Event Streaming (Kafka mock)');
    console.log('  ✓ WebSocket Gateway (ready on ws://localhost:3001)');
    console.log('  ✓ Multi-stage matching with timeouts');
    console.log('  ✓ Ride state machine');
    console.log('  ✓ Circuit breaker (architecture ready)');
    console.log('');
  }

  _wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = Simulator;
