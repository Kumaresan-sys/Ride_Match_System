'use strict';

const { requireOwnedResource } = require('../middleware/authz-middleware');
const { validateSchema, validationError } = require('./validation');
const {
  buildErrorFromResult,
  normalizeRouteError,
  getAuthenticatedSession,
} = require('./response');

function registerDriverRoutes(router, ctx) {
  const { requireAuth, requireAdmin, services } = ctx;
  const { notificationService, driverWalletService, locationService } = services;

  router.register('GET', '/api/v1/drivers', async ({ headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;
    return { data: { drivers: locationService.getAllTracked() } };
  });

  router.register('GET', '/api/v1/drivers/nearby', async ({ params, headers }) => {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth.error;

    const parsed = validateSchema(
      {
        lat: params.get('lat'),
        lng: params.get('lng'),
        radius: params.get('radius') || 5,
      },
      [
        { key: 'lat', type: 'number', required: true, min: -90, max: 90 },
        { key: 'lng', type: 'number', required: true, min: -180, max: 180 },
        { key: 'radius', type: 'number', required: false, min: 0.1, max: 50 },
      ]
    );
    if (!parsed.ok) return validationError(parsed.error);

    const nearby = await locationService.findNearby(parsed.data.lat, parsed.data.lng, parsed.data.radius || 5, 20);
    return { data: { count: nearby.length, drivers: nearby } };
  });

  router.register('PUT', '/api/v1/drivers/:driverId/location', async ({ pathParams, body, headers }) => {
    const owner = await requireOwnedResource({
      headers,
      resourceUserId: pathParams.driverId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot update another driver location.',
    });
    if (owner.error) return normalizeRouteError(owner.error);

    const parsed = validateSchema(body, [
      { key: 'lat', type: 'number', required: true, min: -90, max: 90 },
      { key: 'lng', type: 'number', required: true, min: -180, max: 180 },
      { key: 'speed', type: 'number', required: false, min: 0, max: 300 },
      { key: 'heading', type: 'number', required: false, min: 0, max: 360 },
      { key: 'clientTimestamp', type: 'number', required: false, min: 0 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const result = await locationService.updateLocation(pathParams.driverId, parsed.data);
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 400,
        defaultCode: 'DRIVER_LOCATION_UPDATE_FAILED',
        defaultMessage: 'Unable to update driver location.',
        expose: ['flag'],
      });
    }
    return { data: result };
  });

  router.register('POST', '/api/v1/users/:userId/device-token', async ({ pathParams, body, headers }) => {
    const owner = await requireOwnedResource({
      headers,
      resourceUserId: pathParams.userId,
      requireAuth,
      requireAdmin,
    });
    if (owner.error) return normalizeRouteError(owner.error);

    const parsed = validateSchema(body, [
      { key: 'token', type: 'string', required: true, minLength: 20, maxLength: 4096 },
      { key: 'platform', type: 'string', required: false, enum: ['ios', 'android', 'web', 'postman'] },
      { key: 'deviceId', type: 'string', required: false, maxLength: 255 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const result = await notificationService.registerToken(
      pathParams.userId,
      parsed.data.token,
      parsed.data.platform,
      null,
    );

    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 400,
        defaultCode: 'DEVICE_TOKEN_REGISTER_FAILED',
        defaultMessage: 'Unable to register device token.',
      });
    }
    return { status: 200, data: result };
  });

  router.register('DELETE', '/api/v1/users/:userId/device-token', async ({ pathParams, headers }) => {
    const owner = await requireOwnedResource({
      headers,
      resourceUserId: pathParams.userId,
      requireAuth,
      requireAdmin,
    });
    if (owner.error) return normalizeRouteError(owner.error);

    await notificationService.removeToken(pathParams.userId);
    return { data: { success: true } };
  });

  router.register('GET', '/api/v1/driver-wallet/:driverId/balance', async ({ pathParams, headers }) => {
    const owner = await requireOwnedResource({
      headers,
      resourceUserId: pathParams.driverId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another driver wallet.',
    });
    if (owner.error) return normalizeRouteError(owner.error);
    return { data: await driverWalletService.getBalance(pathParams.driverId) };
  });

  router.register('GET', '/api/v1/driver-wallet/:driverId/transactions', async ({ pathParams, params, headers }) => {
    const owner = await requireOwnedResource({
      headers,
      resourceUserId: pathParams.driverId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another driver wallet.',
    });
    if (owner.error) return normalizeRouteError(owner.error);

    const limit = Number.parseInt(params.get('limit') || '20', 10);
    return { data: await driverWalletService.getTransactions(pathParams.driverId, Math.min(Math.max(limit, 1), 100)) };
  });

  router.register('POST', '/api/v1/driver-wallet/:driverId/recharge', async ({ pathParams, body, headers }) => {
    const owner = await requireOwnedResource({
      headers,
      resourceUserId: pathParams.driverId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot recharge another driver wallet.',
    });
    if (owner.error) return owner.error;

    const parsed = validateSchema(body, [
      { key: 'amount', type: 'number', required: true, min: 1, max: 100000 },
      { key: 'method', type: 'string', required: false, enum: ['upi', 'card', 'netbanking', 'razorpay', 'admin'] },
      { key: 'referenceId', type: 'string', required: false, maxLength: 255 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const result = await driverWalletService.rechargeWallet(
      pathParams.driverId,
      parsed.data.amount,
      parsed.data.method || 'upi',
      parsed.data.referenceId || null,
    );

    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 400,
        defaultCode: 'DRIVER_WALLET_RECHARGE_FAILED',
        defaultMessage: 'Unable to recharge driver wallet.',
      });
    }
    return { status: 200, data: result };
  });

  router.register('GET', '/api/v1/driver-wallet/:driverId/eligibility', async ({ pathParams, headers }) => {
    const owner = await requireOwnedResource({
      headers,
      resourceUserId: pathParams.driverId,
      requireAuth,
      requireAdmin,
      forbiddenMessage: 'Forbidden: cannot access another driver wallet.',
    });
    if (owner.error) return normalizeRouteError(owner.error);
    return { data: await driverWalletService.canReceiveRide(pathParams.driverId) };
  });
}

module.exports = registerDriverRoutes;
