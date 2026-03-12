'use strict';

require('../../config/env-loader');

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const tripShareService = require('../../services/trip-share-service');
const { startAPIServer } = require('../../server');

test('trip share night window respects Asia/Kolkata rollover', async (t) => {
  const safetyRepo = require('../../repositories/pg/pg-safety-repository');
  const previous = safetyRepo.getPreferences;
  t.after(() => {
    safetyRepo.getPreferences = previous;
  });

  safetyRepo.getPreferences = async () => ({ autoShare: false, shareAtNight: true });

  const night = await tripShareService.shouldAutoShareRide({
    riderId: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-03-12T17:10:00.000Z',
  });
  assert.equal(night.shouldShare, true);
  assert.equal(night.reason, 'NIGHT_SHARE_WINDOW');

  const day = await tripShareService.shouldAutoShareRide({
    riderId: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-03-12T08:10:00.000Z',
  });
  assert.equal(day.shouldShare, false);
  assert.equal(day.reason, 'PREFERENCE_DISABLED');
});

test('public share page renders API-backed tracking shell', () => {
  const html = tripShareService.renderPublicSharePage('sample-token');
  assert.match(html, /GoApp Trip Tracking/);
  assert.match(html, /\/api\/v1\/public\/ride-share\/sample-token/);
  assert.match(html, /Open pickup in Google Maps/);
});

test('public tracking API returns standardized envelope with safe share snapshot', async (t) => {
  const originalGetPublicShareSnapshot = tripShareService.getPublicShareSnapshot;
  tripShareService.getPublicShareSnapshot = async () => ({
    success: true,
    rideId: 'RIDE-TEST1234',
    status: 'TRIP_STARTED',
    driver: {
      name: 'Arun',
      vehicleType: 'bike',
      vehicleNumber: 'TN09DEV1001',
    },
    pickup: { address: 'Pickup', lat: 13.08, lng: 80.14 },
    drop: { address: 'Drop', lat: 13.09, lng: 80.16 },
    live: { lat: 13.085, lng: 80.15, etaMin: 6, distanceKmRemaining: 1.2 },
    googleMapsCurrentUrl: 'https://maps.example/current',
    googleMapsPickupUrl: 'https://maps.example/pickup',
    googleMapsDropUrl: 'https://maps.example/drop',
    publicTrackingUrl: 'http://localhost:3000/ride-share/token',
    expiresAt: '2026-03-12T12:00:00.000Z',
  });
  t.after(() => {
    tripShareService.getPublicShareSnapshot = originalGetPublicShareSnapshot;
  });

  let server;
  try {
    server = startAPIServer(0);
  } catch (err) {
    if (/EPERM|operation not permitted/i.test(String(err?.message || ''))) {
      t.skip('Sandbox does not allow binding a local HTTP port.');
      return;
    }
    throw err;
  }
  try {
    await once(server, 'listening');
  } catch (err) {
    if (/EPERM|operation not permitted/i.test(String(err?.message || ''))) {
      t.skip('Sandbox does not allow binding a local HTTP port.');
      return;
    }
    throw err;
  }
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/public/ride-share/sample-token`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.rideId, 'RIDE-TEST1234');
  assert.equal(payload.data.driver.name, 'Arun');
  assert.equal(payload.data.googleMapsPickupUrl, 'https://maps.example/pickup');
  assert.equal(payload.data.paymentMethod, undefined);
});
