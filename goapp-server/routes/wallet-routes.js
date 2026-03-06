function registerWalletRoutes(router, ctx) {
  const { repositories } = ctx;

  router.register('GET', '/api/v1/wallet/:userId/balance', async ({ pathParams }) => ({
    data: repositories.wallet.getBalance(pathParams.userId),
  }));

  router.register('GET', '/api/v1/wallet/:userId/transactions', async ({ pathParams, params }) => ({
    data: { transactions: repositories.wallet.getTransactions(pathParams.userId, parseInt(params.get('limit') || '50', 10)) },
  }));

  router.register('POST', '/api/v1/wallet/:userId/pay', async ({ pathParams, body }) => {
    if (!body.fareInr || body.fareInr <= 0) return { status: 400, data: { error: 'fareInr required' } };
    const result = repositories.wallet.payRide(pathParams.userId, body.fareInr, body.rideId);
    return { status: result.success ? 200 : 400, data: result };
  });

  router.register('POST', '/api/v1/wallet/:userId/refund', async ({ pathParams, body }) => {
    if (!body.amount || body.amount <= 0) return { status: 400, data: { error: 'amount required' } };
    const result = repositories.wallet.refund(pathParams.userId, body.amount, body.rideId, body.reason);
    return { status: result.success ? 200 : 400, data: result };
  });
}

module.exports = registerWalletRoutes;
