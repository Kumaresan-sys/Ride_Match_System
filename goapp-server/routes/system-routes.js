const { haversine, bearing } = require('../utils/formulas');

function registerSystemRoutes(router, ctx) {
  const { enterpriseConfig, repositories, services, eventBus, requireAdmin, authRuntimeStats } = ctx;

  function ensureAdmin(headers = {}) {
    const adminCheck = requireAdmin(headers);
    return adminCheck || null;
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
        canRunWithoutDatabase: true,
        eventBusBuffered: true,
        inMemoryTestDataSeeded: Boolean(services.mockDb.getStats().seedMeta),
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
      return { status: 400, data: { error: 'lat1, lng1, lat2, lng2 required' } };
    }
    return { data: { distanceKm: haversine(lat1, lng1, lat2, lng2) } };
  });

  router.register('GET', '/api/v1/formulas/bearing', async ({ params }) => {
    const lat1 = parseFloat(params.get('lat1'));
    const lng1 = parseFloat(params.get('lng1'));
    const lat2 = parseFloat(params.get('lat2'));
    const lng2 = parseFloat(params.get('lng2'));
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) {
      return { status: 400, data: { error: 'lat1, lng1, lat2, lng2 required' } };
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
      return { status: 400, data: { error: 'input query param required (min 2 chars)' } };
    }
    if ((latRaw != null && !Number.isFinite(lat)) || (lngRaw != null && !Number.isFinite(lng))) {
      return { status: 400, data: { error: 'lat and lng must be valid numbers when provided' } };
    }
    const result = await services.googleMapsService.autocomplete(input, sessionToken, lat, lng);
    if (result.error) return { status: 503, data: result };
    return { data: result };
  });

  router.register('GET', '/api/v1/maps/place', async ({ params }) => {
    const placeId = String(params.get('placeId') || '').trim();
    const sessionToken = params.get('sessionToken') || undefined;
    if (!placeId) return { status: 400, data: { error: 'placeId required' } };
    const result = await services.googleMapsService.getPlaceCoordinates(placeId, sessionToken);
    if (result.error) return { status: 503, data: result };
    return { data: result };
  });

  router.register('GET', '/api/v1/maps/reverse-geocode', async ({ params }) => {
    const lat = parseFloat(params.get('lat'));
    const lng = parseFloat(params.get('lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { status: 400, data: { error: 'lat and lng required' } };
    }
    const result = await services.googleMapsService.reverseGeocode(lat, lng);
    if (result.error) return { status: 503, data: result };
    return { data: result };
  });

  router.register('POST', '/api/v1/fare/estimate', async ({ body }) => {
    const pickupLat = parseFloat(body?.pickupLat);
    const pickupLng = parseFloat(body?.pickupLng);
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
      return { status: 400, data: { error: 'pickupLat and pickupLng must be valid coordinates' } };
    }
    const estimates = await services.pricingService.getEstimates(pickupLat, pickupLng, body?.destLat, body?.destLng);
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
    return { status: result.success ? 201 : 400, data: result };
  });

  router.register('PUT', '/api/v1/admin/zones/:zoneId/enable', async ({ pathParams, headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    const result = services.zoneService.setZoneEnabled(pathParams.zoneId, true);
    return { status: result.success ? 200 : 404, data: result };
  });

  router.register('PUT', '/api/v1/admin/zones/:zoneId/disable', async ({ pathParams, headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    const result = services.zoneService.setZoneEnabled(pathParams.zoneId, false);
    return { status: result.success ? 200 : 404, data: result };
  });

  router.register('DELETE', '/api/v1/admin/zones/:zoneId', async ({ pathParams, headers }) => {
    const adminError = ensureAdmin(headers);
    if (adminError) return adminError;
    const result = services.zoneService.deleteZone(pathParams.zoneId);
    return { status: result.success ? 200 : 404, data: result };
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
}

module.exports = registerSystemRoutes;
