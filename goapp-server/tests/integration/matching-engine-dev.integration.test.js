// Requires: NODE_ENV=test. Uses mock Redis/DB and stubs matching collaborators.

'use strict';

require('../../config/env-loader');

const test = require('node:test');
const assert = require('node:assert/strict');

function loadFreshMatchingEngine() {
  delete require.cache[require.resolve('../../config')];
  delete require.cache[require.resolve('../../services/matching-engine')];
  return require('../../services/matching-engine');
}

test('matching engine normalizes requested service type and ignores aggregate ride modes', async (t) => {
  process.env.DEV_AUTO_ACCEPT_MATCHES = 'false';
  const engine = loadFreshMatchingEngine();
  const locationService = require('../../services/location-service');

  const originalFindNearby = locationService.findNearby;
  const originalGetExcludedDrivers = engine.stateStore.getExcludedDrivers;
  const originalGetDriverEligibility = engine.stateStore.getDriverEligibility;
  const originalSetDriverEligibility = engine.stateStore.setDriverEligibility;
  const originalGetDriverState = engine.stateStore.getDriverState;

  t.after(() => {
    locationService.findNearby = originalFindNearby;
    engine.stateStore.getExcludedDrivers = originalGetExcludedDrivers;
    engine.stateStore.getDriverEligibility = originalGetDriverEligibility;
    engine.stateStore.setDriverEligibility = originalSetDriverEligibility;
    engine.stateStore.getDriverState = originalGetDriverState;
    delete process.env.DEV_AUTO_ACCEPT_MATCHES;
  });

  locationService.findNearby = async () => [
    { driverId: 'dev-bike-1', lat: 13.0835, lng: 80.1500 },
  ];
  engine.stateStore.getExcludedDrivers = async () => [];
  engine.stateStore.getDriverEligibility = async () => ({ eligible: true });
  engine.stateStore.setDriverEligibility = async () => {};
  engine.stateStore.getDriverState = async () => ({
    status: 'online',
    vehicleType: 'bike',
  });

  const stage = { stage: 1, radiusKm: 2, maxDrivers: 3 };

  const bikeCandidates = await engine._findCandidates(
    {
      rideId: 'RIDE-REQ-SERVICE',
      pickupLat: 13.0833913,
      pickupLng: 80.1499398,
      rideType: 'on_demand',
      requestedServiceType: 'bike',
    },
    stage,
  );
  assert.equal(bikeCandidates.length, 1);

  const sedanCandidates = await engine._findCandidates(
    {
      rideId: 'RIDE-REQ-MISMATCH',
      pickupLat: 13.0833913,
      pickupLng: 80.1499398,
      rideType: 'on_demand',
      requestedServiceType: 'sedan',
    },
    stage,
  );
  assert.equal(sedanCandidates.length, 0);

  const aggregateOnlyCandidates = await engine._findCandidates(
    {
      rideId: 'RIDE-AGGREGATE',
      pickupLat: 13.0833913,
      pickupLng: 80.1499398,
      rideType: 'on_demand',
    },
    stage,
  );
  assert.equal(aggregateOnlyCandidates.length, 1);
});

test('matching engine development auto-accept uses acceptOffer winner path', async (t) => {
  process.env.DEV_AUTO_ACCEPT_MATCHES = 'true';
  process.env.DEV_AUTO_ACCEPT_DELAY_MS = '50';
  const engine = loadFreshMatchingEngine();
  const notificationService = require('../../services/notification-service');

  const originalSetRideOffer = engine.stateStore.setRideOffer;
  const originalGetRideOffer = engine.stateStore.getRideOffer;
  const originalMarkRideAccepted = engine.stateStore.markRideAccepted;
  const originalGetAcceptedDriver = engine.stateStore.getAcceptedDriver;
  const originalClearAcceptedDriver = engine.stateStore.clearAcceptedDriver;
  const originalAcquireRideAssignLock = engine.stateStore.acquireRideAssignLock;
  const originalGetDriverState = engine.stateStore.getDriverState;
  const originalGetMatchState = engine.stateStore.getMatchState;
  const originalUpdateDriverStatus = engine.updateDriverStatus;
  const originalNotifyDriverRideOffer = notificationService.notifyDriverRideOffer;
  const originalAcceptOffer = engine.acceptOffer.bind(engine);

  t.after(() => {
    engine.stateStore.setRideOffer = originalSetRideOffer;
    engine.stateStore.getRideOffer = originalGetRideOffer;
    engine.stateStore.markRideAccepted = originalMarkRideAccepted;
    engine.stateStore.getAcceptedDriver = originalGetAcceptedDriver;
    engine.stateStore.clearAcceptedDriver = originalClearAcceptedDriver;
    engine.stateStore.acquireRideAssignLock = originalAcquireRideAssignLock;
    engine.stateStore.getDriverState = originalGetDriverState;
    engine.stateStore.getMatchState = originalGetMatchState;
    engine.updateDriverStatus = originalUpdateDriverStatus;
    notificationService.notifyDriverRideOffer = originalNotifyDriverRideOffer;
    engine.acceptOffer = originalAcceptOffer;
    delete process.env.DEV_AUTO_ACCEPT_MATCHES;
    delete process.env.DEV_AUTO_ACCEPT_DELAY_MS;
  });

  let acceptedDriverId = null;
  let acceptOfferCalled = false;
  const offers = new Map();

  engine.stateStore.setRideOffer = async (rideId, driverId, payload) => {
    const offer = { ...payload };
    offers.set(`${rideId}:${driverId}`, offer);
    return offer;
  };
  engine.stateStore.getRideOffer = async (rideId, driverId) => offers.get(`${rideId}:${driverId}`) || null;
  engine.stateStore.markRideAccepted = async (_rideId, driverId) => {
    if (acceptedDriverId) return null;
    acceptedDriverId = driverId;
    return 'OK';
  };
  engine.stateStore.getAcceptedDriver = async () => acceptedDriverId;
  engine.stateStore.clearAcceptedDriver = async () => {
    acceptedDriverId = null;
  };
  engine.stateStore.acquireRideAssignLock = async (_rideId, driverId) => ({
    acquired: true,
    holder: driverId,
    lockToken: `lock:${driverId}`,
  });
  engine.stateStore.getDriverState = async () => ({ status: 'online' });
  engine.stateStore.getMatchState = async () => ({ cancelled: false });
  engine.updateDriverStatus = async () => {};
  notificationService.notifyDriverRideOffer = async () => ({ sent: false, reason: 'test' });
  engine.acceptOffer = async (...args) => {
    acceptOfferCalled = true;
    return originalAcceptOffer(...args);
  };

  const startedAt = Date.now();
  const result = await engine._broadcastAndWaitBatch({
    rideId: 'RIDE-AUTO-ACCEPT',
    drivers: [
      {
        driverId: 'driver-top-ranked',
        driverName: 'Nearest Driver',
        vehicleType: 'bike',
        vehicleNumber: 'TN09TEST1001',
        score: 0.998,
        etaMin: 1.2,
        distKm: 0.18,
      },
    ],
    stage: { stage: 1 },
    timeoutSec: 2,
    startedAt,
  });

  assert.equal(acceptOfferCalled, true);
  assert.equal(result.accepted, true);
  assert.equal(result.driverId, 'driver-top-ranked');
  assert.equal(result.stage, 1);

  const trace = engine.getRecentDevAutoAcceptTrace({ rideId: 'RIDE-AUTO-ACCEPT', limit: 10 });
  const phases = trace.map((entry) => entry.phase);
  assert.ok(phases.includes('scheduled'));
  assert.ok(phases.includes('accepted'));
  assert.ok(phases.includes('winner_selected'));

  const acceptedEntry = trace.find((entry) => entry.phase === 'accepted');
  assert.equal(acceptedEntry?.driverId, 'driver-top-ranked');
  assert.equal(acceptedEntry?.reason, 'top_ranked_driver_auto_accepted');
});

test('matching engine treats same-driver assignment lock as idempotent success', async (t) => {
  process.env.DEV_AUTO_ACCEPT_MATCHES = 'true';
  process.env.DEV_AUTO_ACCEPT_DELAY_MS = '50';
  const engine = loadFreshMatchingEngine();
  const notificationService = require('../../services/notification-service');

  const originalSetRideOffer = engine.stateStore.setRideOffer;
  const originalGetRideOffer = engine.stateStore.getRideOffer;
  const originalMarkRideAccepted = engine.stateStore.markRideAccepted;
  const originalGetAcceptedDriver = engine.stateStore.getAcceptedDriver;
  const originalClearAcceptedDriver = engine.stateStore.clearAcceptedDriver;
  const originalAcquireRideAssignLock = engine.stateStore.acquireRideAssignLock;
  const originalGetRideAssignLock = engine.stateStore.getRideAssignLock;
  const originalGetDriverState = engine.stateStore.getDriverState;
  const originalGetMatchState = engine.stateStore.getMatchState;
  const originalUpdateDriverStatus = engine.updateDriverStatus;
  const originalNotifyDriverRideOffer = notificationService.notifyDriverRideOffer;

  t.after(() => {
    engine.stateStore.setRideOffer = originalSetRideOffer;
    engine.stateStore.getRideOffer = originalGetRideOffer;
    engine.stateStore.markRideAccepted = originalMarkRideAccepted;
    engine.stateStore.getAcceptedDriver = originalGetAcceptedDriver;
    engine.stateStore.clearAcceptedDriver = originalClearAcceptedDriver;
    engine.stateStore.acquireRideAssignLock = originalAcquireRideAssignLock;
    engine.stateStore.getRideAssignLock = originalGetRideAssignLock;
    engine.stateStore.getDriverState = originalGetDriverState;
    engine.stateStore.getMatchState = originalGetMatchState;
    engine.updateDriverStatus = originalUpdateDriverStatus;
    notificationService.notifyDriverRideOffer = originalNotifyDriverRideOffer;
    delete process.env.DEV_AUTO_ACCEPT_MATCHES;
    delete process.env.DEV_AUTO_ACCEPT_DELAY_MS;
  });

  let acceptedDriverId = null;
  const offers = new Map();

  engine.stateStore.setRideOffer = async (rideId, driverId, payload) => {
    const offer = { ...payload };
    offers.set(`${rideId}:${driverId}`, offer);
    return offer;
  };
  engine.stateStore.getRideOffer = async (rideId, driverId) => offers.get(`${rideId}:${driverId}`) || null;
  engine.stateStore.markRideAccepted = async (_rideId, driverId) => {
    if (acceptedDriverId) return null;
    acceptedDriverId = driverId;
    return 'OK';
  };
  engine.stateStore.getAcceptedDriver = async () => acceptedDriverId;
  engine.stateStore.clearAcceptedDriver = async () => {
    acceptedDriverId = null;
  };
  engine.stateStore.acquireRideAssignLock = async (_rideId, driverId) => ({
    acquired: false,
    holder: driverId,
    lockToken: null,
  });
  engine.stateStore.getRideAssignLock = async (_rideId) => 'driver-top-ranked:existing-lock';
  engine.stateStore.getDriverState = async () => ({ status: 'online' });
  engine.stateStore.getMatchState = async () => ({ cancelled: false });
  engine.updateDriverStatus = async () => {};
  notificationService.notifyDriverRideOffer = async () => ({ sent: false, reason: 'test' });

  const result = await engine._broadcastAndWaitBatch({
    rideId: 'RIDE-IDEMPOTENT-LOCK',
    drivers: [
      {
        driverId: 'driver-top-ranked',
        driverName: 'Nearest Driver',
        vehicleType: 'bike',
        vehicleNumber: 'TN09TEST1001',
        score: 0.998,
        etaMin: 1.2,
        distKm: 0.18,
      },
    ],
    stage: { stage: 1 },
    timeoutSec: 2,
    startedAt: Date.now(),
  });

  assert.equal(result.accepted, true);
  assert.equal(result.driverId, 'driver-top-ranked');
  assert.equal(result.lockToken, 'driver-top-ranked:existing-lock');

  const trace = engine.getRecentDevAutoAcceptTrace({ rideId: 'RIDE-IDEMPOTENT-LOCK', limit: 10 });
  const phases = trace.map((entry) => entry.phase);
  assert.ok(phases.includes('winner_selected'));
  assert.ok(!phases.includes('claim_rejected'));
});
