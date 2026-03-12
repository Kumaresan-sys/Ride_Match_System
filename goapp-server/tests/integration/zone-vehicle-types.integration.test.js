'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

async function execute(dbName, sql, params = []) {
  const client = new Client(makeDbConfig(dbName));
  await client.connect();
  try {
    await client.query(sql, params);
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
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(String(otpCode))
    .digest('hex');
}

test('zone-disabled sedan is excluded from discovery and rejected on ride request', { timeout: 60000 }, async (t) => {
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

  const pickupLat = 13.0833913;
  const pickupLng = 80.1499398;
  const zoneId = `91000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
  const zoneName = `IT-ZONE-${Date.now()}`;

  const vehicleTypeRows = await query(
    'goapp_enterprise',
    `SELECT id::text AS id, name
       FROM vehicle_types
      WHERE name IN ('bike', 'sedan')`,
  );
  const vehicleTypeIdByName = new Map(vehicleTypeRows.map((row) => [row.name, row.id]));
  assert.ok(vehicleTypeIdByName.get('bike'), 'bike vehicle type must exist');
  assert.ok(vehicleTypeIdByName.get('sedan'), 'sedan vehicle type must exist');

  await execute(
    'rides_db',
    `INSERT INTO zone_restrictions
       (id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled, restriction_message, created_by)
     VALUES ($1, $2, $3, $4, $5, 'both', true, true, 'Zone test', 'integration-test')`,
    [zoneId, zoneName, pickupLat, pickupLng, 1.0],
  );
  t.after(async () => {
    await execute(
      'rides_db',
      `DELETE FROM zone_vehicle_type_availability WHERE zone_id = $1`,
      [zoneId],
    ).catch(() => {});
    await execute(
      'rides_db',
      `DELETE FROM zone_restrictions WHERE id = $1`,
      [zoneId],
    ).catch(() => {});
  });

  await execute(
    'rides_db',
    `INSERT INTO zone_vehicle_type_availability
       (zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by)
     VALUES
       ($1, $2, 'bike', true, 'integration-test'),
       ($1, $3, 'sedan', false, 'integration-test')
     ON CONFLICT (zone_id, vehicle_type_id)
     DO UPDATE SET
       vehicle_type_name = EXCLUDED.vehicle_type_name,
       is_enabled = EXCLUDED.is_enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [zoneId, vehicleTypeIdByName.get('bike'), vehicleTypeIdByName.get('sedan')],
  );

  const vehicleTypes = await requestJson(
    baseUrl,
    `/api/v1/vehicle-types?pickupLat=${pickupLat}&pickupLng=${pickupLng}`,
  );
  assert.equal(vehicleTypes.status, 200, JSON.stringify(vehicleTypes.body));
  const returnedVehicleTypes = vehicleTypes.body?.data?.vehicleTypes || [];
  const returnedNames = returnedVehicleTypes.map((item) => String(item.name || '').toLowerCase());
  assert.ok(returnedNames.includes('bike'), `expected bike in ${JSON.stringify(returnedNames)}`);
  assert.ok(!returnedNames.includes('sedan'), `did not expect sedan in ${JSON.stringify(returnedNames)}`);

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
  assert.equal(requestOtp.status, 200, JSON.stringify(requestOtp.body));
  const requestId = requestOtp.body?.data?.requestId;
  assert.ok(requestId);

  await execute(
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
      deviceId: `zone-vehicle-types-it-${Date.now()}`,
      platform: 'android',
      fcmToken: `zone-vehicle-types-token-${Date.now()}`,
    }),
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const accessToken = login.body?.data?.accessToken;
  const userId = login.body?.data?.user?.id;
  assert.ok(accessToken);
  assert.ok(userId);

  const profileCreate = await requestJson(baseUrl, '/api/v1/profile/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      name: 'Zone Vehicle Type Integration',
      gender: 'Male',
      date_of_birth: '10 March 1995',
      email: `zone-it-${Date.now()}@goapp.local`,
      emergency_contact: '9876543210',
    }),
  });
  assert.equal(profileCreate.status, 200, JSON.stringify(profileCreate.body));

  const rideRequest = await requestJson(baseUrl, '/api/v1/rides/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Idempotency-Key': `zone-vehicle-types-it-${Date.now()}`,
    },
    body: JSON.stringify({
      riderId: userId,
      pickupLat,
      pickupLng,
      destLat: 13.080874,
      destLng: 80.164234,
      pickupAddress: 'Gpvalencia, Mel Ayanambakkam, Chennai',
      destAddress: '103 HIG Mogappair West, Chennai',
      rideType: 'sedan',
    }),
  });
  assert.equal(rideRequest.status, 400, JSON.stringify(rideRequest.body));
  assert.equal(
    rideRequest.body?.errorCode || rideRequest.body?.data?.errorCode,
    'RIDE_TYPE_NOT_AVAILABLE_IN_ZONE',
  );
  assert.match(
    String(rideRequest.body?.message || rideRequest.body?.error || ''),
    /not available in this zone/i,
  );
});
