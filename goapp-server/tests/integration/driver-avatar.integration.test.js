'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const dotenv = require('dotenv');
const { Client } = require('pg');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEV_ENV_FILES = [
  path.join(REPO_ROOT, '.env.development'),
  path.join(REPO_ROOT, '.env.development.local'),
];
const SEEDED_DRIVER_ID = '20000000-0000-4000-8000-000000000001';

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

test('authenticated rider can fetch seeded driver avatar from backend-owned local storage', { timeout: 60000 }, async (t) => {
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
      deviceId: `driver-avatar-it-${Date.now()}`,
      platform: 'android',
      fcmToken: `driver-avatar-token-${Date.now()}`,
    }),
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const accessToken = login.body?.data?.accessToken;
  assert.ok(accessToken);

  const avatarResponse = await fetch(`${baseUrl}/api/v1/drivers/${SEEDED_DRIVER_ID}/avatar`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  assert.equal(avatarResponse.status, 200);
  assert.equal(avatarResponse.headers.get('content-type'), 'image/svg+xml');
  const body = await avatarResponse.text();
  assert.match(body, /<svg/i);
  assert.match(body, /Arun Bike|AB/i);

  const avatarProjection = await query(
    'drivers_db',
    `SELECT
       dup.avatar_url,
       dup.completed_rides_count,
       dd.storage_key,
       dd.mime_type,
       dd.verification_status,
       dd.is_active
     FROM driver_user_projection dup
     JOIN LATERAL (
       SELECT storage_key, mime_type, verification_status, is_active
       FROM driver_documents
       WHERE driver_id = dup.driver_id
         AND document_type = 'profile_photo'
         AND is_active = true
       ORDER BY uploaded_at DESC
       LIMIT 1
     ) dd ON true
     WHERE dup.driver_id = $1`,
    [SEEDED_DRIVER_ID],
  );

  assert.equal(avatarProjection.length, 1);
  assert.match(String(avatarProjection[0].avatar_url || ''), /^\/api\/v1\/drivers\/20000000-0000-4000-8000-000000000001\/avatar\?v=\d+$/);
  assert.equal(Number(avatarProjection[0].completed_rides_count), 155);
  assert.equal(avatarProjection[0].mime_type, 'image/svg+xml');
  assert.equal(avatarProjection[0].verification_status, 'verified');
  assert.equal(avatarProjection[0].is_active, true);
  assert.ok(String(avatarProjection[0].storage_key || '').includes('/profile_photo/'));
});
