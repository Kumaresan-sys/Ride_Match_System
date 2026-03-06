const { haversine, bearing } = require('../utils/formulas');

function registerSystemRoutes(router, ctx) {
  const { enterpriseConfig, repositories, services, eventBus } = ctx;

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

  router.register('GET', '/api/v1/users', async ({ params }) => {
    const limit = Number(params.get('limit') || 20);
    return { data: { users: repositories.identity.getUsers(limit) } };
  });

  router.register('GET', '/api/v1/auth/stats', async () => ({ data: repositories.identity.getStats() }));
  router.register('GET', '/api/v1/events', async ({ params }) => {
    const count = parseInt(params.get('count') || '20', 10);
    return { data: { events: eventBus.getRecentEvents(count) } };
  });

  router.register('GET', '/api/v1/stats', async () => ({
    data: {
      redis: services.redis.getStats(),
      identity: repositories.identity.getStats(),
      location: services.locationService.getStats(),
      pricing: services.pricingService.getStats(),
      rides: services.rideService.getStats(),
      events: { total: eventBus.events.length },
    },
  }));

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
}

module.exports = registerSystemRoutes;
