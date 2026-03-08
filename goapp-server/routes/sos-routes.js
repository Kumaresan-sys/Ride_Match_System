'use strict';

const { requireOwnedResource } = require('../middleware/authz-middleware');
const { validateSchema } = require('./validation');

function registerSosRoutes(router, ctx) {
  const { requireAuth, requireAdmin, services } = ctx;
  const { sosService } = services;

  router.register('POST', '/api/v1/sos', async ({ body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'userId', type: 'string', required: true },
      { key: 'userType', type: 'string', required: false, enum: ['rider', 'driver'] },
      { key: 'rideId', type: 'string', required: false },
      { key: 'lat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'lng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'sosType', type: 'string', required: false, enum: ['PANIC', 'ACCIDENT', 'ROUTE_DEVIATE', 'SHARE_TRIP'] },
      { key: 'message', type: 'string', required: false, maxLength: 500 },
    ]);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };
    if (parsed.data.userId !== auth.session.userId) {
      return { status: 403, data: { error: 'Forbidden: userId must match authenticated user.' } };
    }

    const result = sosService.triggerSos(parsed.data);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('GET', '/api/v1/sos/:sosId', async ({ pathParams, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const sos = sosService.getSos(pathParams.sosId);
    if (!sos) return { status: 404, data: { error: 'SOS not found' } };

    const owner = await requireOwnedResource({
      headers,
      resourceUserId: sos.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another user SOS.',
    });
    if (owner.error) return owner.error;

    return { data: sos };
  });

  router.register('POST', '/api/v1/sos/:sosId/location', async ({ pathParams, body, headers }) => {
    const auth = await requireAuth(headers || {});
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'lat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'lng', type: 'number', required: true, min: -180, max: 180 },
    ]);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };

    const sos = sosService.getSos(pathParams.sosId);
    if (!sos) return { status: 404, data: { error: 'SOS not found' } };

    const owner = await requireOwnedResource({
      headers,
      resourceUserId: sos.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot update another user SOS.',
    });
    if (owner.error) return owner.error;

    const result = sosService.updateLocation(pathParams.sosId, parsed.data);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('GET', '/api/v1/users/:userId/sos/active', async ({ pathParams, headers }) => {
    const owner = await requireOwnedResource({
      headers,
      resourceUserId: pathParams.userId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another user SOS.',
    });
    if (owner.error) return owner.error;

    const sos = sosService.getActiveSos(pathParams.userId);
    return { data: sos || { active: false } };
  });
}

module.exports = registerSosRoutes;
