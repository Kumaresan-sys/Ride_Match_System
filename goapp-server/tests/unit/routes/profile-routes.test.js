'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerProfileRoutes = require('../../../routes/profile-routes');

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

test('profile create accepts referral code and returns live referral fields', async () => {
  const router = createRouter();
  registerProfileRoutes(router, {
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    services: {
      profileService: {
        upsertUserProfileWithEmail: async () => {},
        awardWelcomeBonus: async () => ({ coinsAwarded: 100 }),
        generateOrGetReferralCode: async () => ({ code: 'YOGE1234' }),
      },
      referralService: {
        validateReferralCode: async () => ({ rewardCoins: 100 }),
        applyReferralCode: async () => ({ code: 'FRND1001' }),
      },
      safetyService: {
        seedProfileEmergencyContact: async () => {},
      },
      notificationService: {
        send: async () => ({ sent: true }),
      },
    },
  });

  const handler = router.get('POST', '/api/v1/profile/create');
  const response = await handler({
    body: {
      name: 'Yogesh',
      gender: 'Male',
      date_of_birth: '12 July 1985',
      email: 'yogesh@example.com',
      emergency_contact: '9876543210',
      referral_code: 'frnd1001',
    },
    headers: {},
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.referralCode, 'YOGE1234');
  assert.equal(response.data.appliedReferralCode, 'FRND1001');
  assert.equal(response.data.coinsAwarded, 100);
});

test('profile create rejects invalid referral code before saving profile', async () => {
  const router = createRouter();
  let upsertCalled = false;
  registerProfileRoutes(router, {
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    services: {
      profileService: {
        upsertUserProfileWithEmail: async () => {
          upsertCalled = true;
        },
      },
      referralService: {
        validateReferralCode: async () => {
          const err = new Error('Referral code is invalid.');
          err.code = 'INVALID_REFERRAL_CODE';
          throw err;
        },
      },
      safetyService: {
        seedProfileEmergencyContact: async () => {},
      },
    },
  });

  const handler = router.get('POST', '/api/v1/profile/create');
  const response = await handler({
    body: {
      name: 'Yogesh',
      gender: 'Male',
      date_of_birth: '12 July 1985',
      email: 'yogesh@example.com',
      emergency_contact: '9876543210',
      referral_code: 'badcode',
    },
    headers: {},
  });

  assert.equal(response.status, 400);
  assert.equal(response.data.errorCode, 'INVALID_REFERRAL_CODE');
  assert.equal(upsertCalled, false);
});

test('profile create rejects self referral with conflict response', async () => {
  const router = createRouter();
  let upsertCalled = false;
  registerProfileRoutes(router, {
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    services: {
      profileService: {
        upsertUserProfileWithEmail: async () => {
          upsertCalled = true;
        },
      },
      referralService: {
        validateReferralCode: async () => {
          const err = new Error('You cannot use your own referral code.');
          err.code = 'SELF_REFERRAL_NOT_ALLOWED';
          throw err;
        },
      },
      safetyService: {
        seedProfileEmergencyContact: async () => {},
      },
    },
  });

  const handler = router.get('POST', '/api/v1/profile/create');
  const response = await handler({
    body: {
      name: 'Yogesh',
      gender: 'Male',
      date_of_birth: '12 July 1985',
      email: 'yogesh@example.com',
      emergency_contact: '9876543210',
      referral_code: 'SELF100',
    },
    headers: {},
  });

  assert.equal(response.status, 409);
  assert.equal(response.data.errorCode, 'SELF_REFERRAL_NOT_ALLOWED');
  assert.equal(upsertCalled, false);
});

test('profile get returns generated referral code', async () => {
  const router = createRouter();
  registerProfileRoutes(router, {
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    services: {
      profileService: {
        getUserProfile: async () => ({
          name: 'Yogesh',
          gender: 'Male',
          date_of_birth: '12 July 1985',
          emergency_contact: '9876543210',
          createdAt: Date.now(),
        }),
        getUserById: async () => ({
          phone_number: '9876543210',
          email: 'yogesh@example.com',
          createdAt: Date.now(),
        }),
        generateOrGetReferralCode: async () => ({ code: 'YOGE1234' }),
      },
      safetyService: {
        seedProfileEmergencyContact: async () => {},
      },
    },
  });

  const handler = router.get('GET', '/api/v1/profile');
  const response = await handler({ headers: {} });

  assert.equal(response.status, 200);
  assert.equal(response.data.referralCode, 'YOGE1234');
});
