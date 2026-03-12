'use strict';

const { Pool } = require('pg');
const config = require('../../config');
const log = require('../observability/logger');

const DOMAINS = ['identity', 'drivers', 'rides', 'payments', 'analytics', 'support'];
const ROLES = ['writer', 'reader'];
const ISOLATION_LEVELS = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);

function baseDbConfig() {
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    min: config.db.pool.min,
    max: config.db.pool.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(config.db.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

class ConnectionManager {
  constructor() {
    this.pools = new Map();
    this.circuitState = new Map();
  }

  _poolKey(domain, role) {
    return `${domain}:${role}`;
  }

  _ensureDomain(domain) {
    if (!DOMAINS.includes(domain)) {
      throw new Error(`Unknown DB domain '${domain}'`);
    }
  }

  _buildPoolConfig(domain, role) {
    const topology = config.architecture?.dbTopology || {};
    const domainCfg = topology[domain] || {};
    const roleCfg = domainCfg[role] || {};
    return {
      ...baseDbConfig(),
      host: roleCfg.host || domainCfg.host || config.db.host,
      port: roleCfg.port || domainCfg.port || config.db.port,
      user: roleCfg.user || domainCfg.user || config.db.user,
      password: roleCfg.password || domainCfg.password || config.db.password,
      database: roleCfg.database || domainCfg.database || config.db.database,
    };
  }

  _isCircuitOpen(key) {
    const state = this.circuitState.get(key);
    return Boolean(state && state.openUntil > Date.now());
  }

  _recordFailure(key, err) {
    const current = this.circuitState.get(key) || { failures: 0, openUntil: 0 };
    const failures = current.failures + 1;
    const openUntil = failures >= 5 ? Date.now() + 30_000 : 0;
    this.circuitState.set(key, { failures, openUntil });
    log.warn('db_pool_failure', { key, failures, openUntil, error: err.message });
  }

  _recordSuccess(key) {
    this.circuitState.set(key, { failures: 0, openUntil: 0 });
  }

  getPool(domain, role = 'writer') {
    this._ensureDomain(domain);
    if (!ROLES.includes(role)) throw new Error(`Unknown DB role '${role}'`);

    const key = this._poolKey(domain, role);
    if (this._isCircuitOpen(key)) {
      throw new Error(`DB circuit open for ${key}`);
    }

    if (!this.pools.has(key)) {
      const pool = new Pool(this._buildPoolConfig(domain, role));
      pool.on('error', (err) => this._recordFailure(key, err));
      this.pools.set(key, pool);
      log.info('db_pool_created', { key });
    }
    return this.pools.get(key);
  }

  async query(domain, text, params = [], options = {}) {
    const role = options.strongRead ? 'writer' : (options.role || 'writer');
    const key = this._poolKey(domain, role);
    const t0 = Date.now();
    try {
      const result = await this.getPool(domain, role).query(text, params);
      this._recordSuccess(key);
      const durationMs = Date.now() - t0;
      if (durationMs > 500) {
        log.warn('db_slow_query', { domain, role, durationMs });
      }
      return result;
    } catch (err) {
      this._recordFailure(key, err);
      throw err;
    }
  }

  _resolveIsolationLevel(isolationLevel) {
    const normalized = String(isolationLevel || 'READ COMMITTED').trim().toUpperCase();
    if (!ISOLATION_LEVELS.has(normalized)) {
      throw new Error(`Unsupported isolation level '${isolationLevel}'`);
    }
    return normalized;
  }

  async withTransaction(domain, fn, options = {}) {
    const pool = this.getPool(domain, 'writer');
    const client = await pool.connect();
    const isolationLevel = this._resolveIsolationLevel(options.isolationLevel || 'READ COMMITTED');
    try {
      await client.query('BEGIN');
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
      if (options.readOnly === true) {
        await client.query('SET TRANSACTION READ ONLY');
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async withTx(domain, fn, options = {}) {
    return this.withTransaction(domain, fn, options);
  }

  async health() {
    const checks = {};
    for (const domain of DOMAINS) {
      for (const role of ROLES) {
        const key = this._poolKey(domain, role);
        try {
          await this.query(domain, 'SELECT 1', [], { role, strongRead: role === 'writer' });
          checks[key] = 'ok';
        } catch (err) {
          checks[key] = `error:${err.message}`;
        }
      }
    }
    return checks;
  }

  async close() {
    for (const pool of this.pools.values()) {
      await pool.end().catch(() => {});
    }
    this.pools.clear();
  }
}

module.exports = ConnectionManager;
