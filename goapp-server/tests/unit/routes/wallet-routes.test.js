'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerWalletRoutes = require('../../../routes/wallet-routes');

function createRouter() {
  const routes = new Map();
  return {
    register(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    get(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
}

test('wallet transactions route returns UI-compatible payload shape', async () => {
  const router = createRouter();
  registerWalletRoutes(router, {
    repositories: {
      wallet: {
        getTransactions: async () => ({
          userId: 'user-1',
          transactions: [{ txId: 'txn_1', amountInr: 250 }],
        }),
      },
    },
    services: {
      redis: {
        checkIdempotency: async () => ({ isDuplicate: false }),
        setIdempotency: async () => {},
      },
    },
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    requireAdmin: () => ({ status: 401, data: { error: 'Admin auth required' } }),
  });

  const handler = router.get('GET', '/api/v1/wallet/:userId/transactions');
  const response = await handler({
    pathParams: { userId: 'user-1' },
    params: new URLSearchParams('limit=10'),
    headers: {},
  });

  assert.deepEqual(response.data, {
    userId: 'user-1',
    transactions: [{ txId: 'txn_1', amountInr: 250 }],
  });
});

test('direct rider wallet topup route is blocked for non-admin callers', async () => {
  const router = createRouter();
  registerWalletRoutes(router, {
    repositories: {
      wallet: {
        getTransactions: async () => ({ userId: 'user-1', transactions: [] }),
      },
    },
    services: {
      redis: {
        checkIdempotency: async () => ({ isDuplicate: false }),
        setIdempotency: async () => {},
      },
      walletService: {
        topupWallet: async () => ({ success: true }),
      },
    },
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    requireAdmin: () => ({ status: 401, data: { error: 'Admin auth required' } }),
  });

  const handler = router.get('POST', '/api/v1/wallet/:userId/topup');
  const response = await handler({
    pathParams: { userId: 'user-1' },
    body: { amount: 500, method: 'upi' },
    headers: {},
  });

  assert.equal(response.status, 409);
  assert.equal(response.data.errorCode, 'DIRECT_WALLET_TOPUP_DISABLED');
});
