// GoApp Integration Tests — Refresh Token Security (PostgreSQL repository)
// Requires: NODE_ENV=test, running PostgreSQL with goapp_enterprise DB
// Run: NODE_ENV=test node --test --test-force-exit tests/integration/refresh-token-security.integration.test.js

'use strict';

require('../../config/env-loader');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const db = require('../../services/db');
const repo = require('../../repositories/pg/pg-identity-repository');

function makeFixtureIds() {
  return {
    userId: crypto.randomUUID(),
    deviceRowId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    refreshHash: `refresh-hash-${crypto.randomUUID()}`,
    phoneNumber: `+9199${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 10)}`,
    email: `refresh-int-${crypto.randomUUID()}@example.com`,
  };
}

async function ensureIdentitySchema() {
  await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_number   VARCHAR(20) UNIQUE NOT NULL,
      email          VARCHAR(255) UNIQUE,
      phone_verified BOOLEAN DEFAULT false,
      user_type      VARCHAR(20) NOT NULL CHECK (user_type IN ('rider','driver','admin','support')),
      status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','active','suspended','deactivated','banned')),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at     TIMESTAMPTZ,
      version        INTEGER NOT NULL DEFAULT 1
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        UUID NOT NULL REFERENCES users(id),
      device_id      VARCHAR(255) NOT NULL,
      device_type    VARCHAR(20) CHECK (device_type IN ('ios','android','web')),
      device_model   VARCHAR(100),
      os_version     VARCHAR(50),
      app_version    VARCHAR(50),
      fcm_token      TEXT,
      apns_token     TEXT,
      is_active      BOOLEAN DEFAULT true,
      last_active_at TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id),
      device_id     UUID REFERENCES user_devices(id),
      session_token VARCHAR(512) UNIQUE NOT NULL,
      refresh_token VARCHAR(512) UNIQUE,
      ip_address    INET,
      user_agent    TEXT,
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMPTZ NOT NULL,
      revoked_at    TIMESTAMPTZ
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_security_logs (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id),
      event_type   VARCHAR(50) NOT NULL,
      event_detail JSONB,
      ip_address   INET,
      device_id    UUID REFERENCES user_devices(id),
      risk_level   VARCHAR(10) CHECK (risk_level IN ('low','medium','high','critical')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS refresh_token_security (
      refresh_token_hash       VARCHAR(512) PRIMARY KEY,
      user_id                  UUID NOT NULL REFERENCES users(id),
      device_id                UUID REFERENCES user_devices(id),
      suspicious_attempt_count INTEGER NOT NULL DEFAULT 0,
      first_suspicious_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_suspicious_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_reason              VARCHAR(50),
      revoked_at               TIMESTAMPTZ
    )
  `);
}

async function cleanupFixtureRows(fixture) {
  await db.query('DELETE FROM refresh_token_security WHERE refresh_token_hash = $1', [fixture.refreshHash]);
  await db.query('DELETE FROM user_security_logs WHERE user_id = $1', [fixture.userId]);
  await db.query('DELETE FROM user_sessions WHERE id = $1 OR user_id = $2', [fixture.sessionId, fixture.userId]);
  await db.query('DELETE FROM user_devices WHERE id = $1 OR user_id = $2', [fixture.deviceRowId, fixture.userId]);
  await db.query('DELETE FROM users WHERE id = $1', [fixture.userId]);
}

async function seedAuthRows(fixture) {
  await db.query(
    `INSERT INTO users (id, phone_number, email, phone_verified, user_type, status)
     VALUES ($1, $2, $3, true, 'rider', 'active')`,
    [fixture.userId, fixture.phoneNumber, fixture.email]
  );

  await db.query(
    `INSERT INTO user_devices (id, user_id, device_id, device_type, is_active, last_active_at)
     VALUES ($1, $2, $3, $4, true, NOW())`,
    [fixture.deviceRowId, fixture.userId, 'android-bound-int-1', 'android']
  );

  await db.query(
    `INSERT INTO user_sessions (
       id, user_id, device_id, session_token, refresh_token, is_active, expires_at
     )
     VALUES ($1, $2, $3, $4, $5, true, NOW() + INTERVAL '30 days')`,
    [fixture.sessionId, fixture.userId, fixture.deviceRowId, 'access-token-int-1', fixture.refreshHash]
  );
}

test.after(async () => {
  if (db.pool) {
    await db.pool.end();
  }
});

test.before(async () => {
  await ensureIdentitySchema();
});

test('recordSuspiciousRefreshAttempt persists strikes and revokes at threshold', async () => {
  const fixture = makeFixtureIds();
  try {
    await seedAuthRows(fixture);

    const first = await repo.recordSuspiciousRefreshAttempt({
      refreshTokenHash: fixture.refreshHash,
      userId: fixture.userId,
      deviceRecordId: fixture.deviceRowId,
      reason: 'device_mismatch',
      maxAttempts: 3,
    });

    assert.deepEqual(first, { attempts: 1, revoked: false });

    const second = await repo.recordSuspiciousRefreshAttempt({
      refreshTokenHash: fixture.refreshHash,
      userId: fixture.userId,
      deviceRecordId: fixture.deviceRowId,
      reason: 'device_mismatch',
      maxAttempts: 3,
    });

    assert.deepEqual(second, { attempts: 2, revoked: false });

    const third = await repo.recordSuspiciousRefreshAttempt({
      refreshTokenHash: fixture.refreshHash,
      userId: fixture.userId,
      deviceRecordId: fixture.deviceRowId,
      reason: 'device_mismatch',
      maxAttempts: 3,
    });

    assert.deepEqual(third, { attempts: 3, revoked: true });

    const persisted = await db.query(
      `SELECT suspicious_attempt_count, last_reason, revoked_at IS NOT NULL AS revoked
       FROM refresh_token_security
       WHERE refresh_token_hash = $1`,
      [fixture.refreshHash]
    );

    assert.equal(persisted.rows.length, 1);
    assert.equal(Number(persisted.rows[0].suspicious_attempt_count), 3);
    assert.equal(persisted.rows[0].last_reason, 'device_mismatch');
    assert.equal(persisted.rows[0].revoked, true);
  } finally {
    await cleanupFixtureRows(fixture);
  }
});

test('clearSuspiciousRefreshAttempts removes the persisted counter row', async () => {
  const fixture = makeFixtureIds();
  try {
    await seedAuthRows(fixture);

    await repo.recordSuspiciousRefreshAttempt({
      refreshTokenHash: fixture.refreshHash,
      userId: fixture.userId,
      deviceRecordId: fixture.deviceRowId,
      reason: 'device_mismatch',
      maxAttempts: 3,
    });

    await repo.clearSuspiciousRefreshAttempts(fixture.refreshHash);

    const persisted = await db.query(
      `SELECT COUNT(*) AS cnt
       FROM refresh_token_security
       WHERE refresh_token_hash = $1`,
      [fixture.refreshHash]
    );

    assert.equal(Number(persisted.rows[0].cnt), 0);
  } finally {
    await cleanupFixtureRows(fixture);
  }
});

test('revokeSessionByRefreshToken deactivates the matching session row', async () => {
  const fixture = makeFixtureIds();
  try {
    await seedAuthRows(fixture);

    await repo.revokeSessionByRefreshToken(fixture.refreshHash);

    const session = await db.query(
      `SELECT is_active, revoked_at IS NOT NULL AS revoked
       FROM user_sessions
       WHERE refresh_token = $1`,
      [fixture.refreshHash]
    );

    assert.equal(session.rows.length, 1);
    assert.equal(session.rows[0].is_active, false);
    assert.equal(session.rows[0].revoked, true);
  } finally {
    await cleanupFixtureRows(fixture);
  }
});
