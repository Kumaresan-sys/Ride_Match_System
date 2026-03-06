// GoApp Unified Redis Interface
// Selects the correct backend based on REDIS_BACKEND environment variable:
//   REDIS_BACKEND=mock  → re-exports redis-mock.js directly (in-memory, zero setup)
//   REDIS_BACKEND=real  → real Redis v4 client with compatibility shims
//
// All shim methods match the call signatures used by existing services so that
// no service files need modification when switching backends.

'use strict';

const config = require('../config');
const { logger } = require('../utils/logger');

const BACKEND = config.redis.backend; // 'mock' | 'real'

if (BACKEND !== 'real') {
  // ── Mock path: re-export the existing singleton unchanged ──────────────────
  logger.info('REDIS', 'Using redis-mock adapter (in-memory, no Redis required)');
  module.exports = require('./redis-mock');

} else {
  // ── Real Redis path ────────────────────────────────────────────────────────
  const { createClient } = require('redis');

  const client = createClient({
    socket: {
      host: config.redis.host,
      port: config.redis.port,
      // Exponential backoff reconnect, capped at 5s
      reconnectStrategy: (retries) => Math.min(retries * 100, 5000),
    },
  });

  client.on('error',        (err) => logger.error('REDIS', `Client error: ${err.message}`));
  client.on('connect',      ()    => logger.info('REDIS',  `Connected to ${config.redis.host}:${config.redis.port}`));
  client.on('reconnecting', ()    => logger.warn('REDIS',  'Reconnecting...'));
  client.on('ready',        ()    => logger.info('REDIS',  'Ready'));

  // Connect eagerly — errors surface at startup rather than first use.
  // reconnectStrategy handles retries automatically.
  client.connect().catch((err) => {
    logger.error('REDIS', `Initial connection failed: ${err.message} — will retry automatically`);
  });

  // ── Compatibility shims (match redis-mock.js API) ──────────────────────────

  client.acquireLock = async (rideId, driverId, ttlSec = 60) => {
    const key = `ride_lock:${rideId}`;
    // SET NX EX is atomic: only sets if key does not exist
    const result = await client.set(key, driverId, { NX: true, EX: ttlSec });
    const acquired = result === 'OK';
    if (acquired) {
      logger.info('REDIS', `Lock acquired: ${key} → driver ${driverId}`);
    } else {
      const holder = await client.get(key);
      logger.warn('REDIS', `Lock FAILED: ${key} already held by ${holder}`);
    }
    return { acquired, holder: acquired ? driverId : await client.get(key) };
  };

  client.releaseLock = async (rideId) => {
    return client.del(`ride_lock:${rideId}`);
  };

  client.checkIdempotency = async (idempotencyKey) => {
    const key = `idempotency:${idempotencyKey}`;
    const existing = await client.get(key);
    if (existing) {
      return { isDuplicate: true, existingResult: JSON.parse(existing) };
    }
    return { isDuplicate: false };
  };

  client.setIdempotency = async (idempotencyKey, result, ttlSec = 300) => {
    const key = `idempotency:${idempotencyKey}`;
    await client.set(key, JSON.stringify(result), { EX: ttlSec });
  };

  // georadius shim: redis-mock uses Haversine internally.
  // Real Redis 7 uses GEOSEARCH (GEORADIUS is deprecated in Redis 6+).
  // Normalises output to the same shape as redis-mock.georadius:
  // [{ member, distance, lat, lng }]
  client.georadius = async (key, lng, lat, radiusKm, opts = {}) => {
    const searchOpts = {
      SORT: 'ASC',
      WITHCOORD: true,
      WITHDIST: true,
    };
    if (opts.count) searchOpts.COUNT = { count: opts.count, any: false };

    const raw = await client.geoSearch(
      key,
      { longitude: lng, latitude: lat },
      { radius: radiusKm, unit: 'km' },
      searchOpts
    );

    return (raw || []).map((r) => ({
      member:   r.member,
      distance: parseFloat(r.distance),
      lat:      parseFloat(r.coordinates?.latitude  ?? 0),
      lng:      parseFloat(r.coordinates?.longitude ?? 0),
    }));
  };

  client.getStats = () => ({
    backend:   'real',
    host:      config.redis.host,
    port:      config.redis.port,
    connected: client.isReady,
  });

  // stop() called in integration test teardown for clean shutdown
  client.stop = async () => {
    await client.quit();
  };

  logger.info('REDIS', `Using real Redis adapter — ${config.redis.host}:${config.redis.port}`);

  module.exports = client;
}
