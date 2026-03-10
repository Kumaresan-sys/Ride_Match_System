'use strict';

const { validateSchema, validationError, forbiddenError, parsePathParams } = require('./validation');

function registerRecoveryRoutes(router, ctx) {
  const { requireAuth, services } = ctx;
  const { rideService, rideSessionService, locationService, matchingEngine } = services;

  router.register('GET', '/api/v1/riders/:riderId/active-ride', async ({ pathParams, headers }) => {
    const pathValidation = parsePathParams(pathParams, [{ key: 'riderId', type: 'string', required: true, minLength: 2 }]);
    if (!pathValidation.ok) return validationError(pathValidation.error);
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;
    if (pathValidation.data.riderId !== auth.session.userId) {
      return forbiddenError('Forbidden: riderId must match authenticated user.');
    }

    const ride = await (rideService.getActiveRideAsync
      ? rideService.getActiveRideAsync(pathValidation.data.riderId)
      : Promise.resolve(rideService.getActiveRide(pathValidation.data.riderId)));
    if (!ride) return { data: { hasActiveRide: false } };

    await rideSessionService._logRecovery({
      type: 'active_check',
      riderId: pathValidation.data.riderId,
      rideId: ride.rideId,
      rideStatus: ride.status,
    });

    return {
      data: {
        hasActiveRide: true,
        rideId: ride.rideId,
        status: ride.status,
        wsChannel: `ride_${ride.rideId}`,
      },
    };
  });

  router.register('POST', '/api/v1/riders/:riderId/restore', async ({ pathParams, headers }) => {
    const pathValidation = parsePathParams(pathParams, [{ key: 'riderId', type: 'string', required: true, minLength: 2 }]);
    if (!pathValidation.ok) return validationError(pathValidation.error);
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;
    if (pathValidation.data.riderId !== auth.session.userId) {
      return forbiddenError('Forbidden: riderId must match authenticated user.');
    }

    const result = await rideSessionService.restoreSession(pathValidation.data.riderId, {
      rideService,
      locationService,
      matchingEngine,
    });

    if (!result.hasActiveRide) return { data: { hasActiveRide: false } };
    return { data: result };
  });

  router.register('POST', '/api/v1/riders/:riderId/heartbeat', async ({ pathParams, body, headers }) => {
    const pathValidation = parsePathParams(pathParams, [{ key: 'riderId', type: 'string', required: true, minLength: 2 }]);
    if (!pathValidation.ok) return validationError(pathValidation.error);
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;
    if (pathValidation.data.riderId !== auth.session.userId) {
      return forbiddenError('Forbidden: riderId must match authenticated user.');
    }

    const parsed = validateSchema(body || {}, [{ key: 'rideId', type: 'string', required: false, minLength: 2 }]);
    if (!parsed.ok) return validationError(parsed.error);
    const result = await rideSessionService.heartbeat(pathValidation.data.riderId, parsed.data.rideId || null);
    return { data: result };
  });
}

module.exports = registerRecoveryRoutes;
