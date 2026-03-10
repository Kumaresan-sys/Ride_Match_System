const crypto = require('crypto');
const { validateSchema } = require('./validation');
const RedisStateStore = require('../infra/redis/state-store');
const redis = require('../services/redis-client');

const RIDE_RATE_WINDOW_SEC = 60;
const RIDE_RATE_MAX = 20;

function registerRideRoutes(router, ctx) {
  const { services, repositories } = ctx;
  const requireAuth = ctx.requireAuth;
  const requireAdmin = ctx.requireAdmin;
  const stateStore = new RedisStateStore(redis);

  async function authenticate(headers) {
    const auth = await requireAuth(headers || {});
    if (auth.error) return { error: auth.error };
    return { session: auth.session };
  }

  function canAccessRide(sessionUserId, ride) {
    if (!ride) return false;
    return String(ride.riderId || '') === String(sessionUserId || '') ||
      String(ride.driverId || '') === String(sessionUserId || '');
  }

  function isAdmin(headers = {}) {
    if (!headers['x-admin-token']) return false;
    return !requireAdmin(headers);
  }

  async function checkRideRateLimit(key) {
    const k = key || 'unknown';
    const count = await stateStore.incrementRateLimit('ride_request', k, RIDE_RATE_WINDOW_SEC);
    return count <= RIDE_RATE_MAX;
  }

  function toIso(value) {
    if (value == null) return null;
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
        const parsedNumeric = new Date(numeric);
        return Number.isNaN(parsedNumeric.getTime()) ? null : parsedNumeric.toISOString();
      }
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    if (typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    return null;
  }

  function toNumber(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  function normalizeStatus(raw) {
    const key = String(raw || '').trim();
    if (!key) return 'UNKNOWN';
    if (key === key.toUpperCase()) return key;
    const upper = key.toUpperCase();
    switch (upper) {
      case 'REQUESTED':
        return 'REQUESTED';
      case 'SEARCHING':
        return 'MATCHING';
      case 'DRIVER_ASSIGNED':
        return 'ACCEPTED';
      case 'DRIVER_ARRIVING':
        return 'DRIVER_ARRIVING';
      case 'DRIVER_ARRIVED':
        return 'DRIVER_ARRIVED';
      case 'RIDE_STARTED':
      case 'IN_PROGRESS':
        return 'TRIP_STARTED';
      case 'COMPLETED':
        return 'TRIP_COMPLETED';
      case 'CANCELLED':
        return 'CANCELLED';
      case 'NO_DRIVERS':
        return 'NO_DRIVERS';
      default:
        return upper;
    }
  }

  function deriveCancelledBy(status, ride) {
    if (status === 'CANCELLED_BY_RIDER') return 'rider';
    if (status === 'CANCELLED_BY_DRIVER') return 'driver';
    if (status === 'CANCELLED') {
      const by = String(ride?.cancelledBy || '').toLowerCase();
      if (by === 'rider' || by === 'driver' || by === 'system') return by;
      return 'system';
    }
    return null;
  }

  async function normalizeRideForClient(ride, paymentInfoByRide = null) {
    if (!ride || typeof ride !== 'object') return null;

    const status = normalizeStatus(ride.status);
    const fareEstimateFinal =
      (ride.fareEstimate && typeof ride.fareEstimate === 'object')
        ? toNumber(ride.fareEstimate.finalFare, null)
        : null;
    const originalFare =
      toNumber(ride.estimatedFare, null) != null
        ? toNumber(ride.estimatedFare, null)
        : (typeof fareEstimateFinal === 'number' ? fareEstimateFinal : null);
    const finalFareRaw =
      toNumber(ride.finalFare, null) != null
        ? toNumber(ride.finalFare, null)
        : (ride.finalFare && typeof ride.finalFare === 'object' && toNumber(ride.finalFare.finalFare, null) != null
          ? toNumber(ride.finalFare.finalFare, null)
          : null);
    const finalFare = typeof finalFareRaw === 'number' ? finalFareRaw : (typeof originalFare === 'number' ? originalFare : 0);
    const fareObj = ride.finalFare && typeof ride.finalFare === 'object' ? ride.finalFare : null;
    const fareBreakdown = fareObj && typeof fareObj.breakdown === 'object' ? fareObj.breakdown : null;
    const gstPctFromRide =
      toNumber(fareObj?.gstPct, null) ??
      toNumber(fareBreakdown?.gstPct, null);
    const serviceCostFromRide =
      toNumber(fareObj?.serviceCost, null) ??
      toNumber(fareBreakdown?.serviceCost, null);
    const gstAmountFromRide =
      toNumber(fareObj?.gstAmount, null) ??
      toNumber(fareBreakdown?.gstAmount, null);

    let gstPct = gstPctFromRide;
    if (gstPct == null && services?.pricingService?.getTaxConfig) {
      try {
        const taxCfg = await services.pricingService.getTaxConfig();
        gstPct = toNumber(taxCfg?.gstPct, null);
      } catch (_) {
        gstPct = null;
      }
    }
    if (gstPct == null) gstPct = 5;

    const serviceCost = serviceCostFromRide != null
      ? serviceCostFromRide
      : Math.round((finalFare / (1 + (gstPct / 100))) * 100) / 100;
    const gstAmount = gstAmountFromRide != null
      ? gstAmountFromRide
      : Math.round((finalFare - serviceCost) * 100) / 100;

    const startedAt = toIso(ride.startedAt);
    const endedAt = toIso(ride.endedAt || ride.completedAt || ride.cancelledAt);

    const normalized = {
      rideId: String(ride.rideId || ride.id || ''),
      status,
      cancelledBy: deriveCancelledBy(status, ride),
      riderId: ride.riderId ? String(ride.riderId) : null,
      driverId: ride.driverId ? String(ride.driverId) : null,
      pickupAddress: ride.pickupAddress || null,
      destAddress: ride.destAddress || ride.dropoffAddress || null,
      pickupLat: toNumber(ride.pickupLat, null),
      pickupLng: toNumber(ride.pickupLng, null),
      destLat: toNumber(ride.destLat, null),
      destLng: toNumber(ride.destLng, null),
      pickupZoneId: ride.pickupZoneId ? String(ride.pickupZoneId) : null,
      dropZoneId: ride.dropZoneId ? String(ride.dropZoneId) : null,
      rideType: ride.rideType || null,
      distanceKm: toNumber(ride.distanceKm, null) != null ? toNumber(ride.distanceKm, 0) : (toNumber(ride.actualDistanceM, null) != null ? (toNumber(ride.actualDistanceM, 0) / 1000) : 0),
      durationMin: toNumber(ride.durationMin, null) != null ? Math.round(toNumber(ride.durationMin, 0)) : (toNumber(ride.actualDurationS, null) != null ? Math.round(toNumber(ride.actualDurationS, 0) / 60) : 0),
      createdAt: toIso(ride.createdAt),
      acceptedAt: toIso(ride.acceptedAt),
      arrivedAt: toIso(ride.arrivedAt),
      otpVerifiedAt: toIso(ride.otpVerifiedAt),
      startedAt,
      endedAt,
      finalFare,
      originalFare,
      serviceCost,
      gstAmount,
      gstPct,
      discountAmount: toNumber(ride.discountAmount, null),
      coinsUsed: toNumber(ride.coinsUsed, null) != null ? Math.round(toNumber(ride.coinsUsed, 0)) : null,
      coinsDiscountAmount: toNumber(ride.coinsDiscountAmount, null),
      paymentMethod: ride.paymentMethod || null,
      paymentTransactionId: ride.paymentTransactionId || null,
      matchResult: ride.matchResult || null,
    };

    if ((!normalized.paymentTransactionId || !normalized.paymentMethod) &&
        normalized.rideId &&
        normalized.riderId &&
        typeof repositories.wallet.getRidePaymentInfo === 'function') {
      try {
        const paymentInfo = paymentInfoByRide instanceof Map
          ? paymentInfoByRide.get(normalized.rideId)
          : await repositories.wallet.getRidePaymentInfo(
            normalized.riderId,
            normalized.rideId
          );
        if (paymentInfo) {
          if (!normalized.paymentTransactionId && paymentInfo.paymentTransactionId) {
            normalized.paymentTransactionId = paymentInfo.paymentTransactionId;
          }
          if (!normalized.paymentMethod && paymentInfo.paymentMethod) {
            normalized.paymentMethod = paymentInfo.paymentMethod;
          }
        }
      } catch (_) {
        // Best-effort enrichment; avoid failing core ride response path.
      }
    }

    return normalized;
  }

  router.register('POST', '/api/v1/rides/request', async ({ body, headers, ip }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    if (!await checkRideRateLimit(`${ip || 'unknown'}:${auth.session.userId}`)) {
      return { status: 429, data: { error: 'Rate limit exceeded for ride requests. Try again shortly.' } };
    }

    const parsed = validateSchema(body, [
      { key: 'riderId', type: 'string', required: true },
      { key: 'pickupLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'pickupLng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'destLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'destLng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'rideType', type: 'string', required: false },
      { key: 'idempotencyKey', type: 'string', required: false, minLength: 8, maxLength: 128 },
    ]);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };

    // Validate rideType against active vehicle types from DB
    if (parsed.data.rideType) {
      const validTypes = await services.pricingService.getVehicleTypes();
      const validNames = validTypes.map(t => t.name);
      if (!validNames.includes(parsed.data.rideType)) {
        return { status: 400, data: { error: `Invalid rideType '${parsed.data.rideType}'. Valid types: ${validNames.join(', ')}` } };
      }
    }

    if (parsed.data.riderId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: riderId must match authenticated user.' } };
    }

    const pickupLat = parsed.data.pickupLat;
    const pickupLng = parsed.data.pickupLng;

    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      // In-memory zone check (open-area validation)
      const zoneCheck = services.zoneService.checkPickup(pickupLat, pickupLng);
      if (!zoneCheck.allowed) {
        return { status: 403, data: { error: zoneCheck.message, reason: zoneCheck.reason } };
      }

      // DB-backed zone restriction check (persisted admin-managed restrictions)
      const zoneRestrictionsService =
        require('../services/zone-restrictions-service');
      const restrictionCheck = await zoneRestrictionsService.checkRestricted(pickupLat, pickupLng, 'rider');
      if (restrictionCheck.restricted) {
        return {
          status: 403,
          data: {
            error:    restrictionCheck.message,
            reason:   'ZONE_RESTRICTED',
            zoneName: restrictionCheck.zoneName,
          },
        };
      }
    }

    let coinRedemptionPreview = null;
    if (parsed.data.riderId && services?.coinsService) {
      const estimates = await services.pricingService.getEstimates(
        pickupLat,
        pickupLng,
        parsed.data.destLat,
        parsed.data.destLng
      );
      const rideType = parsed.data.rideType || 'sedan';
      const estimatedFare = estimates.estimates[rideType]?.finalFare;
      if (estimatedFare != null) {
        coinRedemptionPreview = await services.coinsService.toRideCoinsQuote(
          parsed.data.riderId,
          Number(estimatedFare),
          { rideType }
        );
      }
    }

    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      services.demandLogService.recordDemand(pickupLat, pickupLng, 'ride_requested');
      services.demandLogService.recordTimeslot('ride_requested');
    }

    const idempotencyHeader = String(
      headers?.['idempotency-key'] || headers?.['x-idempotency-key'] || ''
    ).trim() || null;

    const result = await repositories.ride.createRide({
      ...body,
      ...parsed.data,
      rideId: crypto.randomUUID(),
      rideNumber: `RD${Date.now().toString(36).toUpperCase()}`,
      idempotencyKey: parsed.data.idempotencyKey || idempotencyHeader || crypto.randomUUID(),
    });

    if (coinRedemptionPreview) {
      result.coins = coinRedemptionPreview;
      result.coinRedemptionPreview = coinRedemptionPreview;
    }
    return { data: result };
  });

  router.register('GET', '/api/v1/rides', async ({ headers, params }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const limitRaw = Number.parseInt(params?.get('limit') || '50', 10);
    const limit = Math.min(Math.max(limitRaw, 1), 200);
    const cursor = params?.get('cursor') || null;
    const page = await repositories.ride.getRidesPage({ limit, cursor });
    const rides = page?.rides || [];
    const paymentInfoByRide = new Map();
    if (rides.length > 0 && typeof repositories.wallet.getRidePaymentInfoBatch === 'function') {
      const rideIdsByRider = new Map();
      for (const ride of rides) {
        const rideId = String(ride?.rideId || '');
        const riderId = String(ride?.riderId || '');
        if (!rideId || !riderId) continue;
        const current = rideIdsByRider.get(riderId) || [];
        current.push(rideId);
        rideIdsByRider.set(riderId, current);
      }

      await Promise.all(Array.from(rideIdsByRider.entries()).map(async ([riderId, rideIds]) => {
        const batch = await repositories.wallet.getRidePaymentInfoBatch(riderId, rideIds).catch(() => ({}));
        Object.entries(batch || {}).forEach(([rideId, info]) => {
          paymentInfoByRide.set(String(rideId), info);
        });
      }));
    }

    const normalized = (await Promise.all(rides.map((ride) => normalizeRideForClient(ride, paymentInfoByRide))))
      .filter(Boolean);
    if (isAdmin(headers || {})) return { data: { rides: normalized, nextCursor: page?.nextCursor || null } };

    const ownRides = normalized.filter(ride => canAccessRide(auth.session.userId, ride));
    return { data: { rides: ownRides, nextCursor: page?.nextCursor || null } };
  });

  router.register('GET', '/api/v1/rides/:rideId', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const ride = await repositories.ride.getRide(pathParams.rideId);
    const normalized = await normalizeRideForClient(ride);
    if (normalized && !canAccessRide(auth.session.userId, normalized)) {
      return { status: 403, data: { error: 'Forbidden: cannot access this ride.' } };
    }
    if (!normalized) {
      return { status: 404, data: { error: 'Ride not found', code: 'RIDE_NOT_FOUND' } };
    }
    return { data: normalized };
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

  // Driver-side accept endpoint.
  router.register('POST', '/api/v1/rides/:rideId/accept', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const result = await services.matchingEngine.acceptOffer(pathParams.rideId, auth.session.userId);
    if (!result.success) return { status: 409, data: result };
    return { data: result };
  });

  router.register('POST', '/api/v2/rides/:rideId/offers/:offerId/accept', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;

    const result = await services.matchingEngine.acceptOffer(
      pathParams.rideId,
      auth.session.userId,
      pathParams.offerId
    );
    if (!result.success) return { status: 409, data: result };
    return { data: result };
  });

  router.register('POST', '/api/v1/rides/:rideId/arrived', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    const ride = await repositories.ride.getRide(pathParams.rideId);
    if (!ride || ride.driverId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: only assigned driver can update arrival.' } };
    }

    const updated = await services.rideService.driverArrived(pathParams.rideId);
    return { data: updated ? { status: updated.status, rideId: pathParams.rideId } : { error: 'Invalid state' } };
  });

  router.register('POST', '/api/v1/rides/:rideId/start', async ({ pathParams, headers }) => {
    const auth = await authenticate(headers);
    if (auth.error) return auth.error;
    const ride = await repositories.ride.getRide(pathParams.rideId);
    if (!ride || ride.driverId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: only assigned driver can start trip.' } };
    }

    const updated = await services.rideService.startTrip(pathParams.rideId);
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
    if (ride && ride.riderId && services?.coinsService) {
      const fareInr = Number(result.fare?.finalFare || 0);
      if (fareInr > 0) {
        const preview = await services.coinsService.previewRideDiscount(ride.riderId, {
          fareInr,
          rideId,
          rideType: ride.rideType || null,
          requestedCoins: body?.coinsToUse,
        });
        if (preview.appliedCoins > 0) {
          const redemption = await repositories.wallet.redeemCoins(
            ride.riderId,
            fareInr,
            preview.appliedCoins
          );
          if (redemption.success) {
            result.fare.finalFareAfterCoins = redemption.finalFare;
            result.fare.coinDiscount = redemption.discountInr;
            result.coinRedemption = redemption;
            result.coins = preview;
          }
        } else {
          result.coins = preview;
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
