'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const repository = require('../../../repositories/pg/pg-support-ticket-repository');

test('resolveRideForRider queries dropoff_address for destination snapshots', async () => {
  let capturedSql = null;
  let capturedParams = null;

  const row = {
    id: 'ride-1',
    rideNumber: 'RIDE-001',
    status: 'completed',
    fareEstimate: 230,
    pickupAddress: 'Pickup address',
    destinationAddress: 'Dropoff address',
    riderUserId: 'user-1',
    driverUserId: 'driver-1',
  };

  const result = await repository.resolveRideForRider('ride-1', 'user-1', {
    query: async (text, params) => {
      capturedSql = text;
      capturedParams = params;
      return { rows: [row] };
    },
  });

  assert.match(capturedSql, /r\.dropoff_address AS "destinationAddress"/);
  assert.doesNotMatch(capturedSql, /r\.dest_address AS "destinationAddress"/);
  assert.deepEqual(capturedParams, ['ride-1', 'user-1']);
  assert.equal(result.destinationAddress, 'Dropoff address');
});
