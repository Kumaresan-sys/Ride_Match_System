'use strict';

const crypto = require('crypto');
const redis = require('../../services/redis-client');

function key(parts) {
  return parts.join(':');
}

class RedisStateStore {
  constructor(client = redis) {
    this.redis = client;
  }

  // Canonical key builders
  driverStateKey(driverId) { return key(['driver', 'state', `{${driverId}}`]); }
  driverEligibilityKey(driverId) { return key(['driver', 'eligibility', `{${driverId}}`]); }
  driverLocationKey(driverId) { return key(['driver', 'location', `{${driverId}}`]); }
  geoDriversKey(city) { return key(['geo', 'drivers', city || 'default']); }
  rideActiveKey(rideId) { return key(['ride', 'active', `{${rideId}}`]); }
  riderActiveRideKey(riderId) { return key(['rider', 'active_ride', riderId]); }
  rideOffersKey(rideId) { return key(['ride', 'offers', `{${rideId}}`]); }
  rideOfferKey(rideId, driverId) { return key(['ride', 'offers', `{${rideId}}`, String(driverId)]); }
  rideAcceptedKey(rideId) { return key(['ride', 'offer_accepted', `{${rideId}}`]); }
  rideAssignLockKey(rideId) { return key(['ride', 'lock', `{${rideId}}`]); }
  rideExcludedSetKey(rideId) { return key(['ride', 'excluded', `{${rideId}}`]); }
  rideMatchStateKey(rideId) { return key(['ride', 'match_state', `{${rideId}}`]); }
  rateLimitKey(k) { return key(['ride_rate', `{${k}}`]); }
  cancelCountKey(actor, userId) { return key(['cancel_count', actor, `{${userId}}`]); }
  walletIdempotencyKey(scope, idempotencyKey) { return key(['idem', scope, idempotencyKey]); }

  async setDriverState(driverId, state = {}, ttlSec = 60) {
    const k = this.driverStateKey(driverId);
    const payload = Object.entries(state).flatMap(([field, value]) => [field, String(value)]);
    if (payload.length > 0) await this.redis.hSet(k, payload);
    await this.redis.expire(k, ttlSec);
  }

  async getDriverState(driverId) {
    return this.redis.hGetAll(this.driverStateKey(driverId));
  }

  async setDriverEligibility(driverId, payload = {}, ttlSec = 60) {
    await this.redis.set(this.driverEligibilityKey(driverId), JSON.stringify(payload), { EX: ttlSec });
  }

  async getDriverEligibility(driverId) {
    const raw = await this.redis.get(this.driverEligibilityKey(driverId));
    return raw ? JSON.parse(raw) : null;
  }

  async updateDriverLocation(driverId, city, lat, lng, ttlSec = 30) {
    await this.redis.geoadd(this.geoDriversKey(city), lng, lat, driverId);
    await this.redis.hSet(this.driverLocationKey(driverId), ['lat', String(lat), 'lng', String(lng), 'city', String(city || 'default')]);
    await this.redis.expire(this.driverLocationKey(driverId), ttlSec);
  }

  async geoSearchDrivers(city, lat, lng, radiusKm, count = 20) {
    return this.redis.geoSearch(this.geoDriversKey(city), lng, lat, radiusKm, { count });
  }

  async setActiveRide(rideId, payload, ttlSec = 4 * 3600) {
    await this.redis.set(this.rideActiveKey(rideId), JSON.stringify(payload), { EX: ttlSec });
  }

  async getActiveRide(rideId) {
    const raw = await this.redis.get(this.rideActiveKey(rideId));
    return raw ? JSON.parse(raw) : null;
  }

  async setRiderActiveRide(riderId, rideId, ttlSec = 4 * 3600) {
    await this.redis.set(this.riderActiveRideKey(riderId), String(rideId), { EX: ttlSec });
  }

  async getRiderActiveRide(riderId) {
    return this.redis.get(this.riderActiveRideKey(riderId));
  }

  async clearRiderActiveRide(riderId) {
    return this.redis.del(this.riderActiveRideKey(riderId));
  }

  async setRideOffer(rideId, driverId, payload, ttlSec = 120) {
    const offer = { ...payload, offerId: payload.offerId || crypto.randomUUID() };
    await this.redis.set(this.rideOfferKey(rideId, driverId), JSON.stringify(offer), { EX: ttlSec });
    await this.redis.zAdd(this.rideOffersKey(rideId), [{ score: Number(offer.score || 0), value: String(driverId) }]);
    await this.redis.expire(this.rideOffersKey(rideId), ttlSec);
    return offer;
  }

  async getRideOffer(rideId, driverId) {
    const raw = await this.redis.get(this.rideOfferKey(rideId, driverId));
    return raw ? JSON.parse(raw) : null;
  }

  async markRideAccepted(rideId, driverId, ttlSec = 120) {
    return this.redis.set(this.rideAcceptedKey(rideId), String(driverId), { NX: true, EX: ttlSec });
  }

  async getAcceptedDriver(rideId) {
    return this.redis.get(this.rideAcceptedKey(rideId));
  }

  async clearAcceptedDriver(rideId) {
    return this.redis.del(this.rideAcceptedKey(rideId));
  }

  async acquireRideAssignLock(rideId, ownerId, ttlSec = 30) {
    const lockKey = this.rideAssignLockKey(rideId);
    const lockValue = `${String(ownerId)}:${crypto.randomUUID()}`;
    const result = await this.redis.set(lockKey, lockValue, { NX: true, EX: ttlSec });
    if (result === 'OK') {
      return {
        acquired: true,
        holder: String(ownerId),
        lockValue,
        lockToken: lockValue,
      };
    }
    const current = await this.redis.get(lockKey);
    const holder = current ? String(current).split(':')[0] : null;
    return { acquired: false, holder, lockValue: null, lockToken: null };
  }

  async getRideAssignLock(rideId) {
    return this.redis.get(this.rideAssignLockKey(rideId));
  }

  async releaseRideAssignLock(rideId, expectedLockValue) {
    const lockKey = this.rideAssignLockKey(rideId);
    if (!expectedLockValue) return 0;
    const script = `
      local current = redis.call("GET", KEYS[1])
      if not current then
        return 0
      end
      if current == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      local prefix = ARGV[1] .. ":"
      if string.sub(current, 1, string.len(prefix)) == prefix then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `;
    return this.redis.eval(script, {
      keys: [lockKey],
      arguments: [String(expectedLockValue)],
    });
  }

  async setMatchState(rideId, payload, ttlSec = 1800) {
    await this.redis.set(this.rideMatchStateKey(rideId), JSON.stringify(payload), { EX: ttlSec });
  }

  async getMatchState(rideId) {
    const raw = await this.redis.get(this.rideMatchStateKey(rideId));
    return raw ? JSON.parse(raw) : null;
  }

  async clearMatchState(rideId) {
    return this.redis.del(this.rideMatchStateKey(rideId));
  }

  async addExcludedDriver(rideId, driverId, ttlSec = 3600) {
    const setKey = this.rideExcludedSetKey(rideId);
    await this.redis.sAdd(setKey, String(driverId));
    await this.redis.expire(setKey, ttlSec);
  }

  async getExcludedDrivers(rideId) {
    return this.redis.sMembers(this.rideExcludedSetKey(rideId));
  }

  async incrementRateLimit(_scope, keyValue, windowSec = 60) {
    const k = this.rateLimitKey(keyValue);
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.expire(k, windowSec + 1);
    return count;
  }

  async incrementCancelCount(actor, userId, windowSec = 24 * 3600) {
    const k = this.cancelCountKey(actor, userId);
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.expire(k, windowSec + 1);
    return count;
  }

  async setWalletIdempotency(scope, idempotencyKey, payload, ttlSec = 24 * 3600) {
    const k = this.walletIdempotencyKey(scope, idempotencyKey);
    await this.redis.set(k, JSON.stringify(payload), { NX: true, EX: ttlSec });
  }

  async getWalletIdempotency(scope, idempotencyKey) {
    const raw = await this.redis.get(this.walletIdempotencyKey(scope, idempotencyKey));
    return raw ? JSON.parse(raw) : null;
  }
}

module.exports = RedisStateStore;
