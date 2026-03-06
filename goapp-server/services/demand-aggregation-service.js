// GoApp Demand Aggregation Service
//
// Pools multiple ride requests going in the same direction into a single shared ride.
// Reduces costs for riders and increases driver earnings per trip.
//
// Pooling Rules:
//   - Pickup must be within POOL_PICKUP_RADIUS_KM (default 1km) of pool origin
//   - Destination bearing must be within POOL_BEARING_TOLERANCE_DEG (default 35°) of pool direction
//   - Destination distance must be compatible (within POOL_DEST_RANGE_KM = 3km of pool dest)
//   - Max riders per pool: POOL_MAX_RIDERS (default 4)
//   - Pool expires if not filled within POOL_EXPIRY_SEC (default 300s = 5 min)
//   - Fare per rider = full_fare * POOL_DISCOUNT_PCT (default 60% of individual fare)

const { logger, eventBus } = require('../utils/logger');
const { haversine, bearing } = require('../utils/formulas');

const POOL_MAX_RIDERS          = parseInt(process.env.POOL_MAX_RIDERS || '4', 10);
const POOL_PICKUP_RADIUS_KM    = parseFloat(process.env.POOL_PICKUP_RADIUS_KM || '1.0');
const POOL_BEARING_TOLERANCE   = parseFloat(process.env.POOL_BEARING_TOLERANCE_DEG || '35');
const POOL_DEST_RANGE_KM       = parseFloat(process.env.POOL_DEST_RANGE_KM || '3.0');
const POOL_EXPIRY_SEC          = parseInt(process.env.POOL_EXPIRY_SEC || '300', 10);
const POOL_DISCOUNT_PCT        = parseFloat(process.env.POOL_DISCOUNT_PCT || '0.60');

class DemandAggregationService {
  constructor() {
    // poolId -> pool object
    this.pools = new Map();
    // Clean expired pools every 2 minutes
    this._cleanupInterval = setInterval(() => this._cleanExpiredPools(), 2 * 60 * 1000);
  }

  // ─── Create a new pool ────────────────────────────────────────────────────
  createPool({ riderId, pickupLat, pickupLng, destLat, destLng, fareInr, rideType = 'sedan' }) {
    if (!riderId || !pickupLat || !pickupLng || !destLat || !destLng) {
      return { success: false, error: 'riderId, pickupLat, pickupLng, destLat, destLng required.' };
    }

    const poolId = `POOL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const direction = bearing(pickupLat, pickupLng, destLat, destLng);
    const distKm = haversine(pickupLat, pickupLng, destLat, destLng);
    const pooledFare = Math.round(fareInr * POOL_DISCOUNT_PCT * 100) / 100;
    const expiresAt = new Date(Date.now() + POOL_EXPIRY_SEC * 1000).toISOString();

    const pool = {
      poolId,
      status: 'OPEN',        // OPEN | FILLING | DISPATCHING | ACTIVE | COMPLETED | EXPIRED | CANCELLED
      rideType,
      pickupLat,
      pickupLng,
      destLat,
      destLng,
      directionBearing: Math.round(direction * 10) / 10,
      distanceKm: Math.round(distKm * 100) / 100,
      fullFareInr: fareInr,
      farePerRiderInr: pooledFare,
      maxRiders: POOL_MAX_RIDERS,
      riders: [{ riderId, joinedAt: new Date().toISOString(), pickupLat, pickupLng }],
      driverId: null,
      rideId: null,
      expiresAt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.pools.set(poolId, pool);

    eventBus.publish('pool_created', { poolId, riderId, pickupLat, pickupLng, destLat, destLng });
    logger.info('POOL', `Pool ${poolId} created by rider ${riderId}. Direction: ${pool.directionBearing}°. Fare/rider: ₹${pooledFare}`);

    return { success: true, pool };
  }

  // ─── Find a compatible open pool for a ride request ──────────────────────
  findCompatiblePool({ riderId, pickupLat, pickupLng, destLat, destLng, rideType = 'sedan' }) {
    if (!pickupLat || !pickupLng || !destLat || !destLng) return null;

    const reqBearing = bearing(pickupLat, pickupLng, destLat, destLng);
    const now = new Date();

    for (const [poolId, pool] of this.pools) {
      // Skip non-open or expired pools
      if (pool.status !== 'OPEN' && pool.status !== 'FILLING') continue;
      if (new Date(pool.expiresAt) < now) continue;
      if (pool.riders.length >= pool.maxRiders) continue;
      if (pool.rideType !== rideType) continue;
      // Already in pool
      if (pool.riders.some(r => r.riderId === riderId)) continue;

      // Check pickup proximity
      const pickupDist = haversine(pickupLat, pickupLng, pool.pickupLat, pool.pickupLng);
      if (pickupDist > POOL_PICKUP_RADIUS_KM) continue;

      // Check direction compatibility
      let bearingDiff = Math.abs(reqBearing - pool.directionBearing);
      if (bearingDiff > 180) bearingDiff = 360 - bearingDiff;
      if (bearingDiff > POOL_BEARING_TOLERANCE) continue;

      // Check destination proximity
      const destDist = haversine(destLat, destLng, pool.destLat, pool.destLng);
      if (destDist > POOL_DEST_RANGE_KM) continue;

      return pool;
    }
    return null;
  }

  // ─── Join an existing pool ────────────────────────────────────────────────
  joinPool(poolId, { riderId, pickupLat, pickupLng }) {
    const pool = this.pools.get(poolId);
    if (!pool) return { success: false, error: 'Pool not found.' };
    if (pool.status !== 'OPEN' && pool.status !== 'FILLING') {
      return { success: false, error: `Pool is ${pool.status}, cannot join.` };
    }
    if (pool.riders.length >= pool.maxRiders) {
      return { success: false, error: 'Pool is full.' };
    }
    if (new Date(pool.expiresAt) < new Date()) {
      pool.status = 'EXPIRED';
      return { success: false, error: 'Pool has expired.' };
    }
    if (pool.riders.some(r => r.riderId === riderId)) {
      return { success: false, error: 'Rider already in this pool.' };
    }

    pool.riders.push({ riderId, joinedAt: new Date().toISOString(), pickupLat, pickupLng });
    pool.updatedAt = new Date().toISOString();

    if (pool.riders.length >= pool.maxRiders) {
      pool.status = 'FILLING';
    }

    eventBus.publish('pool_joined', { poolId, riderId, riderCount: pool.riders.length });
    logger.info('POOL', `Rider ${riderId} joined pool ${poolId}. Riders: ${pool.riders.length}/${pool.maxRiders}`);

    return {
      success: true,
      pool,
      riderCount: pool.riders.length,
      farePerRiderInr: pool.farePerRiderInr,
      savings: Math.round((pool.fullFareInr - pool.farePerRiderInr) * 100) / 100,
    };
  }

  // ─── Smart match: find or create pool for a ride request ─────────────────
  smartMatch({ riderId, pickupLat, pickupLng, destLat, destLng, fareInr, rideType = 'sedan' }) {
    // Try to find existing compatible pool
    const existingPool = this.findCompatiblePool({ riderId, pickupLat, pickupLng, destLat, destLng, rideType });

    if (existingPool) {
      const joinResult = this.joinPool(existingPool.poolId, { riderId, pickupLat, pickupLng });
      if (joinResult.success) {
        return {
          action: 'joined_pool',
          pool: joinResult.pool,
          farePerRiderInr: joinResult.farePerRiderInr,
          savings: joinResult.savings,
          message: `Joined existing pool with ${joinResult.pool.riders.length} riders.`,
        };
      }
    }

    // Create a new pool
    const createResult = this.createPool({ riderId, pickupLat, pickupLng, destLat, destLng, fareInr, rideType });
    if (createResult.success) {
      return {
        action: 'created_pool',
        pool: createResult.pool,
        farePerRiderInr: createResult.pool.farePerRiderInr,
        savings: Math.round((fareInr - createResult.pool.farePerRiderInr) * 100) / 100,
        message: 'New pool created. Waiting for more riders to join.',
      };
    }

    return { action: 'failed', error: createResult.error };
  }

  // ─── Assign driver to pool (dispatch) ────────────────────────────────────
  dispatchDriver(poolId, driverId, rideId = null) {
    const pool = this.pools.get(poolId);
    if (!pool) return { success: false, error: 'Pool not found.' };
    if (!['OPEN', 'FILLING'].includes(pool.status)) {
      return { success: false, error: `Cannot dispatch to pool in status ${pool.status}.` };
    }

    pool.driverId = driverId;
    pool.rideId = rideId;
    pool.status = 'DISPATCHING';
    pool.updatedAt = new Date().toISOString();

    eventBus.publish('pool_dispatched', { poolId, driverId, rideId, riders: pool.riders.length });
    logger.info('POOL', `Driver ${driverId} dispatched to pool ${poolId} (${pool.riders.length} riders).`);

    return { success: true, pool };
  }

  // ─── Update pool status ───────────────────────────────────────────────────
  updateStatus(poolId, status) {
    const pool = this.pools.get(poolId);
    if (!pool) return { success: false, error: 'Pool not found.' };

    const validStatuses = ['OPEN', 'FILLING', 'DISPATCHING', 'ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      return { success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` };
    }

    pool.status = status;
    pool.updatedAt = new Date().toISOString();
    if (status === 'COMPLETED') pool.completedAt = new Date().toISOString();

    return { success: true, pool };
  }

  // ─── Rider leaves pool ────────────────────────────────────────────────────
  leavePool(poolId, riderId) {
    const pool = this.pools.get(poolId);
    if (!pool) return { success: false, error: 'Pool not found.' };
    if (!['OPEN', 'FILLING'].includes(pool.status)) {
      return { success: false, error: 'Cannot leave pool after dispatch.' };
    }

    pool.riders = pool.riders.filter(r => r.riderId !== riderId);
    pool.updatedAt = new Date().toISOString();

    if (pool.riders.length === 0) {
      pool.status = 'CANCELLED';
      logger.info('POOL', `Pool ${poolId} cancelled — all riders left.`);
    } else {
      pool.status = 'OPEN';
    }

    return { success: true, pool, ridersRemaining: pool.riders.length };
  }

  // ─── Get pool details ─────────────────────────────────────────────────────
  getPool(poolId) {
    return this.pools.get(poolId) || null;
  }

  // ─── Get all pools (admin) ────────────────────────────────────────────────
  listPools({ status, limit = 50 } = {}) {
    const all = Array.from(this.pools.values());
    const filtered = status ? all.filter(p => p.status === status) : all;
    return filtered
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, Math.min(limit, 200));
  }

  // ─── Get pools for a specific rider ──────────────────────────────────────
  getRiderPools(riderId) {
    const result = [];
    this.pools.forEach(pool => {
      if (pool.riders.some(r => r.riderId === riderId)) {
        result.push(pool);
      }
    });
    return result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // ─── Clean up expired pools ───────────────────────────────────────────────
  _cleanExpiredPools() {
    const now = new Date();
    let cleaned = 0;
    this.pools.forEach((pool, poolId) => {
      if (['OPEN', 'FILLING'].includes(pool.status) && new Date(pool.expiresAt) < now) {
        pool.status = 'EXPIRED';
        cleaned++;
        eventBus.publish('pool_expired', { poolId, riders: pool.riders.length });
      }
    });
    if (cleaned > 0) logger.info('POOL', `Cleaned ${cleaned} expired pools.`);
  }

  // ─── Stats ────────────────────────────────────────────────────────────────
  getStats() {
    const counts = { OPEN: 0, FILLING: 0, DISPATCHING: 0, ACTIVE: 0, COMPLETED: 0, EXPIRED: 0, CANCELLED: 0 };
    let totalRidersPooled = 0;
    this.pools.forEach(pool => {
      counts[pool.status] = (counts[pool.status] || 0) + 1;
      if (pool.status === 'COMPLETED') totalRidersPooled += pool.riders.length;
    });
    return {
      totalPools: this.pools.size,
      statusBreakdown: counts,
      totalRidersPooled,
      poolDiscountPct: Math.round(POOL_DISCOUNT_PCT * 100),
      maxRidersPerPool: POOL_MAX_RIDERS,
    };
  }
}

module.exports = new DemandAggregationService();
