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

test('admin bulk zone vehicle type toggle updates multiple ride types and public discovery reflects them', { timeout: 60000 }, async (t) => {
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
  const zoneId = `93000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
  const zoneName = `ADMIN-BULK-ZONE-${Date.now()}`;

  const vehicleTypeRows = await query(
    'goapp_enterprise',
    `SELECT id::text AS id, name
       FROM vehicle_types
      WHERE name IN ('bike', 'sedan', 'premium')
      ORDER BY name`,
  );
  const vehicleTypeIdByName = new Map(vehicleTypeRows.map((row) => [row.name, row.id]));
  const bikeVehicleTypeId = vehicleTypeIdByName.get('bike');
  const sedanVehicleTypeId = vehicleTypeIdByName.get('sedan');
  const premiumVehicleTypeId = vehicleTypeIdByName.get('premium');
  assert.ok(bikeVehicleTypeId, 'bike vehicle type must exist');
  assert.ok(sedanVehicleTypeId, 'sedan vehicle type must exist');
  assert.ok(premiumVehicleTypeId, 'premium vehicle type must exist');

  await execute(
    'rides_db',
    `INSERT INTO zone_restrictions
       (id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled, restriction_message, created_by)
     VALUES ($1, $2, $3, $4, $5, 'both', true, true, 'Admin bulk zone test', 'integration-test')`,
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
  assert.ok(beforeNames.includes('bike'), `expected bike before bulk toggle in ${JSON.stringify(beforeNames)}`);
  assert.ok(!beforeNames.includes('sedan'), `did not expect sedan before bulk toggle in ${JSON.stringify(beforeNames)}`);
  assert.ok(!beforeNames.includes('premium'), `did not expect premium before bulk toggle in ${JSON.stringify(beforeNames)}`);

  const bulkUpdate = await requestJson(
    baseUrl,
    `/api/v1/admin/zones/${zoneId}/vehicle-types/bulk`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': adminToken,
        'x-admin-id': 'integration-admin',
      },
      body: JSON.stringify({
        availability: [
          { vehicleTypeId: bikeVehicleTypeId, isEnabled: true },
          { vehicleTypeId: sedanVehicleTypeId, isEnabled: true },
          { vehicleTypeId: premiumVehicleTypeId, isEnabled: true },
        ],
      }),
    },
  );
  assert.equal(bulkUpdate.status, 200, JSON.stringify(bulkUpdate.body));
  const updates = bulkUpdate.body?.data?.updates || [];
  assert.equal(updates.length, 3);
  const updatesByVehicleTypeId = new Map(updates.map((item) => [item.vehicleTypeId, item]));
  assert.equal(updatesByVehicleTypeId.get(bikeVehicleTypeId)?.isEnabled, true);
  assert.equal(updatesByVehicleTypeId.get(sedanVehicleTypeId)?.isEnabled, true);
  assert.equal(updatesByVehicleTypeId.get(premiumVehicleTypeId)?.isEnabled, true);

  const after = await requestJson(
    baseUrl,
    `/api/v1/vehicle-types?pickupLat=${pickupLat}&pickupLng=${pickupLng}`,
  );
  assert.equal(after.status, 200, JSON.stringify(after.body));
  const afterNames = (after.body?.data?.vehicleTypes || []).map((item) =>
    String(item.name || '').toLowerCase(),
  );
  assert.ok(afterNames.includes('bike'), `expected bike after bulk toggle in ${JSON.stringify(afterNames)}`);
  assert.ok(afterNames.includes('sedan'), `expected sedan after bulk toggle in ${JSON.stringify(afterNames)}`);
  assert.ok(afterNames.includes('premium'), `expected premium after bulk toggle in ${JSON.stringify(afterNames)}`);
});

test('admin bulk zone vehicle type toggle rejects invalid vehicleTypeId and applies no partial updates', { timeout: 60000 }, async (t) => {
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
  const zoneId = `93000000-0000-4000-8100-${String(Date.now()).slice(-12)}`;
  const zoneName = `ADMIN-BULK-NEGATIVE-ZONE-${Date.now()}`;

  const vehicleTypeRows = await query(
    'goapp_enterprise',
    `SELECT id::text AS id, name
       FROM vehicle_types
      WHERE name IN ('bike', 'sedan')
      ORDER BY name`,
  );
  const vehicleTypeIdByName = new Map(vehicleTypeRows.map((row) => [row.name, row.id]));
  const bikeVehicleTypeId = vehicleTypeIdByName.get('bike');
  const sedanVehicleTypeId = vehicleTypeIdByName.get('sedan');
  const invalidVehicleTypeId = '00000000-0000-4000-8000-000000000999';
  assert.ok(bikeVehicleTypeId, 'bike vehicle type must exist');
  assert.ok(sedanVehicleTypeId, 'sedan vehicle type must exist');

  await execute(
    'rides_db',
    `INSERT INTO zone_restrictions
       (id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled, restriction_message, created_by)
     VALUES ($1, $2, $3, $4, $5, 'both', true, true, 'Admin bulk negative zone test', 'integration-test')`,
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

  const beforeRows = await query(
    'rides_db',
    `SELECT vehicle_type_id::text AS vehicle_type_id, vehicle_type_name, is_enabled
       FROM zone_vehicle_type_availability
      WHERE zone_id = $1
      ORDER BY vehicle_type_name ASC`,
    [zoneId],
  );
  assert.deepEqual(beforeRows, [
    {
      vehicle_type_id: bikeVehicleTypeId,
      vehicle_type_name: 'bike',
      is_enabled: true,
    },
  ]);

  const bulkUpdate = await requestJson(
    baseUrl,
    `/api/v1/admin/zones/${zoneId}/vehicle-types/bulk`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': adminToken,
        'x-admin-id': 'integration-admin',
      },
      body: JSON.stringify({
        availability: [
          { vehicleTypeId: bikeVehicleTypeId, isEnabled: false },
          { vehicleTypeId: invalidVehicleTypeId, isEnabled: true },
          { vehicleTypeId: sedanVehicleTypeId, isEnabled: true },
        ],
      }),
    },
  );
  assert.equal(bulkUpdate.status, 404, JSON.stringify(bulkUpdate.body));
  assert.equal(bulkUpdate.body?.success, false);
  assert.equal(bulkUpdate.body?.errorCode, 'VEHICLE_TYPE_NOT_FOUND');

  const afterRows = await query(
    'rides_db',
    `SELECT vehicle_type_id::text AS vehicle_type_id, vehicle_type_name, is_enabled
       FROM zone_vehicle_type_availability
      WHERE zone_id = $1
      ORDER BY vehicle_type_name ASC`,
    [zoneId],
  );
  assert.deepEqual(afterRows, beforeRows, 'bulk request with invalid vehicle type should not partially update zone availability');

  const discovery = await requestJson(
    baseUrl,
    `/api/v1/vehicle-types?pickupLat=${pickupLat}&pickupLng=${pickupLng}`,
  );
  assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
  const names = (discovery.body?.data?.vehicleTypes || []).map((item) =>
    String(item.name || '').toLowerCase(),
  );
  assert.ok(names.includes('bike'), `expected bike to remain available in ${JSON.stringify(names)}`);
  assert.ok(!names.includes('sedan'), `did not expect sedan after rejected bulk update in ${JSON.stringify(names)}`);
});
