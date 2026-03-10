'use strict';

const {
  parseQueryNumber,
  validateSchema,
  validationError,
} = require('./validation');
const { getAuthenticatedSession } = require('./response');

function registerCoinsRoutes(router, ctx) {
  const requireAuth = ctx.requireAuth;
  const coinsService = ctx.services.coinsService;

  async function getSession(headers = {}) {
    return getAuthenticatedSession(requireAuth, headers);
  }

  router.register('GET', '/api/v1/coins/balance', async ({ headers }) => {
    const auth = await getSession(headers || {});
    if (auth.error) return auth.error;

    const result = await coinsService.getCoinsBalance(auth.session.userId);
    return {
      data: {
        totalCoins: result.totalCoins,
        autoUseEnabled: result.autoUseEnabled,
        conversionRate: result.conversionRate,
        maxDiscountPct: result.maxDiscountPct,
        minRedeemCoins: result.minRedeemCoins,
      },
    };
  });

  router.register('GET', '/api/v1/coins/history', async ({ headers, params }) => {
    const auth = await getSession(headers || {});
    if (auth.error) return auth.error;

    const pageResult = parseQueryNumber(params, 'page', { min: 1, max: 100000, fallback: 1 });
    if (!pageResult.ok) return validationError(pageResult.error);
    const limitResult = parseQueryNumber(params, 'limit', { min: 1, max: 100, fallback: 20 });
    if (!limitResult.ok) return validationError(limitResult.error);

    const transactions = await coinsService.getCoinsHistory(auth.session.userId, {
      page: pageResult.value,
      limit: limitResult.value,
    });

    return { data: { transactions } };
  });

  router.register('PUT', '/api/v1/coins/auto-use', async ({ headers, body }) => {
    const auth = await getSession(headers || {});
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'enabled', type: 'boolean', required: true },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const result = await coinsService.setAutoUse(auth.session.userId, parsed.data.enabled);
    return {
      data: {
        totalCoins: result.totalCoins,
        autoUseEnabled: result.autoUseEnabled,
        conversionRate: result.conversionRate,
        maxDiscountPct: result.maxDiscountPct,
        minRedeemCoins: result.minRedeemCoins,
      },
    };
  });

  router.register('POST', '/api/v1/coins/preview', async ({ headers, body }) => {
    const auth = await getSession(headers || {});
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'fareInr', type: 'number', required: true, min: 0 },
      { key: 'rideId', type: 'string', required: false, maxLength: 255 },
      { key: 'rideType', type: 'string', required: false, maxLength: 64 },
      { key: 'autoUse', type: 'boolean', required: false },
      { key: 'requestedCoins', type: 'number', required: false, min: 0 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);

    const preview = await coinsService.previewRideDiscount(auth.session.userId, {
      fareInr: parsed.data.fareInr,
      rideId: parsed.data.rideId || null,
      rideType: parsed.data.rideType || null,
      autoUse: body?.autoUse,
      requestedCoins: parsed.data.requestedCoins,
    });

    return { data: preview };
  });
}

module.exports = registerCoinsRoutes;
