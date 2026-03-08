const test = require('node:test');
const assert = require('node:assert/strict');

const registerAuthRoutes = require('../routes/auth-routes');

function buildRouter() {
  const handlers = new Map();
  return {
    handlers,
    register(method, path, handler) {
      handlers.set(`${method} ${path}`, handler);
    },
  };
}

test('login registers device token and sends profile setup push for new user', async () => {
  const router = buildRouter();
  const sent = [];

  registerAuthRoutes(router, {
    repositories: {
      identity: {
        verifyOtp: async () => ({
          success: true,
          isNewUser: true,
          sessionToken: 'session-1',
          deviceRecordId: 'device-row-1',
          user: { userId: 'user-1', phoneNumber: '+919876543210' },
        }),
        isProfileComplete: async () => false,
        getUserProfile: async () => null,
      },
    },
    services: {
      notificationService: {
        async send(userId, payload) {
          sent.push({ userId, payload });
        },
      },
    },
  });

  const handler = router.handlers.get('POST /api/v1/auth/login');
  const response = await handler({
    body: {
      phone: '9876543210',
      countryCode: '+91',
      otp: '123456',
      fcmToken: 'fcm-token-1',
      platform: 'android',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'Welcome to GoApp');
  assert.equal(sent[0].payload.data.route, 'profile_setup');
  assert.equal(response.data.data.user.name, '');
});

test('login sends welcome back push with profile name for existing user', async () => {
  const router = buildRouter();
  const sent = [];

  registerAuthRoutes(router, {
    repositories: {
      identity: {
        verifyOtp: async () => ({
          success: true,
          isNewUser: false,
          sessionToken: 'session-2',
          user: { userId: 'user-2', phoneNumber: '+919111111111' },
        }),
        isProfileComplete: async () => true,
        getUserProfile: async () => ({ name: 'Yogesh S' }),
      },
    },
    services: {
      notificationService: {
        registerToken() {},
        async send(userId, payload) {
          sent.push({ userId, payload });
        },
      },
    },
  });

  const handler = router.handlers.get('POST /api/v1/auth/login');
  const response = await handler({
    body: {
      phone: '9111111111',
      countryCode: '+91',
      otp: '123456',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'Welcome back to GoApp');
  assert.equal(sent[0].payload.body, 'Welcome back, Yogesh S.');
  assert.equal(sent[0].payload.data.route, 'home');
  assert.equal(response.data.data.user.name, 'Yogesh S');
});

test('logout revokes current session', async () => {
  const router = buildRouter();
  const revoked = [];

  registerAuthRoutes(router, {
    repositories: {
      identity: {
        revokeSession: async (payload) => {
          revoked.push(payload);
          return { success: true };
        },
      },
    },
    requireAuth: async () => ({
      session: {
        sessionToken: 'session-logout-1',
      },
    }),
  });

  const handler = router.handlers.get('POST /api/v1/auth/logout');
  const response = await handler({
    body: { refreshToken: 'refresh-logout-1' },
    headers: { authorization: 'Bearer session-logout-1' },
  });

  assert.equal(response.status, 200);
  assert.equal(revoked[0].sessionToken, 'session-logout-1');
  assert.equal(revoked[0].refreshToken, 'refresh-logout-1');
  assert.equal(revoked[0].logoutType, 'voluntary');
});

test('refresh token endpoint rate limits excessive attempts by IP', async () => {
  const router = buildRouter();

  registerAuthRoutes(router, {
    repositories: {
      identity: {
        refreshSession: async () => ({ success: true, sessionToken: 'access-1', refreshToken: 'refresh-2', expiresInSec: 1800 }),
        validateSession: async () => ({ userId: 'user-1' }),
      },
    },
  });

  const handler = router.handlers.get('POST /api/v1/auth/refresh-token');
  let response;
  for (let i = 0; i < 21; i++) {
    response = await handler({
      body: { refreshToken: `refresh-${i}` },
      headers: {},
      ip: '203.0.113.10',
    });
  }

  assert.equal(response.status, 429);
  assert.equal(response.data.errorCode, 'REFRESH_RATE_LIMITED');
});
