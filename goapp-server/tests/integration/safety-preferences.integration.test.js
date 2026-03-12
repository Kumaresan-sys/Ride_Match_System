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

test('safety preferences route persists flags in identity_db', { timeout: 60000 }, async (t) => {
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

  const schemaRows = await query(
    'identity_db',
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'safety_preferences'`,
  );
  assert.equal(schemaRows.length, 1, 'identity_db.safety_preferences must exist');

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
      deviceId: `safety-prefs-it-${Date.now()}`,
      platform: 'android',
      fcmToken: `safety-prefs-token-${Date.now()}`,
    }),
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));

  const accessToken = login.body?.data?.accessToken;
  const userId = login.body?.data?.user?.id;
  assert.ok(accessToken);
  assert.ok(userId);

  const before = await requestJson(baseUrl, '/api/v1/safety/preferences', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(typeof before.body?.autoShare, 'boolean');
  assert.equal(typeof before.body?.shareAtNight, 'boolean');

  const updated = await requestJson(baseUrl, '/api/v1/safety/preferences', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      autoShare: true,
      shareAtNight: true,
    }),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body?.success, true);
  assert.equal(updated.body?.autoShare, true);
  assert.equal(updated.body?.shareAtNight, true);

  const after = await requestJson(baseUrl, '/api/v1/safety/preferences', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body?.autoShare, true);
  assert.equal(after.body?.shareAtNight, true);

  const persistedRows = await query(
    'identity_db',
    `SELECT auto_share, share_at_night
       FROM safety_preferences
      WHERE user_id = $1`,
    [userId],
  );

  assert.equal(persistedRows.length, 1);
  assert.equal(persistedRows[0].auto_share, true);
  assert.equal(persistedRows[0].share_at_night, true);
});
