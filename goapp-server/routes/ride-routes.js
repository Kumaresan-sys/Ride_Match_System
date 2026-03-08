const crypto = require('crypto');
const { validateSchema } = require('./validation');

const RIDE_RATE_WINDOW_MS = 60 * 1000;
const RIDE_RATE_MAX = 20;
const rideRateByKey = new Map();

function registerRideRoutes(router, ctx) {
  const { services, repositories } = ctx;
  const requireAuth = ctx.requireAuth;
  const requireAdmin = ctx.requireAdmin;

  async function authenticate(headers) {
    const auth = await requireAuth(headers || {});
    if (auth.error) return { error: auth.error };
    return { session: auth.session };
  }

  function canAccessRide(sessionUserId, ride) {
    return ride && (ride.riderId === sessionUserId || ride.driverId === sessionUserId);
  }

  function isAdmin(headers = {}) {
    if (!headers['x-admin-token']) return false;
    return !requireAdmin(headers);
  }

  function checkRideRateLimit(key) {
    const now = Date.now();
    const k = key || 'unknown';
    const rec = rideRateByKey.get(k);
    if (rec && (now - rec.windowStart) < RIDE_RATE_WINDOW_MS) {
      if (rec.count >= RIDE_RATE_MAX) return false;
      rec.count += 1;
      return true;
    }
    rideRateByKey.set(k, { count: 1, windowStart: now });
    return true;
  }

  router.register('POST', '/api/v1/rides/request', async ({ body, headers, ip }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    if (!checkRideRateLimit(`${ip || 'unknown'}:${auth.session.userId}`)) {
      return { status: 429, data: { error: 'Rate limit exceeded for ride requests. Try again shortly.' } };
    }

    const parsed = validateSchema(body, [
      { key: 'riderId', type: 'string', required: true },
      { key: 'pickupLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'pickupLng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'destLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'destLng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'rideType', type: 'string', required: false, enum: ['mini', 'sedan', 'suv', 'premium', 'bike', 'auto'] },
      { key: 'idempotencyKey', type: 'string', required: false, minLength: 8, maxLength: 128 },
    ]);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };

    if (parsed.data.riderId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: riderId must match authenticated user.' } };
    }

    const pickupLat = parsed.data.pickupLat;
    const pickupLng = parsed.data.pickupLng;

    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      const zoneCheck = services.zoneService.checkPickup(pickupLat, pickupLng);
      if (!zoneCheck.allowed) {
        return { status: 403, data: { error: zoneCheck.message, reason: zoneCheck.reason } };
      }
    }

    let coinRedemptionPreview = null;
    if (body.useCoins && parsed.data.riderId) {
      const estimates = await services.pricingService.getEstimates(
        pickupLat,
        pickupLng,
        parsed.data.destLat,
        parsed.data.destLng
      );
      const rideType = parsed.data.rideType || 'sedan';
      const estimatedFare = estimates.estimates[rideType]?.finalFare;
      if (estimatedFare) {
        const balance = await repositories.wallet.getBalance(parsed.data.riderId);
        coinRedemptionPreview = {
          coinsAvailable: balance.coinBalance,
          maxDiscountInr: Math.round(Math.min(balance.coinBalance, Math.floor(estimatedFare * 0.20 / 0.10)) * 0.10 * 100) / 100,
        };
      }
    }

    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      services.demandLogService.recordDemand(pickupLat, pickupLng, 'ride_requested');
      services.demandLogService.recordTimeslot('ride_requested');
    }

    const result = await repositories.ride.createRide({
      ...body,
      ...parsed.data,
      idempotencyKey: parsed.data.idempotencyKey || crypto.randomUUID(),
    });

    if (coinRedemptionPreview) result.coinRedemptionPreview = coinRedemptionPreview;
    return { data: result };
  });

  router.register('GET', '/api/v1/rides', async ({ headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const rides = await repositories.ride.getAllRides();
    if (isAdmin(headers || {})) return { data: { rides } };

    const ownRides = rides.filter(ride => canAccessRide(auth.session.userId, ride));
    return { data: { rides: ownRides } };
  });

  router.register('GET', '/api/v1/rides/:rideId', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const ride = await repositories.ride.getRide(pathParams.rideId);
    if (ride && !canAccessRide(auth.session.userId, ride)) {
      return { status: 403, data: { error: 'Forbidden: cannot access this ride.' } };
    }
    return { data: ride || { error: 'Ride not found' } };
  });

  router.register('POST', '/api/v1/rides/:rideId/cancel', async ({ pathParams, body, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    if (!body.userId) return { status: 400, data: { error: 'userId is required' } };
    if (body.userId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: userId must match authenticated user.' } };
    }
    const ride = await repositories.ride.getRide(pathParams.rideId);
    if (ride && !canAccessRide(auth.session.userId, ride)) {
      return { status: 403, data: { error: 'Forbidden: cannot cancel this ride.' } };
    }

    const result = await repositories.ride.cancelRide(pathParams.rideId, body.cancelledBy, body.userId);
    return { data: result };
  });

  router.register('POST', '/api/v1/rides/:rideId/arrived', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    const ride = await repositories.ride.getRide(pathParams.rideId);
    if (!ride || ride.driverId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: only assigned driver can update arrival.' } };
    }

    const updated = services.rideService.driverArrived(pathParams.rideId);
    return { data: updated ? { status: updated.status, rideId: pathParams.rideId } : { error: 'Invalid state' } };
  });

  router.register('POST', '/api/v1/rides/:rideId/start', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    const ride = await repositories.ride.getRide(pathParams.rideId);
    if (!ride || ride.driverId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: only assigned driver can start trip.' } };
    }

    const updated = services.rideService.startTrip(pathParams.rideId);
    return { data: updated ? { status: updated.status, rideId: pathParams.rideId } : { error: 'Invalid state' } };
  });

  router.register('POST', '/api/v1/rides/:rideId/complete', async ({ pathParams, body, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    const existingRide = await repositories.ride.getRide(pathParams.rideId);
    if (!existingRide || existingRide.driverId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: only assigned driver can complete trip.' } };
    }

    const rideId = pathParams.rideId;
    const result = await repositories.ride.completeTrip(rideId, body.distanceKm, body.durationMin);
    if (!result) return { data: { error: 'Invalid state' } };

    const ride = await repositories.ride.getRide(rideId);
    if (ride && body.useCoins && ride.riderId) {
      const fareInr = result.fare?.finalFare;
      if (fareInr) {
        const redemption = await repositories.wallet.redeemCoins(ride.riderId, fareInr, body.coinsToUse);
        if (redemption.success) {
          result.fare.finalFareAfterCoins = redemption.finalFare;
          result.fare.coinDiscount = redemption.discountInr;
          result.coinRedemption = redemption;
        }
      }
    }

    if (ride && ride.riderId) {
      const earnFare = result.fare?.finalFare;
      const earnResult = await services.walletService.earnCoins(ride.riderId, earnFare, rideId);
      if (earnResult) result.coinsEarned = earnResult.coins;
    }

    return { data: result };
  });
}

module.exports = registerRideRoutes;
