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

test('admin bulk zone pricing updates multiple ride types in a single request', { timeout: 60000 }, async (t) => {
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
  const destLat = 13.080874;
  const destLng = 80.164234;
  const zoneId = `93000000-0000-4000-8300-${String(Date.now()).slice(-12)}`;
  const zoneName = `ADMIN-BULK-PRICING-ZONE-${Date.now()}`;

  const vehicleTypeRows = await query(
    'goapp_enterprise',
    `SELECT id::text AS id, name, per_km_rate, per_min_rate, min_fare
       FROM vehicle_types
      WHERE name IN ('sedan', 'premium')
      ORDER BY name`,
  );
  const byName = new Map(vehicleTypeRows.map((row) => [row.name, row]));
  const sedan = byName.get('sedan');
  const premium = byName.get('premium');
  assert.ok(sedan, 'sedan vehicle type must exist');
  assert.ok(premium, 'premium vehicle type must exist');

  await execute(
    'rides_db',
    `INSERT INTO zone_restrictions
       (id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled, restriction_message, created_by)
     VALUES ($1, $2, $3, $4, $5, 'both', true, true, 'Admin bulk pricing zone test', 'integration-test')`,
    [zoneId, zoneName, pickupLat, pickupLng, 1.0],
  );
  await execute(
    'rides_db',
    `INSERT INTO zone_vehicle_type_availability
       (zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by)
     VALUES ($1, $2, $3, true, 'integration-test')
     ON CONFLICT (zone_id, vehicle_type_id)
     DO UPDATE SET
       vehicle_type_name = EXCLUDED.vehicle_type_name,
       is_enabled = EXCLUDED.is_enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [zoneId, sedan.id, 'sedan'],
  );
  await execute(
    'rides_db',
    `INSERT INTO zone_vehicle_type_availability
       (zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by)
     VALUES ($1, $2, $3, true, 'integration-test')
     ON CONFLICT (zone_id, vehicle_type_id)
     DO UPDATE SET
       vehicle_type_name = EXCLUDED.vehicle_type_name,
       is_enabled = EXCLUDED.is_enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [zoneId, premium.id, 'premium'],
  );

  t.after(async () => {
    await execute('rides_db', `DELETE FROM zone_vehicle_type_pricing WHERE zone_id = $1`, [zoneId]).catch(() => {});
    await execute('rides_db', `DELETE FROM zone_vehicle_type_availability WHERE zone_id = $1`, [zoneId]).catch(() => {});
    await execute('rides_db', `DELETE FROM zone_restrictions WHERE id = $1`, [zoneId]).catch(() => {});
  });

  const bulkUpdate = await requestJson(
    baseUrl,
    `/api/v1/admin/zones/${zoneId}/vehicle-types/pricing/bulk`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': adminToken,
        'x-admin-id': 'integration-admin',
      },
      body: JSON.stringify({
        pricing: [
          {
            vehicleTypeId: sedan.id,
            baseFare: 123,
            perKmRate: Number(sedan.per_km_rate),
            perMinRate: Number(sedan.per_min_rate),
            minFare: Number(sedan.min_fare),
          },
          {
            vehicleTypeId: premium.id,
            baseFare: 234,
            perKmRate: Number(premium.per_km_rate),
            perMinRate: Number(premium.per_min_rate),
            minFare: Number(premium.min_fare),
          },
        ],
      }),
    },
  );
  assert.equal(bulkUpdate.status, 200, JSON.stringify(bulkUpdate.body));
  const updates = bulkUpdate.body?.data?.updates || [];
  assert.equal(updates.length, 2);

  const updateByName = new Map(updates.map((item) => [String(item.vehicleTypeName).toLowerCase(), item]));
  assert.equal(updateByName.get('sedan')?.baseFare, 123);
  assert.equal(updateByName.get('premium')?.baseFare, 234);

  const listResponse = await requestJson(
    baseUrl,
    `/api/v1/admin/zones/${zoneId}/vehicle-types`,
    {
      headers: {
        'x-admin-token': adminToken,
        'x-admin-id': 'integration-admin',
      },
    },
  );
  assert.equal(listResponse.status, 200, JSON.stringify(listResponse.body));
  const listedSedan = (listResponse.body?.data?.vehicleTypes || []).find((item) => String(item.name).toLowerCase() === 'sedan');
  const listedPremium = (listResponse.body?.data?.vehicleTypes || []).find((item) => String(item.name).toLowerCase() === 'premium');
  assert.equal(listedSedan?.effectivePricing?.baseFare, 123);
  assert.equal(listedPremium?.effectivePricing?.baseFare, 234);

  const fareResponse = await requestJson(baseUrl, '/api/v1/fare/estimate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pickupLat,
      pickupLng,
      destLat,
      destLng,
      rideType: 'sedan',
    }),
  });
  assert.equal(fareResponse.status, 200, JSON.stringify(fareResponse.body));
  assert.equal(fareResponse.body?.data?.estimates?.sedan?.breakdown?.baseFare, 123);
  assert.equal(fareResponse.body?.data?.estimates?.premium?.breakdown?.baseFare, 234);
});

test('admin bulk zone pricing rejects invalid vehicleTypeId and applies no partial pricing overrides', { timeout: 60000 }, async (t) => {
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
  const zoneId = `93000000-0000-4000-8400-${String(Date.now()).slice(-12)}`;
  const zoneName = `ADMIN-BULK-PRICING-NEGATIVE-ZONE-${Date.now()}`;
  const invalidVehicleTypeId = '00000000-0000-4000-8000-000000000998';

  const vehicleTypeRows = await query(
    'goapp_enterprise',
    `SELECT id::text AS id, name, base_fare, per_km_rate, per_min_rate, min_fare
       FROM vehicle_types
      WHERE name IN ('sedan', 'premium')
      ORDER BY name`,
  );
  const byName = new Map(vehicleTypeRows.map((row) => [row.name, row]));
  const sedan = byName.get('sedan');
  const premium = byName.get('premium');
  assert.ok(sedan, 'sedan vehicle type must exist');
  assert.ok(premium, 'premium vehicle type must exist');

  await execute(
    'rides_db',
    `INSERT INTO zone_restrictions
       (id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled, restriction_message, created_by)
     VALUES ($1, $2, $3, $4, $5, 'both', true, true, 'Admin bulk pricing negative zone test', 'integration-test')`,
    [zoneId, zoneName, pickupLat, pickupLng, 1.0],
  );
  await execute(
    'rides_db',
    `INSERT INTO zone_vehicle_type_availability
       (zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by)
     VALUES ($1, $2, $3, true, 'integration-test')
     ON CONFLICT (zone_id, vehicle_type_id)
     DO UPDATE SET
       vehicle_type_name = EXCLUDED.vehicle_type_name,
       is_enabled = EXCLUDED.is_enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [zoneId, sedan.id, 'sedan'],
  );
  await execute(
    'rides_db',
    `INSERT INTO zone_vehicle_type_availability
       (zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by)
     VALUES ($1, $2, $3, true, 'integration-test')
     ON CONFLICT (zone_id, vehicle_type_id)
     DO UPDATE SET
       vehicle_type_name = EXCLUDED.vehicle_type_name,
       is_enabled = EXCLUDED.is_enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [zoneId, premium.id, 'premium'],
  );

  t.after(async () => {
    await execute('rides_db', `DELETE FROM zone_vehicle_type_pricing WHERE zone_id = $1`, [zoneId]).catch(() => {});
    await execute('rides_db', `DELETE FROM zone_vehicle_type_availability WHERE zone_id = $1`, [zoneId]).catch(() => {});
    await execute('rides_db', `DELETE FROM zone_restrictions WHERE id = $1`, [zoneId]).catch(() => {});
  });

  const beforeRows = await query(
    'rides_db',
    `SELECT vehicle_type_id::text AS vehicle_type_id, vehicle_type_name, base_fare, per_km_rate, per_min_rate, min_fare
       FROM zone_vehicle_type_pricing
      WHERE zone_id = $1
      ORDER BY vehicle_type_name ASC`,
    [zoneId],
  );
  assert.deepEqual(beforeRows, []);

  const bulkUpdate = await requestJson(
    baseUrl,
    `/api/v1/admin/zones/${zoneId}/vehicle-types/pricing/bulk`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': adminToken,
        'x-admin-id': 'integration-admin',
      },
      body: JSON.stringify({
        pricing: [
          {
            vehicleTypeId: sedan.id,
            baseFare: 123,
            perKmRate: Number(sedan.per_km_rate),
            perMinRate: Number(sedan.per_min_rate),
            minFare: Number(sedan.min_fare),
          },
          {
            vehicleTypeId: invalidVehicleTypeId,
            baseFare: 234,
            perKmRate: Number(premium.per_km_rate),
            perMinRate: Number(premium.per_min_rate),
            minFare: Number(premium.min_fare),
          },
        ],
      }),
    },
  );
  assert.equal(bulkUpdate.status, 404, JSON.stringify(bulkUpdate.body));
  assert.equal(bulkUpdate.body?.success, false);
  assert.equal(bulkUpdate.body?.errorCode, 'VEHICLE_TYPE_NOT_FOUND');

  const afterRows = await query(
    'rides_db',
    `SELECT vehicle_type_id::text AS vehicle_type_id, vehicle_type_name, base_fare, per_km_rate, per_min_rate, min_fare
       FROM zone_vehicle_type_pricing
      WHERE zone_id = $1
      ORDER BY vehicle_type_name ASC`,
    [zoneId],
  );
  assert.deepEqual(afterRows, beforeRows, 'bulk pricing request with invalid vehicle type should not partially create overrides');

  const listResponse = await requestJson(
    baseUrl,
    `/api/v1/admin/zones/${zoneId}/vehicle-types`,
    {
      headers: {
        'x-admin-token': adminToken,
        'x-admin-id': 'integration-admin',
      },
    },
  );
  assert.equal(listResponse.status, 200, JSON.stringify(listResponse.body));
  const listedSedan = (listResponse.body?.data?.vehicleTypes || []).find((item) => String(item.name).toLowerCase() === 'sedan');
  assert.equal(listedSedan?.zonePricing, null);
  assert.equal(listedSedan?.effectivePricing?.baseFare, listedSedan?.baseFare);
});
