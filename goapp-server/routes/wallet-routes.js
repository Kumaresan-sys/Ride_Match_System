function registerWalletRoutes(router, ctx) {
  const { repositories, services } = ctx;
  const requireAuth = ctx.requireAuth;
  const { redis } = services;
  const { validateSchema } = require('./validation');

  async function ensureWalletOwner(headers, userId) {
    const auth = await requireAuth(headers || {});
    if (auth.error) return { error: auth.error };
    if (auth.session.userId !== userId) {
      return { error: { status: 403, data: { error: 'Forbidden: cannot access another user wallet.' } } };
    }
    return { session: auth.session };
  }

  router.register('GET', '/api/v1/wallet/:userId/balance', async ({ pathParams, headers }) => {
    const auth = await ensureWalletOwner(headers, pathParams.userId);
    if (auth.error) return auth.error;
    const balance = await repositories.wallet.getBalance(pathParams.userId);
    return { data: balance };
  });

  router.register('GET', '/api/v1/wallet/:userId/transactions', async ({ pathParams, params, headers }) => {
    const auth = await ensureWalletOwner(headers, pathParams.userId);
    if (auth.error) return auth.error;
    const transactions = await repositories.wallet.getTransactions(
      pathParams.userId,
      parseInt(params.get('limit') || '50', 10)
    );
    return {
      data: { transactions },
    };
  });

  router.register('POST', '/api/v1/wallet/:userId/pay', async ({ pathParams, body, headers }) => {
    const auth = await ensureWalletOwner(headers, pathParams.userId);
    if (auth.error) return auth.error;
    const parsed = validateSchema(body, [
      { key: 'fareInr', type: 'number', required: true, min: 0.01 },
      { key: 'rideId', type: 'string', required: false, maxLength: 255 },
    ]);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };
    const result = await repositories.wallet.payRide(pathParams.userId, parsed.data.fareInr, parsed.data.rideId);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('POST', '/api/v1/wallet/:userId/refund', async ({ pathParams, body, headers }) => {
    const auth = await ensureWalletOwner(headers, pathParams.userId);
    if (auth.error) return auth.error;
    const parsed = validateSchema(body, [
      { key: 'amount', type: 'number', required: true, min: 0.01 },
      { key: 'rideId', type: 'string', required: false, maxLength: 255 },
      { key: 'reason', type: 'string', required: false, maxLength: 255 },
    ]);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };
    const result = await repositories.wallet.refund(
      pathParams.userId,
      parsed.data.amount,
      parsed.data.rideId,
      parsed.data.reason
    );
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('POST', '/api/v1/wallet/:userId/topup', async ({ pathParams, body, headers }) => {
    const auth = await ensureWalletOwner(headers, pathParams.userId);
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'amount', type: 'number', required: true, min: 1, max: 50000 },
      { key: 'method', type: 'string', required: false, enum: ['upi', 'card', 'netbanking', 'razorpay', 'admin'] },
      { key: 'referenceId', type: 'string', required: false, maxLength: 255 },
      { key: 'idempotencyKey', type: 'string', required: false, minLength: 8, maxLength: 128 },
    ]);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };

    const idempotencyKey = parsed.data.idempotencyKey || body.idempotency_key || null;
    if (idempotencyKey) {
      const check = await redis.checkIdempotency(`wallet_topup:${pathParams.userId}:${idempotencyKey}`);
      if (check.isDuplicate) return { status: 200, data: { ...check.existingResult, duplicate: true } };
    }

    const result = await services.walletService.topupWallet(
      pathParams.userId,
      parsed.data.amount,
      parsed.data.method || 'upi',
      parsed.data.referenceId || null
    );

    if (idempotencyKey && result.success) {
      await redis.setIdempotency(`wallet_topup:${pathParams.userId}:${idempotencyKey}`, result, 600);
    }

    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('POST', '/api/v1/wallet/:userId/redeem', async ({ pathParams, body, headers }) => {
    const auth = await ensureWalletOwner(headers, pathParams.userId);
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'fareInr', type: 'number', required: true, min: 1 },
      { key: 'coinsToUse', type: 'number', required: false, min: 1 },
    ]);
    if (!parsed.ok) return { status: 400, data: { error: parsed.error } };
    const result = await services.walletService.redeemCoins(
      pathParams.userId,
      parsed.data.fareInr,
      parsed.data.coinsToUse
    );
    return { status: result.success ? 200 : 400, data: result };
  });
}

module.exports = registerWalletRoutes;
