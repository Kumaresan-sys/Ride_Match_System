function registerWalletRoutes(router, ctx) {
  const { repositories, services } = ctx;
  const requireAuth = ctx.requireAuth;
  const { redis } = services;
  const { validateSchema, validationError } = require('./validation');
  const {
    forbiddenError,
    buildErrorFromResult,
    getAuthenticatedSession,
  } = require('./response');

  async function ensureWalletOwner(headers, userId) {
    const auth = await getAuthenticatedSession(requireAuth, headers);
    if (auth.error) return auth;
    if (auth.session.userId !== userId) {
      return { error: forbiddenError('Forbidden: cannot access another user wallet.', 'FORBIDDEN_WALLET_ACCESS') };
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
    const idempotencyKey = String(
      headers?.['idempotency-key'] || headers?.['x-idempotency-key'] || body?.idempotencyKey || ''
    ).trim() || null;
    const parsed = validateSchema(body, [
      { key: 'fareInr', type: 'number', required: true, min: 0.01 },
      { key: 'rideId', type: 'string', required: false, maxLength: 255 },
      { key: 'paymentId', type: 'string', required: false, maxLength: 255 },
      { key: 'method', type: 'string', required: false, maxLength: 64 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    const result = await repositories.wallet.payRide(
      pathParams.userId,
      parsed.data.fareInr,
      parsed.data.rideId,
      parsed.data.paymentId,
      parsed.data.method,
      idempotencyKey
    );
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 400,
        defaultCode: 'WALLET_PAY_FAILED',
        defaultMessage: 'Wallet payment failed.',
      });
    }
    return { status: 200, data: result };
  });

  router.register('POST', '/api/v1/wallet/:userId/refund', async ({ pathParams, body, headers }) => {
    const auth = await ensureWalletOwner(headers, pathParams.userId);
    if (auth.error) return auth.error;
    const idempotencyKey = String(
      headers?.['idempotency-key'] || headers?.['x-idempotency-key'] || body?.idempotencyKey || ''
    ).trim() || null;
    const parsed = validateSchema(body, [
      { key: 'amount', type: 'number', required: true, min: 0.01 },
      { key: 'rideId', type: 'string', required: false, maxLength: 255 },
      { key: 'reason', type: 'string', required: false, maxLength: 255 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    const result = await repositories.wallet.refund(
      pathParams.userId,
      parsed.data.amount,
      parsed.data.rideId,
      parsed.data.reason,
      idempotencyKey
    );
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 400,
        defaultCode: 'WALLET_REFUND_FAILED',
        defaultMessage: 'Wallet refund failed.',
      });
    }
    return { status: 200, data: result };
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
    if (!parsed.ok) return validationError(parsed.error);

    const idempotencyKey = String(
      parsed.data.idempotencyKey
      || body.idempotency_key
      || headers?.['idempotency-key']
      || headers?.['x-idempotency-key']
      || ''
    ).trim() || null;
    if (idempotencyKey) {
      const check = await redis.checkIdempotency(`wallet_topup:${pathParams.userId}:${idempotencyKey}`);
      if (check.isDuplicate) return { status: 200, data: { ...check.existingResult, duplicate: true } };
    }

    const result = await services.walletService.topupWallet(
      pathParams.userId,
      parsed.data.amount,
      parsed.data.method || 'upi',
      parsed.data.referenceId || null,
      idempotencyKey
    );

    if (idempotencyKey && result.success) {
      await redis.setIdempotency(`wallet_topup:${pathParams.userId}:${idempotencyKey}`, result, 600);
    }

    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 400,
        defaultCode: 'WALLET_TOPUP_FAILED',
        defaultMessage: 'Wallet top-up failed.',
      });
    }
    return { status: 200, data: result };
  });

  router.register('POST', '/api/v1/wallet/:userId/redeem', async ({ pathParams, body, headers }) => {
    const auth = await ensureWalletOwner(headers, pathParams.userId);
    if (auth.error) return auth.error;

    const parsed = validateSchema(body, [
      { key: 'fareInr', type: 'number', required: true, min: 1 },
      { key: 'coinsToUse', type: 'number', required: false, min: 1 },
    ]);
    if (!parsed.ok) return validationError(parsed.error);
    const result = await services.walletService.redeemCoins(
      pathParams.userId,
      parsed.data.fareInr,
      parsed.data.coinsToUse
    );
    if (!result.success) {
      return buildErrorFromResult(result, {
        status: 400,
        defaultCode: 'WALLET_REDEEM_FAILED',
        defaultMessage: 'Wallet coin redemption failed.',
      });
    }
    return { status: 200, data: result };
  });
}

module.exports = registerWalletRoutes;
