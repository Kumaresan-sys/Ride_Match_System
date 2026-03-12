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

test('admin zone vehicle pricing override changes sedan fare estimate for that pickup zone', { timeout: 60000 }, async (t) => {
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
  const zoneId = `93000000-0000-4000-8200-${String(Date.now()).slice(-12)}`;
  const zoneName = `ADMIN-PRICING-ZONE-${Date.now()}`;

  const vehicleTypeRows = await query(
    'goapp_enterprise',
    `SELECT id::text AS id, name, base_fare, per_km_rate, per_min_rate, min_fare
       FROM vehicle_types
      WHERE name = 'sedan'
      LIMIT 1`,
  );
  const sedanVehicleType = vehicleTypeRows[0];
  assert.ok(sedanVehicleType, 'sedan vehicle type must exist');

  await execute(
    'rides_db',
    `INSERT INTO zone_restrictions
       (id, name, lat, lng, radius_km, applies_to, is_allowed, is_enabled, restriction_message, created_by)
     VALUES ($1, $2, $3, $4, $5, 'both', true, true, 'Admin pricing zone test', 'integration-test')`,
    [zoneId, zoneName, pickupLat, pickupLng, 1.0],
  );
  await execute(
    'rides_db',
    `INSERT INTO zone_vehicle_type_availability
       (zone_id, vehicle_type_id, vehicle_type_name, is_enabled, updated_by)
     VALUES ($1, $2, 'sedan', true, 'integration-test')
     ON CONFLICT (zone_id, vehicle_type_id)
     DO UPDATE SET
       vehicle_type_name = EXCLUDED.vehicle_type_name,
       is_enabled = EXCLUDED.is_enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [zoneId, sedanVehicleType.id],
  );

  t.after(async () => {
    await execute('rides_db', `DELETE FROM zone_vehicle_type_pricing WHERE zone_id = $1`, [zoneId]).catch(() => {});
    await execute('rides_db', `DELETE FROM zone_vehicle_type_availability WHERE zone_id = $1`, [zoneId]).catch(() => {});
    await execute('rides_db', `DELETE FROM zone_restrictions WHERE id = $1`, [zoneId]).catch(() => {});
  });

  const before = await requestJson(baseUrl, '/api/v1/fare/estimate', {
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
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const beforeSedan = before.body?.data?.estimates?.sedan;
  assert.ok(beforeSedan, 'sedan estimate must exist before pricing override');

  const pricingUpdate = await requestJson(
    baseUrl,
    `/api/v1/admin/zones/${zoneId}/vehicle-types/${sedanVehicleType.id}/pricing`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': adminToken,
        'x-admin-id': 'integration-admin',
      },
      body: JSON.stringify({
        baseFare: 123,
        perKmRate: Number(sedanVehicleType.per_km_rate),
        perMinRate: Number(sedanVehicleType.per_min_rate),
        minFare: Number(sedanVehicleType.min_fare),
      }),
    },
  );
  assert.equal(pricingUpdate.status, 200, JSON.stringify(pricingUpdate.body));
  assert.equal(pricingUpdate.body?.data?.pricing?.baseFare, 123);

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
  assert.ok(listedSedan, 'sedan must be present in zone vehicle type list');
  assert.equal(listedSedan.zonePricing?.baseFare, 123);
  assert.equal(listedSedan.effectivePricing?.baseFare, 123);

  const after = await requestJson(baseUrl, '/api/v1/fare/estimate', {
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
  assert.equal(after.status, 200, JSON.stringify(after.body));
  const afterSedan = after.body?.data?.estimates?.sedan;
  assert.ok(afterSedan, 'sedan estimate must exist after pricing override');
  assert.equal(afterSedan.breakdown?.baseFare, 123);
  assert.ok(afterSedan.finalFare > beforeSedan.finalFare, 'sedan fare should increase after base fare override');
});
