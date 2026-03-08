const test = require('node:test');
const assert = require('node:assert/strict');

const registerAuthRoutes = require('../routes/auth-routes');
const pgRepo = require('../repositories/pg/pg-identity-repository');

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
  const originalIsProfileComplete = pgRepo.isProfileComplete;
  const originalGetUserProfile = pgRepo.getUserProfile;

  pgRepo.isProfileComplete = async () => false;
  pgRepo.getUserProfile = async () => null;

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

  pgRepo.isProfileComplete = originalIsProfileComplete;
  pgRepo.getUserProfile = originalGetUserProfile;

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'Welcome to GoApp');
  assert.equal(sent[0].payload.data.route, 'profile_setup');
  assert.equal(response.data.data.user.name, '');
});

test('login sends welcome back push with profile name for existing user', async () => {
  const router = buildRouter();
  const sent = [];
  const originalIsProfileComplete = pgRepo.isProfileComplete;
  const originalGetUserProfile = pgRepo.getUserProfile;

  pgRepo.isProfileComplete = async () => true;
  pgRepo.getUserProfile = async () => ({ name: 'Yogesh S' });

  registerAuthRoutes(router, {
    repositories: {
      identity: {
        verifyOtp: async () => ({
          success: true,
          isNewUser: false,
          sessionToken: 'session-2',
          user: { userId: 'user-2', phoneNumber: '+919111111111' },
        }),
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

  pgRepo.isProfileComplete = originalIsProfileComplete;
  pgRepo.getUserProfile = originalGetUserProfile;

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'Welcome back to GoApp');
  assert.equal(sent[0].payload.body, 'Welcome back, Yogesh S.');
  assert.equal(sent[0].payload.data.route, 'home');
  assert.equal(response.data.data.user.name, 'Yogesh S');
});
