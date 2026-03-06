// GoApp Unified Database Interface
// Selects the correct backend based on DB_BACKEND environment variable:
//   DB_BACKEND=mock  → in-memory MockDb adapter (no PostgreSQL required)
//   DB_BACKEND=pg    → real PostgreSQL via pg.Pool
//
// Exported API (same regardless of backend):
//   query(text, params)  → Promise<{ rows, rowCount }>
//   getClient()          → Promise<pg.PoolClient | MockClient>
//   pool                 → pg.Pool | null

'use strict';

const config = require('../config');
const { logger } = require('../utils/logger');

const BACKEND = config.db.backend; // 'mock' | 'pg'

// ─── Mock Adapter ─────────────────────────────────────────────────────────────
// Returns a no-op adapter. Services that need actual seeded data in development
// continue to import mock-db.js directly. This shim prevents crashes for any
// future route handlers or services that call db.query() generically.

function buildMockAdapter() {
  logger.info('DB', 'Using mock-db adapter (in-memory, no PostgreSQL required)');

  const adapter = {
    pool: null,

    async query(text, _params) {
      logger.warn('DB', `Mock query (no-op): ${String(text).slice(0, 80)}`);
      return { rows: [], rowCount: 0 };
    },

    async getClient() {
      return {
        query:   async (_t, _p) => ({ rows: [], rowCount: 0 }),
        release: () => {},
      };
    },
  };

  return adapter;
}

// ─── PostgreSQL Adapter ────────────────────────────────────────────────────────

function buildPgAdapter() {
  const { Pool } = require('pg');

  const pool = new Pool({
    host:     config.db.host,
    port:     config.db.port,
    user:     config.db.user,
    password: config.db.password,
    database: config.db.database,
    min:      config.db.pool.min,
    max:      config.db.pool.max,
    // Idle connections released after 30s to avoid holding resources
    idleTimeoutMillis: 30_000,
    // Fail fast if Postgres is unreachable — reveals misconfiguration at startup
    connectionTimeoutMillis: 5_000,
    ...(config.db.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  pool.on('error', (err) => {
    logger.error('DB', `PG pool error: ${err.message}`);
  });

  pool.on('connect', () => {
    logger.info('DB', `Connected to PostgreSQL ${config.db.host}:${config.db.port}/${config.db.database}`);
  });

  logger.info('DB', `Using PostgreSQL adapter — pool min:${config.db.pool.min} max:${config.db.pool.max}`);

  return {
    pool,

    async query(text, params) {
      const t0 = Date.now();
      try {
        const result = await pool.query(text, params);
        const duration = Date.now() - t0;
        if (duration > 1000) {
          logger.warn('DB', `Slow query (${duration}ms): ${String(text).slice(0, 120)}`);
        }
        return result;
      } catch (err) {
        logger.error('DB', `Query error: ${err.message} | SQL: ${String(text).slice(0, 120)}`);
        throw err;
      }
    },

    async getClient() {
      return pool.connect();
    },
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

const adapter = BACKEND === 'pg' ? buildPgAdapter() : buildMockAdapter();

module.exports = {
  query:     adapter.query.bind(adapter),
  getClient: adapter.getClient.bind(adapter),
  pool:      adapter.pool,
  backend:   BACKEND,
};
