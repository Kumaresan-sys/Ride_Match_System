'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const dotenv = require('dotenv');
const { Client } = require('pg');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEV_ENV_FILES = [
  path.join(REPO_ROOT, '.env.development'),
  path.join(REPO_ROOT, '.env.development.local'),
];

function loadDevelopmentEnv() {
  const env = {};
  DEV_ENV_FILES.forEach((file, index) => {
    if (!fs.existsSync(file)) return;
    dotenv.config({
      path: file,
      processEnv: env,
      override: index === 0,
      quiet: true,
    });
  });
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && /^\$\{[A-Z0-9_]+\}$/.test(value.trim())) {
      delete env[key];
    }
  }
  return env;
}

const devEnv = loadDevelopmentEnv();

function makeDbConfig(dbName) {
  return {
    host: devEnv.POSTGRES_HOST || 'localhost',
    port: Number(devEnv.POSTGRES_PORT || 5432),
    user: devEnv.POSTGRES_USER || 'goapp',
    password: devEnv.POSTGRES_PASSWORD || 'goapp',
    database: dbName,
  };
}

async function query(dbName, sql, params = []) {
  const client = new Client(makeDbConfig(dbName));
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function requestJson(baseUrl, targetPath, options = {}) {
  const response = await fetch(`${baseUrl}${targetPath}`, options);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function hashOtp(otpCode, secret) {
  return crypto.createHmac('sha256', String(secret || ''))
    .update(String(otpCode))
    .digest('hex');
}

function ensureDevDriversSeeded() {
  const seeded = spawnSync(
    process.execPath,
    ['scripts/dev-seed-drivers.js'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'development' },
      encoding: 'utf8',
    }
  );

  assert.equal(
    seeded.status,
    0,
    `Development driver seed failed: ${String(seeded.stderr || seeded.stdout || '').trim()}`
  );
}

async function waitForCondition(fn, timeoutMs = 15000, intervalMs = 500) {
  const startedAt = Date.now();
  let lastValue = null;
  while ((Date.now() - startedAt) < timeoutMs) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await delay(intervalMs);
  }
  return lastValue;
}

test('brand-new development rider can login, sync projections, create profile, and auto-match nearest seeded bike driver', { timeout: 90000 }, async (t) => {
  const baseUrl = process.env.GOAPP_DEV_BASE_URL || 'http://127.0.0.1:3000';
  try {
    const healthResponse = await fetch(`${baseUrl}/api/v1/health`);
    if (!healthResponse.ok) {
      t.skip(`Development API is not healthy at ${baseUrl}.`);
      return;
    }
  } catch (err) {
    if (/connect EPERM|Local TCP access blocked|operation not permitted|ECONNREFUSED|fetch failed/i.test(String(err?.message || ''))) {
      t.skip(`Development API is not reachable at ${baseUrl}.`);
      return;
    }
    throw err;
  }

  ensureDevDriversSeeded();

  const localPhone = `9${String(Date.now()).slice(-9)}`;
  const countryCode = '+91';
  const requestOtp = await requestJson(baseUrl, '/api/v1/auth/request-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: localPhone,
      countryCode,
      channel: 'sms',
    }),
  });
  assert.equal(requestOtp.status, 200);
  const requestId = requestOtp.body?.data?.requestId;
  assert.ok(requestId);

  await query(
    'identity_db',
    `UPDATE otp_requests
     SET otp_code = $2
     WHERE id = $1`,
    [requestId, hashOtp('123456', devEnv.OTP_SECRET || 'test-otp-secret')],
  );

  const login = await requestJson(baseUrl, '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: localPhone,
      countryCode,
      otp: '123456',
      requestId,
      deviceId: `ride-request-dev-it-${Date.now()}`,
      platform: 'android',
      fcmToken: `dev-it-token-${Date.now()}`,
    }),
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const accessToken = login.body?.data?.accessToken;
  const userId = login.body?.data?.user?.id;
  assert.ok(accessToken);
  assert.ok(userId);

  const ridesProjection = await waitForCondition(async () => {
    const rows = await query(
      'rides_db',
      `SELECT rider_id::text AS rider_id, user_id::text AS user_id
       FROM ride_rider_projection
       WHERE user_id = $1`,
      [userId],
    );
    return rows[0] || null;
  }, 10000, 250);
  assert.ok(ridesProjection, 'ride_rider_projection was not created after login');

  const driversProjection = await waitForCondition(async () => {
    const rows = await query(
      'drivers_db',
      `SELECT rider_id::text AS rider_id, user_id::text AS user_id, COALESCE(display_name, '') AS display_name
       FROM rider_user_projection
       WHERE user_id = $1`,
      [userId],
    );
    return rows[0] || null;
  }, 10000, 250);
  assert.ok(driversProjection, 'rider_user_projection was not created after login');

  const profileCreate = await requestJson(baseUrl, '/api/v1/profile/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      name: 'Dev Rider Integration',
      gender: 'Male',
      date_of_birth: '10 March 1995',
      email: `dev-rider-${Date.now()}@goapp.local`,
      emergency_contact: '9876543210',
    }),
  });
  assert.equal(profileCreate.status, 200, JSON.stringify(profileCreate.body));

  const refreshedProjection = await waitForCondition(async () => {
    const rows = await query(
      'drivers_db',
      `SELECT COALESCE(display_name, '') AS display_name
       FROM rider_user_projection
       WHERE user_id = $1`,
      [userId],
    );
    return rows[0]?.display_name === 'Dev Rider Integration' ? rows[0] : null;
  }, 10000, 250);
  assert.ok(refreshedProjection, 'rider projection display_name was not refreshed after profile create');

  const rideRequest = await requestJson(baseUrl, '/api/v1/rides/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Idempotency-Key': `ride-request-dev-it-${Date.now()}`,
    },
    body: JSON.stringify({
      riderId: userId,
      pickupLat: 13.0833913,
      pickupLng: 80.1499398,
      destLat: 13.080874,
      destLng: 80.164234,
      pickupAddress: 'Gpvalencia, Mel Ayanambakkam, Chennai',
      destAddress: '103 HIG Mogappair West, Chennai',
      rideType: 'bike',
    }),
  });
  assert.equal(rideRequest.status, 200, JSON.stringify(rideRequest.body));
  const rideNumber = rideRequest.body?.rideId;
  assert.ok(rideNumber);

  const matchedRide = await waitForCondition(async () => {
    const rows = await query(
      'rides_db',
      `SELECT ride_number,
              status,
              driver_id::text AS driver_id,
              estimated_fare
       FROM rides
       WHERE ride_number = $1`,
      [rideNumber],
    );
    const ride = rows[0] || null;
    if (!ride) return null;
    if (!['driver_assigned', 'driver_arriving'].includes(String(ride.status))) return null;
    return ride;
  }, 15000, 500);

  assert.ok(matchedRide, 'ride was not matched within the expected window');
  assert.equal(matchedRide.driver_id, '20000000-0000-4000-8000-000000000001');
  assert.ok(['driver_assigned', 'driver_arriving'].includes(matchedRide.status));
  assert.equal(Number(matchedRide.estimated_fare), 42);

  const rideOtp = await waitForCondition(async () => {
    const rows = await query(
      'rides_db',
      `SELECT ro.otp_code
       FROM ride_otp ro
       JOIN rides r ON r.id = ro.ride_id
       WHERE r.ride_number = $1
       ORDER BY ro.created_at DESC
       LIMIT 1`,
      [rideNumber],
    );
    return rows[0]?.otp_code || null;
  }, 10000, 250);
  assert.match(String(rideOtp || ''), /^\d{4}$/);

  const rideDetails = await waitForCondition(async () => {
    const response = await requestJson(baseUrl, `/api/v1/rides/${rideNumber}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (response.status !== 200) return null;
    const payload = response.body?.data || response.body;
    if (!payload?.driver?.name) return null;
    if (!payload?.otp) return null;
    return payload;
  }, 10000, 250);

  assert.ok(rideDetails, 'ride details payload did not include driver info and ride OTP');
  assert.equal(rideDetails.driver.name, 'Arun Bike');
  assert.equal(rideDetails.driver.vehicleNumber, 'TN09DEV1001');
  assert.equal(rideDetails.driver.phone, '+919876500001');
  assert.equal(rideDetails.driver.rating, 4.9);
  assert.equal(rideDetails.driver.completedRides, 155);
  assert.match(
    String(rideDetails.driver.avatarUrl || ''),
    /^\/api\/v1\/drivers\/20000000-0000-4000-8000-000000000001\/avatar\?v=\d+$/,
  );
  assert.equal(rideDetails.driverAvatarUrl, rideDetails.driver.avatarUrl);
  assert.equal(rideDetails.driverCompletedRides, 155);
  assert.equal(rideDetails.matchResult?.driverId, '20000000-0000-4000-8000-000000000001');
  assert.equal(rideDetails.matchResult?.driverName, 'Arun Bike');
  assert.equal(rideDetails.matchResult?.vehicleNumber, 'TN09DEV1001');
  assert.equal(rideDetails.matchResult?.driverPhone, '+919876500001');
  assert.equal(rideDetails.matchResult?.driverRating, 4.9);
  assert.equal(rideDetails.matchResult?.completedRides, 155);
  assert.match(
    String(rideDetails.matchResult?.avatarUrl || ''),
    /^\/api\/v1\/drivers\/20000000-0000-4000-8000-000000000001\/avatar\?v=\d+$/,
  );
  assert.equal(rideDetails.otp, rideOtp);
});
