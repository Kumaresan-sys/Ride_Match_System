'use strict';

const { validateSchema, validationError, forbiddenError, parseQueryNumber, parsePathParams } = require('./validation');

function registerPoolRoutes(router, ctx) {
  const { requireAuth, requireAdmin, services } = ctx;
  const { demandAggregationService } = services;

  router.register('POST', '/api/v1/pool/match', async ({ body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'riderId', type: 'string', required: true },
      { key: 'pickupLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'pickupLng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'destLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'destLng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'fareInr', type: 'number', required: true, min: 1 },
      { key: 'rideType', type: 'string', required: false },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    if (parsed.data.riderId !== auth.session.userId) {
      return forbiddenError('Forbidden: riderId must match authenticated user.');
    }

    const result = demandAggregationService.smartMatch(parsed.data);
    return { data: result };
  });

  router.register('POST', '/api/v1/pool', async ({ body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'riderId', type: 'string', required: true },
      { key: 'pickupLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'pickupLng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'destLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'destLng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'fareInr', type: 'number', required: true, min: 1 },
      { key: 'rideType', type: 'string', required: false },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    if (parsed.data.riderId !== auth.session.userId) {
      return forbiddenError('Forbidden: riderId must match authenticated user.');
    }

    const result = demandAggregationService.createPool(parsed.data);
    return { status: result.success ? 201 : 400, data: result };
  });

  router.register('GET', '/api/v1/pool/:poolId', async ({ pathParams }) => {
    const pathValidation = parsePathParams(pathParams, [{ key: 'poolId', type: 'string', required: true, minLength: 2 }]);
    if (!pathValidation.ok) return validationError(pathValidation.error);
    const pool = demandAggregationService.getPool(pathValidation.data.poolId);
    return { data: pool || { error: 'Pool not found', code: 'NOT_FOUND' } };
  });

  router.register('POST', '/api/v1/pool/:poolId/join', async ({ pathParams, body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'riderId', type: 'string', required: true },
      { key: 'pickupLat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'pickupLng', type: 'number', required: true, min: -180, max: 180 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    if (parsed.data.riderId !== auth.session.userId) {
      return forbiddenError('Forbidden: riderId must match authenticated user.');
    }

    const pathValidation = parsePathParams(pathParams, [{ key: 'poolId', type: 'string', required: true, minLength: 2 }]);
    if (!pathValidation.ok) return validationError(pathValidation.error);
    const result = demandAggregationService.joinPool(pathValidation.data.poolId, parsed.data);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('POST', '/api/v1/pool/:poolId/leave', async ({ pathParams, body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const riderId = String(body?.riderId || '').trim();
    if (!riderId) return validationError('riderId required');
    if (riderId !== auth.session.userId) {
      return forbiddenError('Forbidden: riderId must match authenticated user.');
    }
    const pathValidation = parsePathParams(pathParams, [{ key: 'poolId', type: 'string', required: true, minLength: 2 }]);
    if (!pathValidation.ok) return validationError(pathValidation.error);
    const result = demandAggregationService.leavePool(pathValidation.data.poolId, riderId);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('GET', '/api/v1/riders/:riderId/pools', async ({ pathParams, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;
    if (pathParams.riderId !== auth.session.userId) {
      return forbiddenError('Forbidden: riderId must match authenticated user.');
    }
    return { data: { pools: demandAggregationService.getRiderPools(pathParams.riderId) } };
  });

  router.register('GET', '/api/v1/admin/pool', async ({ params, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const status = params.get('status') || undefined;
    const limitParsed = parseQueryNumber(params, 'limit', { min: 1, max: 200, fallback: 50 });
    if (!limitParsed.ok) return validationError(limitParsed.error);
    return { data: { pools: demandAggregationService.listPools({ status, limit: limitParsed.value }) } };
  });

  router.register('POST', '/api/v1/admin/pool/:poolId/dispatch', async ({ pathParams, body, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const result = demandAggregationService.dispatchDriver(pathParams.poolId, body?.driverId, body?.rideId);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('PUT', '/api/v1/admin/pool/:poolId/status', async ({ pathParams, body, headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    const result = demandAggregationService.updateStatus(pathParams.poolId, body?.status);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('GET', '/api/v1/admin/pool/stats', async ({ headers }) => {
    const admin = requireAdmin(headers || {});
    if (admin) return admin;
    return { data: demandAggregationService.getStats() };
  });
}

module.exports = registerPoolRoutes;
