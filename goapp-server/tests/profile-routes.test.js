const test = require('node:test');
const assert = require('node:assert/strict');

const registerProfileRoutes = require('../routes/profile-routes');
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

test('formatMemberSince returns month and year for numeric string epoch values', () => {
  const formatted = registerProfileRoutes.formatMemberSince('1704067200000');

  assert.equal(formatted, 'January 2024');
});

test('formatMemberSince returns month and year for decimal epoch strings', () => {
  const formatted = registerProfileRoutes.formatMemberSince('1704067200000.000000');

  assert.equal(formatted, 'January 2024');
});

test('get profile returns member_since from user createdAt', async () => {
  const router = buildRouter();
  const originalGetUserProfile = pgRepo.getUserProfile;
  const originalGetUserById = pgRepo.getUserById;

  pgRepo.getUserProfile = async () => ({
    name: 'Yogesh',
    gender: 'Male',
    date_of_birth: '12 July 1985',
    emergency_contact: '9876543210',
  });
  pgRepo.getUserById = async () => ({
    email: 'yogesh@gmail.com',
    phone_number: '+919876543210',
    createdAt: '1704067200000.000000',
  });

  registerProfileRoutes(router, {
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    services: {},
  });

  const handler = router.handlers.get('GET /api/v1/profile');
  const response = await handler({ headers: {} });

  pgRepo.getUserProfile = originalGetUserProfile;
  pgRepo.getUserById = originalGetUserById;

  assert.equal(response.status, 200);
  assert.equal(response.data.member_since, 'January 2024');
});
