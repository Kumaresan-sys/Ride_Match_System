'use strict';

require('../../config/env-loader');

const test = require('node:test');
const assert = require('node:assert/strict');

const { DevResetService } = require('../../services/dev-reset-service');

test('dev reset dry-run targets seeded-driver rides and explicit test riders only', async (t) => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';

  const calls = [];
  const fakeDomainDb = {
    async query(domain, text) {
      calls.push({ domain, text });
      if (domain === 'identity' && text.includes('FROM users u')) {
        return {
          rows: [
            {
              user_id: '90000000-0000-4000-8000-000000000001',
              rider_id: '91000000-0000-4000-8000-000000000001',
              phone_number: '+919876543210',
              email: 'dev-rider-1@goapp.local',
              display_name: 'Dev Rider Integration',
            },
          ],
        };
      }
      if (domain === 'rides' && text.includes('FROM rides')) {
        return {
          rows: [
            {
              id: '92000000-0000-4000-8000-000000000001',
              ride_number: 'RIDE-DEVRESET1',
              rider_id: '91000000-0000-4000-8000-000000000001',
              driver_id: '20000000-0000-4000-8000-000000000001',
              status: 'driver_arriving',
              created_at: '2026-03-10T12:00:00.000Z',
            },
          ],
        };
      }
      throw new Error(`Unexpected query for ${domain}: ${text}`);
    },
  };

  t.after(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  const service = new DevResetService({ domainDb: fakeDomainDb });
  const result = await service.reset({ dryRun: true });

  assert.equal(result.success, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.target.testRiderCount, 1);
  assert.equal(result.target.rideCount, 1);
  assert.equal(result.target.testRiders[0].email, 'dev-rider-1@goapp.local');
  assert.equal(result.target.rides[0].rideId, 'RIDE-DEVRESET1');
  assert.equal(result.target.rides[0].driverId, '20000000-0000-4000-8000-000000000001');
  assert.equal(calls.length, 2);
});
