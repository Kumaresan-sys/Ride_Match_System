// GoApp Integration Test — DB Setup Helper
// Creates and tears down the minimal schema needed for integration tests.
// Called from test.before() / test.after() in integration test files.
//
// Requires: NODE_ENV=test, running PostgreSQL with goapp_test DB.

'use strict';

const db = require('../../services/db');
const { logger } = require('../../utils/logger');

async function setupTestDb() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Drop and recreate test tables so every run starts clean.
    // Extend this as more DB-backed services are added.
    await client.query(`
      DROP TABLE IF EXISTS goapp_test_sentinel;
      CREATE TABLE goapp_test_sentinel (
        id         SERIAL      PRIMARY KEY,
        label      TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query('COMMIT');
    logger.info('TEST_DB', 'Test schema ready');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function teardownTestDb() {
  await db.query('DROP TABLE IF EXISTS goapp_test_sentinel');
  if (db.pool) {
    await db.pool.end();
    logger.info('TEST_DB', 'Connection pool closed');
  }
}

module.exports = { setupTestDb, teardownTestDb };
