// GoApp Integration Tests — PostgreSQL (services/db.js)
// Requires: NODE_ENV=test, running PostgreSQL with goapp_test DB
// Run: npm run test:integration

'use strict';

// env-loader must be first to populate process.env from .env.test
require('../../config/env-loader');

const test   = require('node:test');
const assert = require('node:assert/strict');
const db     = require('../../services/db');
const { setupTestDb, teardownTestDb } = require('../helpers/test-db-setup');

test.before(async () => {
  await setupTestDb();
});

test.after(async () => {
  await teardownTestDb();
});

test('db backend is pg in test environment', () => {
  assert.equal(db.backend, 'pg', 'Expected pg backend when NODE_ENV=test');
  assert.ok(db.pool, 'Pool should be defined in pg mode');
});

test('db.query: insert and select', async () => {
  await db.query("INSERT INTO goapp_test_sentinel (label) VALUES ($1)", ['insert-test']);
  const result = await db.query("SELECT label FROM goapp_test_sentinel WHERE label = $1", ['insert-test']);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].label, 'insert-test');
});

test('db.getClient: transaction commit', async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO goapp_test_sentinel (label) VALUES ($1)", ['txn-commit']);
    await client.query('COMMIT');

    const result = await db.query("SELECT COUNT(*) AS cnt FROM goapp_test_sentinel WHERE label = $1", ['txn-commit']);
    assert.ok(Number(result.rows[0].cnt) >= 1, 'Row should exist after commit');
  } finally {
    client.release();
  }
});

test('db.getClient: transaction rollback', async () => {
  const before = await db.query("SELECT COUNT(*) AS cnt FROM goapp_test_sentinel WHERE label = $1", ['txn-rollback']);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO goapp_test_sentinel (label) VALUES ($1)", ['txn-rollback']);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const after = await db.query("SELECT COUNT(*) AS cnt FROM goapp_test_sentinel WHERE label = $1", ['txn-rollback']);
  assert.equal(after.rows[0].cnt, before.rows[0].cnt, 'Row count should be unchanged after rollback');
});
