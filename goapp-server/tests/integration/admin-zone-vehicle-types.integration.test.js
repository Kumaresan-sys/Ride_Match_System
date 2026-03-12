'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('admin zone vehicle type toggle is reflected by public vehicle type discovery', { timeout: 60000 }, async (t) => {
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

  const adminToken = devEnv.GOAPP_ADMIN_TOKEN || 'goapp-admin-secret';
  const pickupLat = 13.0833913;
  const pickupLng = 80.1499398;
  const zoneId = `92000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
  const zoneName = `ADMIN-ZONE-${Date.now()}`;

  const vehicleTypeRows = await query(
    'goapp_enterprise',
    `SELECT id::text AS id, name
       FROM vehicle_types
      WHERE name IN ('bike', 'sedan')
      ORDER BY name`,
  );
  const vehicleTypeIdByName = new Map(vehicleTypeRows.map((row) => [row.name, row.id]));
  const sedanVehicleTypeId = vehicleTypeIdByName.get('sedan');
  const bikeVehicleTypeId = vehicleTypeIdByName.get('bike');
  assert.ok(sedanVehicleTypeId, 'sedan vehicle type must exist');
  assert.ok(bikeVehicleTypeId, 'bike vehicle type must exist');

  await execute(
    'rides_db',
    `INSERT INTO zone_restrictions
       (id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled, restriction_message, created_by)
     VALUES ($1, $2, $3, $4, $5, 'both', true, true, 'Admin zone test', 'integration-test')`,
    [zoneId, zoneName, pickupLat, pickupLng, 1.0],
  );
  await execute(
    'rides_db',
    `INSERT INTO zone_vehicle_type_availability
       (zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by)
     VALUES ($1, $2, 'bike', true, 'integration-test')
     ON CONFLICT (zone_id, vehicle_type_id)
     DO UPDATE SET
       vehicle_type_name = EXCLUDED.vehicle_type_name,
       is_enabled = EXCLUDED.is_enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [zoneId, bikeVehicleTypeId],
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

  const before = await requestJson(
    baseUrl,
    `/api/v1/vehicle-types?pickupLat=${pickupLat}&pickupLng=${pickupLng}`,
  );
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const beforeNames = (before.body?.data?.vehicleTypes || []).map((item) =>
    String(item.name || '').toLowerCase(),
  );
  assert.ok(beforeNames.includes('bike'), `expected bike before toggle in ${JSON.stringify(beforeNames)}`);
  assert.ok(!beforeNames.includes('sedan'), `did not expect sedan before toggle in ${JSON.stringify(beforeNames)}`);

  const update = await requestJson(
    baseUrl,
    `/api/v1/admin/zones/${zoneId}/vehicle-types/${sedanVehicleTypeId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': adminToken,
        'x-admin-id': 'integration-admin',
      },
      body: JSON.stringify({ isEnabled: true }),
    },
  );
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body?.data?.availability?.zoneId, zoneId);
  assert.equal(update.body?.data?.availability?.vehicleTypeId, sedanVehicleTypeId);
  assert.equal(update.body?.data?.availability?.isEnabled, true);

  const after = await requestJson(
    baseUrl,
    `/api/v1/vehicle-types?pickupLat=${pickupLat}&pickupLng=${pickupLng}`,
  );
  assert.equal(after.status, 200, JSON.stringify(after.body));
  const afterNames = (after.body?.data?.vehicleTypes || []).map((item) =>
    String(item.name || '').toLowerCase(),
  );
  assert.ok(afterNames.includes('bike'), `expected bike after toggle in ${JSON.stringify(afterNames)}`);
  assert.ok(afterNames.includes('sedan'), `expected sedan after toggle in ${JSON.stringify(afterNames)}`);
});
