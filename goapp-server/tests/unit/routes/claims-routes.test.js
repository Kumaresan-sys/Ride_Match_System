'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerClaimsRoutes = require('../../../routes/claims-routes');

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

test('claims referral route returns live referral summary payload', async () => {
  const router = createRouter();
  registerClaimsRoutes(router, {
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    services: {
      referralService: {
        getReferralSummary: async (userId) => ({
          code: 'YOGE1234',
          rewardCoins: 100,
          description:
            'Share your code and earn 100 coins when your friend completes their first ride.',
          shareMessage: 'Join GoApp with my referral code YOGE1234.',
          totalEarnedCoins: 200,
          totalReferrals: 3,
          completedReferrals: 2,
          pendingReferrals: 1,
          history: [
            {
              trackingId: 'track-1',
              displayName: 'Friend One',
              maskedPhone: '98******10',
              status: 'reward_issued',
              rewardCoins: 100,
              usedAt: '2026-03-10T10:00:00.000Z',
              completedAt: '2026-03-11T10:00:00.000Z',
              rewardIssuedAt: '2026-03-11T10:01:00.000Z',
              rideId: 'ride-1',
            },
          ],
          userId,
        }),
      },
    },
  });

  const handler = router.get('GET', '/api/v1/claims/referral');
  const response = await handler({ headers: {} });

  assert.equal(response.status, undefined);
  assert.equal(response.data.code, 'YOGE1234');
  assert.equal(response.data.rewardCoins, 100);
  assert.equal(response.data.totalEarnedCoins, 200);
  assert.equal(response.data.history.length, 1);
  assert.equal(response.data.history[0].trackingId, 'track-1');
});

test('claims referral route normalizes auth failures', async () => {
  const router = createRouter();
  registerClaimsRoutes(router, {
    requireAuth: async () => ({
      error: {
        status: 401,
        data: {
          error: 'Authentication required.',
          errorCode: 'AUTH_REQUIRED',
        },
      },
    }),
    services: {
      referralService: {
        getReferralSummary: async () => {
          throw new Error('should not be called');
        },
      },
    },
  });

  const handler = router.get('GET', '/api/v1/claims/referral');
  const response = await handler({ headers: {} });

  assert.equal(response.status, 401);
  assert.equal(response.data.errorCode, 'AUTH_REQUIRED');
});
