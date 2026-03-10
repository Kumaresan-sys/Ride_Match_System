// GoApp Redis Interface — real Redis v4 client with compatibility shims
//
// All shim methods match the call signatures used by existing services.

'use strict';

const config = require('../config');
const { logger } = require('../utils/logger');

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

const nativeGeoSearch = typeof client.geoSearch === 'function'
  ? client.geoSearch.bind(client)
  : null;

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeGeoEntry(entry) {
  if (typeof entry === 'string' || typeof entry === 'number') {
    return {
      member: String(entry),
      distance: null,
      lat: null,
      lng: null,
    };
  }

  if (Array.isArray(entry)) {
    const member = entry.length ? String(entry[0]) : null;
    let distance = null;
    let lat = null;
    let lng = null;

    if (entry.length > 1 && !Array.isArray(entry[1]) && typeof entry[1] !== 'object') {
      distance = toFiniteOrNull(entry[1]);
    }

    const coord = entry.find((v) => Array.isArray(v) && v.length >= 2);
    if (coord) {
      lng = toFiniteOrNull(coord[0]);
      lat = toFiniteOrNull(coord[1]);
    }

    return { member, distance, lat, lng };
  }

  if (entry && typeof entry === 'object') {
    const member = entry.member != null
      ? String(entry.member)
      : (entry.value != null ? String(entry.value) : null);
    const distance = toFiniteOrNull(entry.distance ?? entry.dist);
    const lat = toFiniteOrNull(
      entry.coordinates?.latitude
      ?? entry.coordinates?.lat
      ?? entry.coord?.latitude
      ?? entry.coord?.lat
    );
    const lng = toFiniteOrNull(
      entry.coordinates?.longitude
      ?? entry.coordinates?.lng
      ?? entry.coord?.longitude
      ?? entry.coord?.lng
    );

    return { member, distance, lat, lng };
  }

  return {
    member: null,
    distance: null,
    lat: null,
    lng: null,
  };
}

// ── Compatibility shims ────────────────────────────────────────────────────

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

client.releaseLockIfValueMatches = async (key, expectedValue) => {
  if (!key || expectedValue == null) return 0;
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;
  return client.eval(script, {
    keys: [String(key)],
    arguments: [String(expectedValue)],
  });
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

// geoadd(key, lng, lat, member)
client.geoadd = async (key, lng, lat, member) => {
  return client.geoAdd(key, {
    longitude: Number(lng),
    latitude: Number(lat),
    member: String(member),
  });
};

// georemove(key, member)
client.georemove = async (key, member) => {
  return client.zRem(key, String(member));
};

// georadius shim: Real Redis 7 uses GEOSEARCH (GEORADIUS is deprecated in Redis 6+).
// Normalises output to [{ member, distance, lat, lng }]
client.georadius = async (key, lng, lat, radiusKm, opts = {}) => {
  if (!nativeGeoSearch) return [];
  const searchOpts = {
    SORT: 'ASC',
    WITHCOORD: true,
    WITHDIST: true,
  };
  if (opts.count) searchOpts.COUNT = Number(opts.count);

  const raw = await nativeGeoSearch(
    key,
    { longitude: lng, latitude: lat },
    { radius: radiusKm, unit: 'km' },
    searchOpts
  );

  return (raw || [])
    .map((entry) => normalizeGeoEntry(entry))
    .filter((entry) => entry.member);
};

// Explicit GEOSEARCH helper used by distributed matching/location paths.
client.geoSearch = async (key, lng, lat, radiusKm, opts = {}) => {
  if (!nativeGeoSearch) return [];
  const searchOpts = { SORT: 'ASC', WITHCOORD: true, WITHDIST: true };
  if (opts.count) searchOpts.COUNT = Number(opts.count);
  const raw = await nativeGeoSearch(
    key,
    { longitude: Number(lng), latitude: Number(lat) },
    { radius: Number(radiusKm), unit: 'km' },
    searchOpts
  );
  return (raw || [])
    .map((entry) => normalizeGeoEntry(entry))
    .filter((entry) => entry.member);
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
