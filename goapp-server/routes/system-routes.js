const { haversine, bearing } = require('../utils/formulas');
const {
  badRequest,
  buildErrorFromResult,
  normalizeRouteError,
  notFoundError,
} = require('./response');

function registerSystemRoutes(router, ctx) {
  const { enterpriseConfig, repositories, services, eventBus, requireAdmin, requireAuth, authRuntimeStats } = ctx;
  const isDevelopmentRuntime = String(process.env.NODE_ENV || enterpriseConfig?.runtime || 'development') === 'development';

  function ensureAdmin(headers = {}) {
    const adminCheck = requireAdmin(headers);
    return adminCheck ? normalizeRouteError(adminCheck, 'ADMIN_AUTH_REQUIRED') : null;
  }

  async function optionalSession(headers = {}) {
    try {
      const auth = await requireAuth(headers);
      if (auth?.error) return null;
      return auth?.session || null;
    } catch (_) {
      return null;
    }
  }

  router.register('GET', '/api/v1/health', async () => ({
    data: {
      status: 'ok',
      service: 'GoApp Ride Matching Platform',
      version: '2.2',
      uptime: process.uptime(),
      runtime: enterpriseConfig.runtime,
      redis: services.redis.getStats(),
      identity: repositories.identity.getStats(),
    },
  }));

  router.register('GET', '/api/v1/microservices', async () => ({ data: enterpriseConfig.microservices }));
  router.register('GET', '/api/v1/aws/readiness', async () => ({
    data: {
      runtime: enterpriseConfig.runtime,
      aws: enterpriseConfig.aws,
      checks: {
        dbBackend: repositories.identity.getStats?.().backend || 'unknown',
        redisBackend: services.redis.getStats?.().backend || 'unknown',
        realFlowMode: true,
      },
    },
  }));

  router.register('GET', '/api/v1/users', async ({ params, headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;

    const limit = Number(params.get('limit') || 20);
    return { data: { users: repositories.identity.getUsers(limit) } };
  });

  router.register('GET', '/api/v1/auth/stats', async ({ headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    return { data: { ...(await repositories.identity.getStats()), authRuntime: authRuntimeStats } };
  });
  router.register('GET', '/api/v1/events', async ({ params, headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;

    const count = parseInt(params.get('count') || '20', 10);
    return { data: { events: eventBus.getRecentEvents(count) } };
  });

  router.register('GET', '/api/v1/stats', async ({ headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;

    return {
      data: {
        redis: services.redis.getStats(),
        identity: repositories.identity.getStats(),
        authRuntime: authRuntimeStats,
        location: services.locationService.getStats(),
        pricing: services.pricingService.getStats(),
        rides: services.rideService.getStats(),
        events: { total: eventBus.events.length },
      },
    };
  });

  router.register('GET', '/api/v1/performance', async ({ headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    return { data: services.perfMonitor.getSnapshot(services) };
  });

  router.register('GET', '/api/v1/formulas/haversine', async ({ params }) => {
    const lat1 = parseFloat(params.get('lat1'));
    const lng1 = parseFloat(params.get('lng1'));
    const lat2 = parseFloat(params.get('lat2'));
    const lng2 = parseFloat(params.get('lng2'));
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) {
      return badRequest('lat1, lng1, lat2, lng2 required', 'VALIDATION_ERROR');
    }
    return { data: { distanceKm: haversine(lat1, lng1, lat2, lng2) } };
  });

  router.register('GET', '/api/v1/formulas/bearing', async ({ params }) => {
    const lat1 = parseFloat(params.get('lat1'));
    const lng1 = parseFloat(params.get('lng1'));
    const lat2 = parseFloat(params.get('lat2'));
    const lng2 = parseFloat(params.get('lng2'));
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) {
      return badRequest('lat1, lng1, lat2, lng2 required', 'VALIDATION_ERROR');
    }
    return { data: { bearingDeg: bearing(lat1, lng1, lat2, lng2) } };
  });

  router.register('GET', '/api/v1/maps/status', async () => ({ data: services.googleMapsService.getStats() }));

  router.register('GET', '/api/v1/maps/autocomplete', async ({ params }) => {
    const input = String(params.get('input') || '').trim();
    const latRaw = params.get('lat');
    const lngRaw = params.get('lng');
    const lat = latRaw != null ? parseFloat(latRaw) : undefined;
    const lng = lngRaw != null ? parseFloat(lngRaw) : undefined;
    const sessionToken = params.get('sessionToken') || undefined;
    if (!input || input.length < 2) {
      return badRequest('input query param required (min 2 chars)', 'VALIDATION_ERROR');
    }
    if ((latRaw != null && !Number.isFinite(lat)) || (lngRaw != null && !Number.isFinite(lng))) {
      return badRequest('lat and lng must be valid numbers when provided', 'VALIDATION_ERROR');
    }
    const result = await services.googleMapsService.autocomplete(input, sessionToken, lat, lng);
    if (result.error) {
      return buildErrorFromResult(result, {
        status: 503,
        defaultCode: 'MAPS_AUTOCOMPLETE_FAILED',
        defaultMessage: 'Unable to fetch autocomplete suggestions.',
        expose: ['suggestions'],
      });
    }
    return { data: result };
  });

  router.register('GET', '/api/v1/maps/place', async ({ params }) => {
    const placeId = String(params.get('placeId') || '').trim();
    const sessionToken = params.get('sessionToken') || undefined;
    if (!placeId) return badRequest('placeId required', 'VALIDATION_ERROR');
    const result = await services.googleMapsService.getPlaceCoordinates(placeId, sessionToken);
    if (result.error) {
      return buildErrorFromResult(result, {
        status: 503,
        defaultCode: 'MAPS_PLACE_LOOKUP_FAILED',
        defaultMessage: 'Unable to fetch place details.',
      });
    }
    return { data: result };
  });

  router.register('GET', '/api/v1/maps/reverse-geocode', async ({ params }) => {
    const lat = parseFloat(params.get('lat'));
    const lng = parseFloat(params.get('lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return badRequest('lat and lng required', 'VALIDATION_ERROR');
    }
    const result = await services.googleMapsService.reverseGeocode(lat, lng);
    if (result.error) {
      return buildErrorFromResult(result, {
        status: 503,
        defaultCode: 'MAPS_REVERSE_GEOCODE_FAILED',
        defaultMessage: 'Unable to reverse geocode location.',
      });
    }
    return { data: result };
  });

  router.register('POST', '/api/v1/fare/estimate', async ({ body, headers }) => {
    const pickupLat = parseFloat(body?.pickupLat);
    const pickupLng = parseFloat(body?.pickupLng);
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
      return badRequest('pickupLat and pickupLng must be valid coordinates', 'VALIDATION_ERROR');
    }
    const estimates = await services.pricingService.getEstimates(pickupLat, pickupLng, body?.destLat, body?.destLng);
    const session = await optionalSession(headers || {});
    if (session?.userId && services?.coinsService) {
      const rideType = String(body?.rideType || '').trim().toLowerCase();
      const patchCoinQuote = async (rideTypeName, estimate) => {
        if (!estimate || typeof estimate !== 'object') return;
        estimate.coins = await services.coinsService.toRideCoinsQuote(
          session.userId,
          Number(estimate.finalFare || 0),
          { rideType: rideTypeName || null }
        );
      };

      if (rideType && estimates?.estimates?.[rideType]) {
        await patchCoinQuote(rideType, estimates.estimates[rideType]);
      } else if (estimates?.estimates && typeof estimates.estimates === 'object') {
        await Promise.all(
          Object.entries(estimates.estimates).map(([key, value]) => patchCoinQuote(key, value))
        );
      }
    }
    return { data: estimates };
  });

  router.register('GET', '/api/v1/surge/zones', async () => ({ data: { zones: services.pricingService.getSurgeZones() } }));

  router.register('POST', '/api/v1/surge/update', async ({ body }) => {
    const result = services.pricingService.updateSurge(body?.zoneId, body?.demand, body?.supply);
    return { data: result };
  });

  router.register('GET', '/api/v1/admin/zones', async ({ headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    return { data: { zones: services.zoneService.listZones(), stats: services.zoneService.getStats() } };
  });

  router.register('POST', '/api/v1/admin/zones', async ({ body, headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    const result = services.zoneService.createZone({
      name: body?.name,
      lat: parseFloat(body?.lat),
      lng: parseFloat(body?.lng),
      radiusKm: parseFloat(body?.radiusKm),
    });
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 400,
        defaultCode: 'ZONE_CREATE_FAILED',
        defaultMessage: 'Unable to create zone.',
      });
    }
    return { status: 201, data: result };
  });

  router.register('PUT', '/api/v1/admin/zones/:zoneId/enable', async ({ pathParams, headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    const result = services.zoneService.setZoneEnabled(pathParams.zoneId, true);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 404,
        defaultCode: 'ZONE_NOT_FOUND',
        defaultMessage: 'Zone not found.',
      });
    }
    return { status: 200, data: result };
  });

  router.register('PUT', '/api/v1/admin/zones/:zoneId/disable', async ({ pathParams, headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    const result = services.zoneService.setZoneEnabled(pathParams.zoneId, false);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 404,
        defaultCode: 'ZONE_NOT_FOUND',
        defaultMessage: 'Zone not found.',
      });
    }
    return { status: 200, data: result };
  });

  router.register('DELETE', '/api/v1/admin/zones/:zoneId', async ({ pathParams, headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    const result = services.zoneService.deleteZone(pathParams.zoneId);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 404,
        defaultCode: 'ZONE_NOT_FOUND',
        defaultMessage: 'Zone not found.',
      });
    }
    return { status: 200, data: result };
  });

  router.register('GET', '/api/v1/admin/notifications/stats', async ({ headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    return { data: services.notificationService.getStats() };
  });

  router.register('GET', '/api/v1/admin/sms/stats', async ({ headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    return { data: services.smsService.getStats() };
  });

  router.register('GET', '/api/v1/admin/dev/matching/auto-accepts', async ({ params, headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    if (!isDevelopmentRuntime) {
      return notFoundError('Not found', 'NOT_FOUND');
    }

    const limit = Math.max(1, Math.min(parseInt(params.get('limit') || '20', 10) || 20, 200));
    const rideId = String(params.get('rideId') || '').trim() || null;
    const driverId = String(params.get('driverId') || '').trim() || null;
    const events = services.matchingEngine.getRecentDevAutoAcceptTrace({
      limit,
      rideId,
      driverId,
    });

    return {
      data: {
        events,
        count: events.length,
        filters: {
          limit,
          rideId,
          driverId,
        },
      },
    };
  });
}

module.exports = registerSystemRoutes;
