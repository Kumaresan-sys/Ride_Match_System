'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../../services/support-ticket-service');

test('createTicket allows cancelled rides and keeps the destination snapshot from the rides schema', async () => {
  const originalRepository = service.repository;
  const originalRedis = service.redis;
  const originalNotificationService = service.notificationService;
  const originalStorageService = service.storageService;
  const originalWsServer = service.wsServer;
  const originalBuildTicketCode = service._buildTicketCode;

  let resolveRideArgs = null;
  let createdTicketPayload = null;

  service.repository = {
    resolveRideForRider: async (rideId, userId) => {
      resolveRideArgs = { rideId, userId };
      return {
        id: 'ride-1',
        rideNumber: 'RIDE-001',
        status: 'cancelled',
        pickupAddress: 'Pickup address',
        destinationAddress: 'Dropoff address',
        fareEstimate: 230,
        riderUserId: 'user-1',
        driverUserId: 'driver-1',
      };
    },
    withTransaction: async (callback) => callback({}),
    getAssignableAgent: async () => null,
    createTicket: async (_client, payload) => {
      createdTicketPayload = payload;
      return 'ticket-1';
    },
    updateTicketAfterCreate: async () => {},
    createMessage: async () => 'message-1',
    insertStatusHistory: async () => {},
    upsertReadState: async () => {},
    enqueueOutbox: async () => {},
    getTicketDetail: async () => ({
      id: 'ticket-1',
      ticketCode: 'SUP-TEST-001',
      status: 'OPEN',
      canReply: true,
    }),
  };
  service.redis = null;
  service.notificationService = null;
  service.storageService = null;
  service.wsServer = null;
  service._buildTicketCode = () => 'SUP-TEST-001';

  try {
    const result = await service.createTicket({
      userId: 'user-1',
      category: 'driver_vehicle_issue',
      subject: 'Past ride issue',
      message: 'Driver was rude',
      rideId: 'ride-1',
      metadata: {
        source: 'past_ride_issue_details_page',
      },
    });

    assert.equal(result.success, true);
    assert.deepEqual(resolveRideArgs, {
      rideId: 'ride-1',
      userId: 'user-1',
    });
    assert.equal(createdTicketPayload.rideId, 'ride-1');
    assert.equal(
      createdTicketPayload.metadata.rideSnapshot.destinationAddress,
      'Dropoff address',
    );
    assert.equal(
      createdTicketPayload.metadata.rideSnapshot.pickupAddress,
      'Pickup address',
    );
  } finally {
    service.repository = originalRepository;
    service.redis = originalRedis;
    service.notificationService = originalNotificationService;
    service.storageService = originalStorageService;
    service.wsServer = originalWsServer;
    service._buildTicketCode = originalBuildTicketCode;
  }
});
