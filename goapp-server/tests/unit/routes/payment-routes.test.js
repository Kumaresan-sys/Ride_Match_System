'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerPaymentRoutes = require('../../../routes/payment-routes');

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

test('rider create-order route delegates to wallet service with method/provider', async () => {
  const router = createRouter();
  const calls = [];

  registerPaymentRoutes(router, {
    services: {
      walletService: {
        createRazorpayTopupOrder: async (userId, amountInr, options) => {
          calls.push({ userId, amountInr, options });
          return {
            success: true,
            orderId: 'order_123',
            amount: 50000,
            currency: 'INR',
            keyId: 'rzp_test_123',
          };
        },
        verifyRazorpayTopup: async () => ({ success: true }),
        getRazorpayTopupOrder: async () => null,
      },
      driverWalletService: {
        rechargeWallet: async () => ({ success: true }),
        canReceiveRide: async () => ({ eligible: true }),
      },
      razorpayService: {
        getOrder: async () => null,
        getStats: () => ({}),
      },
    },
    eventBus: { publish: () => {} },
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    requireAdmin: () => null,
  });

  const handler = router.get('POST', '/api/v1/payments/rider/create-order');
  const response = await handler({
    body: {
      userId: 'user-1',
      amountInr: 500,
      method: 'upi',
      provider: 'google_pay',
    },
    headers: {
      'x-request-id': 'req-1',
      'idempotency-key': 'idem-1',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.orderId, 'order_123');
  assert.deepEqual(calls, [
    {
      userId: 'user-1',
      amountInr: 500,
      options: {
        method: 'upi',
        provider: 'google_pay',
        requestId: 'req-1',
        idempotencyKey: 'idem-1',
      },
    },
  ]);
});

test('rider verify route returns wallet service verification result', async () => {
  const router = createRouter();
  const calls = [];
  const published = [];

  registerPaymentRoutes(router, {
    services: {
      walletService: {
        createRazorpayTopupOrder: async () => ({ success: true }),
        verifyRazorpayTopup: async (userId, payload) => {
          calls.push({ userId, payload });
          return {
            success: true,
            message: '₹500 credited to your wallet',
            orderId: 'order_123',
            paymentId: 'pay_123',
            amountInr: 500,
            wallet: {
              success: true,
              cashBalance: 750,
            },
          };
        },
        getRazorpayTopupOrder: async () => null,
      },
      driverWalletService: {
        rechargeWallet: async () => ({ success: true }),
        canReceiveRide: async () => ({ eligible: true }),
      },
      razorpayService: {
        getOrder: async () => null,
        getStats: () => ({}),
      },
    },
    eventBus: {
      publish: (eventName, payload) => {
        published.push({ eventName, payload });
      },
    },
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    requireAdmin: () => null,
  });

  const handler = router.get('POST', '/api/v1/payments/rider/verify');
  const response = await handler({
    body: {
      razorpayOrderId: 'order_123',
      razorpayPaymentId: 'pay_123',
      razorpaySignature: 'sig_123',
    },
    headers: {
      'x-request-id': 'req-2',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.message, '₹500 credited to your wallet');
  assert.deepEqual(calls, [
    {
      userId: 'user-1',
      payload: {
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123',
        razorpaySignature: 'sig_123',
        requestId: 'req-2',
      },
    },
  ]);
  assert.equal(published.length, 1);
  assert.equal(published[0].eventName, 'payment_processed');
});
