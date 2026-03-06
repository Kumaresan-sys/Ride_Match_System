// GoApp Integration Tests — Redis (services/redis-client.js)
// Requires: NODE_ENV=test, running Redis on localhost:6379
// Run: npm run test:integration

'use strict';

// env-loader must be first to populate process.env from .env.test
require('../../config/env-loader');

const test   = require('node:test');
const assert = require('node:assert/strict');
const redis  = require('../../services/redis-client');

test.after(async () => {
  // Clean up test keys and close connection
  await redis.flushAll();
  if (typeof redis.stop === 'function') await redis.stop();
});

test('redis: set and get a key', async () => {
  await redis.set('integ:test:key', 'hello-world', { EX: 60 });
  const val = await redis.get('integ:test:key');
  assert.equal(val, 'hello-world');
});

test('redis: del removes a key', async () => {
  await redis.set('integ:del:key', 'to-delete', { EX: 60 });
  await redis.del('integ:del:key');
  const val = await redis.get('integ:del:key');
  assert.equal(val, null);
});

test('redis: acquireLock succeeds for a new ride', async () => {
  const result = await redis.acquireLock('RIDE-INTEG-1', 'DRV-001', 30);
  assert.ok(result.acquired, 'Lock should be acquired for a new ride');
  assert.equal(result.holder, 'DRV-001');
  await redis.releaseLock('RIDE-INTEG-1');
});

test('redis: acquireLock fails when ride is already locked', async () => {
  await redis.acquireLock('RIDE-INTEG-2', 'DRV-001', 30);
  const second = await redis.acquireLock('RIDE-INTEG-2', 'DRV-002', 30);
  assert.ok(!second.acquired, 'Second lock attempt should fail');
  await redis.releaseLock('RIDE-INTEG-2');
});

test('redis: releaseLock allows re-acquisition', async () => {
  await redis.acquireLock('RIDE-INTEG-3', 'DRV-001', 30);
  await redis.releaseLock('RIDE-INTEG-3');
  const reacquire = await redis.acquireLock('RIDE-INTEG-3', 'DRV-002', 30);
  assert.ok(reacquire.acquired, 'Lock should be acquirable after release');
  await redis.releaseLock('RIDE-INTEG-3');
});

test('redis: checkIdempotency returns false for new key', async () => {
  const result = await redis.checkIdempotency('integ-idem-new-key');
  assert.ok(!result.isDuplicate);
});

test('redis: setIdempotency then checkIdempotency returns duplicate', async () => {
  const payload = { rideId: 'RIDE-IDEM-1', status: 'created' };
  await redis.setIdempotency('integ-idem-set-key', payload, 60);
  const result = await redis.checkIdempotency('integ-idem-set-key');
  assert.ok(result.isDuplicate, 'Should be detected as duplicate after set');
  assert.equal(result.existingResult.rideId, 'RIDE-IDEM-1');
});
