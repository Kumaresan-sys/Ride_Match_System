// GoApp In-Memory Redis Mock
// Simulates Redis GEO, SETNX (distributed locks), TTL, and Pub/Sub

const { haversine } = require('../utils/formulas');
const { logger } = require('../utils/logger');
const { EventEmitter } = require('events');

class RedisMock extends EventEmitter {
  constructor() {
    super();
    this.store = new Map();         // key -> { value, expiresAt }
    this.geoSets = new Map();       // key -> Map<member, { lat, lng }>
    this.setMaxListeners(100);

    // TTL cleanup every second
    this._cleanupInterval = setInterval(() => this._cleanExpired(), 1000);
    this._cleanupInterval.unref();
  }

  // ─── Basic Key-Value ───

  set(key, value, ttlSec) {
    const entry = { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : null };
    this.store.set(key, entry);
    return 'OK';
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  del(key) {
    return this.store.delete(key) ? 1 : 0;
  }

  exists(key) {
    const val = this.get(key);
    return val !== null ? 1 : 0;
  }

  expire(key, ttlSec) {
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + ttlSec * 1000;
      return 1;
    }
    return 0;
  }

  incr(key) {
    const val = this.get(key);
    const newVal = (parseInt(val) || 0) + 1;
    this.set(key, newVal.toString());
    return newVal;
  }

  // ─── SETNX (Distributed Lock) ───
  // Returns 1 if key was set (lock acquired), 0 if key already exists (lock failed)

  setnx(key, value) {
    if (this.get(key) !== null) {
      return 0; // Key exists = lock already held
    }
    this.set(key, value);
    return 1; // Lock acquired
  }

  // Combined SETNX + EXPIRE for ride locks
  acquireLock(rideId, driverId, ttlSec = 60) {
    const key = `ride_lock:${rideId}`;
    const result = this.setnx(key, driverId);
    if (result === 1) {
      this.expire(key, ttlSec);
      logger.success('REDIS', `Lock acquired: ${key} → driver ${driverId}`);
    } else {
      const holder = this.get(key);
      logger.warn('REDIS', `Lock FAILED: ${key} already held by ${holder}`);
    }
    return { acquired: result === 1, holder: this.get(key) };
  }

  releaseLock(rideId) {
    const key = `ride_lock:${rideId}`;
    return this.del(key);
  }

  // ─── Idempotency ───

  checkIdempotency(idempotencyKey, ttlSec = 300) {
    const key = `idempotency:${idempotencyKey}`;
    const existing = this.get(key);
    if (existing) {
      return { isDuplicate: true, existingResult: JSON.parse(existing) };
    }
    return { isDuplicate: false };
  }

  setIdempotency(idempotencyKey, result, ttlSec = 300) {
    const key = `idempotency:${idempotencyKey}`;
    this.set(key, JSON.stringify(result), ttlSec);
  }

  // ─── GEO Operations ───

  geoadd(key, lng, lat, member) {
    if (!this.geoSets.has(key)) {
      this.geoSets.set(key, new Map());
    }
    this.geoSets.get(key).set(member, { lat, lng, updatedAt: Date.now() });
    return 1;
  }

  georemove(key, member) {
    const set = this.geoSets.get(key);
    if (set) return set.delete(member) ? 1 : 0;
    return 0;
  }

  // GEORADIUS - find members within radius, sorted by distance ASC
  georadius(key, lng, lat, radiusKm, options = {}) {
    const set = this.geoSets.get(key);
    if (!set) return [];

    const results = [];
    for (const [member, pos] of set) {
      const dist = haversine(lat, lng, pos.lat, pos.lng);
      if (dist <= radiusKm) {
        results.push({
          member,
          distance: Math.round(dist * 100) / 100,
          lat: pos.lat,
          lng: pos.lng,
          updatedAt: pos.updatedAt,
        });
      }
    }

    // Sort by distance ASC
    results.sort((a, b) => a.distance - b.distance);

    // COUNT limit
    if (options.count) {
      return results.slice(0, options.count);
    }

    return results;
  }

  geopos(key, member) {
    const set = this.geoSets.get(key);
    if (!set) return null;
    return set.get(member) || null;
  }

  geodist(key, member1, member2) {
    const set = this.geoSets.get(key);
    if (!set) return null;
    const pos1 = set.get(member1);
    const pos2 = set.get(member2);
    if (!pos1 || !pos2) return null;
    return haversine(pos1.lat, pos1.lng, pos2.lat, pos2.lng);
  }

  // ─── Pub/Sub Mock ───

  publish(channel, message) {
    this.emit(`pubsub:${channel}`, message);
    return 1;
  }

  subscribe(channel, callback) {
    this.on(`pubsub:${channel}`, callback);
  }

  // ─── Cleanup ───

  _cleanExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  getStats() {
    return {
      keys: this.store.size,
      geoSets: this.geoSets.size,
      geoMembers: [...this.geoSets.values()].reduce((acc, s) => acc + s.size, 0),
    };
  }

  flushAll() {
    this.store.clear();
    this.geoSets.clear();
  }

  stop() {
    clearInterval(this._cleanupInterval);
    this.removeAllListeners();
  }
}

module.exports = new RedisMock();
